import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import fs from "fs";
import { pg } from "../config/db.js";
import { SESSION_DIR, syncSessionFromDB, syncSessionToDB } from "./sessionService.js";
import { handleMessage } from "../controllers/messageController.js";
import { handleGroupParticipantsUpdate } from "../controllers/groupEventsController.js";
import { rememberMessage, getStoredMessage } from "../utils/msgStore.js";
import { groupJidOf } from "../utils/jid.js";
import { peekGroupMeta, rememberGroupMeta, warmAllGroups, getGroupMeta, invalidateGroupMeta } from "../utils/groupMeta.js";
import { isWaReady, markWaReady, waitForBaileysSocket } from "../utils/waReady.js";

let isConnecting = false;
let sock = null;
let reconnectTimer = null;
let reconnectDelay = 5_000;
const pendingUpserts = [];
const handledIds = new Set();
const MAX_RECONNECT_DELAY = 60_000;
const MAX_HANDLED_IDS = 800;

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function dropSocket() {
  markWaReady(false);
  pendingUpserts.length = 0;
  handledIds.clear();
  const old = sock;
  sock = null;
  if (!old) return;
  try {
    old.ev.removeAllListeners();
  } catch {
    // ignore
  }
  try {
    old.end(undefined);
  } catch {
    // ignore
  }
}

export async function startBot() {
  if (isConnecting) return;
  isConnecting = true;
  clearReconnect();
  dropSocket();

  await syncSessionFromDB();
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    connectTimeoutMs: 20_000,
    keepAliveIntervalMs: 30_000,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    cachedGroupMetadata: async (jid) => peekGroupMeta(jid),
    getMessage: async (key) => getStoredMessage(key?.id),
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    await syncSessionToDB();
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("Scan the QR code below with WhatsApp:");
      qrcode.toString(qr, { type: "terminal", small: true }, (err, url) => {
        if (!err) console.log(url);
      });
    }

    if (connection === "open") {
      console.log("WA connected — waiting for Baileys socket…");
      isConnecting = false;
      reconnectDelay = 5_000;
      const opened = sock;
      const ok = await waitForBaileysSocket(opened);
      if (sock === opened && ok) {
        markWaReady(true);
        console.log(
          `✅ Nyxius ready  pn=${sock.user?.id || "?"}  lid=${sock.user?.lid || sock.authState?.creds?.me?.lid || "?"}`,
        );
        try {
          await warmAllGroups(opened);
        } catch (err) {
          console.warn("⚠️  group warmup failed:", err.message);
        }
        if (sock === opened) flushPending();
      } else {
        console.warn("⚠️  Socket did not become ready in time");
      }
    }

    if (connection === "close") {
      markWaReady(false);
      if (!sock) return;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log("Connection closed:", statusCode);

      if (shouldReconnect) {
        isConnecting = false;
        const delay = reconnectDelay;
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
        console.log(`Reconnecting in ${delay / 1000}s...`);
        clearReconnect();
        reconnectTimer = setTimeout(() => {
          startBot().catch((err) => console.error("reconnect failed:", err.message));
        }, delay);
      } else {
        console.log("Logged out — clearing session");
        await pg.query("DELETE FROM whatsapp_sessions WHERE id = $1", ["baileys"]).catch(() => {});
        fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        isConnecting = false;
      }
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (!isWaReady()) {
      if (type === "notify") pendingUpserts.push({ messages, type });
      console.log(`⏳ socket not ready, queued ${messages?.length || 0} ${type || "upsert"}`);
      return;
    }
    processUpsert(messages, type);
  });

  sock.ev.on("messages.update", (updates) => {
    const messages = [];
    for (const item of updates || []) {
      if (!item?.update?.message || !item.key) continue;
      messages.push({ key: item.key, message: item.update.message });
    }
    if (!messages.length) return;
    if (!isWaReady()) {
      pendingUpserts.push({ messages, type: "notify" });
      return;
    }
    processUpsert(messages, "notify");
  });

  sock.ev.on("groups.upsert", (groups) => {
    for (const meta of groups || []) {
      if (meta?.id) rememberGroupMeta(meta.id, meta);
    }
  });

  sock.ev.on("groups.update", (updates) => {
    for (const update of updates || []) {
      const id = update?.id;
      if (!id?.endsWith("@g.us")) continue;
      invalidateGroupMeta(id);
      getGroupMeta(sock, id).catch((err) => console.warn(`⚠️  groups.update meta ${id}: ${err.message}`));
    }
  });

  sock.ev.on("group-participants.update", async (update) => {
    if (!isWaReady()) {
      console.log("⏳ socket not ready, skipping group event");
      return;
    }
    try {
      await handleGroupParticipantsUpdate(sock, update);
    } catch (err) {
      console.error("group-participants.update error:", err);
    }
  });
}

function rememberHandled(id) {
  if (!id) return;
  handledIds.add(id);
  if (handledIds.size <= MAX_HANDLED_IDS) return;
  const oldest = handledIds.values().next().value;
  handledIds.delete(oldest);
}

function processUpsert(messages, type) {
  for (const message of messages || []) {
    if (message?.key?.fromMe && message.message) {
      rememberMessage(message.key.id, message.message);
    }
    if (!message?.message) {
      const jid = groupJidOf(message?.key);
      if (type === "notify" && jid) {
        console.log(`🔒 group ciphertext ${jid} id=${message.key?.id || "?"} — waiting for decrypt`);
      }
      continue;
    }
    const id = message.key?.id;
    if (id && handledIds.has(id)) continue;
    rememberHandled(id);
    handleMessage(sock, message).catch((err) => {
      console.error("🔥 Fatal error in handleMessage:", err);
    });
  }
}

function flushPending() {
  const queued = pendingUpserts.splice(0);
  if (!queued.length) return;
  console.log(`▶️  flushing ${queued.length} queued upsert(s)`);
  for (const { messages, type } of queued) processUpsert(messages, type);
}
