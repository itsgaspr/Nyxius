import { extractNumber, sameUser } from "../utils/jid.js";
import { isReplyToBot } from "../utils/message.js";
import { sendQuoted, withTyping } from "../utils/feedback.js";

const pending = new Map();
const games = new Map();
const CHALLENGE_MS = 30_000;

const EMPTY = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
const ACCEPT = ["sim", "yes", "aceito", "ok"];

function renderBoard(board) {
  const cell = (i) => board[i] || EMPTY[i];
  return `${cell(0)}${cell(1)}${cell(2)}\n${cell(3)}${cell(4)}${cell(5)}\n${cell(6)}${cell(7)}${cell(8)}`;
}

function winner(board) {
  const lines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];
  for (const [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  if (board.every(Boolean)) return "draw";
  return null;
}

function markFor(player, game) {
  return sameUser(player, game.x) ? "❌" : "⭕";
}

function say(sock, ctx, content, label = "ttt") {
  return sendQuoted(sock, ctx.jid, content, ctx.message, label, 20_000);
}

async function acceptChallenge(sock, ctx) {
  const { jid, senderId, t } = ctx;
  const challenge = pending.get(jid);
  if (!challenge) return;
  if (!sameUser(senderId, challenge.opponent)) {
    return say(sock, ctx, { text: t("ttt_not_yours") });
  }
  if (Date.now() > challenge.expires) {
    pending.delete(jid);
    return say(sock, ctx, { text: t("ttt_expired") });
  }
  pending.delete(jid);
  const next = {
    x: challenge.challenger,
    o: challenge.opponent,
    board: Array(9).fill(null),
    turn: challenge.challenger,
  };
  games.set(jid, next);
  const xNum = extractNumber(next.x);
  const oNum = extractNumber(next.o);
  return say(sock, ctx, {
    text: t("ttt_started", {
      x: xNum,
      o: oNum,
      board: renderBoard(next.board),
      turn: xNum,
    }),
    mentions: [next.x, next.o],
  });
}

export async function handleTttReply(sock, ctx) {
  if (!isReplyToBot(ctx.message, sock)) return false;
  const raw = (ctx.text || "").trim().toLowerCase();
  if (!raw || raw.startsWith(".")) return false;

  const game = games.get(ctx.jid);
  if (game && /^[1-9]$/.test(raw)) {
    await withTyping(sock, ctx.jid, () => playMove(sock, ctx, Number(raw) - 1));
    return true;
  }

  if (pending.get(ctx.jid) && ACCEPT.includes(raw)) {
    await withTyping(sock, ctx.jid, () => acceptChallenge(sock, ctx));
    return true;
  }
  return false;
}

export async function handleTttCommand(sock, ctx) {
  const { jid, senderId, argText, target, t, message } = ctx;
  const arg = (argText || "").trim().toLowerCase();
  const game = games.get(jid);
  const challenge = pending.get(jid);
  const replied = isReplyToBot(message, sock);

  if (game && /^[1-9]$/.test(arg)) {
    if (!replied) return;
    return playMove(sock, ctx, Number(arg) - 1);
  }

  if (challenge && ACCEPT.includes(arg)) {
    if (!replied) return;
    return acceptChallenge(sock, ctx);
  }

  if (arg === "stop" || arg === "parar") {
    pending.delete(jid);
    games.delete(jid);
    return say(sock, ctx, { text: t("ttt_stopped") });
  }

  if (game && !arg) {
    const turnNum = extractNumber(game.turn);
    return say(sock, ctx, {
      text: t("ttt_status", { board: renderBoard(game.board), turn: turnNum }),
      mentions: [game.turn],
    });
  }

  if (target) {
    if (sameUser(target, senderId)) {
      return say(sock, ctx, { text: t("ttt_self") });
    }
    if (game) {
      return say(sock, ctx, { text: t("ttt_busy") });
    }
    pending.set(jid, {
      challenger: senderId,
      opponent: target,
      expires: Date.now() + CHALLENGE_MS,
    });
    const oppNum = extractNumber(target);
    const meNum = extractNumber(senderId);
    return say(sock, ctx, {
      text: t("ttt_challenge", { me: meNum, opp: oppNum }),
      mentions: [senderId, target],
    });
  }

  return say(sock, ctx, { text: t("ttt_usage") });
}

async function playMove(sock, ctx, index) {
  const { jid, senderId, t } = ctx;
  const game = games.get(jid);
  if (!game) return;

  if (!sameUser(senderId, game.x) && !sameUser(senderId, game.o)) {
    return say(sock, ctx, { text: t("ttt_not_in") });
  }

  if (!sameUser(senderId, game.turn)) {
    return say(sock, ctx, { text: t("ttt_wait") });
  }

  if (game.board[index]) {
    return say(sock, ctx, { text: t("ttt_taken") });
  }

  game.board[index] = markFor(senderId, game);
  const result = winner(game.board);
  const board = renderBoard(game.board);

  if (result === "draw") {
    games.delete(jid);
    return say(sock, ctx, { text: t("ttt_draw", { board }) });
  }

  if (result) {
    games.delete(jid);
    const num = extractNumber(senderId);
    return say(sock, ctx, {
      text: t("ttt_win", { user: num, board }),
      mentions: [senderId],
    });
  }

  game.turn = sameUser(senderId, game.x) ? game.o : game.x;
  const turnNum = extractNumber(game.turn);
  return say(sock, ctx, {
    text: t("ttt_turn", { board, turn: turnNum }),
    mentions: [game.turn],
  });
}
