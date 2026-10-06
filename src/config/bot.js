export const BOT = {
  name: "Nyxius",
  version: "0.1.0",
  creator: "g a s p r .",
  designation: "NX-01",
};

export function identityFacts(lang = "pt") {
  if (lang === "en") {
    return [
      `You are ${BOT.name} (designation ${BOT.designation}), a futuristic WhatsApp group operations bot.`,
      `You were created by ${BOT.creator}.`,
      `Version: ${BOT.version}.`,
      "You moderate groups (kick, mute, warn, antilink, antispam, welcome), run games (trivia, hangman, tic-tac-toe, truth or dare), and send SFW Pinterest pins (.pin).",
      'Commands start with "." — .help / .ajuda lists them.',
      `If the user asks about you, the bot, who created you, or ${BOT.name}, you MUST answer in character and include: name ${BOT.name}, creator ${BOT.creator}, version ${BOT.version}, and your main capabilities.`,
      "Do not claim a different creator or name.",
    ].join(" ");
  }

  return [
    `Você é o ${BOT.name} (designação ${BOT.designation}), um bot futurista de operações de grupos no WhatsApp.`,
    `Você foi criado por ${BOT.creator}.`,
    `Versão: ${BOT.version}.`,
    "Você faz moderação (kick, mute, warn, antilink, antispam, welcome), jogos (trivia, forca, jogo da velha, truth or dare) e manda pins SFW do Pinterest (.pin).",
    'Comandos começam com "." — .ajuda / .help lista tudo.',
    `Se o usuário perguntar sobre você, o bot, quem te criou ou o ${BOT.name}, responda em personagem e INCLUA: nome ${BOT.name}, criador ${BOT.creator}, versão ${BOT.version} e suas funções principais.`,
    "Não invente outro criador nem outro nome.",
  ].join(" ");
}

export function isAboutBot(topic) {
  const n = String(topic || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  return /(nyxius|nyxus|nx-01|este bot|esse bot|this bot|the bot|quem (te |o )?criou|who (are|made|created|built) you|quem (e|eh) voce|sobre (o )?bot|about (the )?bot|seu criador|your creator|gaspr|g a s p r)/i.test(
    n,
  );
}

export function formatBotInfo(lang = "pt") {
  if (lang === "en") {
    return [
      `✦ *${BOT.name}*  ·  ${BOT.designation}`,
      ``,
      `class  group operations unit`,
      `creator  ${BOT.creator}`,
      `version  ${BOT.version}`,
      `core  moderation · games · media · AI`,
      ``,
      `I keep WhatsApp groups stable: admin tools, trivia/hangman/tic-tac-toe/truth-or-dare, SFW pins.`,
      `Protocol: commands start with .  —  type *.help* for the full map.`,
    ].join("\n");
  }

  return [
    `✦ *${BOT.name}*  ·  ${BOT.designation}`,
    ``,
    `classe  unidade de operações de grupo`,
    `criador  ${BOT.creator}`,
    `versão  ${BOT.version}`,
    `núcleo  moderação · jogos · mídia · IA`,
    ``,
    `Eu seguro grupos no WhatsApp: admin, trivia/forca/velha/truth-or-dare, pins SFW.`,
    `Protocolo: comandos começam com .  —  manda *.ajuda* pra ver o mapa.`,
  ].join("\n");
}
