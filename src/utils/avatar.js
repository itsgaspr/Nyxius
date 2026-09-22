import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { prepareWhatsAppImage, withTempJpeg } from "./waImage.js";
import { sendQuoted } from "./feedback.js";

const AVATAR_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../assets/nyxius.png",
);

let cached = null;

export async function getAvatarImage() {
  if (cached) return cached;
  const raw = await fs.readFile(AVATAR_PATH);
  cached = await prepareWhatsAppImage(raw);
  return cached;
}

export async function sendBranded(sock, jid, text, message, label) {
  const { jpeg, width, height } = await getAvatarImage();
  return withTempJpeg(jpeg, (filePath) =>
    sendQuoted(
      sock,
      jid,
      {
        image: { url: filePath },
        mimetype: "image/jpeg",
        caption: text,
        width,
        height,
      },
      message,
      label,
    ),
  );
}
