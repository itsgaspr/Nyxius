//queries for sessions

import { pg } from "../config/db.js";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SESSION_DIR = path.join(__dirname, '..', '..', 'whatsapp_sessions');

// Initialize table on startup
async function initTable() {
    try {
        await pg.query('CREATE TABLE IF NOT EXISTS public.whatsapp_sessions (id VARCHAR(255) PRIMARY KEY, session_data JSONB)');
    } catch (err) {
        console.error('Error initializing sessions table:', err);
    }
}

await initTable();

let syncTimer = null;
let syncing = false;
let syncQueued = false;

export async function syncSessionFromDB() {
  try {
    const credsPath = path.join(SESSION_DIR, "creds.json");
    if (fs.existsSync(credsPath)) {
      console.log("✅ Using local WhatsApp session");
      return;
    }

    const result = await pg.query(
      "SELECT session_data FROM public.whatsapp_sessions WHERE id = $1",
      ["baileys"],
    );
    if (result.rows.length > 0) {
      const sessionData = result.rows[0].session_data;
      fs.mkdirSync(SESSION_DIR, { recursive: true });

      if (sessionData && typeof sessionData === "object") {
        for (const [filename, content] of Object.entries(sessionData)) {
          const filePath = path.join(SESSION_DIR, filename);
          fs.writeFileSync(filePath, JSON.stringify(content));
        }
      }
      console.log("✅ Session restored from database");
    }
  } catch (err) {
    console.error("Error syncing session from DB:", err.message);
  }
}

export async function syncSessionToDB() {
  syncQueued = true;
  if (syncTimer || syncing) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    flushSessionToDB();
  }, 1500);
}

async function flushSessionToDB() {
  if (syncing) {
    syncQueued = true;
    return;
  }
  if (!syncQueued) return;
  syncQueued = false;
  syncing = true;
  try {
    if (!fs.existsSync(SESSION_DIR)) return;

    const files = fs.readdirSync(SESSION_DIR);
    const sessionData = {};

    for (const file of files) {
      const filePath = path.join(SESSION_DIR, file);
      const content = fs.readFileSync(filePath, "utf-8");
      try {
        sessionData[file] = JSON.parse(content);
      } catch {
        sessionData[file] = content;
      }
    }

    await pg.query(
      "INSERT INTO public.whatsapp_sessions (id, session_data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET session_data = $2",
      ["baileys", sessionData],
    );
    console.log("✅ Session synced to database");
  } catch (err) {
    console.error("Error syncing session to DB:", err.message);
  } finally {
    syncing = false;
    if (syncQueued) {
      syncTimer = setTimeout(() => {
        syncTimer = null;
        flushSessionToDB();
      }, 1500);
    }
  }
}

export function setupTableQuery() {
    return {
        text: 'CREATE TABLE IF NOT EXISTS public.whatsapp_sessions (id VARCHAR(255) PRIMARY KEY, session_data JSONB)',
    }
}


export function loadSessionQuery() {
    return {
        text: `SELECT session_data FROM public.whatsapp_sessions WHERE id = $1`,
        values: ['baileys']
    };
}

export function saveSessionQuery(data) {
    return {
        text: 'INSERT INTO public.whatsapp_sessions (id, session_data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET session_data = $2',
        values: ['baileys', data]
    }
}
