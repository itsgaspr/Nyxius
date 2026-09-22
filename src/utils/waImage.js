import fs from "fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import sharp from "sharp";

export async function prepareWhatsAppImage(input) {
  const jpeg = await sharp(input)
    .rotate()
    .resize(1280, 1280, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85, progressive: false, chromaSubsampling: "4:2:0" })
    .toBuffer();
  const meta = await sharp(jpeg).metadata();
  return {
    jpeg,
    width: meta.width || 720,
    height: meta.height || 720,
  };
}

export async function withTempJpeg(jpeg, fn) {
  const filePath = path.join(os.tmpdir(), `nyxius-pin-${randomUUID()}.jpg`);
  await fs.writeFile(filePath, jpeg);
  try {
    return await fn(filePath);
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
}
