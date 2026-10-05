import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

const AVATAR_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../assets/nyxius.png",
);

const execFileAsync = promisify(execFile);

const MAX_DURATION = 600;
const MAX_SIZE_BYTES = 15 * 1024 * 1024;
const INNERTUBE_SEARCH = "https://www.youtube.com/youtubei/v1/search?prettyPrint=false";
const INNERTUBE_PLAYER = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const SEARCH_MIRRORS = [
  "https://inv.nadeko.net/api/v1/search?type=video&q=",
  "https://yewtu.be/api/v1/search?type=video&q=",
  "https://pipedapi.kavin.rocks/search?filter=videos&q=",
];
const ANDROID_CLIENT = {
  clientName: "ANDROID",
  clientVersion: "20.10.38",
  androidSdkVersion: 35,
  hl: "en",
  gl: "US",
};

const WEB_CLIENT = {
  clientName: "WEB",
  clientVersion: "2.20250327.01.00",
  hl: "en",
  gl: "US",
};

let ytDlpPath = null;
let ensurePromise = null;
let ffmpegPath = null;
let ffmpegPromise = null;
let cookieFilePromise = null;

function mimetypeFrom(nameOrType) {
  const v = String(nameOrType || "").toLowerCase();
  if (v.includes("ogg") || v.includes("opus")) return "audio/ogg; codecs=opus";
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

function ffmpegAsset() {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "ffmpeg-darwin-arm64" : "ffmpeg-darwin-x64";
  }
  if (process.platform === "win32") return "ffmpeg-win32-x64.exe";
  return process.arch === "arm64" ? "ffmpeg-linux-arm64" : "ffmpeg-linux-x64";
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

export async function ensureFfmpeg() {
  if (ffmpegPath) return ffmpegPath;
  if (ffmpegPromise) return ffmpegPromise;
  ffmpegPromise = (async () => {
    try {
      await execFileAsync("ffmpeg", ["-version"], { timeout: 15_000 });
      ffmpegPath = "ffmpeg";
      return ffmpegPath;
    } catch {
      // portable binary — no apt on Render
    }

    const dest = path.join(os.tmpdir(), `nyxius-${ffmpegAsset()}`);
    try {
      await fs.access(dest, fs.constants.X_OK);
      ffmpegPath = dest;
      return dest;
    } catch {
      // download
    }

    const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/${ffmpegAsset()}`;
    console.log("⬇️  Fetching ffmpeg for .play…");
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error("ffmpeg_missing");
    await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
    ffmpegPath = dest;
    console.log("✅ ffmpeg ready");
    return dest;
  })();
  try {
    return await ffmpegPromise;
  } catch (err) {
    ffmpegPromise = null;
    throw err;
  }
}

function scrubMeta(value, fallback) {
  return (
    String(value || fallback)
      .replace(/[\r\n\0=]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || fallback
  );
}

async function fetchCoverArt(videoId) {
  if (!videoId) return null;
  const urls = [
    `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      // YouTube sometimes returns a tiny grey placeholder for missing maxres.
      if (buf.length < 8_000) continue;
      const dest = path.join(os.tmpdir(), `nyxius-cover-${randomUUID()}.jpg`);
      await fs.writeFile(dest, buf);
      return dest;
    } catch {
      // try next size
    }
  }
  return null;
}

async function resolveCoverPath(meta = {}) {
  if (meta.coverPath) {
    try {
      await fs.access(meta.coverPath);
      return { path: meta.coverPath, cleanup: false };
    } catch {
      // fall through
    }
  }
  const videoId = meta.videoId || videoIdFromUrl(meta.url);
  const fetched = await fetchCoverArt(videoId);
  if (fetched) return { path: fetched, cleanup: true };
  try {
    await fs.access(AVATAR_PATH);
    return { path: AVATAR_PATH, cleanup: false };
  } catch {
    return null;
  }
}

/** Encode to MP3 with ID3 tags + embedded cover art. */
async function remuxForWhatsApp(inputPath, meta = {}) {
  const ffmpeg = await ensureFfmpeg();
  const id = randomUUID();
  const outPath = path.join(os.tmpdir(), `nyxius-wa-${id}.mp3`);
  const title = scrubMeta(meta.title, "Nyxius");
  const artist = scrubMeta(meta.artist, "Nyxius");
  const album = scrubMeta(meta.album, "Nyxius");
  const cover = await resolveCoverPath(meta);

  const args = ["-y", "-i", inputPath];
  if (cover?.path) args.push("-i", cover.path);
  if (cover?.path) {
    args.push(
      "-map",
      "0:a:0",
      "-map",
      "1:0",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "192k",
      "-c:v",
      "mjpeg",
      "-metadata:s:v",
      "title=Album cover",
      "-metadata:s:v",
      "comment=Cover (front)",
      "-disposition:v:0",
      "attached_pic",
    );
  } else {
    args.push("-vn", "-c:a", "libmp3lame", "-b:a", "192k");
  }
  args.push(
    "-metadata",
    `title=${title}`,
    "-metadata",
    `artist=${artist}`,
    "-metadata",
    `album=${album}`,
    "-id3v2_version",
    "3",
    outPath,
  );

  try {
    await execFileAsync(ffmpeg, args, { timeout: 180_000, windowsHide: true });
  } finally {
    if (cover?.cleanup) await fs.unlink(cover.path).catch(() => {});
  }

  const buffer = await fs.readFile(outPath);
  await fs.unlink(outPath).catch(() => {});
  if (!buffer.length) throw new Error("download_failed");
  if (buffer.length > MAX_SIZE_BYTES) throw new Error("too_large");
  return { buffer, mimetype: "audio/mpeg" };
}

async function bufferToWhatsAppAudio(buffer, extHint = "m4a", meta = {}) {
  const id = randomUUID();
  const inputPath = path.join(os.tmpdir(), `nyxius-raw-${id}.${extHint}`);
  await fs.writeFile(inputPath, buffer);
  try {
    return await remuxForWhatsApp(inputPath, meta);
  } finally {
    await fs.unlink(inputPath).catch(() => {});
  }
}

async function cookieArgs() {
  if (process.env.YT_COOKIES_FILE) return ["--cookies", process.env.YT_COOKIES_FILE];
  const raw = process.env.YT_COOKIES;
  if (!raw) return [];
  if (!cookieFilePromise) {
    cookieFilePromise = (async () => {
      const dest = path.join(os.tmpdir(), "nyxius-yt-cookies.txt");
      const text = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
      await fs.writeFile(dest, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
      return dest;
    })();
  }
  return ["--cookies", await cookieFilePromise];
}

function parseJson(stdout) {
  const raw = String(stdout || "").trim();
  const start = raw.indexOf("{");
  if (start === -1) throw new Error("invalid_json");
  return JSON.parse(raw.slice(start));
}

async function runYtDlp(bin, args, opts) {
  try {
    return await execFileAsync(bin, args, { ...opts, windowsHide: true });
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

async function ytCommon(extra = []) {
  return [
    "--no-warnings",
    "--no-progress",
    "--no-check-certificates",
    "--extractor-args",
    "youtube:player_client=android,ios,web_safari,tv",
    "--js-runtimes",
    "node",
    ...(await cookieArgs()),
    ...extra,
  ];
}

export function isYoutubeUrl(query) {
  return /youtu\.?be/i.test(query) || /^https?:\/\/(www\.)?youtube\.com\//i.test(query);
}

function videoIdFromUrl(url) {
  const match = String(url || "").match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([\w-]{11})/);
  return match?.[1] || null;
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

function textOf(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value.simpleText) return value.simpleText;
  if (Array.isArray(value.runs)) return value.runs.map((run) => run.text).join("");
  return "";
}

function parseClock(value) {
  const raw = String(value || "").trim();
  const parts = raw.split(":").map(Number);
  if (!parts.length || parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function collectTracks(node, query, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collectTracks(item, query, out);
    return out;
  }
  const videoId = node.videoId;
  if (videoId && /^[\w-]{11}$/.test(videoId)) {
    const title = textOf(node.title || node.headline || node.overlayMetadata?.primaryText);
    const artist = textOf(
      node.longBylineText ||
        node.shortBylineText ||
        node.ownerText ||
        node.overlayMetadata?.secondaryText,
    );
    const duration =
      Number(node.lengthSeconds || 0) ||
      parseClock(textOf(node.lengthText)) ||
      parseClock(node.lengthText?.accessibility?.accessibilityData?.label);
    if (title && !node.isLive && !node.badges?.some((b) => /live/i.test(JSON.stringify(b)))) {
      out.push(
        trackFromEntry(
          {
            id: videoId,
            title,
            artist: artist || undefined,
            duration,
            webpage_url: `https://www.youtube.com/watch?v=${videoId}`,
          },
          query,
        ),
      );
    }
    return out;
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") collectTracks(value, query, out);
  }
  return out;
}

function uniqueTracks(list, limit) {
  const tracks = [];
  const seenIds = new Set();
  const seenSongs = new Set();
  for (const track of list) {
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
  return tracks;
}

async function innertubePost(url, client, body) {
  const android = client.clientName === "ANDROID";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": android
        ? `com.google.android.youtube/${client.clientVersion} (Linux; U; Android 15) gzip`
        : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "X-YouTube-Client-Name": android ? "3" : "1",
      "X-YouTube-Client-Version": client.clientVersion,
    },
    body: JSON.stringify({ context: { client }, ...body }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`innertube_${res.status}`);
  return res.json();
}

async function searchInnertube(query, limit) {
  for (const client of [ANDROID_CLIENT, WEB_CLIENT]) {
    try {
      const data = await innertubePost(INNERTUBE_SEARCH, client, {
        query,
        params: "EgIQAQ==",
      });
      const tracks = uniqueTracks(collectTracks(data, query), limit);
      if (tracks.length) return tracks;
    } catch (err) {
      console.warn("⚠️  innertube search failed:", err.message);
    }
  }
  return [];
}

async function searchMirrors(query, limit) {
  for (const base of SEARCH_MIRRORS) {
    try {
      const res = await fetch(`${base}${encodeURIComponent(query)}`, {
        signal: AbortSignal.timeout(12_000),
        headers: { Accept: "application/json" },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const items = Array.isArray(data) ? data : data?.items || [];
      const mapped = items.map((item) =>
        trackFromEntry(
          {
            id: item.videoId || item.id || item.url,
            title: item.title,
            artist: item.author || item.uploaderName || item.uploader,
            duration: Number(item.lengthSeconds || item.duration || 0),
            webpage_url: item.videoId
              ? `https://www.youtube.com/watch?v=${item.videoId}`
              : item.url,
          },
          query,
        ),
      );
      const tracks = uniqueTracks(mapped, limit);
      if (tracks.length) return tracks;
    } catch (err) {
      console.warn("⚠️  search mirror failed:", err.message);
    }
  }
  return [];
}

async function searchYtDlp(query, limit) {
  const bin = await ensureYtDlp();
  const fetchCount = Math.max(12, limit * 3);
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
      ...(await ytCommon()),
    ],
    { timeout: 120_000, maxBuffer: 20 * 1024 * 1024 },
  );
  const info = parseJson(metaRaw.stdout);
  const entries = Array.isArray(info?.entries) ? info.entries : [info];
  const tracks = uniqueTracks(
    entries.map((entry) => trackFromEntry(entry, query)),
    limit,
  );
  if (!tracks.length) throw new Error("not_found");
  return tracks;
}

export async function searchYoutubeTracks(query, limit = 5) {
  console.log(`🎧 yt search${limit} "${query}"`);
  const innertube = await searchInnertube(query, limit);
  const tracks = innertube.length ? innertube : await searchMirrors(query, limit);
  if (tracks.length) {
    console.log(`🎧 yt picks ${tracks.map((t) => t.title).join(" | ")}`);
    return tracks;
  }
  try {
    const fallback = await searchYtDlp(query, limit);
    console.log(`🎧 yt picks ${fallback.map((t) => t.title).join(" | ")}`);
    return fallback;
  } catch (err) {
    const msg = String(err.stderr || err.message || "");
    if (/not a bot|Sign in to confirm/i.test(msg)) throw new Error("not_found");
    throw err;
  }
}

function pickAudioFormats(formats = []) {
  const audio = formats.filter((f) => {
    const mime = String(f.mimeType || f.type || "");
    const url = String(f.url || "");
    const itag = Number(f.itag || 0);
    return url.startsWith("http") && (/^audio\//i.test(mime) || [140, 139, 251, 250, 249].includes(itag));
  });
  const rank = (f) => {
    const itag = Number(f.itag || 0);
    if (itag === 140) return 4;
    if (String(f.mimeType || f.type || "").includes("mp4")) return 3;
    if (itag === 251) return 2;
    return 1;
  };
  const seen = new Set();
  return audio
    .sort((a, b) => rank(b) - rank(a) || Number(b.bitrate || 0) - Number(a.bitrate || 0))
    .filter((f) => {
      const key = `${Number(f.itag || 0)}:${String(f.mimeType || f.type || "")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

const AUDIO_CHUNK = 256 * 1024;

async function fetchRanged(url, headers) {
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    const res = await fetch(current, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const next = res.headers.get("location");
      if (!next) throw new Error(`audio_http_${res.status}`);
      current = new URL(next, current).href;
      continue;
    }
    return res;
  }
  throw new Error("audio_http_redirect");
}

async function downloadUrl(url, headers = {}) {
  const base = {
    Accept: "*/*",
    Origin: "https://www.youtube.com",
    Referer: "https://www.youtube.com/",
    ...headers,
  };
  const chunks = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const end = offset + AUDIO_CHUNK - 1;
    const res = await fetchRanged(url, { ...base, Range: `bytes=${offset}-${end}` });
    if (res.status !== 206 && !res.ok) throw new Error(`audio_http_${res.status}`);
    const range = res.headers.get("content-range");
    const match = range?.match(/\/(\d+)\s*$/);
    if (match) total = Number(match[1]);
    if (total > MAX_SIZE_BYTES) throw new Error("too_large");
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error("audio_empty");
    chunks.push(buf);
    offset += buf.length;
    if (!match && buf.length < AUDIO_CHUNK) break;
  }
  const buffer = Buffer.concat(chunks);
  if (buffer.length > MAX_SIZE_BYTES) throw new Error("too_large");
  return buffer;
}

function audioResult({ buffer, mimetype, title, artist, duration, url }) {
  return { buffer, mimetype, title, artist, duration, url };
}

async function downloadViaInnertube(videoId, fallback) {
  const data = await innertubePost(INNERTUBE_PLAYER, ANDROID_CLIENT, {
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  });
  if (data?.playabilityStatus?.status && data.playabilityStatus.status !== "OK") {
    throw new Error(data.playabilityStatus.reason || "player_blocked");
  }
  const formats = [
    ...(data?.streamingData?.adaptiveFormats || []),
    ...(data?.streamingData?.formats || []),
  ];
  const format = pickAudioFormats(formats)[0];
  if (!format) throw new Error("no_audio_url");
  const details = data.videoDetails || {};
  const duration = Number(details.lengthSeconds || fallback.duration || 0);
  if (duration > MAX_DURATION) throw new Error("too_long");
  const raw = await downloadUrl(format.url, {
    "User-Agent": `com.google.android.youtube/${ANDROID_CLIENT.clientVersion} (Linux; U; Android 15) gzip`,
  });
  const ext = /webm|opus/i.test(String(format.mimeType || "")) ? "webm" : "m4a";
  const title = details.title || fallback.title;
  const artist = details.author || fallback.artist;
  const fixed = await bufferToWhatsAppAudio(raw, ext, {
    title,
    artist,
    album: artist || "Nyxius",
    videoId,
  });
  return audioResult({
    buffer: fixed.buffer,
    mimetype: fixed.mimetype,
    title,
    artist,
    duration,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  });
}

async function downloadViaYtDlp(query, known = {}) {
  const bin = await ensureYtDlp();
  const ffmpeg = await ensureFfmpeg().catch(() => null);
  const id = randomUUID();
  const outTemplate = path.join(os.tmpdir(), `nyxius-play-${id}.%(ext)s`);
  const common = await ytCommon([
    "--no-playlist",
    ...(ffmpeg ? ["--ffmpeg-location", ffmpeg] : []),
  ]);
  const webpageUrl = isYoutubeUrl(query) ? query.trim() : null;

  let title = known.title || "";
  let artist = known.artist || "";
  let duration = Number(known.duration || 0);
  let target = webpageUrl;

  if (!webpageUrl) {
    target = `ytsearch1:${query}`;
    console.log(`🎧 yt-dlp fetch ${target}`);
    const metaRaw = await runYtDlp(
      bin,
      [target, "--dump-single-json", "--skip-download", ...common],
      { timeout: 90_000, maxBuffer: 20 * 1024 * 1024 },
    );
    const entry = pickEntry(parseJson(metaRaw.stdout));
    duration = Number(entry?.duration || 0);
    title = entry?.track || entry?.title || query;
    artist = entry?.artist || entry?.creator || entry?.uploader || "";
    target = entry?.webpage_url || entry?.url;
    if (!target) throw new Error("not_found");
  } else {
    console.log(`🎧 yt-dlp fetch ${target}`);
  }

  if (duration > MAX_DURATION) throw new Error("too_long");

  const args = [
    target,
    "-o",
    outTemplate,
    "--max-filesize",
    "15m",
    "-f",
    "140/139/251/250/249/bestaudio/best",
    "--print",
    "after_move:%(duration)s\t%(artist,creator,uploader|)s\t%(track,title)s",
    "--no-simulate",
    ...common,
  ];
  if (!duration) {
    args.push("--match-filter", `duration <= ${MAX_DURATION}`);
  }

  let stdout = "";
  try {
    const result = await execFileAsync(bin, args, {
      timeout: 180_000,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
    stdout = String(result.stdout || "");
  } catch (err) {
    const msg = String(err.stderr || err.message || "");
    if (/Requested format is not available|format is not available|Only images are supported/i.test(msg)) {
      const retry = await execFileAsync(
        bin,
        [
          target,
          "-o",
          outTemplate,
          "--max-filesize",
          "15m",
          "-f",
          "bestaudio/best/18",
          ...common,
        ],
        { timeout: 180_000, maxBuffer: 20 * 1024 * 1024, windowsHide: true },
      );
      stdout = String(retry.stdout || "");
    } else {
      throw err;
    }
  }
  console.log("🎧 yt-dlp downloaded");

  const printLine = stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^\d+\t/.test(line));
  if (printLine) {
    const [dur, art, ttl] = printLine.split("\t");
    if (!duration) duration = Number(dur || 0);
    if (!artist) artist = art || "";
    if (!title) title = ttl || target;
  }
  if (duration > MAX_DURATION) throw new Error("too_long");

  const files = await fs.readdir(os.tmpdir());
  const match = files.find((name) => name.startsWith(`nyxius-play-${id}.`));
  if (!match) throw new Error("download_failed");
  const filePath = path.join(os.tmpdir(), match);
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_SIZE_BYTES) {
    await fs.unlink(filePath).catch(() => {});
    throw new Error("too_large");
  }
  const finalTitle = title || target;
  const videoId = videoIdFromUrl(webpageUrl || target);
  let buffer;
  let mimetype;
  try {
    const fixed = await remuxForWhatsApp(filePath, {
      title: finalTitle,
      artist,
      album: artist || "Nyxius",
      videoId,
      url: webpageUrl || target,
    });
    buffer = fixed.buffer;
    mimetype = fixed.mimetype;
  } catch (err) {
    console.warn("⚠️  mp3 encode failed, sending raw:", err.message);
    buffer = await fs.readFile(filePath);
    mimetype = mimetypeFrom(match);
  }
  await fs.unlink(filePath).catch(() => {});
  return audioResult({
    buffer,
    mimetype,
    title: finalTitle,
    artist,
    duration,
    url: webpageUrl || target,
  });
}

async function firstResolved(promises) {
  return new Promise((resolve, reject) => {
    let pending = promises.length;
    const errors = [];
    for (const promise of promises) {
      Promise.resolve(promise).then(resolve, (err) => {
        errors.push(err);
        pending -= 1;
        if (pending === 0) {
          reject(errors.find(isYoutubeBotBlock) || errors.at(-1) || new Error("download_failed"));
        }
      });
    }
  });
}

function isYoutubeBotBlock(err) {
  const message = `${err?.stderr || ""}\n${err?.message || err || ""}`;
  return /sign in to confirm|not a bot|automated queries|unusual traffic/i.test(message);
}

export async function downloadYoutubeAudio(query, known = null) {
  let url = String(query || "").trim();
  let fallback = {
    title: known?.title || url,
    artist: known?.artist || "",
    duration: Number(known?.duration || 0),
    url,
  };

  if (!isYoutubeUrl(url)) {
    const [first] = await searchYoutubeTracks(url, 1);
    if (!first) throw new Error("not_found");
    url = first.url;
    fallback = first;
  }

  const videoId = videoIdFromUrl(url);
  const cookies = await cookieArgs();

  try {
    if (cookies.length) {
      return await downloadViaYtDlp(url, fallback);
    }

    // Race: yt-dlp wins locally; innertube sometimes wins on datacenter IPs.
    // Dead Piped/Invidious mirrors are skipped — they only added 10–40s of delay.
    const jobs = [downloadViaYtDlp(url, fallback).then((audio) => {
      console.log("🎧 yt-dlp audio");
      return audio;
    })];
    if (videoId) {
      jobs.push(
        downloadViaInnertube(videoId, fallback).then((audio) => {
          console.log("🎧 innertube player audio");
          return audio;
        }),
      );
    }
    return await firstResolved(jobs);
  } catch (err) {
    if (/too_long|too_large|not_found/.test(err?.message || "")) throw err;
    if (isYoutubeBotBlock(err)) {
      console.warn("⚠️ YouTube blocked this server; configure YT_COOKIES or YT_COOKIES_FILE.");
      throw new Error("youtube_blocked");
    }
    throw err?.message ? err : new Error("download_failed");
  }
}
