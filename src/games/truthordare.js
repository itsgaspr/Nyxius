import { extractNumber, sameUser } from "../utils/jid.js";
import { isReplyToBot } from "../utils/message.js";
import { sendQuoted, withTyping } from "../utils/feedback.js";
import { generateTruthOrDare } from "../integrations/groq.js";
import { getSettings } from "../services/moderationService.js";

const pending = new Map();
const CHOICE_MS = 45_000;

const TRUTH = new Set([
  "v",
  "verdade",
  "truth",
  "t",
  "1",
]);
const DARE = new Set([
  "d",
  "desafio",
  "dare",
  "2",
]);

const FALLBACK = {
  pt: {
    leve: {
      truth: [
        "🎧 Qual foi a última música que ficaste a ouvir em loop?",
        "🦸 Se pudesses ter um superpoder inútil, qual seria?",
        "🍿 Qual snack tu defenderias numa discussão séria?",
        "😎 Qual emoji te representa hoje e porquê?",
      ],
      dare: [
        "🎤 Manda um áudio de 5s a imitar um telejornal a anunciar o tempo.",
        "👍📸 Tira uma foto do teu polegar a 'cumprimentar' a câmara.",
        "🎭 Manda um áudio a dizer 'eu juro que isto é uma boa ideia' bem dramático.",
        "📦✨ Fotografa o objecto mais aleatório à tua frente e dá-lhe um nome épico.",
      ],
    },
    medio: {
      truth: [
        "🤭 Qual foi a maior vergonha engraçada que já tiveste num grupo?",
        "🪞 Qual hábito teu os amigos gozam sem piedade?",
        "📺 Se o grupo fosse um reality, qual seria o teu papel?",
        "💬 Qual mensagem antiga gostavas de apagar (sem spoiler pesado)?",
      ],
      dare: [
        "🍪🎤 Confessa num áudio um 'crime' ridículo inventado (tipo roubar um chip).",
        "👟📸 Foto do sapato/chinelo como capa de revista de moda.",
        "🎶 Humma 8 segundos de uma música aleatória (desafinado conta).",
        "🛫 Fotografa o tecto ou o chão e vende como destino de viagem.",
      ],
    },
    profundo: {
      truth: [
        "🌟 Qual momento recente te deixou mesmo orgulhoso de ti?",
        "🕰️ Que conselho darias ao teu 'eu' de há 3 anos?",
        "💛 Qual amizade neste grupo valorizas mais do que costumas dizer?",
        "🌿 O que te acalma quando o dia corre mal?",
      ],
      dare: [
        "🙏🎤 Áudio curto a agradecer a alguém do grupo por uma coisa pequena.",
        "🪞📸 Foto de algo que te represente hoje + 1 frase.",
        "🎬 Conta numa voz de documentário uma vitória pequena desta semana.",
        "🖐️✨ High five à câmara dedicado a alguém do grupo.",
      ],
    },
  },
  en: {
    leve: {
      truth: [
        "🎧 What's the last song you had on repeat?",
        "🦸 If you could have one useless superpower, what would it be?",
        "🍿 Which snack would you defend in a serious debate?",
        "😎 Which emoji represents you today and why?",
      ],
      dare: [
        "🎤 Send a 5s voice note impersonating a news anchor on the weather.",
        "👍📸 Photo of your thumb 'greeting' the camera.",
        "🎭 Voice note: 'this is definitely a good idea' — go dramatic.",
        "📦✨ Photograph the most random object nearby and give it an epic name.",
      ],
    },
    medio: {
      truth: [
        "🤭 Funniest embarrassing moment you've had in a group chat?",
        "🪞 Which habit of yours do friends roast the most?",
        "📺 If this group were a reality show, what's your role?",
        "💬 Which old message do you wish you could unsend (keep it light)?",
      ],
      dare: [
        "🍪🎤 Confess a ridiculous fake 'crime' in a voice note (like stealing one chip).",
        "👟📸 Shoe/slipper photo like a fashion magazine cover.",
        "🎶 Hum 8 seconds of a random song (off-key welcome).",
        "🛫 Photograph the ceiling or floor as a travel destination.",
      ],
    },
    profundo: {
      truth: [
        "🌟 What recent moment made you feel genuinely proud?",
        "🕰️ What advice would you give your past self from 3 years ago?",
        "💛 Which friendship here do you value more than you usually say?",
        "🌿 What calms you when the day goes sideways?",
      ],
      dare: [
        "🙏🎤 Short voice note thanking someone here for one small thing.",
        "🪞📸 Photo of something that represents you today + one line.",
        "🎬 Narrate a small win this week like a documentary.",
        "🖐️✨ High-five the camera and dedicate it to someone here.",
      ],
    },
  },
};

function say(sock, ctx, content, label = "tod") {
  return sendQuoted(sock, ctx.jid, content, ctx.message, label, 20_000);
}

