// Extension host. An extension is a folder in <home>/extensions/<name>/:
//
//   extension.json   optional manifest { name, description, version }
//   server.js        optional: export function activate(ctx)  — runs in this process
//   client.js        optional: export function activate(seed) — runs in the web UI
//   style.css        optional stylesheet(s) for the web UI
//
// This is how the app grows: the agent writes these files and calls
// reload_extensions. Everything an extension registers goes through a scoped
// context, so a reload can undo it completely. Load errors are kept per
// extension and handed back to the agent so it can fix its own code.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import * as nodeModule from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_DIR, VERSION, readJson, writeJsonAtomic } from '../util.js';
import { newMessage } from '../store.js';
import { RESPONSE } from '../server/api.js';

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,48}$/;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const freshRoots = new Set(); // URL prefixes of extension folders (one per app in this process)
let hooksInstalled = false;
/**
 * Give every reload a fresh copy of an extension's whole module graph.
 * The entry file is imported with "?g=<generation>"; this hook passes the
 * same query on to the files it imports from inside the extensions folder.
 */
function installFreshImportHook(root) {
  freshRoots.add(`${pathToFileURL(root).href}/`);
  if (hooksInstalled || typeof nodeModule.registerHooks !== 'function') return;
  hooksInstalled = true;
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      try {
        const parent = context.parentURL;
        if (!parent || !result.url || result.url.includes('?')) return result;
        for (const prefix of freshRoots) {
          if (parent.startsWith(prefix) && result.url.startsWith(prefix)) {
            const g = new URL(parent).searchParams.get('g');
            return g ? { ...result, url: `${result.url}?g=${g}` } : result;
          }
        }
      } catch {
        /* fall through to the default result */
      }
      return result;
    },
  });
}

export class ExtensionHost {
  constructor(app) {
    this.app = app;
    this.dir = app.extensionsDir;
    this.dataDir = path.join(app.home, 'extension-data');
    this.generation = 0;
    /** @type {Map<string, object>} */
    this.records = new Map();
    this.routes = []; // { ext, method, segments, handler }
    this.promptParts = []; // { ext, text }
    this.watcher = null;
    this.reloading = null;
    this.clientWaiters = new Set();
    this.storageCache = new Map();
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    installFreshImportHook(this.dir);
    await this.reload();
  }

  // ---- loading -----------------------------------------------------------

  /** Reload every extension. Calls made while a reload is running wait for it and reload once more. */
  reload() {
    if (this.reloading) {
      this.again = true;
      return this.reloading;
    }
    this.reloading = (async () => {
      try {
        do {
          this.again = false;
          await this.reloadNow();
        } while (this.again);
      } finally {
        this.reloading = null;
      }
      return this.list();
    })();
    return this.reloading;
  }

  async reloadNow() {
    const { app } = this;
    this.generation++;

    for (const record of this.records.values()) await this.dispose(record);
    this.routes = [];
    this.promptParts = [];

    const previous = this.records;
    this.records = new Map();
    if (app.safeMode) {
      app.events.emit({ type: 'extensions.changed', generation: this.generation });
      return;
    }

    let entries = [];
    try {
      entries = await fsp.readdir(this.dir, { withFileTypes: true });
    } catch {
      /* no extensions folder yet */
    }
    const disabled = new Set(app.config.data.extensions?.disabled || []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const dir = path.join(this.dir, entry.name);
      const record = {
        name: entry.name,
        dir,
        description: '',
        version: '',
        enabled: !disabled.has(entry.name),
        serverFile: null,
        clientFile: null,
        styles: [],
        server: { status: 'none', error: null },
        client: { status: 'none', error: null, generation: 0 },
        runtimeErrors: previous.get(entry.name)?.runtimeErrors?.slice(-3) || [],
        tools: [],
        routes: [],
        disposers: [],
      };
      this.records.set(record.name, record);
      if (!NAME.test(entry.name)) {
        record.enabled = false;
        record.server = { status: 'error', error: `Invalid folder name "${entry.name}": use letters, digits, "-" and "_".` };
        continue;
      }
      let manifest = {};
      try {
        manifest = (await readJson(path.join(dir, 'extension.json'), {})) || {};
      } catch (err) {
        record.server = { status: 'error', error: `extension.json is not valid JSON: ${err.message}` };
        continue;
      }
      record.description = typeof manifest.description === 'string' ? manifest.description : '';
      record.version = typeof manifest.version === 'string' ? manifest.version : '';
      if (manifest.enabled === false) record.enabled = false;
      const exists = (rel) => typeof rel === 'string' && isSafeRelative(rel) && fs.existsSync(path.join(dir, rel));
      const serverFile = manifest.server || 'server.js';
      const clientFile = manifest.client || 'client.js';
      if (exists(serverFile)) record.serverFile = serverFile;
      if (exists(clientFile)) record.clientFile = clientFile;
      const styles = Array.isArray(manifest.styles) ? manifest.styles : ['style.css'];
      record.styles = styles.filter(exists);
      if (record.clientFile || record.styles.length) record.client.status = record.enabled ? 'pending' : 'none';
    }

    for (const record of this.records.values()) {
      if (!record.enabled || !record.serverFile || record.server.status === 'error') continue;
      await this.activateServer(record);
    }
    // A browser reports a syntax error without saying where it is. Parse the UI code
    // here first, so the agent gets the file and line.
    await Promise.all(
      [...this.records.values()]
        .filter((r) => r.enabled && r.clientFile)
        .map(async (r) => {
          const problem = await checkModuleSyntax(path.join(r.dir, r.clientFile), r.clientFile);
          if (problem) r.client = { status: 'error', error: problem, generation: this.generation, syntax: true };
        }),
    );
    app.events.emit({ type: 'extensions.changed', generation: this.generation });
  }

