import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import sharp from "sharp";

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

// android and mweb get the datacenter bot check. These two still return a
// format without cookies or a proof-of-origin token.
const DEFAULT_CLIENTS = "android_vr";
const ANON_CLIENTS = "android_vr";
const EMBED_CLIENTS = "web_embedded";
const COOKIE_CLIENTS = "web_safari";
const TV_CLIENT = {
  clientName: "TVHTML5",
  clientVersion: "7.20260707.07.00",
  clientId: "7",
  hl: "en",
  gl: "US",
  userAgent:
    "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)",
};

let ytDlpPath = null;
let ensurePromise = null;
let ffmpegPath = null;
let ffmpegPromise = null;
let cookieTextPromise = null;

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

async function encodeMp3(inputPath, meta = {}) {
  const ffmpeg = await ensureFfmpeg();
  const id = randomUUID();
  const outPath = path.join(os.tmpdir(), `nyxius-wa-${id}.mp3`);
  const coverPath = meta.cover ? path.join(os.tmpdir(), `nyxius-cover-${id}.jpg`) : null;
  const title = scrubMeta(meta.title, "Nyxius");
  const artist = scrubMeta(meta.artist, "Nyxius");
  const album = scrubMeta(meta.album, "Nyxius");
  if (coverPath) await fs.writeFile(coverPath, meta.cover);

  const args = ["-y", "-i", inputPath];
  if (coverPath) {
    args.push(
      "-i",
      coverPath,
      "-map",
      "0:a:0",
      "-map",
      "1:0",
      "-c:v",
      "copy",
      "-disposition:v:0",
      "attached_pic",
    );
  } else {
    args.push("-vn");
  }
  args.push("-c:a", "libmp3lame", "-b:a", "128k");
  args.push(
    "-metadata",
    `title=${title}`,
    "-metadata",
    `artist=${artist}`,
    "-metadata",
    `album=${album}`,
    "-id3v2_version",
    "3",
  );
  if (coverPath) {
    args.push(
      "-metadata:s:v",
      "title=Album cover",
      "-metadata:s:v",
      "comment=Cover (front)",
    );
  }
  args.push(outPath);

  try {
    await execFileAsync(ffmpeg, args, { timeout: 180_000, windowsHide: true });
    const buffer = await fs.readFile(outPath);
    if (!buffer.length) throw new Error("download_failed");
    if (buffer.length > MAX_SIZE_BYTES) throw new Error("too_large");
    return { buffer, mimetype: "audio/mpeg" };
  } finally {
    await fs.unlink(outPath).catch(() => {});
    if (coverPath) await fs.unlink(coverPath).catch(() => {});
  }
}

/** Encode to MP3 with ID3 tags and, when we have one, the album cover. */
async function remuxForWhatsApp(inputPath, meta = {}) {
  try {
    return await encodeMp3(inputPath, meta);
  } catch (err) {
    if (!meta.cover || err?.message === "too_large") throw err;
    console.warn("⚠️  cover embed failed, sending audio without it:", err.message);
    return encodeMp3(inputPath, { ...meta, cover: null });
  }
}

