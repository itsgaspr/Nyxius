import { pg } from "../config/db.js";

const DEFAULT_SETTINGS = {
  antilink: false,
  antispam: false,
  antimedia: false,
  welcomeEnabled: false,
  welcomeText: null,
  warnLimit: 3,
  lang: "pt",
};

const settingsCache = new Map();

async function initTables() {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS public.group_settings (
      group_jid VARCHAR(255) PRIMARY KEY,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await pg.query(`
    CREATE TABLE IF NOT EXISTS public.warnings (
      group_jid VARCHAR(255) NOT NULL,
      user_number VARCHAR(64) NOT NULL,
      count INT NOT NULL DEFAULT 0,
      last_reason TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (group_jid, user_number)
    )
  `);
  await pg.query(`
    CREATE TABLE IF NOT EXISTS public.mod_logs (
      id SERIAL PRIMARY KEY,
      group_jid VARCHAR(255) NOT NULL,
      action VARCHAR(64) NOT NULL,
      actor VARCHAR(255),
      target VARCHAR(255),
      reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

try {
  await initTables();
  console.log("moderation tables ready");
} catch (err) {
  console.error("Error initializing moderation tables:", err);
}

export async function getSettings(groupJid) {
  try {
    const result = await pg.query(
      "SELECT settings FROM public.group_settings WHERE group_jid = $1",
      [groupJid],
    );
    const settings = result.rows.length
      ? { ...DEFAULT_SETTINGS, ...result.rows[0].settings }
      : { ...DEFAULT_SETTINGS };
    settingsCache.set(groupJid, settings);
    return settings;
  } catch (err) {
    console.error("getSettings error:", err.message);
    const cached = settingsCache.get(groupJid);
    if (cached) return { ...cached };
    return { ...DEFAULT_SETTINGS };
  }
}

export async function updateSettings(groupJid, patch) {
  const current = await getSettings(groupJid);
  const next = { ...current, ...patch };
  settingsCache.set(groupJid, next);
  try {
    await pg.query(
      `INSERT INTO public.group_settings (group_jid, settings)
       VALUES ($1, $2)
       ON CONFLICT (group_jid) DO UPDATE SET settings = $2`,
      [groupJid, next],
    );
  } catch (err) {
    console.error("updateSettings error:", err.message);
  }
  return next;
}

export async function incrementWarn(groupJid, userNumber, reason = null) {
  const settings = await getSettings(groupJid);
  const result = await pg.query(
    `INSERT INTO public.warnings (group_jid, user_number, count, last_reason, updated_at)
     VALUES ($1, $2, 1, $3, NOW())
     ON CONFLICT (group_jid, user_number)
     DO UPDATE SET
       count = public.warnings.count + 1,
       last_reason = COALESCE($3, public.warnings.last_reason),
       updated_at = NOW()
     RETURNING count`,
    [groupJid, userNumber, reason],
  );
  const count = result.rows[0].count;
  const limit = settings.warnLimit || DEFAULT_SETTINGS.warnLimit;
  return { count, limit, shouldKick: count >= limit };
}

export async function decrementWarn(groupJid, userNumber) {
  const result = await pg.query(
    `UPDATE public.warnings
     SET count = GREATEST(count - 1, 0), updated_at = NOW()
     WHERE group_jid = $1 AND user_number = $2
     RETURNING count`,
    [groupJid, userNumber],
  );
  if (!result.rows.length) return { count: 0 };
  if (result.rows[0].count === 0) {
    await pg.query(
      "DELETE FROM public.warnings WHERE group_jid = $1 AND user_number = $2",
      [groupJid, userNumber],
    );
  }
  return { count: result.rows[0].count };
}

export async function resetWarn(groupJid, userNumber) {
  await pg.query(
    "DELETE FROM public.warnings WHERE group_jid = $1 AND user_number = $2",
    [groupJid, userNumber],
  );
}

export async function listWarns(groupJid) {
  const result = await pg.query(
    `SELECT user_number, count, last_reason, updated_at
     FROM public.warnings
     WHERE group_jid = $1 AND count > 0
     ORDER BY count DESC, updated_at DESC`,
    [groupJid],
  );
  return result.rows;
}

export async function addLog({ groupJid, action, actor, target, reason }) {
  try {
    await pg.query(
      `INSERT INTO public.mod_logs (group_jid, action, actor, target, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [groupJid, action, actor || null, target || null, reason || null],
    );
  } catch (err) {
    console.error("addLog error:", err);
  }
}

export async function getLogs(groupJid, limit = 10) {
  const result = await pg.query(
    `SELECT action, actor, target, reason, created_at
     FROM public.mod_logs
     WHERE group_jid = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [groupJid, limit],
  );
  return result.rows;
}
