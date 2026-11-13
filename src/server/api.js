// The REST API as plain functions: dispatch({ method, url, body, actor })
// → { status, body }. The HTTP server calls it for network requests and the
// seed_api tool calls it directly, so the agent and outside programs use
// exactly the same interface. docs/API.md describes every endpoint.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APPROVAL_MODES, PROVIDER_TYPES } from '../config.js';
import { compactConversation } from '../agent/compaction.js';
import { userContent } from '../agent/messages.js';
import { PRESETS, presetById } from '../providers/presets.js';
import { newMessage, publicConversation, publicMessage } from '../store.js';
import { APP_DIR, VERSION, expandHome } from '../util.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    Object.assign(this, extra);
  }
}

export const RESPONSE = Symbol('seed.response');

export class Api {
  constructor(app) {
    this.app = app;
    this.routes = [];
    this.define();
  }

  route(method, pattern, handler) {
    this.routes.push({ method, segments: pattern.split('/').filter(Boolean), handler });
  }

  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method || r.segments.length !== parts.length) continue;
      const params = {};
      const ok = r.segments.every((seg, i) => {
        if (seg.startsWith(':')) {
          try {
            params[seg.slice(1)] = decodeURIComponent(parts[i]);
          } catch {
            return false;
          }
          return true;
        }
        return seg === parts[i];
      });
      if (ok) return { handler: r.handler, params };
    }
    return null;
  }

  /**
   * @param {{ method: string, url: string, body?: any, actor?: { source: 'user' | 'agent', conversationId?: string, mode?: string },
   *           clientId?: string, headers?: object }} req
   * @returns {Promise<{ status: number, body: any, type?: string, headers?: object }>}
   */
  async dispatch(req) {
    const actor = req.actor || { source: 'user' };
    try {
      const url = new URL(req.url, 'http://seed.local');
      const query = Object.fromEntries(url.searchParams);
      const method = String(req.method).toUpperCase();

      if (url.pathname.startsWith('/ext/')) {
        const hit = this.app.extensions.matchRoute(method, url.pathname);
        if (!hit) throw new HttpError(404, `No extension route for ${method} ${url.pathname}.`);
        const value = await hit.route.handler({
          method,
          path: url.pathname,
          params: hit.params,
          query,
          headers: req.headers || {},
          body: req.body,
        });
        return normalizeRouteResult(value);
      }

      const hit = this.match(method, url.pathname);
      if (!hit) throw new HttpError(404, `Unknown endpoint: ${method} ${url.pathname}. See docs/API.md.`);
      const value = await hit.handler({ params: hit.params, query, body: req.body ?? {}, actor, clientId: req.clientId || null });
      if (value && value[RESPONSE]) return value;
      return { status: 200, body: value ?? { ok: true } };
    } catch (err) {
      // An error from the model API is not this server's own status: a rejected model key
      // must not look like a rejected Seed token.
      const upstream = err.name === 'ProviderError';
      const status = upstream ? 502 : Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
      if (status === 500) console.error('[seed] API error:', err);
      return {
        status,
        body: { error: { message: err.message || String(err), kind: err.kind || undefined, ...(upstream && err.status ? { upstreamStatus: err.status } : {}) } },
      };
    }
  }

  async conversation(id) {
    const conv = await this.app.store.get(id);
    if (!conv) throw new HttpError(404, `Conversation not found: ${id}`);
    return conv;
  }

  /**
   * Shared by POST /api/chat and POST /api/conversations/:id/messages.
   * Creates the conversation when needed and starts the run.
   */
  async startChat({ conversationId, body, actor, onEvent }) {
    const { app } = this;
    const agent = actor.source === 'agent';
    if (agent && conversationId && conversationId === actor.conversationId) {
      throw new HttpError(403, 'You cannot send a message to the conversation you are running in.');
    }
    const content = userContent(body.content ?? body.message);
    if (body.approval != null && !APPROVAL_MODES.includes(body.approval)) {
      throw new HttpError(400, `approval must be one of: ${APPROVAL_MODES.join(', ')}.`);
    }
    const existing = conversationId ? await this.conversation(conversationId) : null;
    // Fail before creating anything when no model can be used.
    if (!body.model && !existing?.model) await app.ensureDefaultModel();
    app.providers.resolve(body.model || existing?.model);
    const conv = existing || (await app.createConversation({ cwd: body.cwd, model: body.model, system: body.system }));
    const run = await app.runs.start(conv, {
      content,
      model: body.model,
      // A run started by the agent never gets more freedom than the agent has, and cannot ask the user.
      approval: agent ? actor.mode : body.approval,
      interactive: agent ? false : body.interactive !== false,
      onEvent,
    });
    return { conv, run };
  }

  /** What a finished run produced, for callers that wait for it. */
  outcome(conv, firstNewIndex, result) {
    const fresh = conv.messages.slice(firstNewIndex).map(publicMessage);
    const text = fresh
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text))
      .join('\n\n');
    return { conversationId: conv.id, status: result.status, ...(result.error ? { error: result.error } : {}), text, messages: fresh };
  }

  define() {
    const { app } = this;
    const notAgent = (actor, what) => {
      if (actor.source === 'agent') throw new HttpError(403, `The agent is not allowed to ${what}.`);
    };
    const notOwn = (actor, id, what) => {
      if (actor.source === 'agent' && actor.conversationId === id) {
        throw new HttpError(403, `You cannot ${what} the conversation you are running in.`);
      }
    };

    // ---- app ---------------------------------------------------------------
    this.route('GET', '/api/info', () => ({
      name: 'seed',
      version: VERSION,
      cwd: app.cwd,
      home: app.home,
      appDir: APP_DIR,
      extensionsDir: app.extensionsDir,
      homeDir: os.homedir(),
      platform: process.platform,
      safeMode: !!app.safeMode,
      connected: Object.keys(app.config.data.providers).length > 0,
      model: app.config.data.model,
      approval: app.config.approval,
      seq: app.events.seq,
    }));

    this.route('GET', '/api/resolve-dir', ({ query }) => ({ path: app.resolveDirectory(query.path || '.') }));

    this.route('GET', '/api/config', () => app.config.public());
    this.route('PATCH', '/api/config', ({ body, actor }) => app.config.update(body, { source: actor.source }));

    this.route('GET', '/api/tools', () => ({
      tools: app.tools.definitions().map((t) => ({ ...t, source: app.tools.source(t.name) })),
    }));

    // ---- providers and models ------------------------------------------------
    this.route('GET', '/api/providers/presets', () => ({
      presets: PRESETS.map(({ id, name, type, baseURL, keyHint, keyUrl, noKey, custom, models, defaultModel }) => ({
        id, name, type, baseURL, keyHint: keyHint || '', keyUrl: keyUrl || '', noKey: !!noKey, custom: !!custom, models, defaultModel: defaultModel || null,
      })),
    }));

    const entryFrom = (body) => {
      if (!PROVIDER_TYPES.includes(body.type)) throw new HttpError(400, `type must be one of: ${PROVIDER_TYPES.join(', ')}.`);
      const entry = { type: body.type };
      if (body.name) entry.name = String(body.name);
      if (body.baseURL) entry.baseURL = String(body.baseURL).trim();
      if (body.type === 'openai' && !entry.baseURL) throw new HttpError(400, 'baseURL is required for an OpenAI-compatible API.');
      if (entry.baseURL && !/^https?:\/\//.test(entry.baseURL)) throw new HttpError(400, 'baseURL must start with http:// or https://.');
      let key = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      // Editing an existing provider without retyping its key.
      if (!key && body.id && app.config.data.providers[body.id]?.apiKey) key = app.config.data.providers[body.id].apiKey;
      if (key) entry.apiKey = key;
      if (body.params && typeof body.params === 'object') entry.params = body.params;
      if (body.headers && typeof body.headers === 'object') entry.headers = body.headers;
      return entry;
    };

    this.route('POST', '/api/providers/test', async ({ body }) => {
      const result = await app.providers.test(entryFrom(body), { model: body.model || null, presetId: body.presetId });
      return { ok: true, ...result };
    });

    this.route('POST', '/api/providers', async ({ body }) => {
      const id = String(body.id || '').trim();
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id)) throw new HttpError(400, 'id must be 1-32 letters, digits, "-" or "_".');
      const entry = entryFrom(body);
      if (!entry.name) entry.name = presetById(body.presetId)?.name || id;
      let model = body.model ? String(body.model).trim() : null;
      if (body.test !== false) {
        const tested = await app.providers.test(entry, { model, presetId: body.presetId });
        model = model || tested.suggested;
      }
      if (!model) {
        throw new HttpError(400, 'The API works, but it did not say which models it has. Enter the model name.', { kind: 'model_required' });
      }
      if (model) entry.models = [model];
      const patch = { providers: { [id]: null } };
      await app.config.update(patch); // replace, not merge, an existing entry
      const next = { providers: { [id]: entry } };
      if (model && (body.setDefault !== false || !app.config.data.model)) next.model = `${id}/${model}`;
      const config = await app.config.update(next);
      return { ok: true, config, model: model ? `${id}/${model}` : null };
    });

    this.route('DELETE', '/api/providers/:id', async ({ params, actor }) => {
      notAgent(actor, 'remove a provider');
      if (!app.config.data.providers[params.id]) throw new HttpError(404, `No provider named "${params.id}".`);
      const patch = { providers: { [params.id]: null } };
      if (app.config.data.model?.startsWith(`${params.id}/`)) patch.model = null;
      return { ok: true, config: await app.config.update(patch) };
    });

    this.route('GET', '/api/models', async ({ query }) => {
      const ids = query.provider ? [query.provider] : Object.keys(app.config.data.providers);
      const providers = await Promise.all(
        ids.map(async (id) => {
          const cfg = app.config.data.providers[id];
          if (!cfg) throw new HttpError(404, `No provider named "${id}".`);
          const out = { id, name: cfg.name || id, type: cfg.type, models: [] };
          try {
            const models = await app.providers.get(id).listModels();
            out.models = models.map((m) => ({ id: m.id, ref: `${id}/${m.id}`, name: m.name || m.id }));
          } catch (err) {
            out.error = err.message;
            out.models = (cfg.models || []).map((m) => ({ id: m, ref: `${id}/${m}`, name: m }));
          }
          return out;
        }),
      );
      return { current: app.config.data.model, providers };
    });

    // ---- conversations -------------------------------------------------------
    this.route('GET', '/api/conversations', async ({ query }) => {
      let list = await app.store.list();
      if (query.q) {
        const q = query.q.toLowerCase();
        list = list.filter((c) => c.title.toLowerCase().includes(q));
      }
      const offset = Math.max(0, Number(query.offset) || 0);
      const limit = Math.min(Math.max(1, Number(query.limit) || 100), 1000);
      return {
        total: list.length,
        conversations: list.slice(offset, offset + limit).map((c) => ({ ...c, running: app.runs.isRunning(c.id) })),
      };
    });

    this.route('POST', '/api/conversations', async ({ body, actor }) => {
      const conv = await app.createConversation({
        cwd: body.cwd,
        model: body.model,
        approval: actor.source === 'agent' ? undefined : body.approval,
        system: body.system,
      });
      if (body.title) {
        conv.title = String(body.title).slice(0, 200);
        await app.store.save(conv);
      }
      app.events.emit({ type: 'conversation.created', conversationId: conv.id, conversation: { id: conv.id, title: conv.title, updatedAt: conv.updatedAt } });
      return publicConversation(conv);
    });

    this.route('GET', '/api/conversations/:id', async ({ params, query }) => {
      const conv = await this.conversation(params.id);
      const seq = app.events.seq; // read before the snapshot: later events are newer than what we return
      return { ...publicConversation(conv, { full: query.full === '1' }), run: app.runs.snapshot(conv.id), seq };
    });

    this.route('PATCH', '/api/conversations/:id', async ({ params, body, actor }) => {
      notOwn(actor, params.id, 'change');
      const conv = await this.conversation(params.id);
      if (typeof body.title === 'string') conv.title = body.title.slice(0, 200);
      if ('model' in body) {
        if (body.model) conv.model = app.config.resolveModel(String(body.model)).ref;
        else conv.model = null;
      }
      if ('approval' in body) {
        notAgent(actor, 'change the approval mode');
        if (body.approval !== null && !APPROVAL_MODES.includes(body.approval)) {
          throw new HttpError(400, `approval must be one of: ${APPROVAL_MODES.join(', ')}, or null for the default.`);
        }
        conv.approval = body.approval;
      }
      if (typeof body.cwd === 'string') {
        const dir = app.resolveDirectory(body.cwd);
        if (dir !== conv.cwd) {
          conv.cwd = dir;
          conv.pendingNote = `[Note from the app: the workspace directory of this conversation is now ${dir}.]`;
        }
      }
      await app.store.save(conv);
      app.events.emit({
        type: 'conversation.updated',
        conversationId: conv.id,
        conversation: { id: conv.id, title: conv.title, model: conv.model, approval: conv.approval, cwd: conv.cwd, updatedAt: conv.updatedAt },
      });
      return publicConversation(conv);
    });

    this.route('DELETE', '/api/conversations/:id', async ({ params, actor }) => {
      notOwn(actor, params.id, 'delete');
      const run = app.runs.get(params.id);
      if (run) {
        app.runs.cancel(params.id);
        await run.done?.catch(() => {});
      }
      const existed = await app.store.delete(params.id);
      if (!existed) throw new HttpError(404, `Conversation not found: ${params.id}`);
      app.events.emit({ type: 'conversation.deleted', conversationId: params.id });
      return { ok: true };
    });

    this.route('POST', '/api/conversations/:id/messages', async ({ params, body, actor }) => {
      const before = (await this.conversation(params.id)).messages.length;
      const { conv, run } = await this.startChat({ conversationId: params.id, body, actor });
      if (!body.wait) return { [RESPONSE]: true, status: 202, body: { runId: run.id, conversationId: conv.id } };
      return this.outcome(conv, before, await run.done);
    });

    this.route('POST', '/api/chat', async ({ body, actor }) => {
      const existing = body.conversationId ? await this.conversation(String(body.conversationId)) : null;
      const before = existing ? existing.messages.length : 0;
      const { conv, run } = await this.startChat({ conversationId: existing?.id || null, body, actor });
      return this.outcome(conv, before, await run.done);
    });

    this.route('POST', '/api/conversations/:id/cancel', ({ params, actor }) => {
      notOwn(actor, params.id, 'cancel');
      return { cancelled: app.runs.cancel(params.id) };
    });

    this.route('POST', '/api/conversations/:id/approvals/:approvalId', ({ params, body, actor }) => {
      notAgent(actor, 'answer approval requests');
      app.runs.resolveApproval(params.id, params.approvalId, body.decision);
      return { ok: true };
    });

    this.route('POST', '/api/conversations/:id/compact', async ({ params, actor }) => {
      notOwn(actor, params.id, 'compact');
      const conv = await this.conversation(params.id);
      if (app.runs.isRunning(conv.id)) throw new HttpError(409, 'The conversation is busy. Try again when it has finished.');
      const { provider, model } = app.providers.resolve(conv.model);
      const tools = (await app.store.getToolset(conv.toolset)) || app.tools.definitions();
      const info = await provider.info(model);
      const compacted = await compactConversation({ conv, provider, model, tools, info });
      if (compacted) {
        const message = newMessage('notice', [{ type: 'text', text: 'Earlier messages were summarized to free up context. The full history is still shown here.' }], { level: 'info' });
        conv.messages.push(message);
        await app.store.save(conv);
        app.events.emit({ type: 'message.added', conversationId: conv.id, message });
      }
      return { compacted };
    });

    // ---- extensions ----------------------------------------------------------
    const extensionList = () => ({
      generation: app.extensions.generation,
      dir: app.extensionsDir,
      safeMode: !!app.safeMode,
      extensions: app.extensions.list(),
    });
    this.route('GET', '/api/extensions', extensionList);
    this.route('POST', '/api/extensions/reload', async () => {
      await app.extensions.reload();
      return extensionList();
    });
    this.route('GET', '/api/extensions/client', () => app.extensions.clientManifest());
    this.route('POST', '/api/extensions/client-report', ({ body, actor }) => {
      notAgent(actor, 'report UI load results');
      app.extensions.reportClient(body);
      return { ok: true };
    });
    this.route('POST', '/api/extensions/client-error', ({ body, actor }) => {
      notAgent(actor, 'report UI errors');
      if (typeof body.name === 'string') app.extensions.runtimeError(body.name, { stack: String(body.stack || body.message || 'error') }, 'client');
      return { ok: true };
    });
    this.route('PATCH', '/api/extensions/:name', async ({ params, body }) => {
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'Send { "enabled": true } or { "enabled": false }.');
      await app.extensions.setEnabled(params.name, body.enabled);
      return extensionList();
    });
    this.route('DELETE', '/api/extensions/:name', async ({ params }) => {
      await app.extensions.remove(params.name);
      return extensionList();
    });

    const storage = (name) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,48}$/.test(name)) throw new HttpError(400, 'Invalid extension name.');
      return app.extensions.storage(name);
    };
    this.route('GET', '/api/extensions/:name/storage', async ({ params }) => ({ values: await storage(params.name).all() }));
    this.route('GET', '/api/extensions/:name/storage/:key', async ({ params }) => ({ value: await storage(params.name).get(params.key) }));
    this.route('PUT', '/api/extensions/:name/storage/:key', async ({ params, body }) => {
      await storage(params.name).set(params.key, body.value ?? null);
      return { ok: true };
    });
    this.route('DELETE', '/api/extensions/:name/storage/:key', async ({ params }) => {
      await storage(params.name).delete(params.key);
      return { ok: true };
    });

    // ---- UI pages ------------------------------------------------------------
    this.route('POST', '/api/client/eval-result', ({ body, actor }) => {
      notAgent(actor, 'answer ui_eval requests');
      return { ok: app.clients.resolveEval(String(body.evalId), body) };
    });
    this.route('POST', '/api/client/view', ({ body, clientId, actor }) => {
      notAgent(actor, 'change what the UI shows');
      if (clientId) app.clients.touch(clientId, body.conversationId || null);
      return { ok: true };
    });
  }
}

/** Turn what an extension route returned into an HTTP response. */
export function normalizeRouteResult(value) {
  if (value && typeof value === 'object' && value[RESPONSE]) {
    const status = Number.isInteger(value.status) ? value.status : 200;
    const headers = value.headers && typeof value.headers === 'object' ? value.headers : {};
    if ('html' in value) return { status, headers, body: String(value.html), type: 'text/html; charset=utf-8' };
    if ('text' in value) return { status, headers, body: String(value.text), type: 'text/plain; charset=utf-8' };
    if ('body' in value) return { status, headers, body: value.body, type: value.type || 'application/octet-stream' };
    return { status, headers, body: value.json ?? null };
  }
  if (value === undefined) return { status: 200, body: { ok: true } };
  if (typeof value === 'string') return { status: 200, body: value, type: 'text/plain; charset=utf-8' };
  return { status: 200, body: value };
}

/** Resolve and check a workspace directory given by a client. */
export function resolveDirectory(base, dir) {
  const resolved = path.resolve(base, expandHome(String(dir || '.')));
  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch {
    /* reported below */
  }
  if (!stat?.isDirectory()) throw new HttpError(400, `Not a directory: ${resolved}`);
  return resolved;
}
