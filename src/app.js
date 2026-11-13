// The application object: owns the configuration, the conversation store,
// the provider adapters, the tool registry, the agent runs, the extension
// host and the HTTP server, and wires them together.
import fs from 'node:fs';
import path from 'node:path';
import { Config } from './config.js';
import { EventHub, Hooks } from './events.js';
import { Store } from './store.js';
import { Providers } from './providers/index.js';
import { ToolRegistry, registerBuiltinTools } from './tools/registry.js';
import { appTools } from './tools/app.js';
import { Runs } from './agent/agent.js';
import { buildSystemPrompt } from './agent/prompt.js';
import { ExtensionHost } from './extensions/host.js';
import { Api, resolveDirectory } from './server/api.js';
import { assetKey } from './server/auth.js';
import { Clients } from './server/clients.js';
import { HttpServer } from './server/http.js';
import { resolveHome } from './util.js';

export class App {
  /**
   * @param {{ home?: string, cwd?: string, detectEnv?: boolean, safeMode?: boolean, watch?: boolean,
   *           overrides?: { server?: { host?: string, port?: number }, approval?: string } }} [options]
   */
  constructor(options = {}) {
    this.home = resolveHome(options.home);
    this.cwd = path.resolve(options.cwd || process.cwd());
    this.safeMode = !!options.safeMode;
    this.watchExtensions = options.watch !== false;
    this.extensionsDir = path.join(this.home, 'extensions');
    fs.mkdirSync(this.home, { recursive: true });

    this.config = new Config(this.home, { detectEnv: options.detectEnv, overrides: options.overrides });
    this.assetKey = assetKey(this.config.server.token);
    this.events = new EventHub();
    this.hooks = new Hooks((err, where) => {
      if (where.owner) this.extensions.runtimeError(where.owner, err, 'server');
      else console.error(`[seed] hook ${where.hook} failed:`, err);
    });
    this.store = new Store(this.home);
    this.providers = new Providers(this.config);
    this.tools = new ToolRegistry();
    this.clients = new Clients();
    this.runs = new Runs(this);
    this.extensions = new ExtensionHost(this);
    this.api = new Api(this);
    this.http = null;
    this.url = null;

    this.store.isBusy = (id) => this.runs.isRunning(id);
    registerBuiltinTools(this.tools);
    for (const tool of appTools(this)) this.tools.register(tool, 'builtin');
    this.config.on('change', (config) => this.events.emit({ type: 'config.changed', config }));
  }

  async init() {
    await this.extensions.init();
    if (this.watchExtensions && !this.safeMode) this.extensions.watch();
    this.ensureDefaultModel().catch(() => {}); // in the background; a run waits for it when it matters
    return this;
  }

  /**
   * A provider found through an environment variable comes without a model.
   * Ask the API which models it has and choose one, so the first message just works.
   */
  ensureDefaultModel() {
    if (this.config.data.model || !Object.keys(this.config.data.providers).length) return Promise.resolve();
    this.choosingModel ||= (async () => {
      try {
        for (const [id, entry] of Object.entries(this.config.data.providers)) {
          try {
            const { suggested } = await this.providers.test(entry, { presetId: id });
            if (suggested && !this.config.data.model) await this.config.update({ model: `${id}/${suggested}` });
            if (this.config.data.model) return;
          } catch {
            /* try the next provider; the user can still choose with /model */
          }
        }
      } finally {
        this.choosingModel = null;
      }
    })();
    return this.choosingModel;
  }

  resolveDirectory(dir) {
    return resolveDirectory(this.cwd, dir);
  }

  /**
   * New conversation. The system prompt and the tool set are fixed here, for
   * the life of the conversation.
   */
  async createConversation({ cwd, model, approval, system, ephemeral } = {}) {
    const dir = cwd ? this.resolveDirectory(cwd) : this.cwd;
    if (model) model = this.config.resolveModel(String(model)).ref;
    const prompt = buildSystemPrompt({
      cwd: dir,
      home: this.home,
      extensionsDir: this.extensionsDir,
      extensions: this.extensions.list().filter((e) => e.enabled),
      instructions: this.config.data.agent?.instructions,
      extra: [...this.extensions.systemPromptParts(), system ? String(system) : ''],
    });
    const toolset = await this.store.putToolset(this.tools.definitions());
    return this.store.create({ cwd: dir, model, approval, system: prompt, toolset, ephemeral });
  }

  /** Start the HTTP server. Returns { url, urlWithToken, port, host }. */
  async listen() {
    this.http = new HttpServer(this);
    const { host, port } = await this.http.listen(this.config.server);
    const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
    this.url = `http://${shown}:${port}`;
    return { host, port, url: this.url, urlWithToken: `${this.url}/?token=${this.config.server.token}` };
  }

  /**
   * Log errors nobody caught instead of letting them stop the server, and
   * record them against the extension they came from when the stack says so.
   * Called by the command line; tests and embedders decide for themselves.
   */
  guardProcess() {
    const onError = (err) => {
      const text = String(err?.stack || err);
      // Stack frames name the file either as a path or as a file:// URL.
      const at = text.indexOf(this.extensionsDir + path.sep);
      const name = at >= 0 ? text.slice(at + this.extensionsDir.length + 1).split(/[\\/]/)[0] : /\/extensions\/([^/\s?]+)\//.exec(text)?.[1];
      if (name && this.extensions.records.has(name)) this.extensions.runtimeError(name, err, 'server');
      console.error('[seed] unexpected error:', err);
    };
    process.on('uncaughtException', onError);
    process.on('unhandledRejection', onError);
  }

  async close() {
    for (const id of [...this.runs.active.keys()]) this.runs.cancel(id);
    await Promise.all([...this.runs.active.values()].map((r) => r.done?.catch(() => {})));
    await this.extensions.close();
    await this.http?.close();
    await this.store.indexWrite;
  }
}