  async activateServer(record) {
    const file = path.join(record.dir, record.serverFile);
    try {
      const mod = await import(`${pathToFileURL(file).href}?g=${this.generation}`);
      const activate = typeof mod.activate === 'function' ? mod.activate : mod.default;
      if (typeof activate !== 'function') {
        throw new Error(`${record.serverFile} must export a function: export function activate(ctx) { ... }`);
      }
      const cleanup = await activate(this.makeContext(record));
      if (typeof cleanup === 'function') record.disposers.push(cleanup);
      record.server = { status: 'ok', error: null };
    } catch (err) {
      await this.dispose(record);
      let error = formatError(err, this.dir);
      // An import that fails to parse does not say where. Find the file and line.
      if (err instanceof SyntaxError) error = (await locateSyntaxError(record.dir, record.name)) || error;
      record.server = { status: 'error', error };
    }
  }

  async dispose(record) {
    const disposers = record.disposers.splice(0).reverse();
    for (const fn of disposers) {
      try {
        await fn();
      } catch (err) {
        console.error(`[seed] extension "${record.name}" cleanup failed:`, err.message);
      }
    }
    record.tools = [];
    record.routes = [];
    this.routes = this.routes.filter((r) => r.ext !== record.name);
    this.promptParts = this.promptParts.filter((p) => p.ext !== record.name);
  }

