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
import { getContextInfo, getQuotedKey } from "../utils/message.js";
import { normalizeTodLevel, labelTodLevel } from "../games/truthordare.js";

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

function normalizeTriviaMode(argText) {
  const raw = (argText || "").trim().toLowerCase();
  if (["fun", "funny", "divertido", "loco", "crazy"].includes(raw)) return "fun";
  if (["normal", "classic", "padrao", "padrão", "default", "std"].includes(raw)) return "normal";
  return null;
}

export async function handleSetmodeCommand(sock, ctx) {
  const { jid, t } = ctx;
  const settings = await getSettings(jid);
  const current = settings.triviaMode === "fun" ? "fun" : "normal";
  const next = normalizeTriviaMode(ctx.argText);
  if (!next) {
    return say(sock, ctx, {
      text: `${t("setmode_usage")}\n${t("setmode_set", { mode: current })}`,
    });
  }
  await updateSettings(jid, { triviaMode: next });
  return say(sock, ctx, { text: t("setmode_set", { mode: next }) });
}

export async function handleSettdCommand(sock, ctx) {
  const { jid, t, lang } = ctx;
  const settings = await getSettings(jid);
  const current =
    settings.todLevel === "medio" || settings.todLevel === "profundo"
      ? settings.todLevel
      : "leve";
  const next = normalizeTodLevel(ctx.argText);
  if (!next) {
    return say(sock, ctx, {
      text: `${t("settd_usage")}\n${t("settd_set", { level: labelTodLevel(current, lang) })}`,
    });
  }
  await updateSettings(jid, { todLevel: next });
  return say(sock, ctx, { text: t("settd_set", { level: labelTodLevel(next, lang) }) });
}

export async function handleGoodbyeCommand(sock, ctx) {
  const { jid, argText, t } = ctx;
  const parsed = parseToggle(argText);
  if (parsed === null) {
    const settings = await getSettings(jid);
    const state = settings.goodbyeEnabled ? t("on") : t("off");
    return say(sock, ctx, { text: t("goodbye_status", { state }) });
  }
  await updateSettings(jid, { goodbyeEnabled: parsed });
  return say(sock, ctx, { text: t("goodbye_set", { state: parsed ? t("on") : t("off") }) });
}

export async function handleSetGoodbyeCommand(sock, ctx) {
  const { jid, argText, t } = ctx;
  if (!argText?.trim()) {
    return say(sock, ctx, { text: t("setgoodbye_usage") });
  }
  await updateSettings(jid, {
    goodbyeText: argText.trim(),
    goodbyeEnabled: true,
  });
  return say(sock, ctx, { text: t("setgoodbye_ok") });
}

function memberIds(ctx) {
  const skip = [ctx.botJid, ctx.sock.user?.id, ctx.sock.user?.lid];
  return ctx.participants
    .map((participant) => participant.id)
    .filter((id) => id && !skip.some((candidate) => candidate && sameUser(id, candidate)));
}

export async function handleTodosCommand(sock, ctx) {
  const { jid, message, argText, t } = ctx;
  const ids = memberIds(ctx);
  if (!ids.length) {
    return say(sock, ctx, { text: t("todos_none") });
  }

  const headline = (argText || "").trim().slice(0, 400) || t("todos_default");
  const chunk = 40;
  try {
    for (let index = 0; index < ids.length; index += chunk) {
      const slice = ids.slice(index, index + chunk);
      const line = slice.map((id) => `@${extractNumber(id)}`).join(" ");
      const text = index === 0 ? `${headline}\n\n${line}` : line;
      await sendQuoted(
        sock,
        jid,
        { text, mentions: slice },
        index === 0 ? message : null,
        "todos",
        20_000,
      );
    }
  } catch (err) {
    console.error("todos error:", err.message);
    return say(sock, ctx, { text: t("todos_fail") });
  }
}

function inviteUrl(code) {
  const clean = typeof code === "string" ? code.trim() : "";
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(clean)) return null;
  return `https://chat.whatsapp.com/${clean}`;
}

async function readInvite(sock, jid) {
  const code = await sock.groupInviteCode(jid);
  return inviteUrl(code);
}

