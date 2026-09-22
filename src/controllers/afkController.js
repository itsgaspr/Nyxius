import { clearAfk, getAfk, listAfkHits, setAfk } from "../services/afkService.js";
import { extractNumber, sameUser } from "../utils/jid.js";
import { sendQuoted } from "../utils/feedback.js";
import { resolveCommand } from "../i18n/index.js";

const OFF = new Set(["off", "sair", "voltar", "back", "stop", "out"]);

export async function handleAfkCommand(sock, ctx) {
  const { jid, message, senderId, argText, t } = ctx;
  const reason = (argText || "").trim();

  if (OFF.has(reason.toLowerCase())) {
    const prev = await clearAfk(jid, senderId);
    if (!prev) {
      return sendQuoted(sock, jid, { text: t("afk_none") }, message, "afk", 12_000);
    }
    return sendQuoted(
      sock,
      jid,
      {
        text: t("afk_back", { user: extractNumber(senderId), reason: prev.reason }),
        mentions: [senderId],
      },
      message,
      "afk",
      12_000,
    );
  }

  if (!reason) {
    return sendQuoted(sock, jid, { text: t("afk_usage") }, message, "afk", 12_000);
  }

  await setAfk(jid, senderId, reason);
  return sendQuoted(
    sock,
    jid,
    {
      text: t("afk_set", { user: extractNumber(senderId), reason }),
      mentions: [senderId],
    },
    message,
    "afk",
    12_000,
  );
}

export async function maybeClearAfk(sock, ctx) {
  const { jid, senderId, message, t, cmd } = ctx;
  if (resolveCommand(cmd) === "afk") return false;
  const prev = getAfk(jid, senderId);
  if (!prev) return false;
  await clearAfk(jid, senderId);
  await sendQuoted(
    sock,
    jid,
    {
      text: t("afk_back", { user: extractNumber(senderId), reason: prev.reason }),
      mentions: [senderId],
    },
    message,
    "afk-back",
    12_000,
  ).catch(() => {});
  return false;
}

export async function enforceAfkMentions(sock, ctx) {
  const { jid, message, senderId, mentioned, quoted, t, isBotAdmin } = ctx;
  const targets = [...(mentioned || [])];
  if (quoted) targets.push(quoted);
  const hits = listAfkHits(jid, targets).filter((hit) => !sameUser(hit.jid, senderId));
  if (!hits.length) return false;
  if (isBotAdmin) {
    await sock.sendMessage(jid, { delete: message.key }).catch((err) => {
      console.error("afk delete error:", err.message);
    });
  }
  const lines = hits.map((hit) => t("afk_blocked_line", { user: hit.user, reason: hit.reason }));
  await sendQuoted(
    sock,
    jid,
    {
      text: `${t("afk_blocked")}\n${lines.join("\n")}`,
      mentions: hits.map((hit) => hit.jid),
    },
    message,
    "afk-block",
    12_000,
  ).catch(() => {});
  console.log(`💤 afk mention blocked from ${extractNumber(senderId)} → ${hits.map((h) => h.user).join(",")}`);
  return true;
}