  /** The API handed to an extension's server-side activate(). */
  makeContext(record) {
    const { app } = this;
    const host = this;
    const track = (dispose) => {
      record.disposers.push(dispose);
      return dispose;
    };
    const route = (method, routePath, handler) => {
      const m = String(method).toUpperCase();
      if (!METHODS.includes(m)) throw new Error(`http.route: unsupported method "${method}".`);
      if (typeof routePath !== 'string' || !routePath.startsWith('/')) throw new Error('http.route: the path must start with "/".');
      if (typeof handler !== 'function') throw new Error('http.route: the handler must be a function.');
      const entry = { ext: record.name, method: m, segments: routePath.split('/').filter(Boolean), handler };
      host.routes.push(entry);
      record.routes.push(`${m} /ext/${record.name}${routePath}`);
      return track(() => {
        host.routes = host.routes.filter((r) => r !== entry);
      });
    };
    const ctx = {
      name: record.name,
      dir: record.dir,
      app: { version: VERSION, appDir: APP_DIR, home: app.home, url: () => app.url || null },
      log: (...args) => console.log(`[ext:${record.name}]`, ...args),
      config: { get: () => app.config.public() },
      tools: {
        /** Add a tool the agent can call. See docs/EXTENDING.md for the fields. */
        register(tool) {
          const dispose = app.tools.register(tool, `ext:${record.name}`);
          record.tools.push(tool.name);
          return track(dispose);
        },
      },
      http: {
        route,
        /** For a response that is not plain JSON: respond({ status?, headers?, json | text | html | body }). */
        respond: (response) => ({ ...response, [RESPONSE]: true }),
        get: (p, h) => route('GET', p, h),
        post: (p, h) => route('POST', p, h),
        put: (p, h) => route('PUT', p, h),
        patch: (p, h) => route('PATCH', p, h),
        delete: (p, h) => route('DELETE', p, h),
      },
      hooks: { on: (name, fn) => track(app.hooks.on(name, fn, record.name)) },
      prompt: {
        /** Add text to the system prompt of conversations created from now on. */
        add(text) {
          const entry = { ext: record.name, text };
          host.promptParts.push(entry);
          return track(() => {
            host.promptParts = host.promptParts.filter((p) => p !== entry);
          });
        },
      },
      storage: this.storage(record.name),
      events: {
        /** Send an event to every open UI page; client code receives it as "ext.<name>.<type>". */
        broadcast: (type, data) => app.events.emit({ type: `ext.${record.name}.${type}`, data }),
      },
      conversations: {
        list: () => app.store.list(),
        get: (id) => app.store.get(id),
        create: (fields) => app.createConversation(fields),
        /** Send a message and wait for the agent's reply text. */
        async send(conversationId, text, options = {}) {
          const conv = conversationId ? await app.store.get(conversationId) : await app.createConversation(options);
          if (!conv) throw new Error(`Conversation not found: ${conversationId}`);
          const run = await app.runs.start(conv, {
            content: [{ type: 'text', text: String(text) }],
            model: options.model,
            approval: options.approval,
            interactive: options.interactive === true,
          });
          const outcome = await run.done;
          const last = conv.messages.findLast((m) => m.role === 'assistant');
          return {
            conversationId: conv.id,
            status: outcome.status,
            error: outcome.error,
            text: last ? last.content.filter((b) => b.type === 'text').map((b) => b.text).join('') : '',
          };
        },
        /** Add a notice (shown to the user, never sent to the model) to a conversation. */
        async notify(conversationId, text) {
          const conv = await app.store.get(conversationId);
          if (!conv) throw new Error(`Conversation not found: ${conversationId}`);
          const message = newMessage('notice', [{ type: 'text', text: String(text) }], { level: 'info' });
          conv.messages.push(message);
          await app.store.save(conv);
          app.events.emit({ type: 'message.added', conversationId, message });
        },
      },
      providers: { register: (type, factory) => track(app.providers.registerType(type, factory)) },
      timers: {
        every(ms, fn) {
          const t = setInterval(() => Promise.resolve().then(fn).catch((e) => host.runtimeError(record.name, e, 'server')), ms);
          t.unref?.();
          return track(() => clearInterval(t));
        },
        after(ms, fn) {
          const t = setTimeout(() => Promise.resolve().then(fn).catch((e) => host.runtimeError(record.name, e, 'server')), ms);
          t.unref?.();
          return track(() => clearTimeout(t));
        },
      },
      onDispose: (fn) => track(fn),
    };
    ctx.on = ctx.hooks.on;
    return ctx;
  }

  // ---- storage -----------------------------------------------------------

  /** A small JSON key-value store per extension, shared by its server and client code. */
  storage(name) {
    const file = path.join(this.dataDir, `${name}.json`);
    const load = async () => {
      if (!this.storageCache.has(name)) this.storageCache.set(name, (await readJson(file, {}).catch(() => ({}))) || {});
      return this.storageCache.get(name);
    };
    const save = (data) => writeJsonAtomic(file, data);
    return {
      async get(key, fallback = null) {
        const data = await load();
        return key in data ? data[key] : fallback;
      },
      async set(key, value) {
        const data = await load();
        data[key] = value;
        await save(data);
      },
      async delete(key) {
        const data = await load();
        delete data[key];
        await save(data);
      },
      async all() {
        return { ...(await load()) };
      },
    };
  }

  // ---- state for clients and the agent ------------------------------------

  list() {
    return [...this.records.values()].map((r) => ({
      name: r.name,
      description: r.description,
      version: r.version,
      enabled: r.enabled,
      dir: r.dir,
      hasServer: !!r.serverFile,
      hasClient: !!r.clientFile || r.styles.length > 0,
      server: r.server,
      client: { status: r.client.status, error: r.client.error },
      runtimeErrors: r.runtimeErrors,
      tools: r.tools,
      routes: r.routes,
    }));
  }

  /** What the web UI needs in order to load the client side of each extension. */
  clientManifest() {
    // "<generation>~<key>": the generation makes every reload a new URL (fresh modules,
    // relative imports included); the key is what allows a page to fetch the files.
    const base = `/extensions/${this.generation}~${this.app.assetKey}`;
    return {
      generation: this.generation,
      safeMode: !!this.app.safeMode,
      extensions: [...this.records.values()]
        .filter((r) => r.enabled && (r.clientFile || r.styles.length))
        .map((r) => ({
          name: r.name,
          client: r.clientFile && !r.client.syntax ? `${base}/${r.name}/${r.clientFile}` : null,
          styles: r.styles.map((s) => `${base}/${r.name}/${s}`),
        })),
    };
  }

