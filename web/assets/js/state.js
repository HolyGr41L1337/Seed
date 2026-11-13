// Shared UI state and a small event bus.

export const state = {
  info: null, // GET /api/info
  config: null, // GET /api/config (no secrets)
  view: 'home', // 'home' | 'chat' | 'page'
  conversationId: null,
  conversation: null, // the open conversation (messages kept current by events)
  running: false, // the open conversation has a run in progress
  page: null, // name of the open extension view
  safeMode: false,
};

const subscribers = new Set();

export function setState(patch) {
  Object.assign(state, patch);
  for (const fn of [...subscribers]) {
    try {
      fn(state);
    } catch (err) {
      reportError(err);
    }
  }
}

/** Called after every state change. Returns a function that stops the subscription. */
export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

const listeners = new Map();

/**
 * Listen to events: server events by their type ("message.added",
 * "run.completed", "ext.<name>.<type>", ...), "*" for every server event, and
 * local ones ("route", "conversation.opened", "send").
 */
export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type)?.delete(fn);
}

export function emit(type, payload) {
  for (const fn of [...(listeners.get(type) || [])]) {
    try {
      fn(payload);
    } catch (err) {
      reportError(err);
    }
  }
}

/** Errors thrown by handlers surface as window "error" events so extension errors can be attributed. */
function reportError(err) {
  setTimeout(() => {
    throw err;
  });
}
