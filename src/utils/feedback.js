import { rememberMessage } from "./msgStore.js";
import { waitWaReady } from "./waReady.js";

const SEARCH_EMOJI = "🔎";
const OK_EMOJI = "✅";
const FAIL_EMOJI = "❌";

export { SEARCH_EMOJI, OK_EMOJI, FAIL_EMOJI };

export async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function reactTo(sock, message, emoji) {
  const ready = await waitWaReady(12_000);
  if (!ready) console.warn("⚠️  react: sending before socket ready");
  const jid = message.key.remoteJid;
  try {
    await withTimeout(
      sock.sendMessage(jid, { react: { text: emoji, key: message.key } }),
      8_000,
      "react",
    );
    console.log(`🙂 react ${emoji || "(clear)"} → ${jid}`);
    return true;
  } catch (err) {
    console.error(`⚠️  react ${emoji} failed:`, err.message);
    return false;
  }
}

export function startSearchReact(sock, message) {
  return reactTo(sock, message, SEARCH_EMOJI);
}

export async function sendQuoted(sock, jid, content, message, label, ms = 45_000) {
  const ready = await waitWaReady(12_000);
  if (!ready) console.warn(`⚠️  ${label}: sending before socket ready`);
  console.log(`📤 ${label}…`);
  try {
    const options = message ? { quoted: message } : {};
    const sent = await withTimeout(sock.sendMessage(jid, content, options), ms, label);
    if (sent?.key?.id && sent.message) rememberMessage(sent.key.id, sent.message);
    const media =
      sent?.message?.imageMessage ||
      sent?.message?.documentMessage ||
      sent?.message?.audioMessage;
    const text = sent?.message?.conversation || sent?.message?.extendedTextMessage?.text;
    console.log(
      `✅ ${label} sent id=${sent?.key?.id || "?"}`,
      media
        ? {
            mime: media.mimetype,
            len: String(media.fileLength || ""),
            w: media.width,
            h: media.height,
            path: media.directPath ? "yes" : "no",
            url: media.url ? "yes" : "no",
            key: media.mediaKey ? "yes" : "no",
          }
        : { keys: sent?.message ? Object.keys(sent.message) : [], chars: text?.length || 0 },
    );
    return sent;
  } catch (err) {
    console.error(`❌ ${label} failed:`, err.message);
    throw err;
  }
}

export function reply(sock, ctx, content, label = "reply", ms = 20_000) {
  return sendQuoted(sock, ctx.jid, content, ctx.message, label, ms);
}

export function mediaLooksSent(sent) {
  const media =
    sent?.message?.imageMessage ||
    sent?.message?.documentMessage ||
    sent?.message?.audioMessage;
  return Boolean(media?.directPath && media?.mediaKey);
}
