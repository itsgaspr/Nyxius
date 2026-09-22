import {
  getSettings,
  updateSettings,
  incrementWarn,
  decrementWarn,
  resetWarn,
  listWarns,
  addLog,
  getLogs,
} from "../services/moderationService.js";
import { extractNumber, findParticipant, sameUser } from "../utils/jid.js";
import { normalizeLang, makeT } from "../i18n/index.js";
import { sendQuoted } from "../utils/feedback.js";
import { getQuotedKey } from "../utils/message.js";

function say(sock, ctx, content) {
  return sendQuoted(sock, ctx.jid, content, ctx.message, "admin", 20_000);
}

function parseToggle(argText) {
  const rest = (argText || "").trim().toLowerCase();
  if (["on", "liga", "ligar", "ativar", "true", "1", "enable"].includes(rest)) return true;
  if (["off", "desliga", "desligar", "desativar", "false", "0", "disable"].includes(rest))
    return false;
  return null;
}

export async function applyWarn(sock, ctx, { target, reason, actorId }) {
  const { jid, participants, isBotAdmin, botJid, t } = ctx;

  if (!target) {
    return say(sock, ctx, { text: t("mention_warn") });
  }

  if (sameUser(target, botJid)) {
    return say(sock, ctx, { text: t("cannot_self_warn") });
  }

  const targetParticipant = findParticipant(participants, target);
  if (!targetParticipant) {
    return say(sock, ctx, { text: t("user_not_found") });
  }

  const targetJid = targetParticipant.id;
  const userNumber = extractNumber(targetJid);
  const result = await incrementWarn(jid, userNumber, reason || null);
  await addLog({
    groupJid: jid,
    action: "warn",
    actor: actorId,
    target: targetJid,
    reason: reason || null,
  });

  if (result.shouldKick) {
    if (!isBotAdmin) {
      return say(sock, ctx, {
        text: t("warn_need_admin", {
          user: userNumber,
          count: result.count,
          limit: result.limit,
        }),
        mentions: [targetJid],
      });
    }
    try {
      await sock.groupParticipantsUpdate(jid, [targetJid], "remove");
      await resetWarn(jid, userNumber);
      await addLog({
        groupJid: jid,
        action: "kick",
        actor: actorId,
        target: targetJid,
        reason: `auto-kick após ${result.limit} advertências`,
      });
      return say(sock, ctx, {
        text: t("warn_kicked", {
          user: userNumber,
          limit: result.limit,
          reason: reason ? t("reason_line", { reason }) : "",
        }),
        mentions: [targetJid],
      });
    } catch (err) {
      console.error("warn auto-kick error:", err);
      return say(sock, ctx, { text: t("warn_kick_failed") });
    }
  }

  return say(sock, ctx, {
    text: t("warned", {
      user: userNumber,
      count: result.count,
      limit: result.limit,
      reason: reason ? t("reason_line", { reason }) : "",
    }),
    mentions: [targetJid],
  });
}

export async function handleWarnCommand(sock, ctx) {
  const reason = (ctx.argText || "")
    .split(/\s+/)
    .filter((token) => !token.startsWith("@"))
    .join(" ")
    .trim();
  return applyWarn(sock, ctx, {
    target: ctx.target,
    reason,
    actorId: ctx.senderId,
  });
}

export async function handleUnwarnCommand(sock, ctx) {
  const { target, participants, t } = ctx;
  if (!target) {
    return say(sock, ctx, { text: t("mention_unwarn") });
  }
  const participant = findParticipant(participants, target);
  if (!participant) {
    return say(sock, ctx, { text: t("user_not_found") });
  }
  const userNumber = extractNumber(participant.id);
  const { count } = await decrementWarn(ctx.jid, userNumber);
  await addLog({
    groupJid: ctx.jid,
    action: "unwarn",
    actor: ctx.senderId,
    target: participant.id,
  });
  return say(sock, ctx, {
    text: t("unwarn_done", { user: userNumber, count }),
    mentions: [participant.id],
  });
}

