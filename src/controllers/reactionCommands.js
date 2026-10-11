import { reactionById } from "../data/reactions.js";
import { fetchReactionMedia } from "../integrations/reactions.js";
import { extractNumber, sameUser } from "../utils/jid.js";
import { sendQuoted } from "../utils/feedback.js";

const COOLDOWN = 4_000;
const lastAt = new Map();
const busy = new Set();

function secondsLeft(key) {
  const last = lastAt.get(key) || 0;
  const wait = COOLDOWN - (Date.now() - last);
  return wait > 0 ? Math.ceil(wait / 1000) : 0;
}

function mentionIds(senderId, target) {
  const ids = [];
  if (senderId) ids.push(senderId);
  if (target && !ids.some((id) => sameUser(id, target))) ids.push(target);
  return ids;
}

export async function handleReactionCommand(sock, ctx, id) {
  const reaction = reactionById(id);
  if (!reaction) return;

  const { jid, message, senderId, target, t } = ctx;
  const key = `${jid}:${extractNumber(senderId) || senderId}`;

  if (busy.has(key)) {
    return sendQuoted(sock, jid, { text: t("react_busy") }, message, "react-busy", 12_000);
  }

  const wait = secondsLeft(key);
  if (wait > 0) {
    return sendQuoted(
      sock,
      jid,
      { text: t("react_wait", { secs: wait }) },
      message,
      "react-wait",
      12_000,
    );
  }

  busy.add(key);
  lastAt.set(key, Date.now());
  try {
    const media = await fetchReactionMedia(reaction.api);
    if (target) {
      await sendQuoted(
        sock,
        jid,
        {
          text: t(reaction.line, {
            actor: extractNumber(senderId),
            target: extractNumber(target),
          }),
          mentions: mentionIds(senderId, target),
        },
        message,
        "react-line",
        20_000,
      );
    }

    if (media.kind === "gif") {
      await sendQuoted(
        sock,
        jid,
        { video: media.data, gifPlayback: true, mimetype: "video/mp4" },
        message,
        "react-gif",
        45_000,
      );
      return;
    }

    await sendQuoted(sock, jid, { sticker: media.data }, message, "react-sticker", 45_000);
  } catch (err) {
    console.error("reaction error:", err.message);
    await sendQuoted(sock, jid, { text: t("react_fail") }, message, "react-fail", 12_000);
  } finally {
    busy.delete(key);
  }
}
