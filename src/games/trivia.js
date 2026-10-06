import {
  generateTriviaQuestion,
  explainTriviaAnswer,
  celebrateTriviaMatch,
} from "../integrations/groq.js";
import { extractNumber, sameUser } from "../utils/jid.js";
import { getMessageText, isReplyToBot } from "../utils/message.js";
import { sendQuoted, withTyping } from "../utils/feedback.js";
import { makeT } from "../i18n/index.js";

const soloState = new Map();
const vsState = new Map();

const SOLO_COOLDOWN = 10_000;
const VS_TIMEOUT_MS = 60_000;
const VS_DEFAULT = 5;
const VS_MIN = 1;
const VS_MAX = 10;
const FACES = ["🤪", "🧐", "🤓", "😏", "🤔", "😼", "👻", "🧠"];

function say(sock, ctx, content, label = "trivia", ms = 20_000) {
  return sendQuoted(sock, ctx.jid, content, ctx.message, label, ms);
}

export function normalizeTriviaPick(raw, format) {
  const text = String(raw || "").trim().toUpperCase();
  if (["A", "B", "C", "D"].includes(text)) return text;
  if (format === "tf") {
    if (/^(TRUE|VERDADEIRO|V|YES|SIM)$/.test(text)) return "A";
    if (/^(FALSE|FALSO|F|NO|NAO|NÃO)$/.test(text)) return "B";
  }
  return null;
}

export function renderTriviaQuestion(item, t, extraLines = []) {
  const face = FACES[Math.floor(Math.random() * FACES.length)];
  const lines = [
    `${face} ${item.question}`,
    ``,
    `🅰️ ${item.options.A}`,
    `🅱️ ${item.options.B}`,
  ];
  if (item.format !== "tf") {
    lines.push(`🅲 ${item.options.C}`, `🅳 ${item.options.D}`);
  }
  lines.push(``, item.format === "tf" ? t("trivia_reply_tf") : t("trivia_reply"));
  if (extraLines.length) lines.push("", ...extraLines);
  return lines.join("\n");
}

function parseVsCount(argText) {
  const match = String(argText || "").match(/(?:^|\s)(\d{1,2})(?:\s|$)/);
  if (!match) return VS_DEFAULT;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return VS_DEFAULT;
  return Math.min(VS_MAX, Math.max(VS_MIN, n));
}

function onlyCountArg(argText) {
  return /^\s*\d{1,2}\s*$/.test(argText || "");
}

function vsOpponent(ctx) {
  const { mentioned, quoted, botJid, senderId } = ctx;
  const people = [...(mentioned || [])];
  if (quoted) people.push(quoted);
  return people.find((id) => id && !sameUser(id, senderId) && !sameUser(id, botJid)) || null;
}

function clearVsTimer(game) {
  if (game?.timer) {
    clearTimeout(game.timer);
    game.timer = null;
  }
}

function scoreLine(game, t) {
  return t("trivia_vs_score", {
    a: extractNumber(game.a),
    b: extractNumber(game.b),
    sa: game.scoreA,
    sb: game.scoreB,
  });
}

async function finishVs(sock, jid, extra, mentions) {
  const game = vsState.get(jid);
  if (!game) return;
  clearVsTimer(game);
  vsState.delete(jid);
  const t = game.t;
  const aNum = extractNumber(game.a);
  const bNum = extractNumber(game.b);
  const draw = game.scoreA === game.scoreB;
  const aWins = game.scoreA > game.scoreB;
  const winnerNumber = draw ? "" : aWins ? aNum : bNum;
  const loserNumber = draw ? "" : aWins ? bNum : aNum;
  const scoreWinner = draw ? game.scoreA : aWins ? game.scoreA : game.scoreB;
  const scoreLoser = draw ? game.scoreB : aWins ? game.scoreB : game.scoreA;
  let result = draw
    ? t("trivia_vs_draw", { sa: game.scoreA, sb: game.scoreB, a: aNum, b: bNum })
    : t("trivia_vs_win", {
        user: winnerNumber,
        loser: loserNumber,
        sa: scoreWinner,
        sb: scoreLoser,
      });
  try {
    const warm = await celebrateTriviaMatch({
      lang: game.lang,
      draw,
      winnerNumber,
      loserNumber,
      aNumber: aNum,
      bNumber: bNum,
      scoreWinner,
      scoreLoser,
    });
    if (warm) result = warm;
  } catch (err) {
    console.error("trivia celebrate failed:", err.message);
  }
  const body = [extra, scoreLine(game, t), result].filter(Boolean).join("\n\n");
  return sendQuoted(
    sock,
    jid,
    { text: body, mentions: mentions || [game.a, game.b] },
    null,
    "trivia-vs-end",
    20_000,
  );
}

