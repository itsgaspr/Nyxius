import { getSettings } from "../services/moderationService.js";
import { getGroupMeta, invalidateGroupMeta } from "../utils/groupMeta.js";
import { extractNumber, sameUser, toJid } from "../utils/jid.js";
import { makeT } from "../i18n/index.js";

export async function handleGroupParticipantsUpdate(sock, update) {
  const jid = update?.id;
  if (!jid?.endsWith("@g.us")) return;
  invalidateGroupMeta(jid);

  const leaving = update.action === "remove" || update.action === "leave";
  const joining = update.action === "add";
  if (!joining && !leaving) return;

  const settings = await getSettings(jid);
  if (joining && !settings.welcomeEnabled) return;
  if (leaving && !settings.goodbyeEnabled) return;

  let groupMeta;
  try {
    groupMeta = await getGroupMeta(sock, jid);
  } catch (err) {
    console.error("group event metadata error:", err);
    return;
  }

  const botId = sock.user?.id;
  const botLid = sock.user?.lid;
  const t = makeT(settings.lang === "en" ? "en" : "pt");
  const template = leaving
    ? settings.goodbyeText || t("default_goodbye")
    : settings.welcomeText || t("default_welcome");
  const label = leaving ? "goodbye" : "welcome";

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
      console.log(`${leaving ? "🚶" : "👋"} ${label} sent → ${mention}`);
    } catch (err) {
      console.error(`${label} send error:`, err);
    }
  }
}
