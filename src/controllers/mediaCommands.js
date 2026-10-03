import {
  downloadYoutubeAudio,
  isYoutubeUrl,
  searchYoutubeTracks,
} from "../integrations/youtube.js";
import { searchPinterestPin } from "../integrations/pinterest.js";
import {
  FAIL_EMOJI,
  OK_EMOJI,
  sendQuoted,
  reactTo,
  mediaLooksSent,
  withTyping,
} from "../utils/feedback.js";
import { prepareWhatsAppImage, withTempJpeg } from "../utils/waImage.js";
import { isReplyToBot } from "../utils/message.js";

const playBusy = new Set();
const pinBusy = new Set();
const playLast = new Map();
const pinLast = new Map();
const playPicks = new Map();
const PLAY_COOLDOWN = 20_000;
const PIN_COOLDOWN = 8_000;
const PLAY_PICK_TTL = 3 * 60_000;

function secondsLeft(map, jid, cooldown) {
  const last = map.get(jid) || 0;
  const wait = cooldown - (Date.now() - last);
  return wait > 0 ? Math.ceil(wait / 1000) : 0;
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function playErrorText(t, err) {
  const map = {
    yt_dlp_missing: t("play_yt_missing"),
    "yt-dlp_missing": t("play_yt_missing"),
    not_found: t("play_not_found"),
    too_long: t("play_too_long"),
    too_large: t("play_too_large"),
    download_failed: t("play_download_failed"),
  };
  return map[err?.message] || t("play_fail");
}

async function failOut(sock, ctx, text, err) {
  const { jid, message } = ctx;
  if (err) console.error("❌ media error:", err);
  await reactTo(sock, message, FAIL_EMOJI);
  await sendQuoted(sock, jid, { text }, message, "media-error", 12_000).catch(() => {});
}

function playFileName(label, ext) {
  const base = String(label || "audio")
    .replace(/[\/\\?%*:|"<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || "audio"}.${ext}`;
}

async function sendPlayAudio(sock, ctx, query, known = null) {
  const { jid, message } = ctx;
  const audio = await downloadYoutubeAudio(query, known);
  const artist = String(audio.artist || "").trim();
  const title = String(audio.title || "audio").trim();
  const label = artist ? `${artist} — ${title}` : title;
  console.log(`🎧 play downloaded "${label}" ${audio.mimetype} ${audio.buffer.length}B`);

  // WhatsApp native player (in-chat). Download name will still be AUD-... — that
  // rename is forced by WhatsApp for audioMessage; only documents keep a custom name.
  // MP3 + ID3 tags keep artist/title inside the file for music apps.
  await sendQuoted(
    sock,
    jid,
    {
      audio: audio.buffer,
      mimetype: "audio/mpeg",
      ptt: false,
      seconds: Number(audio.duration) || undefined,
      fileName: playFileName(label, "mp3"),
    },
    message,
    "play-audio",
  );
  await reactTo(sock, message, OK_EMOJI);
}

export async function handlePlayCommand(sock, ctx) {
  const { jid, message, argText, t } = ctx;
  const query = (argText || "").trim();
  if (!query) {
    return sendQuoted(sock, jid, { text: t("play_usage") }, message, "play-usage", 12_000);
  }

  const wait = secondsLeft(playLast, jid, PLAY_COOLDOWN);
  if (wait > 0) {
    console.log(`🎧 play cooldown ${wait}s query="${query}"`);
    return sendQuoted(
      sock,
      jid,
      { text: t("play_wait", { secs: wait }) },
      message,
      "play-wait",
      12_000,
    );
  }

  if (playBusy.has(jid)) {
    console.log(`🎧 play busy query="${query}"`);
    return sendQuoted(sock, jid, { text: t("play_busy") }, message, "play-busy", 12_000);
  }

  playBusy.add(jid);
  playLast.set(jid, Date.now());
  console.log(`🎧 play start query="${query}"`);
  try {
    if (isYoutubeUrl(query)) {
      await sendPlayAudio(sock, ctx, query);
      return;
    }

    const tracks = await searchYoutubeTracks(query, 5);
    const list = tracks
      .map((track, i) =>
        t("play_pick_item", {
          n: String(i + 1),
          artist: track.artist,
          title: track.title,
          duration: formatDuration(track.duration),
        }),
      )
      .join("\n");
    const sent = await sendQuoted(
      sock,
      jid,
      { text: t("play_results", { query, list }) },
      message,
      "play-results",
      20_000,
    );
    playPicks.set(jid, {
      listMsgId: sent?.key?.id || "",
      picks: tracks,
      expiresAt: Date.now() + PLAY_PICK_TTL,
    });
    await reactTo(sock, message, OK_EMOJI);
    console.log(`🎧 play list id=${sent?.key?.id} n=${tracks.length}`);
  } catch (err) {
    await failOut(sock, ctx, playErrorText(t, err), err);
  } finally {
    playBusy.delete(jid);
    console.log(`🎧 play done query="${query}"`);
  }
}

export async function handlePlayPick(sock, ctx) {
  const { jid, message, text, t } = ctx;
  const pending = playPicks.get(jid);
  if (!pending) return false;

  const choice = (text || "").trim();
  if (!/^[1-5]$/.test(choice)) return false;
  if (!isReplyToBot(message, sock)) return false;

  if (Date.now() > pending.expiresAt) {
    playPicks.delete(jid);
    await failOut(sock, ctx, t("play_pick_expired"), null);
    return true;
  }

  const track = pending.picks[Number(choice) - 1];
  if (!track) {
    await failOut(sock, ctx, t("play_pick_invalid"), null);
    return true;
  }

  if (playBusy.has(jid)) {
    await sendQuoted(sock, jid, { text: t("play_busy") }, message, "play-busy", 12_000);
    return true;
  }

  playPicks.delete(jid);
  playBusy.add(jid);
  console.log(`🎧 play pick ${choice} "${track.artist} — ${track.title}"`);
  try {
    await withTyping(sock, jid, () => sendPlayAudio(sock, ctx, track.url, track));
  } catch (err) {
    await failOut(sock, ctx, playErrorText(t, err), err);
  } finally {
    playBusy.delete(jid);
  }
  return true;
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