function armVsTimeout(sock, jid) {
  const game = vsState.get(jid);
  if (!game) return;
  clearVsTimer(game);
  const turn = game.turn;
  game.deadline = Date.now() + VS_TIMEOUT_MS;
  game.timer = setTimeout(() => {
    const current = vsState.get(jid);
    if (!current || current.turn !== turn) return;
    const late = extractNumber(current.turn);
    finishVs(sock, jid, current.t("trivia_vs_timeout", { user: late }), [
      current.a,
      current.b,
      current.turn,
    ]).catch((err) => console.error("trivia vs timeout:", err.message));
  }, VS_TIMEOUT_MS);
}

async function loadQuestion(lang, mode, seen) {
  let lastErr = null;
  for (let i = 0; i < 6; i += 1) {
    try {
      const triviaData = await generateTriviaQuestion(lang, mode);
      if (!triviaData?.question || !triviaData?.options?.A || !triviaData?.answer) {
        throw new Error("invalid_trivia");
      }
      const key = String(triviaData.question).toLowerCase().slice(0, 90);
      if (seen?.has(key)) continue;
      seen?.add(key);
      return {
        question: triviaData.question,
        options: triviaData.options,
        answer: triviaData.answer.toUpperCase().trim(),
        format: triviaData.format || "mc",
        funny: triviaData.funny || "",
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("invalid_trivia");
}

async function askVsTurn(sock, ctx, game) {
  const isA = sameUser(game.turn, game.a);
  const index = isA ? game.askedA : game.askedB;
  const item = await loadQuestion(game.lang, game.mode, game.seen);
  game.current = item;
  const header = game.t("trivia_vs_turn", {
    user: extractNumber(game.turn),
    n: index + 1,
    total: game.total,
  });
  armVsTimeout(sock, ctx.jid);
  return say(
    sock,
    ctx,
    {
      text: `${header}\n\n${renderTriviaQuestion(item, game.t, [
        game.t("trivia_vs_clock"),
        scoreLine(game, game.t),
      ])}`,
      mentions: [game.turn],
    },
    "trivia-vs",
  );
}

async function handleSoloTrivia(ctx) {
  const { sock, jid, message, t, lang, settings } = ctx;
  const state = soloState.get(jid) || {};
  const mode = settings?.triviaMode === "fun" ? "fun" : "normal";

  if (vsState.has(jid)) {
    return say(sock, ctx, { text: t("trivia_vs_busy") });
  }

  if (state.lastUsed && Date.now() - state.lastUsed < SOLO_COOLDOWN) {
    const secsLeft = Math.ceil((SOLO_COOLDOWN - (Date.now() - state.lastUsed)) / 1000);
    return sendQuoted(sock, jid, { text: t("trivia_wait", { secs: secsLeft }) }, message, "trivia", 12_000);
  }

  soloState.set(jid, { ...state, lastUsed: Date.now(), active: false, lang, mode });

  let triviaData;
  try {
    triviaData = await loadQuestion(lang, mode, null);
  } catch (err) {
    console.error("❌ Trivia generation error:", err);
    return sendQuoted(sock, jid, { text: t("trivia_fail") }, message, "trivia", 12_000);
  }

  soloState.set(jid, {
    active: true,
    ...triviaData,
    mode,
    lastUsed: Date.now(),
    lang,
  });

  await sendQuoted(sock, jid, { text: renderTriviaQuestion(triviaData, t) }, message, "trivia", 20_000);
}

async function startVs(sock, ctx, opponent, total) {
  const { jid, senderId, t, lang, settings } = ctx;
  const mode = settings?.triviaMode === "fun" ? "fun" : "normal";

  if (sameUser(opponent, senderId)) {
    return say(sock, ctx, { text: t("trivia_vs_self") });
  }
  if (ctx.botJid && sameUser(opponent, ctx.botJid)) {
    return say(sock, ctx, { text: t("trivia_vs_bot") });
  }
  if (vsState.has(jid) || soloState.get(jid)?.active) {
    return say(sock, ctx, { text: t("trivia_vs_busy") });
  }

  const game = {
    a: senderId,
    b: opponent,
    turn: senderId,
    scoreA: 0,
    scoreB: 0,
    askedA: 0,
    askedB: 0,
    total,
    mode,
    lang,
    t,
    current: null,
    timer: null,
    seen: new Set(),
  };
  vsState.set(jid, game);

  await say(sock, ctx, {
    text: t("trivia_vs_start", {
      a: extractNumber(senderId),
      b: extractNumber(opponent),
      n: total,
      mode,
    }),
    mentions: [senderId, opponent],
  });

  try {
    await askVsTurn(sock, ctx, game);
  } catch (err) {
    console.error("❌ trivia vs start:", err);
    vsState.delete(jid);
    return say(sock, ctx, { text: t("trivia_fail") });
  }
}

export async function handleTriviaCommand(sock, ctx) {
  const raw = (ctx.argText || "").trim().toLowerCase();
  if (raw === "stop" || raw === "parar" || raw === "cancelar") {
    const game = vsState.get(ctx.jid);
    if (!game) return say(sock, ctx, { text: ctx.t("trivia_vs_none") });
    const canStop =
      ctx.isAdmin ||
      ctx.isOwner ||
      sameUser(ctx.senderId, game.a) ||
      sameUser(ctx.senderId, game.b);
    if (!canStop) return say(sock, ctx, { text: ctx.t("trivia_vs_admin_stop") });
    clearVsTimer(game);
    vsState.delete(ctx.jid);
    return say(sock, ctx, { text: ctx.t("trivia_vs_stopped") });
  }

  const opponent = vsOpponent(ctx);
  const count = parseVsCount(ctx.argText);
  if (opponent) {
    return startVs(sock, ctx, opponent, count);
  }
  if (onlyCountArg(ctx.argText)) {
    return say(sock, ctx, { text: ctx.t("trivia_vs_need_rival") });
  }
  return handleSoloTrivia(ctx);
}

async function handleSoloAnswer(sock, message, ctx) {
  const jid = message.key.remoteJid;
  const state = soloState.get(jid);
  if (!state?.active) return false;
  if (!isReplyToBot(message, sock)) return false;

  const pick = normalizeTriviaPick(getMessageText(message), state.format || "mc");
  if (!pick) return false;
  if (state.format === "tf" && !["A", "B"].includes(pick)) return false;

  const senderId = message.key.participant;
  const number = extractNumber(senderId);
  const tFn = ctx?.t || makeT(state.lang || "pt");
  const lang = state.lang || ctx?.lang || "pt";
  const correct = pick === state.answer;

  if (!correct && state.format !== "tf") {
    await sendQuoted(
      sock,
      jid,
      {
        text: tFn("trivia_wrong", {
          user: number,
          pick,
          option: state.options[pick] || pick,
        }),
        mentions: [senderId],
      },
      message,
      "trivia-wrong",
      12_000,
    ).catch((err) => console.error("trivia-wrong failed:", err.message));
    return true;
  }

  soloState.set(jid, { ...state, active: false });

  await withTyping(sock, jid, async () => {
    const header = correct
      ? tFn("trivia_right", {
          user: number,
          answer: state.answer,
          option: state.options[state.answer],
        })
      : tFn("trivia_wrong_reveal", {
          user: number,
          pick,
          option: state.options[pick] || pick,
          answer: state.answer,
          correct: state.options[state.answer],
        });
    let body = header;
    try {
      if (state.funny) {
        body = `${header}\n\n${tFn("trivia_explain", { explanation: state.funny })}`;
      } else {
        const explanation = await explainTriviaAnswer(
          {
            question: state.question,
            options: state.options,
            answer: state.answer,
          },
          lang,
        );
        body = `${header}\n\n${tFn("trivia_explain", { explanation })}`;
      }
    } catch (err) {
      console.error("❌ trivia explain failed:", err.message);
    }
    await sendQuoted(
      sock,
      jid,
      { text: body, mentions: [senderId] },
      message,
      correct ? "trivia-right" : "trivia-wrong-reveal",
      30_000,
    );
  }).catch((err) => console.error("trivia reveal failed:", err.message));

  return true;
}

async function handleVsAnswer(sock, message, ctx) {
  const jid = message.key.remoteJid;
  const game = vsState.get(jid);
  if (!game?.current) return false;
  if (!isReplyToBot(message, sock)) return false;

  const pick = normalizeTriviaPick(getMessageText(message), game.current.format || "mc");
  if (!pick) return false;
  if (game.current.format === "tf" && !["A", "B"].includes(pick)) return false;

  const senderId = message.key.participant;
  const t = game.t;
  if (!sameUser(senderId, game.a) && !sameUser(senderId, game.b)) {
    return false;
  }
  if (!sameUser(senderId, game.turn)) {
    await sendQuoted(sock, jid, { text: t("trivia_vs_wait") }, message, "trivia-vs-wait", 12_000);
    return true;
  }

  const item = game.current;
  const correct = pick === item.answer;
  const isA = sameUser(senderId, game.a);
  if (isA) game.askedA += 1;
  else game.askedB += 1;
  if (correct) {
    if (isA) game.scoreA += 1;
    else game.scoreB += 1;
  }
  game.current = null;
  clearVsTimer(game);

  const number = extractNumber(senderId);
  const header = correct
    ? t("trivia_right", {
        user: number,
        answer: item.answer,
        option: item.options[item.answer],
      })
    : t("trivia_wrong_reveal", {
        user: number,
        pick,
        option: item.options[pick] || pick,
        answer: item.answer,
        correct: item.options[item.answer],
      });
  const funny = item.funny
    ? `\n\n${t("trivia_explain", { explanation: item.funny })}`
    : "";

  const done = game.askedA >= game.total && game.askedB >= game.total;
  if (done) {
    await sendQuoted(
      sock,
      jid,
      {
        text: `${header}${funny}`,
        mentions: [senderId],
      },
      message,
      correct ? "trivia-vs-right" : "trivia-vs-wrong",
      20_000,
    );
    await finishVs(sock, jid, t("trivia_vs_done"), [game.a, game.b]);
    return true;
  }

  game.turn = isA ? game.b : game.a;
  await sendQuoted(
    sock,
    jid,
    {
      text: `${header}${funny}\n\n${scoreLine(game, t)}`,
      mentions: [senderId],
    },
    message,
    correct ? "trivia-vs-right" : "trivia-vs-wrong",
    20_000,
  );

  try {
    await withTyping(sock, jid, () => askVsTurn(sock, ctx, game));
  } catch (err) {
    console.error("❌ trivia vs next:", err);
    await finishVs(sock, jid, t("trivia_fail"), [game.a, game.b]);
  }
  return true;
}

export async function handleTriviaReply(sock, message, ctx) {
  const jid = message.key.remoteJid;
  if (!jid?.endsWith("@g.us")) return false;
  if (message.key.fromMe) return false;
  if (await handleVsAnswer(sock, message, ctx)) return true;
  return handleSoloAnswer(sock, message, ctx);
}