export async function handleLinkCommand(sock, ctx) {
  const { jid, isBotAdmin, isOwner, t } = ctx;
  if (!isBotAdmin && !isOwner) {
    return say(sock, ctx, { text: t("need_admin") });
  }
  try {
    const url = await readInvite(sock, jid);
    if (!url) return say(sock, ctx, { text: t("link_fail") });
    return say(sock, ctx, { text: t("link_ok", { url }) });
  } catch (err) {
    console.error("link error:", err.message);
    return say(sock, ctx, { text: t("link_fail") });
  }
}

export async function handleRevokeCommand(sock, ctx) {
  const { jid, isBotAdmin, isOwner, senderId, t } = ctx;
  if (!isBotAdmin && !isOwner) {
    return say(sock, ctx, { text: t("need_admin") });
  }
  try {
    const fresh = inviteUrl(await sock.groupRevokeInvite(jid)) || (await readInvite(sock, jid));
    if (!fresh) return say(sock, ctx, { text: t("revoke_fail") });
    await addLog({ groupJid: jid, action: "revoke", actor: senderId });
    return say(sock, ctx, { text: t("revoke_ok", { url: fresh }) });
  } catch (err) {
    console.error("revoke error:", err.message);
    return say(sock, ctx, { text: t("revoke_fail") });
  }
}

const RULES_MAX = 1500;

export async function handleRulesCommand(sock, ctx) {
  const { jid, t } = ctx;
  const settings = await getSettings(jid);
  const text = (settings.rulesText || "").trim();
  if (!text) return say(sock, ctx, { text: t("rules_empty") });
  return say(sock, ctx, { text: `${t("rules_title")}\n\n${text}` });
}

export async function handleSetRulesCommand(sock, ctx) {
  const { jid, argText, t } = ctx;
  const text = (argText || "").trim();
  if (!text) return say(sock, ctx, { text: t("setrules_usage") });
  if (text.length > RULES_MAX) return say(sock, ctx, { text: t("setrules_long") });
  await updateSettings(jid, { rulesText: text });
  return say(sock, ctx, { text: t("setrules_ok") });
}

function uniqueIds(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    const number = extractNumber(id);
    if (!id || !number || seen.has(number)) continue;
    seen.add(number);
    out.push(id);
  }
  return out;
}

export async function handleReportCommand(sock, ctx) {
  const { jid, message, senderId, participants, argText, t } = ctx;
  const quotedKey = getQuotedKey(message, sock);
  if (!quotedKey?.participant) {
    return say(sock, ctx, { text: t("report_usage") });
  }

  const reason = (argText || "")
    .split(/\s+/)
    .filter((token) => !token.startsWith("@"))
    .join(" ")
    .trim();
  const admins = participants.filter((participant) => participant.admin);
  const mentions = uniqueIds([
    senderId,
    quotedKey.participant,
    ...admins.map((participant) => participant.id),
  ]);
  const adminLine = admins
    .map((participant) => `@${extractNumber(participant.id)}`)
    .filter(Boolean)
    .join(" ");
  const text = [
    t("report_notice", {
      reporter: extractNumber(senderId),
      target: extractNumber(quotedKey.participant) || "?",
      reason: reason ? t("reason_line", { reason }) : "",
    }),
    adminLine,
  ]
    .filter(Boolean)
    .join("\n");

  const context = getContextInfo(message);
  const quoted = context.quotedMessage
    ? { key: quotedKey, message: context.quotedMessage }
    : message;

  try {
    await sendQuoted(sock, jid, { text, mentions }, quoted, "report", 20_000);
  } catch (err) {
    console.error("report quote error:", err.message);
    try {
      await sendQuoted(sock, jid, { text, mentions }, message, "report", 20_000);
    } catch (sendErr) {
      console.error("report error:", sendErr.message);
      return say(sock, ctx, { text: t("report_fail") });
    }
  }

  await addLog({
    groupJid: jid,
    action: "report",
    actor: senderId,
    target: quotedKey.participant,
    reason: reason || null,
  });
}
