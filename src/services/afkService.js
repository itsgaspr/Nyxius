import { pg } from "../config/db.js";
import { extractNumber } from "../utils/jid.js";

const cache = new Map();

try {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS public.afk_status (
      group_jid VARCHAR(255) NOT NULL,
      user_number VARCHAR(64) NOT NULL,
      reason TEXT NOT NULL,
      since TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (group_jid, user_number)
    )
  `);
  const rows = await pg.query("SELECT group_jid, user_number, reason, since FROM public.afk_status");
  for (const row of rows.rows) {
    cache.set(`${row.group_jid}:${row.user_number}`, {
      reason: row.reason,
      since: row.since,
    });
  }
} catch (err) {
  console.error("afk table error:", err.message);
}

export function getAfk(groupJid, user) {
  const num = extractNumber(user);
  if (!num) return null;
  return cache.get(`${groupJid}:${num}`) || null;
}

export async function setAfk(groupJid, user, reason) {
  const num = extractNumber(user);
  const entry = { reason: String(reason).trim(), since: new Date() };
  cache.set(`${groupJid}:${num}`, entry);
  try {
    await pg.query(
      `INSERT INTO public.afk_status (group_jid, user_number, reason, since)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (group_jid, user_number)
       DO UPDATE SET reason = $3, since = NOW()`,
      [groupJid, num, entry.reason],
    );
  } catch (err) {
    console.error("setAfk error:", err.message);
  }
  return entry;
}

export async function clearAfk(groupJid, user) {
  const num = extractNumber(user);
  const prev = cache.get(`${groupJid}:${num}`) || null;
  cache.delete(`${groupJid}:${num}`);
  try {
    await pg.query("DELETE FROM public.afk_status WHERE group_jid = $1 AND user_number = $2", [
      groupJid,
      num,
    ]);
  } catch (err) {
    console.error("clearAfk error:", err.message);
  }
  return prev;
}

export function listAfkHits(groupJid, jids) {
  const hits = [];
  const seen = new Set();
  for (const jid of jids || []) {
    const num = extractNumber(jid);
    if (!num || seen.has(num)) continue;
    const entry = cache.get(`${groupJid}:${num}`);
    if (!entry) continue;
    seen.add(num);
    hits.push({ user: num, jid, reason: entry.reason, since: entry.since });
  }
  return hits;
}
