const MAX = 200;
const store = new Map();

export function rememberMessage(id, message) {
  if (!id || !message) return;
  store.set(id, message);
  while (store.size > MAX) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
}

export function getStoredMessage(id) {
  return store.get(id) || undefined;
}
