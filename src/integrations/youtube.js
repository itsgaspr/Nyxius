import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

const execFileAsync = promisify(execFile);

const MAX_DURATION = 600;
const MAX_SIZE_BYTES = 15 * 1024 * 1024;

let ytDlpPath = null;
let ensurePromise = null;

function mimetypeFrom(nameOrType) {
  const v = String(nameOrType || "").toLowerCase();
  if (v.includes("webm")) return "audio/webm";
  if (v.includes("mpeg") || v.includes("mp3")) return "audio/mpeg";
  return "audio/mp4";
}

function ytDlpAsset() {
  if (process.platform === "darwin") return "yt-dlp_macos";
  if (process.platform === "win32") return "yt-dlp.exe";
  if (process.arch === "arm64") return "yt-dlp_linux_aarch64";
  return "yt-dlp_linux";
}

export async function ensureYtDlp() {
  if (ytDlpPath) return ytDlpPath;
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    try {
      await execFileAsync("yt-dlp", ["--version"], { timeout: 15_000 });
      ytDlpPath = "yt-dlp";
      return ytDlpPath;
    } catch {
      // portable binary — no apt on Render
    }

    const dest = path.join(os.tmpdir(), `nyxius-${ytDlpAsset()}`);
    try {
      await fs.access(dest, fs.constants.X_OK);
      ytDlpPath = dest;
      return dest;
    } catch {
      // download
    }

    const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytDlpAsset()}`;
    console.log("⬇️  Fetching yt-dlp for .play…");
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error("yt-dlp_missing");
    await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
    ytDlpPath = dest;
    console.log("✅ yt-dlp ready");
    return dest;
  })();
  try {
    return await ensurePromise;
  } catch (err) {
    ensurePromise = null;
    throw err;
  }
}

function parseJson(stdout) {
  const raw = String(stdout || "").trim();
  const start = raw.indexOf("{");
  if (start === -1) throw new Error("invalid_json");
  return JSON.parse(raw.slice(start));
}

async function runYtDlp(bin, args, opts) {
  try {
    return await execFileAsync(bin, args, opts);
  } catch (err) {
    if (err.stdout && String(err.stdout).includes("{")) {
      const hint = String(err.stderr || err.message || "")
        .split("\n")
        .find((line) => line.trim());
      console.warn("⚠️  yt-dlp skipped a result:", hint || err.message);
      return { stdout: err.stdout, stderr: err.stderr };
    }
    throw err;
  }
}

function pickEntry(info) {
  if (info?.entries?.length) return info.entries[0];
  return info;
}

function ytCommon(extra = []) {
  return [
    "--no-warnings",
    "--no-check-certificates",
    "--extractor-args",
    "youtube:player_client=default,tv_embedded",
    ...extra,
  ];
}

export function isYoutubeUrl(query) {
  return /youtu\.?be/i.test(query) || /^https?:\/\/(www\.)?youtube\.com\//i.test(query);
}

function splitArtistTitle(entry, fallbackTitle) {
  const raw = String(entry?.track || entry?.title || fallbackTitle || "").trim();
  if (entry?.artist && entry?.track) {
    return { artist: String(entry.artist).trim(), title: String(entry.track).trim() };
  }
  const parts = raw.split(/\s+-\s+/);
  if (parts.length >= 2) {
    return {
      artist: parts[0].trim(),
      title: parts.slice(1).join(" - ").replace(/\s*\((lyrics|official.*?|audio)\)\s*$/i, "").trim() || raw,
    };
  }
  return {
    artist: entry?.creator || entry?.uploader || entry?.channel || "YouTube",
    title: raw,
  };
}

function foldText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalArtist(artist) {
  return foldText(artist)
    .replace(/\b(vevo|official|oficial|topic)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalTitle(title) {
  let t = String(title || "");
  t = t.replace(/\s*[\(\[\{][^\)\]\}]{0,80}[\)\]\}]/g, (chunk) => {
    const inner = foldText(chunk);
    const isNoise =
      /\b(official|oficial|lyric|lyrics|letra|audio|video|visualizer|mv|hd|4k|hq)\b/.test(inner);
    const isVariation =
      /\b(remix|live|ao vivo|acoustic|acustico|sped|slowed|cover|version|versao|edit|mix|instrumental|karaoke|nightcore)\b/.test(
        inner,
      );
    return isNoise && !isVariation ? "" : chunk;
  });
  return foldText(t);
}

function trackIdentity(track) {
  return `${canonicalArtist(track.artist)}|${canonicalTitle(track.title)}`;
}

function trackFromEntry(entry, fallbackTitle) {
  if (!entry || entry.availability === "unavailable") return null;
  const id = entry?.id || entry?.display_id;
  const url =
    entry?.webpage_url ||
    (id && /^[\w-]{6,}$/.test(String(id)) ? `https://www.youtube.com/watch?v=${id}` : null) ||
    entry?.url;
  if (!url || !/^https?:\/\//.test(url) || url.includes("ytsearch")) return null;
  const { artist, title } = splitArtistTitle(entry, fallbackTitle);
  return {
    id: id || url,
    url,
    title,
    artist,
    duration: Number(entry.duration || 0),
  };
}

