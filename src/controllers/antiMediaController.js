import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { unwrapMessageContent } from "../utils/message.js";
import { extractNumber } from "../utils/jid.js";
import { sendQuoted, withTimeout } from "../utils/feedback.js";

function detectMedia(message) {
  const inner = unwrapMessageContent(message);
  if (!inner || inner.stickerMessage) return null;

  if (inner.imageMessage) {
    return { kind: "image", mimetype: inner.imageMessage.mimetype };
  }
  if (inner.videoMessage) {
    return { kind: "video" };
  }
  if (inner.audioMessage) {
    return { kind: "audio" };
  }
  if (inner.documentMessage) {
    const mime = inner.documentMessage.mimetype || "";
    if (mime.startsWith("image/")) return { kind: "image", mimetype: mime };
    if (mime.startsWith("video/")) return { kind: "video" };
    if (mime.startsWith("audio/")) return { kind: "audio" };
    return { kind: "document" };
  }
  return null;
}

export async function enforceAntiMedia(sock, ctx) {
  const { jid, message, senderId, isBotAdmin, t, settings } = ctx;
  if (!settings?.antimedia) return false;
  if (!isBotAdmin) return false;

  const media = detectMedia(message);
  if (!media) return false;

  if (media.kind !== "image") {
    try {
      await sock.sendMessage(jid, { delete: message.key });
      console.log(`👁️  antimedia deleted ${media.kind}`);
    } catch (err) {
      console.error("antimedia delete failed:", err.message);
    }
    return true;
  }

  let buffer;
  try {
    buffer = await withTimeout(downloadMediaMessage(message, "buffer", {}), 30_000, "antimedia-dl");
  } catch (err) {
    console.error("antimedia download failed:", err.message);
    return false;
  }
  if (!buffer?.length) return false;

  try {
    await sock.sendMessage(jid, { delete: message.key });
  } catch (err) {
    console.error("antimedia delete failed:", err.message);
    return false;
  }

  const user = extractNumber(senderId);
  try {
    await sendQuoted(
      sock,
      jid,
      {
        image: buffer,
        caption: `sent by @${user}`,
        mentions: [senderId],
        viewOnce: true,
      },
      null,
      "antimedia",
      30_000,
    );
    console.log(`👁️  antimedia view-once image from ${user}`);
  } catch (err) {
    console.error("antimedia resend failed:", err.message);
    await sendQuoted(sock, jid, { text: t("antimedia_fail") }, message, "antimedia-fail", 12_000).catch(
      () => {},
    );
  }
  return true;
}
