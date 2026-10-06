export function groupJidOf(key) {
  if (!key) return null;
  if (typeof key.remoteJid === "string" && key.remoteJid.endsWith("@g.us")) return key.remoteJid;
  if (typeof key.remoteJidAlt === "string" && key.remoteJidAlt.endsWith("@g.us")) return key.remoteJidAlt;
  return null;
}

export function toJid(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    return value.phoneNumber || value.jid || value.id || value.lid || null;
  }
  return null;
}

export function extractNumber(jid) {
  const raw = toJid(jid);
  if (!raw || typeof raw !== "string") return null;
  return raw.split("@")[0].split(":")[0];
}

export function sameUser(a, b) {
  const left = extractNumber(a);
  const right = extractNumber(b);
  if (!left || !right) return false;
  return left === right;
}

export function findParticipant(participants, jid) {
  const num = extractNumber(jid);
  if (!num) return null;
  return (
    participants.find((p) => {
      const ids = typeof p === "string" ? [p] : [p?.id, p?.jid, p?.lid, p?.phoneNumber];
      return ids.some((id) => extractNumber(id) === num);
    }) || null
  );
}

export function isPrivilegedSender(senderId) {
  return (
    sameUser(senderId, process.env.BOT_OWNER_NUMBER) ||
    sameUser(senderId, process.env.BOT_OWNER_LID)
  );
}

export function resolveBotParticipant(sock, participants) {
  const botLid = sock.user?.lid;
  const botRawId = sock.user?.id;
  return (
    (botLid ? findParticipant(participants, botLid) : null) ||
    findParticipant(participants, botRawId)
  );
}
