// Registry of connected UI pages (one per open event stream). Lets the
// server reach a page directly, which is how the ui_eval tool works.
import { newId } from '../util.js';

export class Clients {
  constructor() {
    this.map = new Map(); // clientId → { send, conversationId, seen }
    this.pending = new Map(); // evalId → { resolve, timer }
  }

  get size() {
    return this.map.size;
  }

  add(id, send, conversationId = null) {
    const entry = { send, conversationId, seen: Date.now() };
    this.map.set(id, entry);
    return () => {
      if (this.map.get(id) === entry) this.map.delete(id);
    };
  }

  /** The page says which conversation it is showing. */
  touch(id, conversationId) {
    const entry = this.map.get(id);
    if (!entry) return;
    entry.seen = Date.now();
    if (conversationId !== undefined) entry.conversationId = conversationId;
  }

  /** Prefer the page that shows the given conversation, otherwise the most recently active one. */
  pick(conversationId) {
    let best = null;
    for (const entry of this.map.values()) {
      if (conversationId && entry.conversationId === conversationId) return entry;
      if (!best || entry.seen > best.seen) best = entry;
    }
    return best;
  }

  /** Run code in a page. Resolves with { ok, value } or { ok: false, error }. */
  eval(code, { conversationId = null, timeoutMs = 10_000 } = {}) {
    const client = this.pick(conversationId);
    if (!client) {
      return Promise.resolve({ ok: false, error: 'No UI page is open, so there is nothing to inspect. Ask the user to open the app in a browser.' });
    }
    return new Promise((resolve) => {
      const evalId = newId('e_');
      const timer = setTimeout(() => {
        this.pending.delete(evalId);
        resolve({ ok: false, error: `The page did not answer within ${timeoutMs / 1000}s.` });
      }, timeoutMs);
      this.pending.set(evalId, { resolve, timer });
      client.send({ type: 'ui.eval', evalId, code });
    });
  }

  resolveEval(evalId, payload) {
    const pending = this.pending.get(evalId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(evalId);
    pending.resolve(payload?.ok ? { ok: true, value: String(payload.value ?? 'undefined') } : { ok: false, error: String(payload?.error || 'unknown error') });
    return true;
  }
}
