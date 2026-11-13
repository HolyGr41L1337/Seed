// Event plumbing: the hub that feeds every connected client, and the hooks
// that let extensions observe and adjust what the agent does.

/** Broadcasts events to subscribers. Every event gets a global, increasing `seq`. */
export class EventHub {
  constructor() {
    this.seq = 0;
    this.subscribers = new Set();
  }

  emit(event) {
    const stamped = { ...event, seq: ++this.seq, at: Date.now() };
    for (const fn of this.subscribers) {
      try {
        fn(stamped);
      } catch {
        /* a broken subscriber must not stop the others */
      }
    }
    return stamped;
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}

/**
 * Named hook points. Handlers run in registration order; a handler that
 * throws is reported and skipped, so one extension cannot break a run.
 *
 *   run:start    { conversation }
 *   run:end      { conversation, status, error? }
 *   message      { conversation, message }
 *   tool:before  { conversation, name, args }  → may return { args } or { deny: 'reason' }
 *   tool:after   { conversation, name, args, result } → may return { result }
 */
export class Hooks {
  constructor(onError = () => {}) {
    this.handlers = new Map();
    this.onError = onError;
  }

  on(name, fn, owner = null) {
    if (typeof fn !== 'function') throw new Error(`hooks.on("${name}") needs a function.`);
    const entry = { fn, owner };
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(entry);
    return () => this.handlers.get(name)?.delete(entry);
  }

  /** Call every handler; returns the list of non-empty return values. */
  async run(name, payload) {
    const results = [];
    for (const entry of this.handlers.get(name) || []) {
      try {
        const value = await entry.fn(payload);
        if (value && typeof value === 'object') results.push(value);
      } catch (err) {
        this.onError(err, { hook: name, owner: entry.owner });
      }
    }
    return results;
  }
}
