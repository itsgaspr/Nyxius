import { extractNumber } from "../utils/jid.js";
import { isReplyToBot } from "../utils/message.js";
import { sendQuoted } from "../utils/feedback.js";

const WORDS = [
  { word: "abacaxi", clue: "fruta tropical de casca espinhosa" },
  { word: "amigavel", clue: "quem trata os outros com simpatia" },
  { word: "aventura", clue: "experiência emocionante e arriscada" },
  { word: "biblioteca", clue: "lugar cheio de livros para ler" },
  { word: "cachoeira", clue: "queda de água na natureza" },
  { word: "chocolate", clue: "doce feito de cacau" },
  { word: "computador", clue: "máquina para trabalhar, estudar ou jogar" },
  { word: "dicionario", clue: "livro que explica o significado das palavras" },
  { word: "elefante", clue: "mamífero grande com tromba" },
  { word: "estrela", clue: "astro que brilha no céu à noite" },
  { word: "floresta", clue: "área densa de árvores" },
  { word: "guitarra", clue: "instrumento musical de cordas" },
  { word: "horizonte", clue: "linha onde o céu parece tocar a terra" },
  { word: "igreja", clue: "lugar de culto cristão" },
  { word: "janela", clue: "abertura na parede para ver o exterior" },
  { word: "laranja", clue: "fruta cítrica de cor alaranjada" },
  { word: "montanha", clue: "grande elevação de terra" },
  { word: "navio", clue: "embarcação grande que cruza o mar" },
  { word: "oceano", clue: "enorme massa de água salgada" },
  { word: "passaro", clue: "animal que voa e tem penas" },
  { word: "relogio", clue: "objeto que marca as horas" },
  { word: "sabedoria", clue: "qualidade de quem sabe e julga bem" },
  { word: "telefone", clue: "aparelho para falar à distância" },
  { word: "universo", clue: "tudo o que existe no espaço" },
  { word: "viagem", clue: "deslocamento de um lugar a outro" },
  { word: "xicara", clue: "recipiente pequeno para beber" },
  { word: "zebra", clue: "animal africano com listras pretas e brancas" },
  { word: "planeta", clue: "corpo celeste que orbita uma estrela" },
  { word: "girassol", clue: "flor amarela que segue o sol" },
  { word: "borboleta", clue: "inseto colorido com asas" },
  { word: "castelo", clue: "construção antiga associada a reis" },
  { word: "desenho", clue: "imagem feita à mão" },
  { word: "escola", clue: "lugar onde se aprende" },
  { word: "foguete", clue: "veículo que vai ao espaço" },
  { word: "geladeira", clue: "eletrodoméstico que conserva os alimentos frios" },
  { word: "harmonia", clue: "combinação agradável de sons ou partes" },
  { word: "ilha", clue: "terra cercada de água por todos os lados" },
  { word: "jardim", clue: "espaço com plantas e flores" },
  { word: "ketchup", clue: "molho vermelho feito de tomate" },
  { word: "luz", clue: "o que ilumina e permite ver" },
  { word: "mochila", clue: "bolsa que se carrega nas costas" },
  { word: "nuvem", clue: "massa de vapor visível no céu" },
  { word: "ouro", clue: "metal precioso de cor amarela" },
  { word: "praia", clue: "faixa de areia junto ao mar" },
  { word: "queijo", clue: "alimento feito a partir do leite" },
  { word: "rio", clue: "curso natural de água doce" },
  { word: "sol", clue: "estrela que ilumina a Terra" },
  { word: "tigre", clue: "felino grande com listras" },
  { word: "uva", clue: "fruta pequena usada para fazer vinho" },
  { word: "vento", clue: "ar em movimento" },
  { word: "waffle", clue: "massa crocante com marcas de grelha" },
];

const WORDS_EN = [
  { word: "airport", clue: "place where planes take off and land" },
  { word: "banana", clue: "long yellow fruit" },
  { word: "castle", clue: "old stone home of kings and queens" },
  { word: "dragon", clue: "mythical creature that breathes fire" },
  { word: "elephant", clue: "huge animal with a trunk" },
  { word: "forest", clue: "large area full of trees" },
  { word: "guitar", clue: "string instrument you strum" },
  { word: "horizon", clue: "line where the sky meets the land" },
  { word: "island", clue: "land surrounded by water" },
  { word: "jungle", clue: "thick tropical forest" },
  { word: "kitchen", clue: "room where food is cooked" },
  { word: "lantern", clue: "portable light you can carry" },
  { word: "mountain", clue: "very high rise of land" },
  { word: "notebook", clue: "book of blank pages for writing" },
  { word: "ocean", clue: "vast body of salt water" },
  { word: "penguin", clue: "flightless bird that lives in the cold" },
  { word: "rainbow", clue: "arc of colors after rain" },
  { word: "sandwich", clue: "food with filling between bread" },
  { word: "thunder", clue: "loud sound that follows lightning" },
  { word: "umbrella", clue: "thing that keeps the rain off you" },
  { word: "village", clue: "small group of houses in the countryside" },
  { word: "window", clue: "opening in a wall to look outside" },
  { word: "yellow", clue: "color of the sun and bananas" },
  { word: "zebra", clue: "African animal with black and white stripes" },
  { word: "bridge", clue: "structure that lets you cross a river" },
  { word: "candle", clue: "wax stick that burns to give light" },
  { word: "diamond", clue: "very hard precious stone" },
  { word: "engine", clue: "machine that makes a vehicle move" },
  { word: "feather", clue: "light covering on a bird" },
  { word: "garden", clue: "outdoor space with plants and flowers" },
];

const MAX_LIVES = 6;
const TIMEOUT_MS = 3 * 60 * 1000;
const games = new Map();