export function normalizeTodLevel(argText) {
  const raw = (argText || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  if (["leve", "light", "easy", "soft", "facil"].includes(raw)) return "leve";
  if (["medio", "medium", "mid", "normal"].includes(raw)) return "medio";
  if (["profundo", "deep", "hard", "intense"].includes(raw)) return "profundo";
  return null;
}

function resolveLevel(settings) {
  const level = settings?.todLevel;
  if (level === "medio" || level === "profundo" || level === "leve") return level;
  return "leve";
}

export function labelTodLevel(level, lang) {
  if (lang === "en") {
    return { leve: "light", medio: "medium", profundo: "deep" }[level] || level;
  }
  return level;
}

function pickFallback(lang, level, kind) {
  const pack = FALLBACK[lang === "en" ? "en" : "pt"][level] || FALLBACK.pt.leve;
  const list = pack[kind] || pack.truth;
  return list[Math.floor(Math.random() * list.length)];
}

function parseChoice(raw) {
  const value = (raw || "").trim().toLowerCase();
  if (!value || value.startsWith(".")) return null;
  if (TRUTH.has(value)) return "truth";
  if (DARE.has(value)) return "dare";
  return null;
}

async function deliverPrompt(sock, ctx, challenge, kind) {
  const { jid, t, lang } = ctx;
  const level = challenge.level || "leve";
  const targetNum = extractNumber(challenge.target);

  let prompt;
  try {
    prompt = await generateTruthOrDare({ kind, level, lang });
  } catch (err) {
    console.warn("⚠️  tod generate failed, using fallback:", err.message);
    prompt = null;
  }
  if (!prompt) prompt = pickFallback(lang, level, kind);

  const levelLabel = labelTodLevel(level, lang);
  const title =
    kind === "truth"
      ? t("tod_truth_title", { level: levelLabel })
      : t("tod_dare_title", { level: levelLabel });
  pending.delete(jid);
  return say(
    sock,
    ctx,
    {
      text: t("tod_prompt", { title, user: targetNum, prompt }),
      mentions: [challenge.target],
    },
    "tod-prompt",
  );
}

async function acceptChoice(sock, ctx, kind) {
  const { jid, senderId, t } = ctx;
  const challenge = pending.get(jid);
  if (!challenge) return;
  if (!sameUser(senderId, challenge.target)) {
    return say(sock, ctx, { text: t("tod_not_yours") });
  }
  if (Date.now() > challenge.expires) {
    pending.delete(jid);
    return say(sock, ctx, { text: t("tod_expired") });
  }
  return deliverPrompt(sock, ctx, challenge, kind);
}

export async function handleTodReply(sock, ctx) {
  if (!isReplyToBot(ctx.message, sock)) return false;
  const challenge = pending.get(ctx.jid);
  if (!challenge) return false;
  const kind = parseChoice(ctx.text);
  if (!kind) return false;
  await withTyping(sock, ctx.jid, () => acceptChoice(sock, ctx, kind));
  return true;
}

export async function handleTodCommand(sock, ctx) {
  const { jid, senderId, argText, target, t, message, botJid, settings } = ctx;
  const arg = (argText || "").trim().toLowerCase();
  const challenge = pending.get(jid);
  const replied = isReplyToBot(message, sock);

  if (challenge && parseChoice(arg)) {
    if (!replied) return;
    return acceptChoice(sock, ctx, parseChoice(arg));
  }

  if (arg === "stop" || arg === "parar" || arg === "cancelar") {
    if (!challenge) return say(sock, ctx, { text: t("tod_none") });
    const canStop =
      ctx.isAdmin ||
      ctx.isOwner ||
      sameUser(senderId, challenge.challenger) ||
      sameUser(senderId, challenge.target);
    if (!canStop) return say(sock, ctx, { text: t("tod_admin_stop") });
    pending.delete(jid);
    return say(sock, ctx, { text: t("tod_stopped") });
  }

  if (!target) {
    const level = resolveLevel(settings || (await getSettings(jid)));
    return say(sock, ctx, { text: t("tod_usage", { level: labelTodLevel(level, ctx.lang) }) });
  }

  if (sameUser(target, senderId)) {
    return say(sock, ctx, { text: t("tod_self") });
  }
  if (botJid && sameUser(target, botJid)) {
    return say(sock, ctx, { text: t("tod_bot") });
  }
  if (challenge && Date.now() <= challenge.expires) {
    return say(sock, ctx, { text: t("tod_busy") });
  }

  const level = resolveLevel(settings || (await getSettings(jid)));
  pending.set(jid, {
    challenger: senderId,
    target,
    level,
    expires: Date.now() + CHOICE_MS,
  });

  const meNum = extractNumber(senderId);
  const oppNum = extractNumber(target);
  return say(sock, ctx, {
    text: t("tod_challenge", {
      me: meNum,
      opp: oppNum,
      level: labelTodLevel(level, ctx.lang),
    }),
    mentions: [senderId, target],
  });
}