export async function searchYoutubeTracks(query, limit = 5) {
  const bin = await ensureYtDlp();
  const fetchCount = Math.max(12, limit * 3);
  console.log(`🎧 yt search${limit} "${query}"`);
  const metaRaw = await runYtDlp(
    bin,
    [
      `ytsearch${fetchCount}:${query}`,
      "--dump-single-json",
      "--skip-download",
      "--playlist-end",
      String(fetchCount),
      "--ignore-errors",
      "--no-abort-on-error",
      ...ytCommon(),
    ],
    { timeout: 120_000, maxBuffer: 20 * 1024 * 1024 },
  );
  const info = parseJson(metaRaw.stdout);
  const entries = Array.isArray(info?.entries) ? info.entries : [info];
  const tracks = [];
  const seenIds = new Set();
  const seenSongs = new Set();
  for (const entry of entries) {
    const track = trackFromEntry(entry, query);
    if (!track) continue;
    if (seenIds.has(track.id)) continue;
    if (track.duration > MAX_DURATION) continue;
    const identity = trackIdentity(track);
    if (identity !== "|" && seenSongs.has(identity)) continue;
    seenIds.add(track.id);
    if (identity !== "|") seenSongs.add(identity);
    tracks.push(track);
    if (tracks.length >= limit) break;
  }
  if (!tracks.length) throw new Error("not_found");
  console.log(`🎧 yt picks ${tracks.map((t) => t.title).join(" | ")}`);
  return tracks;
}

export async function downloadYoutubeAudio(query) {
  const bin = await ensureYtDlp();
  const id = randomUUID();
  const outTemplate = path.join(os.tmpdir(), `nyxius-play-${id}.%(ext)s`);
  const common = ytCommon(["--no-playlist"]);

  const target = isYoutubeUrl(query) ? query.trim() : `ytsearch1:${query}`;
  console.log(`🎧 yt fetch ${target}`);
  const metaRaw = await runYtDlp(
    bin,
    [target, "--dump-single-json", "--skip-download", ...common],
    { timeout: 120_000, maxBuffer: 20 * 1024 * 1024 },
  );
  const entry = pickEntry(parseJson(metaRaw.stdout));
  const duration = Number(entry?.duration || 0);
  const title = entry?.track || entry?.title || query;
  const artist = entry?.artist || entry?.creator || entry?.uploader || "";
  const webpageUrl = entry?.webpage_url || entry?.url;
  if (!webpageUrl) throw new Error("not_found");
  if (duration > MAX_DURATION) throw new Error("too_long");

  // android/web often only expose muxed or storyboard formats, so bestaudio[ext=m4a] fails.
  const formatTries = [
    ["-f", "140/139/251/250/249/bestaudio/best"],
    ["-f", "bestaudio/best"],
    ["-f", "18/best"],
    [],
  ];

  let downloaded = false;
  let lastErr = null;
  for (const extra of formatTries) {
    try {
      await execFileAsync(
        bin,
        [
          webpageUrl,
          "-o",
          outTemplate,
          "--max-filesize",
          "15m",
          ...common,
          ...extra,
        ],
        { timeout: 180_000, maxBuffer: 20 * 1024 * 1024 },
      );
      downloaded = true;
      console.log(`🎧 yt downloaded format ${extra[1] || "default"}`);
      break;
    } catch (err) {
      lastErr = err;
      const msg = String(err.stderr || err.message || "");
      const retryable =
        msg.includes("Requested format is not available") ||
        msg.includes("format is not available") ||
        msg.includes("The page needs to be reloaded") ||
        msg.includes("Only images are supported");
      if (!retryable) throw err;
    }
  }
  if (!downloaded) throw lastErr || new Error("download_failed");

  const files = await fs.readdir(os.tmpdir());
  const match = files.find((name) => name.startsWith(`nyxius-play-${id}.`));
  if (!match) throw new Error("download_failed");
  const filePath = path.join(os.tmpdir(), match);
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_SIZE_BYTES) {
    await fs.unlink(filePath).catch(() => {});
    throw new Error("too_large");
  }
  const buffer = await fs.readFile(filePath);
  await fs.unlink(filePath).catch(() => {});
  return {
    buffer,
    mimetype: mimetypeFrom(match),
    title,
    artist,
    duration,
    url: webpageUrl,
  };
}
