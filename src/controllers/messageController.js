import { explainTopic } from "../integrations/groq.js";
import {
  extractNumber,
  sameUser,
  findParticipant,
  isPrivilegedSender,
  resolveBotParticipant,
} from "../utils/jid.js";
import {
  getMessageText,
  getMentionsAndQuote,
  parseCommand,
  PREFIX,
} from "../utils/message.js";
import { getGroupMeta } from "../utils/groupMeta.js";
import { runAutoMod } from "./autoModController.js";
import {
  handleWarnCommand,
  handleUnwarnCommand,
  handleWarnsCommand,
  handleAntilinkCommand,
  handleAntispamCommand,
  handleWelcomeCommand,
  handleSetWelcomeCommand,
  handleLogsCommand,
  handleLangCommand,
  handleSetmodeCommand,
  handleSettdCommand,
  handleAntimediaCommand,
  handleDelCommand,
} from "./adminCommands.js";
import { handleAfkCommand, maybeClearAfk, enforceAfkMentions } from "./afkController.js";
import { enforceAntiMedia } from "./antiMediaController.js";
import { handlePinCommand } from "./mediaCommands.js";
import { handleForcaCommand, handleHangmanGuess } from "../games/hangman.js";
import { handleTttCommand, handleTttReply } from "../games/tictactoe.js";
import { handleTodCommand, handleTodReply } from "../games/truthordare.js";
import { handleTriviaCommand, handleTriviaReply } from "../games/trivia.js";
import { addLog, getSettings } from "../services/moderationService.js";
import { BOT, formatBotInfo, isAboutBot } from "../config/bot.js";
import { reactTo, sendQuoted, withTyping } from "../utils/feedback.js";
import { sendBranded } from "../utils/avatar.js";
import { formatAskCard } from "../utils/waFormat.js";
import {
  COMMANDS,
  resolveCommand,
  formatCommandHelp,
  makeT,
} from "../i18n/index.js";

function buildCtx(sock, message, groupMeta, text, parsed, lang) {
  const jid = message.key.remoteJid;
  const participants = groupMeta.participants;
  const senderId = message.key.participant;
  const botParticipant = resolveBotParticipant(sock, participants);
  const senderParticipant = findParticipant(participants, senderId);
  const { target, mentioned, quoted } = getMentionsAndQuote(message);

  return {
    sock,
    message,
    jid,
    text,
    cmd: parsed?.cmd || null,
    args: parsed?.args || [],
    argText: parsed?.argText || "",
    senderId,
    groupMeta,
    participants,
    botJid: botParticipant?.id || null,
    isBotAdmin: botParticipant?.admin != null,
    isAdmin: senderParticipant?.admin != null,
    isOwner: isPrivilegedSender(senderId),
    target,
    mentioned,
    quoted,
    lang,
    t: makeT(lang),
  };
}