export async function handleWarnsCommand(sock, ctx) {
  const { jid, t } = ctx;
  const rows = await listWarns(jid);
  if (!rows.length) {
    return say(sock, ctx, { text: t("no_warns") });
  }
  const settings = await getSettings(jid);
  const lines = rows.map(
    (row) =>
      `• @${row.user_number} — ${row.count}/${settings.warnLimit}${row.last_reason ? ` (${row.last_reason})` : ""}`,
  );
  const mentions = rows
    .map((row) => {
      const p = findParticipant(ctx.participants, row.user_number);
      return p?.id;
    })
    .filter(Boolean);

  return say(sock, ctx, {
    text: `${t("warns_title")}\n\n${lines.join("\n")}`,
    mentions,
  });
}

async function handleFlagToggle(sock, ctx, flag, label) {
  const { jid, argText, t } = ctx;
  const parsed = parseToggle(argText);
  if (parsed === null) {
    const settings = await getSettings(jid);
    const state = settings[flag] ? t("on") : t("off");
    return say(sock, ctx, { text: t("toggle_status", { label, state, flag }) });
  }
  await updateSettings(jid, { [flag]: parsed });
  return say(sock, ctx, { text: t("toggle_set", { label, state: parsed ? t("on") : t("off") }) });
}

export function handleAntilinkCommand(sock, ctx) {
  return handleFlagToggle(sock, ctx, "antilink", "🔗 Antilink");
}

export function handleAntispamCommand(sock, ctx) {
  return handleFlagToggle(sock, ctx, "antispam", "🛡️ Antispam");
}

export function handleAntimediaCommand(sock, ctx) {
  return handleFlagToggle(sock, ctx, "antimedia", "👁️ Antimedia");
}

export async function handleDelCommand(sock, ctx) {
  const { jid, message, senderId, isAdmin, isOwner, isBotAdmin, t } = ctx;
  if (!isBotAdmin) {
    return say(sock, ctx, { text: t("need_admin") });
  }

  const quotedKey = getQuotedKey(message, sock);
  if (!quotedKey) {
    return say(sock, ctx, { text: t("del_usage") });
  }

  const ownMessage = sameUser(quotedKey.participant, senderId);
  if ((!ownMessage || quotedKey.fromMe) && !isAdmin && !isOwner) {
    return say(sock, ctx, { text: t("del_only_admin") });
  }

  try {
    await sock.sendMessage(jid, { delete: quotedKey });
    await sock.sendMessage(jid, { delete: message.key }).catch(() => {});
    console.log(`🗑️  del ${quotedKey.id} by ${senderId}`);
  } catch (err) {
    console.error("del error:", err.message);
    return say(sock, ctx, { text: t("del_fail") });
  }
}

export async function handleWelcomeCommand(sock, ctx) {
  const { jid, argText, t } = ctx;
  const parsed = parseToggle(argText);
  if (parsed === null) {
    const settings = await getSettings(jid);
    const state = settings.welcomeEnabled ? t("on") : t("off");
    return say(sock, ctx, { text: t("welcome_status", { state }) });
  }
  await updateSettings(jid, { welcomeEnabled: parsed });
  return say(sock, ctx, { text: t("welcome_set", { state: parsed ? t("on") : t("off") }) });
}

export async function handleSetWelcomeCommand(sock, ctx) {
  const { jid, argText, t } = ctx;
  if (!argText?.trim()) {
    return say(sock, ctx, { text: t("setwelcome_usage") });
  }
  await updateSettings(jid, {
    welcomeText: argText.trim(),
    welcomeEnabled: true,
  });
  return say(sock, ctx, { text: t("setwelcome_ok") });
}

export async function handleLogsCommand(sock, ctx) {
  const { jid, t } = ctx;
  const rows = await getLogs(jid, 10);
  if (!rows.length) {
    return say(sock, ctx, { text: t("no_logs") });
  }
  const lines = rows.map((row) => {
    const when = new Date(row.created_at).toLocaleString(t("locale"));
    const who = row.target ? extractNumber(row.target) : "-";
    return `• ${when} — *${row.action}* ${who}${row.reason ? ` (${row.reason})` : ""}`;
  });
  return say(sock, ctx, { text: `${t("logs_title")}\n\n${lines.join("\n")}` });
}

export async function handleLangCommand(sock, ctx) {
  const { jid, t, lang } = ctx;
  const next = normalizeLang(ctx.argText);
  if (!next) {
    return say(sock, ctx, { text: `${t("lang_usage")}\n${t("lang_set", { lang })}` });
  }
  await updateSettings(jid, { lang: next });
  const tNext = makeT(next);
  return say(sock, ctx, { text: tNext("lang_set", { lang: next }) });
}
