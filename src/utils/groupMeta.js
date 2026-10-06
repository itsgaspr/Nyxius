const cache = new Map();
const inflight = new Map();
const TTL_MS = 5 * 60_000;
const FETCH_MS = 8_000;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("group_meta_timeout")), ms);
    }),
  ]);
}

export function rememberGroupMeta(jid, data) {
  if (!jid || !data) return;
  cache.set(jid, { at: Date.now(), data });
}

export function peekGroupMeta(jid) {
  return cache.get(jid)?.data;
}

export function invalidateGroupMeta(jid) {
  cache.delete(jid);
}

async function fetchMeta(sock, jid, stale) {
  try {
    const data = await withTimeout(sock.groupMetadata(jid), FETCH_MS);
    rememberGroupMeta(jid, data);
    return data;
  } catch (err) {
    if (stale?.data) {
      console.warn(`⚠️  group meta stale ${jid}: ${err.message}`);
      return stale.data;
    }
    throw err;
  }
}

export async function getGroupMeta(sock, jid) {
  const hit = cache.get(jid);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const pending = inflight.get(jid);
  if (pending) return pending;

  const task = fetchMeta(sock, jid, hit).finally(() => inflight.delete(jid));
  inflight.set(jid, task);
  return task;
}

export function warmAllGroups(sock) {
  const pending = sock.groupFetchAllParticipating().then((groups) => {
    const list = Object.values(groups || {});
    for (const meta of list) {
      if (meta?.id) rememberGroupMeta(meta.id, meta);
    }
    console.log(`👥 subscribed groups: ${list.length}`);
    return list.length;
  });
  return withTimeout(pending, 20_000);
}