export async function handleMessage(sock, message) {
  try {
    if (message.key.fromMe) return;
    if (message.key.remoteJid === "status@broadcast") return;

    const jid = message.key.remoteJid;
    if (!jid?.endsWith("@g.us")) return;

    const text = getMessageText(message);

    let groupMeta;
    try {
      groupMeta = await getGroupMeta(sock, jid);
    } catch (err) {
      console.error("❌ Metadata error:", err);
      return;
    }

    const settings = await getSettings(jid);
    const lang = settings.lang === "en" ? "en" : "pt";
    const parsed = parseCommand(text);
    const ctx = buildCtx(sock, message, groupMeta, text, parsed, lang);
    ctx.settings = settings;

    await maybeClearAfk(sock, ctx);
    if (await enforceAfkMentions(sock, ctx)) return;
    if (await enforceAntiMedia(sock, ctx)) return;

    const blocked = await runAutoMod(sock, ctx);
    if (blocked) return;

    const triviaHandled = await handleTriviaReply(sock, message, ctx);
    if (triviaHandled && !parsed) return;

    if (!triviaHandled && (await handleHangmanGuess(sock, ctx))) return;

    if (await handleTttReply(sock, ctx)) return;

    if (await handleTodReply(sock, ctx)) return;

    const cmdId = parsed ? resolveCommand(parsed.cmd) : null;
    if (!cmdId) return;

    const meta = COMMANDS[cmdId];
    console.log(`📨 Command: "${cmdId}" (${parsed.cmd}) | from: ${ctx.senderId} | group: ${jid}`);
    void reactTo(sock, message, "👀");

    if (meta.adminOnly && !ctx.isAdmin && !ctx.isOwner) {
      return sendQuoted(sock, jid, { text: ctx.t("only_admin") }, message, "only-admin", 12_000);
    }

    const handlers = {
      kick: () => handleKick(ctx),
      mute: () => handleMute(ctx, true),
      unmute: () => handleMute(ctx, false),
      promote: () => handleRole(ctx, "promote"),
      demote: () => handleRole(ctx, "demote"),
      info: () => handleInfo(ctx),
      botinfo: () => handleBotInfo(ctx),
      help: () => handleHelp(ctx),
      warn: () => handleWarnCommand(sock, ctx),
      unwarn: () => handleUnwarnCommand(sock, ctx),
      warns: () => handleWarnsCommand(sock, ctx),
      antilink: () => handleAntilinkCommand(sock, ctx),
      antispam: () => handleAntispamCommand(sock, ctx),
      welcome: () => handleWelcomeCommand(sock, ctx),
      setwelcome: () => handleSetWelcomeCommand(sock, ctx),
      logs: () => handleLogsCommand(sock, ctx),
      lang: () => handleLangCommand(sock, ctx),
      setmode: () => handleSetmodeCommand(sock, ctx),
      settd: () => handleSettdCommand(sock, ctx),
      antimedia: () => handleAntimediaCommand(sock, ctx),
      del: () => handleDelCommand(sock, ctx),
      afk: () => handleAfkCommand(sock, ctx),
      trivia: () => handleTriviaCommand(sock, ctx),
      forca: () => handleForcaCommand(sock, ctx),
      ttt: () => handleTttCommand(sock, ctx),
      td: () => handleTodCommand(sock, ctx),
      pin: () => handlePinCommand(sock, ctx),
      ask: () => handleAsk(ctx),
    };

    try {
      await withTyping(sock, jid, () => handlers[cmdId]());
      console.log(`✅ Command done: ${cmdId}`);
    } catch (err) {
      console.error(`❌ Command crashed: ${cmdId}`, err);
      await sendQuoted(sock, jid, { text: ctx.t("cmd_fail") }, message, "cmd-fail", 12_000).catch(
        (sendErr) => console.error("❌ fail notice:", sendErr.message),
      );
    }
  } catch (err) {
    console.error("🔥 Fatal error in handleMessage:", err);
  }
}

async function handleKick(ctx) {
  const { sock, jid, target, participants, isBotAdmin, isOwner, botJid, message, senderId, t } = ctx;

  if (!target) {
    return sendQuoted(sock, jid, { text: t("mention_user") }, message, "kick", 12_000);
  }
  if (!isBotAdmin && !isOwner) {
    return sendQuoted(sock, jid, { text: t("need_admin") }, message, "kick", 12_000);
  }
  if (sameUser(target, botJid)) {
    return sendQuoted(sock, jid, { text: t("cannot_self_kick") }, message, "kick", 12_000);
  }

  const targetParticipant = findParticipant(participants, target);
  if (targetParticipant?.admin != null && !isOwner) {
    return sendQuoted(sock, jid, { text: t("cannot_kick_admin") }, message, "kick", 12_000);
  }

  try {
    const targetJid = targetParticipant?.id || target;
    await sock.groupParticipantsUpdate(jid, [targetJid], "remove");
    await addLog({ groupJid: jid, action: "kick", actor: senderId, target: targetJid });
    await sendQuoted(sock, jid, { text: t("member_removed") }, message, "kick", 12_000);
  } catch (err) {
    console.error("❌ Kick error:", err);
    await sendQuoted(sock, jid, { text: t("kick_failed") }, message, "kick", 12_000);
  }
}

async function handleMute(ctx, mute) {
  const { sock, jid, isBotAdmin, isOwner, message, t } = ctx;
  if (!isBotAdmin && !isOwner) {
    return sendQuoted(sock, jid, { text: t("need_admin") }, message, "mute", 12_000);
  }
  try {
    await sock.groupSettingUpdate(jid, mute ? "announcement" : "not_announcement");
    await sendQuoted(
      sock,
      jid,
      { text: mute ? t("group_muted") : t("group_unmuted") },
      message,
      "mute",
      12_000,
    );
  } catch (err) {
    console.error("❌ Mute error:", err);
    await sendQuoted(sock, jid, { text: t("mute_failed") }, message, "mute", 12_000);
  }
}

