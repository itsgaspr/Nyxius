import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import axios from "axios";
import sharp from "sharp";
import { isAllowedReactionApi } from "../data/reactions.js";

const API = "https://nekos.best/api/v2";
const STICKER_BYTES = 900_000;

const http = axios.create({
  timeout: 15_000,
  headers: { "User-Agent": "Nyxius/0.1", Accept: "application/json" },
  maxContentLength: 8_000_000,
  maxBodyLength: 8_000_000,
});

function isNekosUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "nekos.best";
  } catch {
    return false;
  }
}

async function sharpSticker(input, quality, pages) {
  return sharp(input, {
    animated: true,
    limitInputPixels: false,
    ...(pages ? { pages } : {}),
  })
    .rotate()
    .resize(512, 512, { fit: "cover", position: "centre" })
    .webp({ quality, effort: 4, loop: 0 })
    .toBuffer();
}

async function pageBudget(input) {
  try {
    const meta = await sharp(input, { animated: true, limitInputPixels: false }).metadata();
    const pages = meta.pages || 1;
    return Math.min(pages, 24);
  } catch {
    return undefined;
  }
}

function run(cmd, args, ms) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd}_timeout`));
    }, ms);
    child.stderr.on("data", (chunk) => {
      err = (err + chunk.toString()).slice(-500);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(err || `${cmd}_${code}`));
    });
  });
}

async function withTemp(input, ext, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nyxius-react-"));
  const source = path.join(dir, `in.${ext}`);
  await fs.writeFile(source, input);
  try {
    return await fn(dir, source);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function ffmpegSticker(input) {
  return withTemp(input, "gif", async (dir, source) => {
    const out = path.join(dir, "out.webp");
    await run(
      "ffmpeg",
      [
        "-y",
        "-i",
        source,
        "-t",
        "6",
        "-vf",
        "fps=12,scale=512:512:force_original_aspect_ratio=increase,crop=512:512,format=rgba",
        "-c:v",
        "libwebp",
        "-quality",
        "45",
        "-loop",
        "0",
        "-an",
        out,
      ],
      20_000,
    );
    return fs.readFile(out);
  });
}

async function ffmpegGif(input) {
  return withTemp(input, "gif", async (dir, source) => {
    const out = path.join(dir, `${randomUUID()}.mp4`);
    await run(
      "ffmpeg",
      [
        "-y",
        "-i",
        source,
        "-t",
        "6",
        "-movflags",
        "faststart",
        "-pix_fmt",
        "yuv420p",
        "-vf",
        "scale=512:512:force_original_aspect_ratio=increase,crop=512:512",
        "-an",
        out,
      ],
      20_000,
    );
    return fs.readFile(out);
  });
}

async function toMedia(input) {
  try {
    const pages = await pageBudget(input);
    let webp = await sharpSticker(input, 50, pages);
    if (webp.length > STICKER_BYTES) webp = await sharpSticker(input, 30, pages);
    if (webp.length > 0 && webp.length <= STICKER_BYTES) {
      return { kind: "sticker", data: webp };
    }
  } catch (err) {
    console.error("reaction sharp:", err.message);
  }

  try {
    const webp = await ffmpegSticker(input);
    if (webp.length > 0 && webp.length <= STICKER_BYTES) {
      return { kind: "sticker", data: webp };
    }
  } catch (err) {
    console.error("reaction ffmpeg webp:", err.message);
  }

  try {
    const mp4 = await ffmpegGif(input);
    if (mp4.length > 0) return { kind: "gif", data: mp4 };
  } catch (err) {
    console.error("reaction ffmpeg gif:", err.message);
  }

  const still = await sharp(input, { animated: true, pages: 1 })
    .resize(512, 512, { fit: "cover", position: "centre" })
    .webp({ quality: 60 })
    .toBuffer();
  return { kind: "sticker", data: still };
}

export async function fetchReactionMedia(apiName) {
  if (!isAllowedReactionApi(apiName)) throw new Error("reaction_blocked");

  const { data } = await http.get(`${API}/${encodeURIComponent(apiName)}`);
  const url = data?.results?.[0]?.url;
  if (!isNekosUrl(url)) throw new Error("reaction_url");

  const file = await http.get(url, { responseType: "arraybuffer" });
  const input = Buffer.from(file.data);
  if (!input.length) throw new Error("reaction_empty");
  return toMedia(input);
}