  /** Resolve "/extensions/<generation>~<key>/<name>/<file>" to a file on disk, or null. */
  clientFile(urlPath) {
    const parts = urlPath.split('/').filter(Boolean); // ['extensions', 'gen~key', name, ...file]
    if (parts.length < 4 || parts[1].split('~')[1] !== this.app.assetKey) return null;
    let record;
    try {
      record = this.records.get(decodeURIComponent(parts[2]));
    } catch {
      return null;
    }
    if (!record?.enabled) return null;
    let rel;
    try {
      rel = parts.slice(3).map(decodeURIComponent).join('/');
    } catch {
      return null;
    }
    if (!isSafeRelative(rel)) return null;
    return path.join(record.dir, rel);
  }

  /** A UI page tells us how loading went: { generation, results: { name: { ok, error } } }. */
  reportClient({ generation, results }) {
    if (generation !== this.generation || !results || typeof results !== 'object') return;
    for (const [name, r] of Object.entries(results)) {
      const record = this.records.get(name);
      if (!record || record.client.syntax) continue;
      record.client = { status: r?.ok ? 'ok' : 'error', error: r?.ok ? null : String(r?.error || 'unknown error').slice(0, 4000), generation };
    }
    for (const waiter of this.clientWaiters) waiter();
  }

  runtimeError(name, err, side) {
    const record = this.records.get(name);
    const text = `[${side}] ${formatError(err, this.dir)}`.slice(0, 2000);
    if (!record) return console.error(`[seed] extension "${name}":`, text);
    if (record.runtimeErrors.at(-1) !== text) record.runtimeErrors.push(text);
    if (record.runtimeErrors.length > 5) record.runtimeErrors.shift();
    this.app.events.emit({ type: 'extensions.error', name, message: text });
  }

  /** Wait until the connected UI pages have reported on the current generation (or time out). */
  async waitForClients(timeoutMs = 3000) {
    const generation = this.generation;
    const pending = () =>
      this.generation === generation &&
      [...this.records.values()].some((r) => r.enabled && r.client.status === 'pending');
    if (!this.app.clients.size || !pending()) return;
    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.clientWaiters.delete(check);
        resolve();
      };
      const check = () => {
        if (!pending()) finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.clientWaiters.add(check);
    });
  }

  /** The reload result as text for the agent. */
  report() {
    const lines = [`Extensions folder: ${this.dir}`, `Reloaded (generation ${this.generation}).`, ''];
    if (this.app.safeMode) lines.push('Safe mode is on: no extension is loaded.');
    if (!this.records.size && !this.app.safeMode) lines.push('No extensions are installed.');
    for (const r of this.records.values()) {
      lines.push(`${r.name} — ${r.enabled ? 'enabled' : 'disabled'}`);
      if (!r.enabled) {
        if (r.server.error) lines.push(indent(`error: ${r.server.error}`));
        continue;
      }
      if (r.server.status === 'error') lines.push(indent(`server: ERROR\n${indent(r.server.error)}`));
      else if (r.server.status === 'ok') {
        const extras = [];
        if (r.tools.length) extras.push(`tools: ${r.tools.join(', ')}`);
        if (r.routes.length) extras.push(`routes: ${r.routes.join(', ')}`);
        lines.push(indent(`server: ok${extras.length ? ` (${extras.join('; ')})` : ''}`));
      } else lines.push(indent('server: none (no server.js)'));

      if (r.client.status === 'error') lines.push(indent(`client: ERROR\n${indent(r.client.error)}`));
      else if (r.client.status === 'ok') lines.push(indent('client: ok (loaded in the open UI page)'));
      else if (r.client.status === 'pending') {
        lines.push(indent(this.app.clients.size ? 'client: no report yet from the UI page (it may still be loading)' : 'client: not checked, because no UI page is open'));
      } else lines.push(indent('client: none (no client.js or style.css)'));
      for (const e of r.runtimeErrors) lines.push(indent(`earlier runtime error: ${e}`));
    }
    const fresh = [...this.records.values()].flatMap((r) => (r.enabled ? r.tools : []));
    if (fresh.length) {
      lines.push('', `Extension tools: ${fresh.join(', ')}. Tools that are not in your tool list can be called with ext_call.`);
    }
    return lines.join('\n');
  }

  systemPromptParts() {
    return this.promptParts.map((p) => {
      try {
        return typeof p.text === 'function' ? String(p.text() ?? '') : String(p.text ?? '');
      } catch {
        return '';
      }
    });
  }

  // ---- management ----------------------------------------------------------

  async setEnabled(name, enabled) {
    if (!this.records.has(name)) throw Object.assign(new Error(`No extension named "${name}".`), { status: 404 });
    const disabled = new Set(this.app.config.data.extensions?.disabled || []);
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    await this.app.config.update({ extensions: { disabled: [...disabled] } });
    return this.reload();
  }

  async remove(name) {
    const record = this.records.get(name);
    if (!record) throw Object.assign(new Error(`No extension named "${name}".`), { status: 404 });
    await this.dispose(record);
    await fsp.rm(record.dir, { recursive: true, force: true });
    return this.reload();
  }

  /** Find the route for "/ext/<name>/<rest>". Returns { route, params } or null. */
  matchRoute(method, urlPath) {
    const parts = urlPath.split('/').filter(Boolean); // ['ext', name, ...rest]
    if (parts[0] !== 'ext' || parts.length < 2) return null;
    const name = parts[1];
    const rest = parts.slice(2).map((p) => decodeURIComponent(p));
    for (const route of this.routes) {
      if (route.ext !== name || route.method !== method || route.segments.length !== rest.length) continue;
      const params = {};
      const ok = route.segments.every((seg, i) => {
        if (seg.startsWith(':')) {
          params[seg.slice(1)] = rest[i];
          return true;
        }
        return seg === rest[i];
      });
      if (ok) return { route, params };
    }
    return null;
  }

  watch() {
    if (this.watcher) return;
    let timer = null;
    try {
      this.watcher = fs.watch(this.dir, { recursive: true }, (_event, filename) => {
        const name = String(filename || '');
        if (!name || name.endsWith('.tmp') || name.includes('node_modules') || /(^|[\\/])\.[^\\/]/.test(name)) return;
        clearTimeout(timer);
        timer = setTimeout(() => this.reload().catch((err) => console.error('[seed] extension reload failed:', err.message)), 400);
        timer.unref?.();
      });
      this.watcher.on('error', () => {});
    } catch (err) {
      console.error('[seed] cannot watch the extensions folder (changes need reload_extensions):', err.message);
    }
  }

  async close() {
    this.watcher?.close();
    this.watcher = null;
    for (const record of this.records.values()) await this.dispose(record);
  }
}

