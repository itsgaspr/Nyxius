import { STRINGS } from "./strings.js";
import { COMMANDS, resolveCommand, formatCommandHelp } from "./commands.js";

export { COMMANDS, resolveCommand, formatCommandHelp };

export function normalizeLang(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (["en", "eng", "english", "ingles", "inglês"].includes(raw)) return "en";
  if (["pt", "pt-br", "ptbr", "portugues", "português", "br"].includes(raw))
    return "pt";
  return null;
}

export function t(lang, key, vars = {}) {
  const dict = STRINGS[lang] || STRINGS.pt;
  let text = dict[key] || STRINGS.pt[key] || key;
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, value ?? "");
  }
  return text;
}

export function makeT(lang) {
  const resolved = lang === "en" ? "en" : "pt";
  return (key, vars) => t(resolved, key, vars);
}
