import { getStoredMessage } from "./msgStore.js";
import { sameUser } from "./jid.js";

export function unwrapMessageContent(message) {
  let m = message?.message;
  if (!m) return null;
  if (m.ephemeralMessage) m = m.ephemeralMessage.message;
  if (m.viewOnceMessage) m = m.viewOnceMessage.message;
  if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
  if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
  return m || null;
}

export function getMessageText(message) {
  const msg = unwrapMessageContent(message);
  if (!msg) return "";
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    ""
  );
}

export function getContextInfo(message) {
  const msg = unwrapMessageContent(message);
  if (!msg) return {};
  return (
    msg.extendedTextMessage?.contextInfo ||
    msg.imageMessage?.contextInfo ||
    msg.videoMessage?.contextInfo ||
    msg.documentMessage?.contextInfo ||
    {}
  );
}

export function getMentionsAndQuote(message) {
  const context = getContextInfo(message);
  const quoted = context.participant || null;
  const mentioned = context.mentionedJid || [];
  const target = quoted || mentioned[0] || null;
  return { quoted, mentioned, target };
}

export function getQuotedStanzaId(message) {
  const context = getContextInfo(message);
  return context.stanzaId || context.stanzaID || null;
}

export function getQuotedKey(message, sock) {
  const context = getContextInfo(message);
  const id = context.stanzaId || context.stanzaID;
  if (!id) return null;
  const me = [sock?.user?.id, sock?.user?.lid, sock?.authState?.creds?.me?.id, sock?.authState?.creds?.me?.lid];
  const fromMe = me.some((jid) => jid && sameUser(jid, context.participant));
  return {
    remoteJid: message.key.remoteJid,
    id,
    fromMe,
    participant: context.participant || undefined,
  };
}

export function isReplyToBot(message, sock) {
  const quotedId = getQuotedStanzaId(message);
  if (!quotedId) return false;
  if (getStoredMessage(quotedId)) return true;

  const quoted = getContextInfo(message).participant;
  if (!quoted) return false;
  const me = [
    sock?.user?.id,
    sock?.user?.lid,
    sock?.authState?.creds?.me?.id,
    sock?.authState?.creds?.me?.lid,
  ];
  return me.some((id) => id && sameUser(id, quoted));
}

export const PREFIX = ".";

export function parseCommand(text) {
  if (!text?.startsWith(PREFIX)) return null;
  const rest = text.slice(PREFIX.length).trim();
  if (!rest) return null;
  const [rawCmd, ...args] = rest.split(/\s+/);
  return {
    cmd: rawCmd.toLowerCase(),
    args,
    argText: rest.slice(rawCmd.length).trim(),
  };
}
