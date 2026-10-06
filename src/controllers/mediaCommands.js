import { searchPinterestPin } from "../integrations/pinterest.js";
import {
  FAIL_EMOJI,
  OK_EMOJI,
  sendQuoted,
  reactTo,
  mediaLooksSent,
} from "../utils/feedback.js";
import { prepareWhatsAppImage, withTempJpeg } from "../utils/waImage.js";

const pinBusy = new Set();
const pinLast = new Map();
const PIN_COOLDOWN = 8_000;

function secondsLeft(map, jid, cooldown) {
  const last = map.get(jid) || 0;
  const wait = cooldown - (Date.now() - last);
  return wait > 0 ? Math.ceil(wait / 1000) : 0;
}

async function failOut(sock, ctx, text, err) {
  const { jid, message } = ctx;
  if (err) console.error("❌ media error:", err);
  await reactTo(sock, message, FAIL_EMOJI);
  await sendQuoted(sock, jid, { text }, message, "media-error", 12_000).catch(() => {});
}

export async function handlePinCommand(sock, ctx) {
  const { jid, message, argText, t } = ctx;
  const query = (argText || "").trim();
  if (!query) {
    return sendQuoted(sock, jid, { text: t("pin_usage") }, message, "pin-usage", 12_000);
  }

  const wait = secondsLeft(pinLast, jid, PIN_COOLDOWN);
  if (wait > 0) {
    console.log(`📌 pin cooldown ${wait}s query="${query}"`);
    return sendQuoted(
      sock,
      jid,
      { text: t("pin_wait", { secs: wait }) },
      message,
      "pin-wait",
      12_000,
    );
  }

  if (pinBusy.has(jid)) {
    console.log(`📌 pin busy query="${query}"`);
    return sendQuoted(sock, jid, { text: t("pin_busy") }, message, "pin-busy", 12_000);
  }

  pinBusy.add(jid);
  pinLast.set(jid, Date.now());
  console.log(`📌 pin start query="${query}"`);
  try {
    const pin = await searchPinterestPin(query);
    console.log(`📌 pin file ${pin.mimetype} ${pin.buffer.length}B ${pin.url}`);
    const { jpeg, width, height } = await prepareWhatsAppImage(pin.buffer);
    console.log(`📌 pin jpeg ${jpeg.length}B ${width}x${height}`);
    const sent = await withTempJpeg(jpeg, (filePath) =>
      sendQuoted(
        sock,
        jid,
        {
          image: { url: filePath },
          mimetype: "image/jpeg",
          caption: `📌 ${query}`,
          width,
          height,
        },
        message,
        "pin-image",
      ),
    );
    if (!mediaLooksSent(sent)) {
      console.warn("📌 image proto incomplete, sending as document");
      await sendQuoted(
        sock,
        jid,
        {
          document: jpeg,
          mimetype: "image/jpeg",
          fileName: "pin.jpg",
          caption: `📌 ${query}`,
        },
        message,
        "pin-document",
      );
    }
    await reactTo(sock, message, OK_EMOJI);
  } catch (err) {
    const map = {
      nsfw: t("pin_nsfw"),
      empty: t("pin_usage"),
      not_found: t("pin_not_found"),
    };
    await failOut(sock, ctx, map[err.message] || t("pin_fail"), err);
  } finally {
    pinBusy.delete(jid);
    console.log(`📌 pin done query="${query}"`);
  }
}