async function handleRole(ctx, action) {
  const { sock, jid, target, participants, isBotAdmin, isOwner, botJid, message, t } = ctx;
  if (!target) {
    return sendQuoted(sock, jid, { text: t("mention_user") }, message, "role", 12_000);
  }
  if (!isBotAdmin && !isOwner) {
    return sendQuoted(sock, jid, { text: t("need_admin") }, message, "role", 12_000);
  }
  if (sameUser(target, botJid)) {
    return sendQuoted(sock, jid, { text: t("cannot_self_role") }, message, "role", 12_000);
  }
  try {
    const targetParticipant = findParticipant(participants, target);
    await sock.groupParticipantsUpdate(jid, [targetParticipant?.id || target], action);
    await sendQuoted(
      sock,
      jid,
      { text: action === "promote" ? t("promoted") : t("demoted") },
      message,
      "role",
      12_000,
    );
  } catch (err) {
    console.error(`❌ Role error (${action}):`, err);
    await sendQuoted(sock, jid, { text: t("role_failed") }, message, "role", 12_000);
  }
}

async function handleInfo(ctx) {
  const { sock, jid, groupMeta, message, t } = ctx;
  const adminParticipants = groupMeta.participants.filter((p) => p.admin);
  const admins = adminParticipants.map((p) => `• @${extractNumber(p.id)}`).join("\n");
  const text = [
    `📋 *${groupMeta.subject}*`,
    ``,
    t("info_members", { n: groupMeta.participants.length }),
    `${t("info_admins")}\n${admins}`,
    t("info_created", {
      date: new Date(groupMeta.creation * 1000).toLocaleDateString(t("locale")),
    }),
    groupMeta.desc ? `\n📝 ${groupMeta.desc}` : "",
  ].join("\n");
  await sendQuoted(
    sock,
    jid,
    { text, mentions: adminParticipants.map((p) => p.id) },
    message,
    "info",
    20_000,
  );
}

async function handleBotInfo(ctx) {
  const { sock, jid, message, lang } = ctx;
  await sendBranded(sock, jid, formatBotInfo(lang), message, "botinfo");
}

async function handleHelp(ctx) {
  const { sock, jid, isAdmin, isOwner, message, lang, t } = ctx;
  const privileged = isAdmin || isOwner;
  const grouped = {};

  for (const [id, meta] of Object.entries(COMMANDS)) {
    if (meta.adminOnly && !privileged) continue;
    const cat = meta.category || "util";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(formatCommandHelp(id, lang));
  }

  const order = ["admin", "jogos", "midia", "util"];
  const blocks = order
    .filter((key) => grouped[key]?.length)
    .map((key) => {
      const header = t("help_cat_open", { cat: t(`cat_${key}`) });
      const body = grouped[key].join("\n│\n");
      return `${header}\n${body}\n${t("help_cat_close")}`;
    });

  const text = [
    t("help_title"),
    t("help_subtitle"),
    "",
    "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈",
    "",
    blocks.join("\n\n"),
    "",
    "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈",
    t("help_footer", { creator: BOT.creator }),
  ].join("\n");

  await sendBranded(sock, jid, text, message, "help");
}

async function handleAsk(ctx) {
  const { sock, jid, message, argText, t, lang } = ctx;
  try {
    if (!argText?.trim()) {
      return sendQuoted(sock, jid, { text: t("ask_usage") }, message, "ask", 12_000);
    }
    const topic = argText.trim();
    const aboutBot = isAboutBot(topic);
    const explanation = await explainTopic(topic, lang);
    const body = formatAskCard({
      topic: aboutBot ? BOT.name : topic,
      body: explanation,
      lang,
      aboutBot,
    });
    await sendBranded(sock, jid, body, message, "ask");
  } catch (error) {
    console.error("❌ Error in handleAsk:", error);
    await sendQuoted(sock, jid, { text: t("ask_fail") }, message, "ask", 12_000);
  }
}

export { PREFIX };