/**
 * Parse an ES module without running it. Returns null when it is fine,
 * otherwise the syntax error with file name and line.
 */
function checkModuleSyntax(file, shownName) {
  return new Promise((resolve) => {
    let source;
    try {
      source = fs.readFileSync(file);
    } catch (err) {
      return resolve(`Cannot read ${shownName}: ${err.message}`);
    }
    const child = spawn(process.execPath, ['--input-type=module', '--check'], { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, NODE_OPTIONS: '', ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } });
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 8000);
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', () => (clearTimeout(timer), resolve(null)));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || !/SyntaxError/.test(stderr)) return resolve(null);
      const text = stderr
        .split('\n')
        .filter((line) => !/^\s+at /.test(line) && !/^Node\.js v/.test(line))
        .join('\n')
        .replace(/\[stdin\]/g, shownName)
        .trim();
      resolve(text);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(source);
  });
}

/** Check every module of an extension folder; returns the first syntax error with its location, or null. */
async function locateSyntaxError(dir, name) {
  const files = [];
  const walk = async (current, depth) => {
    for (const entry of await fsp.readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && depth < 4) await walk(full, depth + 1);
      else if (entry.isFile() && /\.m?js$/.test(entry.name) && files.length < 60) files.push(full);
    }
  };
  await walk(dir, 0);
  for (const file of files) {
    const problem = await checkModuleSyntax(file, `${name}/${path.relative(dir, file).split(path.sep).join('/')}`);
    if (problem) return problem;
  }
  return null;
}

function isSafeRelative(rel) {
  if (!rel || path.isAbsolute(rel)) return false;
  const parts = rel.split(/[\\/]/);
  return !parts.includes('..') && !parts.includes('');
}

function indent(text) {
  return String(text)
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
}

/** Error text for the agent: message plus the stack frames inside the extensions folder. */
export function formatError(err, extensionsDir) {
  if (!err || typeof err !== 'object') return String(err);
  const stack = String(err.stack || err.message || err);
  const prefix = pathToFileURL(extensionsDir).href;
  const lines = stack.split('\n');
  const kept = [];
  for (const line of lines) {
    const isFrame = /^\s+at /.test(line);
    if (!isFrame || line.includes(prefix) || line.includes(extensionsDir)) kept.push(line);
    if (kept.length >= 14) break;
  }
  return kept
    .join('\n')
    .replaceAll(prefix + '/', '')
    .replaceAll(extensionsDir + path.sep, '')
    .replace(/\?g=\d+/g, '');
}
