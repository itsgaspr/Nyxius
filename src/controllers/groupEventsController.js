import { getSettings } from "../services/moderationService.js";
import { getGroupMeta, invalidateGroupMeta } from "../utils/groupMeta.js";
import { extractNumber, sameUser, toJid } from "../utils/jid.js";
import { makeT } from "../i18n/index.js";

export async function handleGroupParticipantsUpdate(sock, update) {
  const jid = update?.id;
  if (!jid?.endsWith("@g.us")) return;
  invalidateGroupMeta(jid);

  if (update.action !== "add") return;

  const settings = await getSettings(jid);
  if (!settings.welcomeEnabled) return;

  let groupMeta;
  try {
    groupMeta = await getGroupMeta(sock, jid);
  } catch (err) {
    console.error("welcome metadata error:", err);
    return;
  }

  const botId = sock.user?.id;
  const botLid = sock.user?.lid;
  const t = makeT(settings.lang === "en" ? "en" : "pt");
  const template = settings.welcomeText || t("default_welcome");

  console.log(`👥 ${update.action} in ${jid}:`, (update.participants || []).map((p) => toJid(p)));

  for (const participant of update.participants || []) {
    const mention = toJid(participant);
    if (!mention) continue;
    if (sameUser(mention, botId) || sameUser(mention, botLid)) continue;
    const number = extractNumber(mention);
    const text = template
      .replaceAll("{user}", `@${number}`)
      .replaceAll("{group}", groupMeta.subject || "grupo");
    try {
      await sock.sendMessage(jid, {
        text,
        mentions: [mention],
      });
      console.log(`👋 welcome sent → ${mention}`);
    } catch (err) {
      console.error("welcome send error:", err);
    }
  }
}
