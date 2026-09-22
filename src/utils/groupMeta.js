const cache = new Map();
const TTL_MS = 30_000;

export async function getGroupMeta(sock, jid) {
  const hit = cache.get(jid);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const data = await sock.groupMetadata(jid);
  cache.set(jid, { at: Date.now(), data });
  return data;
}

export function peekGroupMeta(jid) {
  return cache.get(jid)?.data;
}

export function invalidateGroupMeta(jid) {
  cache.delete(jid);
}
