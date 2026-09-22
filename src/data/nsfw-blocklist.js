export const NSFW_TERMS = [
  "nsfw",
  "porn",
  "porno",
  "pornografia",
  "xxx",
  "sex",
  "sexo",
  "sexual",
  "nude",
  "nudes",
  "nua",
  "nuas",
  "nu",
  "pelada",
  "pelado",
  "peladas",
  "onlyfans",
  "hentai",
  "rule34",
  "gore",
  "incest",
  "incesto",
  "bdsm",
  "boob",
  "boobs",
  "pussy",
  "dick",
  "penis",
  "pênis",
  "vagina",
  "transando",
  "gozada",
  "punheta",
  "siririca",
  "anal",
  "oral",
  "ejaculation",
];

export function isNsfwQuery(query) {
  const normalized = (query || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const tokenSet = new Set(tokens);
  return NSFW_TERMS.some((term) => {
    const t = term.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
    if (t.length <= 3) return tokenSet.has(t);
    return tokenSet.has(t) || tokens.some((tok) => tok.includes(t));
  });
}