async function fetchCoverJpeg(videoId) {
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) return null;
  const urls = [
    `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!res.ok) continue;
      const raw = Buffer.from(await res.arrayBuffer());
      if (raw.length < 1500) continue;
      const meta = await sharp(raw).metadata();
      if ((meta.width || 0) < 320 || (meta.height || 0) < 180) continue;
      let jpeg = await sharp(raw)
        .rotate()
        .resize(480, 480, { fit: "cover", position: "centre" })
        .jpeg({ quality: 75, progressive: false, chromaSubsampling: "4:2:0" })
        .toBuffer();
      // WhatsApp drops the chat card when the thumbnail is large.
      if (jpeg.length > 60_000) {
        jpeg = await sharp(jpeg)
          .resize(320, 320, { fit: "inside" })
          .jpeg({ quality: 60, progressive: false, chromaSubsampling: "4:2:0" })
          .toBuffer();
      }
      return jpeg;
    } catch (err) {
      console.warn("⚠️  cover fetch failed:", err.message);
    }
  }
  return null;
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

function jsonCookiesToNetscape(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return "";
  }
  const list = Array.isArray(data) ? data : data.cookies || data.cookie;
  if (!Array.isArray(list)) return "";
  const lines = ["# Netscape HTTP Cookie File"];
  for (const cookie of list) {
    const name = cookie?.name || cookie?.key;
    if (!name || cookie.value == null) continue;
    let domain = String(cookie.domain || ".youtube.com");
    if (!domain.startsWith(".") && !cookie.hostOnly) domain = `.${domain}`;
    const includeSub = domain.startsWith(".") ? "TRUE" : "FALSE";
    const secure = cookie.secure ? "TRUE" : "FALSE";
    const exp = Math.floor(Number(cookie.expirationDate || cookie.expires || cookie.expiry || 0)) || 0;
    const prefix = cookie.httpOnly ? "#HttpOnly_" : "";
    const value = String(cookie.value).replace(/[\r\n\t]/g, "");
    lines.push(`${prefix}${domain}\t${includeSub}\t${cookie.path || "/"}\t${secure}\t${exp}\t${name}\t${value}`);
  }
  return lines.length > 1 ? `${lines.join("\n")}\n` : "";
}

function headerCookiesToNetscape(text) {
  const body = text.replace(/^cookie:\s*/i, "").trim();
  if (!body || body.includes("\t") || body.includes("\n") || !body.includes("=")) return "";
  const lines = ["# Netscape HTTP Cookie File"];
  for (const part of body.split(";")) {
    const piece = part.trim();
    const eq = piece.indexOf("=");
    if (eq <= 0) continue;
    const name = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim().replace(/[\r\n\t]/g, "");
    if (!name || !value) continue;
    lines.push(`.youtube.com\tTRUE\t/\tTRUE\t0\t${name}\t${value}`);
  }
  return lines.length > 1 ? `${lines.join("\n")}\n` : "";
}

function normalizeCookieExport(raw) {
  let text = String(raw || "").replace(/^\uFEFF/, "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\r\n/g, "\n").trim();
  const compact = text.replace(/\s+/g, "");
  if (
    !text.includes("\n") &&
    !text.includes("\t") &&
    compact.length > 40 &&
    /^[A-Za-z0-9+/=]+$/.test(compact)
  ) {
    try {
      const decoded = Buffer.from(compact, "base64").toString("utf8").trim();
      if (/youtube|Netscape|\t|LOGIN_INFO|SID/i.test(decoded)) text = decoded;
    } catch {
      // keep the original text
    }
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const converted = jsonCookiesToNetscape(trimmed);
    if (converted) return converted;
  }
  if (!trimmed.includes("\t") && trimmed.includes("=") && trimmed.includes(";")) {
    const converted = headerCookiesToNetscape(trimmed);
    if (converted) return converted;
  }
  if (!trimmed.startsWith("#")) text = `# Netscape HTTP Cookie File\n${trimmed}`;
  if (!text.endsWith("\n")) text += "\n";
  return text;
}

