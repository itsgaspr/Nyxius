// Fixed SFW actions. `.kick` is only the admin remove command, not a sticker.
// `kill` uses nekos.best `shoot` (no kill category).
export const REACTIONS = [
  {
    id: "pat",
    api: "pat",
    aliases: ["pat", "cafune", "cafuné", "cafunar"],
    primary: { pt: "cafune", en: "pat" },
    line: "react_pat",
  },
  {
    id: "kiss",
    api: "kiss",
    aliases: ["kiss", "beijo", "beijar"],
    primary: { pt: "beijo", en: "kiss" },
    line: "react_kiss",
  },
  {
    id: "hug",
    api: "hug",
    aliases: ["hug", "abraco", "abraço", "abracar", "abraçar"],
    primary: { pt: "abraco", en: "hug" },
    line: "react_hug",
  },
  {
    id: "kill",
    api: "shoot",
    aliases: ["kill", "matar"],
    primary: { pt: "matar", en: "kill" },
    line: "react_kill",
  },
  {
    id: "slap",
    api: "slap",
    aliases: ["slap", "tapa", "estapear"],
    primary: { pt: "tapa", en: "slap" },
    line: "react_slap",
  },
  {
    id: "poke",
    api: "poke",
    aliases: ["poke", "cutucar", "cutuca"],
    primary: { pt: "cutucar", en: "poke" },
    line: "react_poke",
  },
  {
    id: "bite",
    api: "bite",
    aliases: ["bite", "morder"],
    primary: { pt: "morder", en: "bite" },
    line: "react_bite",
  },
  {
    id: "cuddle",
    api: "cuddle",
    aliases: ["cuddle", "aconchego", "colo"],
    primary: { pt: "colo", en: "cuddle" },
    line: "react_cuddle",
  },
  {
    id: "bonk",
    api: "bonk",
    aliases: ["bonk", "bonkada"],
    primary: { pt: "bonk", en: "bonk" },
    line: "react_bonk",
  },
  {
    id: "wave",
    api: "wave",
    aliases: ["wave", "acenar"],
    primary: { pt: "acenar", en: "wave" },
    line: "react_wave",
  },
  {
    id: "cry",
    api: "cry",
    aliases: ["cry", "chorar"],
    primary: { pt: "chorar", en: "cry" },
    line: "react_cry",
  },
  {
    id: "dance",
    api: "dance",
    aliases: ["dance", "dancar", "dançar"],
    primary: { pt: "dancar", en: "dance" },
    line: "react_dance",
  },
  {
    id: "wink",
    api: "wink",
    aliases: ["wink", "piscar"],
    primary: { pt: "piscar", en: "wink" },
    line: "react_wink",
  },
  {
    id: "highfive",
    api: "highfive",
    aliases: ["highfive", "toca", "high5"],
    primary: { pt: "toca", en: "highfive" },
    line: "react_highfive",
  },
];

const BY_ID = new Map(REACTIONS.map((reaction) => [reaction.id, reaction]));
const ALLOWED_API = new Set(REACTIONS.map((reaction) => reaction.api));

export function reactionById(id) {
  return BY_ID.get(id) || null;
}

export function isAllowedReactionApi(api) {
  return ALLOWED_API.has(api);
}
