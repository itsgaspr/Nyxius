let ready = false;
const waiters = [];

export function isWaReady() {
  return ready;
}

export function markWaReady(value) {
  ready = Boolean(value);
  if (ready) {
    for (const resolve of waiters.splice(0)) resolve(true);
  }
}

export function waitWaReady(ms = 15_000) {
  if (ready) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const idx = waiters.indexOf(done);
      if (idx >= 0) waiters.splice(idx, 1);
      resolve(ready);
    }, ms);
    function done() {
      clearTimeout(timer);
      resolve(true);
    }
    waiters.push(done);
  });
}

export async function waitForBaileysSocket(sock, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const me = sock?.user?.id || sock?.authState?.creds?.me?.id;
    const lid = sock?.user?.lid || sock?.authState?.creds?.me?.lid;
    const ws = sock?.ws;
    const wsOpen =
      Boolean(ws) &&
      (ws.isOpen === true ||
        ws.readyState === 1 ||
        ws.socket?.readyState === 1 ||
        ws._socket?.readyState === 1);
    if (me && lid && wsOpen) {
      await new Promise((r) => setTimeout(r, 800));
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return Boolean(sock?.user?.id);
}
