/**
 * WhatsApp uses *bold* / _italic_ (one marker each side).
 * Convert common Markdown so AI replies don't send **bold**.
 */
export function toWhatsAppMarkup(text) {
  let out = String(text ?? "");
  // **bold** or __bold__ → *bold*
  out = out.replace(/\*\*(.+?)\*\*/gs, "*$1*");
  out = out.replace(/__(.+?)__/gs, "*$1*");
  // Collapse accidental ****bold**** leftovers
  out = out.replace(/\*{3,}(.+?)\*{3,}/gs, "*$1*");
  // Strip markdown headings / fences that look ugly in WhatsApp
  out = out.replace(/^#{1,6}\s+/gm, "");
  out = out.replace(/```[\w]*\n?/g, "");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

export function formatContentForWhatsApp(content) {
  if (!content || typeof content !== "object") return content;
  const next = { ...content };
  if (typeof next.text === "string") next.text = toWhatsAppMarkup(next.text);
  if (typeof next.caption === "string") next.caption = toWhatsAppMarkup(next.caption);
  return next;
}

/** Pretty WhatsApp card for every `.ask` reply. */
export function formatAskCard({ topic, body, lang = "pt", aboutBot = false }) {
  const title = String(topic || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);
  const clean = toWhatsAppMarkup(body);
  const eyebrow = aboutBot
    ? lang === "en"
      ? "⌜ NX-01  ·  about me ⌟"
      : "⌜ NX-01  ·  sobre mim ⌟"
    : lang === "en"
      ? "⌜ .ask ⌟"
      : "⌜ .ask ⌟";
  const icon = aboutBot ? "✦" : "💭";

  return [
    `✧･ﾟ: ${icon} *${title || (lang === "en" ? "Answer" : "Resposta")}* :･ﾟ✧`,
    eyebrow,
    "",
    "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈",
    "",
    clean,
    "",
    "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈",
    "┊ Nyxius",
  ].join("\n");
}
