import {
  getSettings,
  incrementWarn,
  resetWarn,
  addLog,
} from "../services/moderationService.js";
import { extractNumber, findParticipant } from "../utils/jid.js";
import { sendQuoted } from "../utils/feedback.js";

const LINK_RE =
  /https?:\/\/\S+|www\.\S+|chat\.whatsapp\.com\/\S+|wa\.me\/\S+/i;

const buckets = new Map();

function isSpam(jid, userNumber, text) {
  const key = `${jid}:${userNumber}`;
  const now = Date.now();
  const bucket = buckets.get(key) || { times: [], lastText: "", repeat: 0 };
  bucket.times = bucket.times.filter((t) => now - t < 8_000);
  bucket.times.push(now);

  const normalized = (text || "").trim().toLowerCase();
  if (normalized && normalized === bucket.lastText) bucket.repeat += 1;
  else {
    bucket.repeat = normalized ? 1 : 0;
    bucket.lastText = normalized;
  }

  buckets.set(key, bucket);
  if (bucket.times.length >= 6) return "flood";
  if (bucket.repeat >= 3) return "repeat";
  return null;
}

async function maybeAutoKick(sock, ctx, targetJid, userNumber, reason) {
  const { jid, participants, isBotAdmin, senderId, t } = ctx;
  const result = await incrementWarn(jid, userNumber, reason);
  await addLog({
    groupJid: jid,
    action: "warn",
    actor: "bot",
    target: targetJid,
    reason,
  });

  if (result.shouldKick && isBotAdmin) {
    const participant = findParticipant(participants, targetJid);
    const kickJid = participant?.id || targetJid;
    try {
      await sock.groupParticipantsUpdate(jid, [kickJid], "remove");
      await resetWarn(jid, userNumber);
      await addLog({
        groupJid: jid,
        action: "kick",
        actor: "bot",
        target: kickJid,
        reason: `auto-kick após ${result.limit} advertências`,
      });
      await sendQuoted(
        sock,
        jid,
        {
          text: t("automod_kicked", { user: userNumber, limit: result.limit }),
          mentions: [senderId],
        },
        ctx.message,
        "automod-kick",
        12_000,
      );
    } catch (err) {
      console.error("auto-kick error:", err);
    }
    return;
  }

  await sendQuoted(
    sock,
    jid,
    {
      text: t("automod_warned", {
        user: userNumber,
        count: result.count,
        limit: result.limit,
        reason,
      }),
      mentions: [senderId],
    },
    ctx.message,
    "automod-warn",
    12_000,
  );
}

export async function runAutoMod(sock, ctx) {
  const { jid, message, text, senderId, isAdmin, isOwner, isBotAdmin, t, settings: ctxSettings } = ctx;
  if (isAdmin || isOwner) return false;
  if (!isBotAdmin) return false;

  const settings = ctxSettings || (await getSettings(jid));
  const userNumber = extractNumber(senderId);

  if (settings.antilink && LINK_RE.test(text || "")) {
    try {
      await sock.sendMessage(jid, { delete: message.key });
    } catch (err) {
      console.error("delete link error:", err);
    }
    await addLog({
      groupJid: jid,
      action: "antilink",
      actor: "bot",
      target: senderId,
      reason: text.slice(0, 180),
    });
    console.log(`🔗 antilink deleted from ${userNumber}`);
    await sendQuoted(
      sock,
      jid,
      {
        text: t("antilink_msg", { user: userNumber }),
        mentions: [senderId],
      },
      message,
      "antilink",
      12_000,
    );
    return true;
  }

  if (settings.antispam) {
    const kind = isSpam(jid, userNumber, text);
    if (kind) {
      try {
        await sock.sendMessage(jid, { delete: message.key });
      } catch (err) {
        console.error("delete spam error:", err);
      }
      const reason = kind === "flood" ? t("spam_flood") : t("spam_repeat");
      await maybeAutoKick(sock, ctx, senderId, userNumber, reason);
      return true;
    }
  }

  return false;
}