function normalize(value) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function hangmanArt(lives) {
  const missed = MAX_LIVES - lives;
  const stages = [
    ["  +---+", "  |   |", "      |", "      |", "      |", "      |", "========="],
    ["  +---+", "  |   |", "  O   |", "      |", "      |", "      |", "========="],
    ["  +---+", "  |   |", "  O   |", "  |   |", "      |", "      |", "========="],
    ["  +---+", "  |   |", "  O   |", " /|   |", "      |", "      |", "========="],
    ["  +---+", "  |   |", "  O   |", " /|\\  |", "      |", "      |", "========="],
    ["  +---+", "  |   |", "  O   |", " /|\\  |", " /    |", "      |", "========="],
    ["  +---+", "  |   |", "  O   |", " /|\\  |", " / \\  |", "      |", "========="],
  ];
  return stages[missed].join("\n");
}

function renderBoard(game) {
  const t = game.t;
  const shown = [...game.word]
    .map((ch) => (game.guessed.has(ch) ? ch.toUpperCase() : "_"))
    .join(" ");
  const tried = [...game.guessed].map((c) => c.toUpperCase()).join(" ") || "-";
  return [
    t("hangman_title"),
    "```",
    hangmanArt(game.lives),
    "```",
    t("hangman_word", { shown }),
    t("hangman_clue", { clue: game.clue }),
    t("hangman_lives", { lives: game.lives, max: MAX_LIVES }),
    t("hangman_letters", { tried }),
    "",
    t("hangman_hint"),
  ].join("\n");
}

function clearTimer(jid) {
  const game = games.get(jid);
  if (game?.timer) clearTimeout(game.timer);
}

function scheduleTimeout(sock, jid) {
  const game = games.get(jid);
  if (!game) return;
  if (game.timer) clearTimeout(game.timer);
  game.timer = setTimeout(async () => {
    const current = games.get(jid);
    if (!current) return;
    games.delete(jid);
    await sendQuoted(
      sock,
      jid,
      { text: current.t("hangman_timeout", { word: current.word.toUpperCase() }) },
      null,
      "hangman-timeout",
      12_000,
    ).catch(() => {});
  }, TIMEOUT_MS);
}

async function sendHangman(sock, ctx, content, label) {
  return sendQuoted(sock, ctx.jid, content, ctx.message, label, 20_000);
}

export function isHangmanActive(jid) {
  return games.has(jid);
}

export async function handleForcaCommand(sock, ctx) {
  const { jid, message, argText, isAdmin, isOwner, t, lang } = ctx;
  const arg = (argText || "").toLowerCase();

  if (arg === "stop" || arg === "parar") {
    if (!isAdmin && !isOwner) {
      return sendHangman(sock, ctx, { text: t("hangman_admin_stop") }, "hangman-stop");
    }
    if (!games.has(jid)) {
      return sendHangman(sock, ctx, { text: t("hangman_none") }, "hangman-none");
    }
    clearTimer(jid);
    games.delete(jid);
    return sendHangman(sock, ctx, { text: t("hangman_stopped") }, "hangman-stopped");
  }

  if (games.has(jid)) {
    return sendHangman(
      sock,
      ctx,
      { text: t("hangman_running", { board: renderBoard(games.get(jid)) }) },
      "hangman-running",
    );
  }

  const pool = lang === "en" ? WORDS_EN : WORDS;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const game = {
    word: pick.word,
    clue: pick.clue,
    guessed: new Set(),
    lives: MAX_LIVES,
    timer: null,
    t,
  };
  games.set(jid, game);
  scheduleTimeout(sock, jid);

  return sendHangman(sock, ctx, { text: renderBoard(game) }, "hangman-board");
}

export async function handleHangmanGuess(sock, ctx) {
  const { jid, text, senderId, message } = ctx;
  const game = games.get(jid);
  if (!game) return false;
  if (!isReplyToBot(message, sock)) return false;

  const raw = (text || "").trim();
  if (!raw || raw.startsWith(".")) return false;

  const guess = normalize(raw);
  if (!/^[a-z]+$/.test(guess)) return false;
  if (guess.length !== 1 && guess.length !== game.word.length) return false;

  const number = extractNumber(senderId);

  if (guess.length === game.word.length) {
    if (guess === game.word) {
      [...game.word].forEach((ch) => game.guessed.add(ch));
      clearTimer(jid);
      games.delete(jid);
      await sendHangman(
        sock,
        ctx,
        {
          text: game.t("hangman_guessed", {
            user: number,
            word: game.word.toUpperCase(),
          }),
          mentions: [senderId],
        },
        "hangman-win",
      );
      return true;
    }
    game.lives -= 1;
  } else {
    if (game.guessed.has(guess)) {
      await sendHangman(
        sock,
        ctx,
        { text: game.t("hangman_already", { letter: guess.toUpperCase() }) },
        "hangman-already",
      );
      return true;
    }
    game.guessed.add(guess);
    if (!game.word.includes(guess)) game.lives -= 1;
  }

  const won = [...game.word].every((ch) => game.guessed.has(ch));
  if (won) {
    clearTimer(jid);
    games.delete(jid);
    await sendHangman(
      sock,
      ctx,
      {
        text: game.t("hangman_completed", {
          user: number,
          word: game.word.toUpperCase(),
        }),
        mentions: [senderId],
      },
      "hangman-complete",
    );
    return true;
  }

  if (game.lives <= 0) {
    clearTimer(jid);
    games.delete(jid);
    await sendHangman(
      sock,
      ctx,
      { text: game.t("hangman_lost", { word: game.word.toUpperCase() }) },
      "hangman-lost",
    );
    return true;
  }

  scheduleTimeout(sock, jid);
  await sendHangman(sock, ctx, { text: renderBoard(game) }, "hangman-board");
  return true;
}
