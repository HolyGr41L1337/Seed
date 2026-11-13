// Conversation storage: one JSON file per conversation plus a small index
// for listing. Conversations are append-only by design (see docs/ARCHITECTURE.md):
// the frozen system prompt and tool set, and every message, are replayed
// unchanged to the model so provider-side prompt caches keep matching.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { newId, readJson, sha1, writeJsonAtomic } from './util.js';

const MAX_CACHED = 64;

export class Store {
  constructor(home) {
    this.dir = path.join(home, 'conversations');
    this.toolsetDir = path.join(home, 'toolsets');
    this.indexFile = path.join(this.dir, 'index.json');
    /** @type {Map<string, object>} live conversation objects */
    this.cache = new Map();
    this.index = null; // id → summary
    this.isBusy = () => false; // set by the app: conversations with a running agent are never evicted
    this.indexWrite = Promise.resolve();
  }

  async loadIndex() {
    if (this.index) return this.index;
    await fsp.mkdir(this.dir, { recursive: true });
    const stored = await readJson(this.indexFile, null).catch(() => null);
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      this.index = new Map(Object.entries(stored));
      return this.index;
    }
    // Rebuild from the conversation files.
    this.index = new Map();
    for (const name of await fsp.readdir(this.dir)) {
      if (!/^c_[\w-]+\.json$/.test(name)) continue;
      const conv = await readJson(path.join(this.dir, name), null).catch(() => null);
      if (conv?.id) this.index.set(conv.id, summarize(conv));
    }
    await this.saveIndex();
    return this.index;
  }

  saveIndex() {
    // Serialize index writes; each write takes the latest state.
    this.indexWrite = this.indexWrite
      .then(() => writeJsonAtomic(this.indexFile, Object.fromEntries(this.index)))
      .catch(() => {});
    return this.indexWrite;
  }

  file(id) {
    if (!/^c_[\w-]+$/.test(id)) throw Object.assign(new Error('Invalid conversation id.'), { status: 400 });
    return path.join(this.dir, `${id}.json`);
  }

  /** Summaries, most recently updated first. */
  async list() {
    const index = await this.loadIndex();
    return [...index.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id) {
    if (this.cache.has(id)) {
      const conv = this.cache.get(id);
      this.cache.delete(id); // refresh LRU position
      this.cache.set(id, conv);
      return conv;
    }
    const conv = await readJson(this.file(id), null);
    if (!conv) return null;
    this.remember(conv);
    return conv;
  }

  remember(conv) {
    this.cache.set(conv.id, conv);
    if (this.cache.size > MAX_CACHED) {
      for (const id of this.cache.keys()) {
        if (this.cache.size <= MAX_CACHED) break;
        if (id !== conv.id && !this.isBusy(id)) this.cache.delete(id);
      }
    }
  }

  async create(fields = {}) {
    const now = Date.now();
    const conv = {
      id: newId('c_'),
      title: '',
      createdAt: now,
      updatedAt: now,
      cwd: fields.cwd,
      model: fields.model || null,
      approval: fields.approval || null,
      system: fields.system || '',
      toolset: fields.toolset || null,
      messages: [],
      context: null, // { summary, from } after a compaction
      grants: {}, // "always allow" decisions made in this conversation
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(fields.ephemeral ? { ephemeral: true } : {}),
    };
    if (!conv.ephemeral) {
      this.remember(conv);
      await this.save(conv);
    }
    return conv;
  }

  async save(conv) {
    if (conv.ephemeral) return;
    conv.updatedAt = Date.now();
    await writeJsonAtomic(this.file(conv.id), conv);
    const index = await this.loadIndex();
    index.set(conv.id, summarize(conv));
    this.saveIndex();
  }

  async delete(id) {
    this.cache.delete(id);
    await fsp.rm(this.file(id), { force: true });
    const index = await this.loadIndex();
    const existed = index.delete(id);
    await this.saveIndex();
    return existed;
  }

  /** Tool sets are stored once by content hash and shared between conversations. */
  async putToolset(tools) {
    const json = JSON.stringify(tools);
    const id = sha1(json).slice(0, 16);
    const file = path.join(this.toolsetDir, `${id}.json`);
    try {
      await fsp.access(file);
    } catch {
      await writeJsonAtomic(file, tools);
    }
    return id;
  }

  async getToolset(id) {
    if (!id || !/^[0-9a-f]{16}$/.test(id)) return null;
    return readJson(path.join(this.toolsetDir, `${id}.json`), null);
  }
}

export function newMessage(role, content, meta) {
  return { id: newId('m_'), role, content, createdAt: Date.now(), ...(meta ? { meta } : {}) };
}

export function titleFrom(text) {
  const line = String(text || '').trim().split('\n').find((l) => l.trim()) || '';
  const clean = line.replace(/\s+/g, ' ').trim();
  return clean.length > 60 ? clean.slice(0, 59) + '…' : clean;
}

function summarize(conv) {
  return {
    id: conv.id,
    title: conv.title || '',
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    cwd: conv.cwd,
    model: conv.model,
    messageCount: conv.messages.length,
  };
}

/** The view of a conversation sent to clients: no provider-opaque payloads. */
export function publicConversation(conv, { full = false } = {}) {
  const { system, toolset, messages, ...rest } = conv;
  return {
    ...rest,
    ...(full ? { system, toolset } : {}),
    messages: messages.map(publicMessage),
  };
}

export function publicMessage(message) {
  if (!message.meta?.raw) return message;
  const { raw, ...meta } = message.meta;
  return { ...message, meta };
}