function countYoutubeCookies(text) {
  return String(text || "")
    .split("\n")
    .filter((line) => {
      if (!line || line.startsWith("# ")) return false;
      const domain = line.replace(/^#HttpOnly_/, "").split("\t")[0] || "";
      return /youtube\.com|google\.com/i.test(domain) && line.split("\t").length >= 7;
    }).length;
}

async function ensureCookieText() {
  const cookieFile = process.env.YT_COOKIES_FILE;
  const raw = process.env.YT_COOKIES;
  if (!cookieFile && !raw) return "";
  if (!cookieTextPromise) {
    cookieTextPromise = (async () => {
      const source = cookieFile ? await fs.readFile(cookieFile, "utf8") : raw;
      const text = normalizeCookieExport(source);
      const count = countYoutubeCookies(text);
      if (!count) {
        console.warn(
          "⚠️  YT_COOKIES is set but no YouTube cookies could be parsed. Use a Netscape cookies.txt, JSON export, or its base64.",
        );
        return "";
      }
      console.log(`🍪 yt cookies ready (${count})`);
      return text;
    })().catch((err) => {
      cookieTextPromise = null;
      throw err;
    });
  }
  return cookieTextPromise;
}

async function cookieArgs() {
  const text = await ensureCookieText();
  if (!text) return [];
  // Fresh file per yt-dlp run. yt-dlp rewrites the cookie file, and a shared
  // one gets corrupted when two downloads overlap — then later plays fail.
  const dest = path.join(os.tmpdir(), `nyxius-ytc-${randomUUID()}.txt`);
  await fs.writeFile(dest, text, { mode: 0o600 });
  return ["--cookies", dest];
}

async function releaseCookies(args = []) {
  const index = args.indexOf("--cookies");
  if (index < 0) return;
  const file = args[index + 1];
  if (typeof file === "string" && file.includes("nyxius-ytc-")) {
    await fs.unlink(file).catch(() => {});
  }
}

function ytStderr(err) {
  return String(err?.stderr || err?.message || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("WARNING"))
    .slice(-4)
    .join(" | ");
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

async function ytCommon(extra = [], playerClients = DEFAULT_CLIENTS, useCookies = true) {
  let clients = playerClients || DEFAULT_CLIENTS;
  // Browser cookies only go to web clients. tv invalidates the session, and
  // android ignores them — sending them there is what triggers the bot wall.
  const cookieClient = clients.split(",").every((part) => ["web_safari", "mweb", "web"].includes(part));
  const cookies = useCookies && cookieClient ? await cookieArgs() : [];
  return [
    "--no-warnings",
    "--no-progress",
    "--no-check-certificates",
    ...(clients ? ["--extractor-args", `youtube:player_client=${clients}`] : []),
    "--js-runtimes",
    "node",
    ...cookies,
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
  const contextClient = { ...client };
  delete contextClient.clientId;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent":
        client.userAgent ||
        (android
          ? `com.google.android.youtube/${client.clientVersion} (Linux; U; Android 15) gzip`
          : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
      "X-YouTube-Client-Name": client.clientId || (android ? "3" : "1"),
      "X-YouTube-Client-Version": client.clientVersion,
    },
    body: JSON.stringify({ context: { client: contextClient }, ...body }),
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
  const args = [
    `ytsearch${fetchCount}:${query}`,
    "--dump-single-json",
    "--skip-download",
    "--playlist-end",
    String(fetchCount),
    "--ignore-errors",
    "--no-abort-on-error",
    ...(await ytCommon()),
  ];
  try {
    const metaRaw = await runYtDlp(bin, args, { timeout: 120_000, maxBuffer: 20 * 1024 * 1024 });
    const info = parseJson(metaRaw.stdout);
    const entries = Array.isArray(info?.entries) ? info.entries : [info];
    const tracks = uniqueTracks(
      entries.map((entry) => trackFromEntry(entry, query)),
      limit,
    );
    if (!tracks.length) throw new Error("not_found");
    return tracks;
  } finally {
    await releaseCookies(args);
  }
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

function audioResult({ buffer, mimetype, title, artist, duration, url, cover = null }) {
  return { buffer, mimetype, title, artist, duration, url, cover };
}

async function downloadViaInnertubeClient(videoId, fallback, client) {
  const data = await innertubePost(INNERTUBE_PLAYER, client, {
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
  const coverPromise = fetchCoverJpeg(videoId);
  const raw = await downloadUrl(format.url, {
    "User-Agent":
      client.userAgent ||
      `com.google.android.youtube/${ANDROID_CLIENT.clientVersion} (Linux; U; Android 15) gzip`,
  });
  const ext = /webm|opus/i.test(String(format.mimeType || "")) ? "webm" : "m4a";
  const title = details.title || fallback.title;
  const artist = details.author || fallback.artist;
  const cover = await coverPromise;
  const fixed = await bufferToWhatsAppAudio(raw, ext, {
    title,
    artist,
    album: artist || "Nyxius",
    cover,
  });
  return audioResult({
    buffer: fixed.buffer,
    mimetype: fixed.mimetype,
    title,
    artist,
    duration,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    cover,
  });
}

async function downloadViaInnertube(videoId, fallback) {
  let lastErr;
  for (const client of [ANDROID_CLIENT, TV_CLIENT]) {
    try {
      return await downloadViaInnertubeClient(videoId, fallback, client);
    } catch (err) {
      if (/too_long|too_large/.test(err?.message || "")) throw err;
      lastErr = err;
      console.warn(`⚠️  innertube ${client.clientName} failed:`, err.message);
    }
  }
  throw lastErr || new Error("player_blocked");
}

async function downloadViaYtDlp(query, known = {}, { clients = null, useCookies = true } = {}) {
  const bin = await ensureYtDlp();
  const ffmpeg = await ensureFfmpeg().catch(() => null);
  const id = randomUUID();
  const outTemplate = path.join(os.tmpdir(), `nyxius-play-${id}.%(ext)s`);
  let common = [];
  const webpageUrl = isYoutubeUrl(query) ? query.trim() : null;
  const coverPromise = fetchCoverJpeg(videoIdFromUrl(webpageUrl || known.url || known.id));

  let title = known.title || "";
  let artist = known.artist || "";
  let duration = Number(known.duration || 0);
  let target = webpageUrl;
  let filePath = "";

  try {
    common = await ytCommon(
      ["--no-playlist", ...(ffmpeg ? ["--ffmpeg-location", ffmpeg] : [])],
      clients,
      useCookies,
    );

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
      "bestaudio/best/18",
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
      const detail = ytStderr(err);
      if (detail) console.warn("⚠️  yt-dlp:", detail);
      err.stderr = err.stderr || detail;
      throw err;
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
    filePath = path.join(os.tmpdir(), match);
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_SIZE_BYTES) throw new Error("too_large");
    const finalTitle = title || target;
    let cover = await coverPromise;
    if (!cover) cover = await fetchCoverJpeg(videoIdFromUrl(target));
    let buffer;
    let mimetype;
    try {
      const fixed = await remuxForWhatsApp(filePath, {
        title: finalTitle,
        artist,
        album: artist || "Nyxius",
        cover,
      });
      buffer = fixed.buffer;
      mimetype = fixed.mimetype;
    } catch (err) {
      console.warn("⚠️  mp3 encode failed, sending raw:", err.message);
      buffer = await fs.readFile(filePath);
      mimetype = mimetypeFrom(match);
      cover = null;
    }
    return audioResult({
      buffer,
      mimetype,
      title: finalTitle,
      artist,
      duration,
      url: webpageUrl || target,
      cover,
    });
  } finally {
    await releaseCookies(common);
    if (filePath) await fs.unlink(filePath).catch(() => {});
  }
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
  const hasCookies = Boolean(await ensureCookieText());
  const permanent = (err) => /too_long|too_large|not_found/.test(err?.message || "");

  try {
    let lastErr;
    try {
      // Quest and embedded players. The phone and mobile-web clients are the
      // ones Render's IP gets challenged on, and saved cookies make that worse.
      const audio = await downloadViaYtDlp(url, fallback, {
        clients: ANON_CLIENTS,
        useCookies: false,
      });
      console.log("🎧 yt-dlp audio (android_vr)");
      return audio;
    } catch (err) {
      if (permanent(err)) throw err;
      lastErr = err;
      console.warn("⚠️  yt-dlp android_vr failed:", ytStderr(err) || err.message);
    }

    try {
      const audio = await downloadViaYtDlp(url, fallback, {
        clients: EMBED_CLIENTS,
        useCookies: false,
      });
      console.log("🎧 yt-dlp audio (web_embedded)");
      return audio;
    } catch (err) {
      if (permanent(err)) throw err;
      console.warn("⚠️  yt-dlp web_embedded failed:", ytStderr(err) || err.message);
      if (isYoutubeBotBlock(err)) lastErr = err;
    }

    if (hasCookies) {
      try {
        const audio = await downloadViaYtDlp(url, fallback, {
          clients: COOKIE_CLIENTS,
          useCookies: true,
        });
        console.log("🎧 yt-dlp audio (cookies)");
        return audio;
      } catch (err) {
        if (permanent(err)) throw err;
        console.warn("⚠️  yt-dlp cookies failed:", ytStderr(err) || err.message);
        if (isYoutubeBotBlock(err)) lastErr = err;
      }
    }

    if (!videoId) throw lastErr || new Error("download_failed");
    console.warn("⚠️  yt-dlp failed; trying YouTube player fallback");
    try {
      const audio = await downloadViaInnertube(videoId, fallback);
      console.log("🎧 innertube player audio fallback");
      return audio;
    } catch (fallbackErr) {
      console.warn("⚠️  YouTube player fallback failed:", fallbackErr.message);
      if (isYoutubeBotBlock(lastErr)) throw lastErr;
      throw fallbackErr;
    }
  } catch (err) {
    if (permanent(err)) throw err;
    if (isYoutubeBotBlock(err) || /^innertube_40[03]$/.test(err?.message || "") || err?.message === "player_blocked") {
      console.warn(
        hasCookies
          ? "⚠️ YouTube rejected this server and the saved cookies."
          : "⚠️ YouTube blocked this server; configure YT_COOKIES or YT_COOKIES_FILE.",
      );
      throw new Error(hasCookies ? "youtube_cookies_rejected" : "youtube_blocked");
    }
    throw err?.message ? err : new Error("download_failed");
  }
}
