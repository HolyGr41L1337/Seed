// Configuration: providers (the user's model APIs), the default model,
// the approval mode and the local server settings. Stored in
// <home>/config.json with file mode 0600 because it can hold API keys.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { deepMerge, isPlainObject, readJsonSync, writeJsonAtomic } from './util.js';
import { PRESETS } from './providers/presets.js';

export const APPROVAL_MODES = ['ask', 'auto-edit', 'full'];
export const PROVIDER_TYPES = ['openai', 'anthropic'];

const DEFAULTS = {
  providers: {},
  model: null, // "<providerId>/<modelId>"
  approval: 'ask',
  server: { host: '127.0.0.1', port: 7333, token: null },
  agent: {
    maxSteps: 200, // tool rounds per run before the agent pauses
    instructions: '', // extra text appended to the system prompt of new conversations
  },
  extensions: { disabled: [] },
};

/** A secret is stored literally or as a reference to an environment variable ("$NAME"). */
export function resolveSecret(value) {
  if (typeof value !== 'string' || value === '') return undefined;
  if (value.startsWith('$')) return process.env[value.slice(1)] || undefined;
  return value;
}

function keyHint(value) {
  if (typeof value !== 'string' || value === '') return null;
  if (value.startsWith('$')) return value;
  return value.length <= 8 ? '••••' : `${value.slice(0, 3)}…${value.slice(-4)}`;
}

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.status = 400;
  }
}

export class Config extends EventEmitter {
  /**
   * @param {string} home data directory
   * @param {{ detectEnv?: boolean, overrides?: object }} [options]
   */
  constructor(home, options = {}) {
    super();
    this.home = home;
    this.file = path.join(home, 'config.json');
    this.detectEnv = options.detectEnv !== false;
    this.overrides = options.overrides || {};
    this.data = structuredClone(DEFAULTS);
    this.load();
  }

  load() {
    const stored = readJsonSync(this.file, {});
    let data = deepMerge(structuredClone(DEFAULTS), stored);
    let dirty = !fs.existsSync(this.file);

    if (!data.server.token) {
      data.server.token = crypto.randomBytes(24).toString('base64url');
      dirty = true;
    }
    if (this.detectEnv && Object.keys(data.providers).length === 0) {
      const found = providersFromEnv();
      if (Object.keys(found.providers).length) {
        data.providers = found.providers;
        data.model = data.model || found.model;
        dirty = true;
      }
    }
    this.data = data;
    if (dirty) this.saveSync();
  }

  saveSync() {
    fs.mkdirSync(this.home, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
  }

  async save() {
    await writeJsonAtomic(this.file, this.data, { mode: 0o600 });
  }

  /** Effective value: file config with process-level overrides (CLI flags) on top. */
  get server() {
    return { ...this.data.server, ...(this.overrides.server || {}) };
  }

  get approval() {
    return this.overrides.approval || this.data.approval;
  }

  /** Configuration without secrets: safe for the UI, the API and the agent. */
  public() {
    const providers = {};
    for (const [id, p] of Object.entries(this.data.providers)) {
      const { apiKey, ...rest } = p;
      providers[id] = {
        ...rest,
        hasKey: !!resolveSecret(apiKey) || (p.type === 'anthropic' && !apiKey),
        keyHint: keyHint(apiKey),
      };
    }
    return {
      providers,
      model: this.data.model,
      approval: this.approval,
      agent: this.data.agent,
      extensions: this.data.extensions,
      server: { host: this.server.host, port: this.server.port },
    };
  }

  /**
   * Apply a deep-merge patch (null deletes a key), validate, save.
   * `source` says who asked: 'user' may change everything, 'agent' may not
   * touch the approval mode or the server settings.
   */
  async update(patch, { source = 'user' } = {}) {
    if (!isPlainObject(patch)) throw new ConfigError('Config patch must be a JSON object.');
    if (source === 'agent') {
      for (const key of ['approval', 'server']) {
        if (key in patch) throw new ConfigError(`The agent is not allowed to change "${key}". Ask the user to do it.`);
      }
    }
    if ('server' in patch && isPlainObject(patch.server) && 'token' in patch.server) {
      throw new ConfigError('The access token cannot be changed through the API.');
    }
    const next = deepMerge(this.data, patch);
    validate(next);
    this.data = next;
    await this.save();
    this.emit('change', this.public());
    return this.public();
  }

  /** "provider/model" (or null for the default) → { providerId, provider, model, ref }. */
  resolveModel(ref) {
    const value = ref || this.data.model;
    const ids = Object.keys(this.data.providers);
    if (!ids.length) throw new ConfigError('No model API is connected yet. Connect one first (type /connect).');
    if (!value) {
      throw new ConfigError('No model selected. Choose one with /model <provider>/<model>.');
    }
    const slash = value.indexOf('/');
    let providerId = slash > 0 ? value.slice(0, slash) : null;
    let model = slash > 0 ? value.slice(slash + 1) : value;
    if (!providerId || !this.data.providers[providerId]) {
      // Allow a bare model id when it is unambiguous (single provider),
      // and model ids that themselves contain a slash ("anthropic/claude-…" on OpenRouter).
      if (ids.length === 1) {
        providerId = ids[0];
        model = value;
      } else {
        throw new ConfigError(`Unknown provider in model "${value}". Connected providers: ${ids.join(', ')}.`);
      }
    }
    return { providerId, provider: this.data.providers[providerId], model, ref: `${providerId}/${model}` };
  }
}

function validate(data) {
  if (!APPROVAL_MODES.includes(data.approval)) {
    throw new ConfigError(`approval must be one of: ${APPROVAL_MODES.join(', ')}.`);
  }
  if (!isPlainObject(data.providers)) throw new ConfigError('providers must be an object.');
  for (const [id, p] of Object.entries(data.providers)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id)) {
      throw new ConfigError(`Invalid provider id "${id}" (use letters, digits, "-" and "_").`);
    }
    if (!isPlainObject(p)) throw new ConfigError(`Provider "${id}" must be an object.`);
    if (!PROVIDER_TYPES.includes(p.type)) {
      throw new ConfigError(`Provider "${id}": type must be one of ${PROVIDER_TYPES.join(', ')}.`);
    }
    if (p.type === 'openai' && !p.baseURL) throw new ConfigError(`Provider "${id}": baseURL is required.`);
    if (p.baseURL && !/^https?:\/\//.test(p.baseURL)) {
      throw new ConfigError(`Provider "${id}": baseURL must start with http:// or https://.`);
    }
  }
  if (data.model != null && typeof data.model !== 'string') throw new ConfigError('model must be a string.');
  const port = data.server?.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError('server.port must be an integer 0–65535.');
  if (!Number.isInteger(data.agent?.maxSteps) || data.agent.maxSteps < 1) {
    throw new ConfigError('agent.maxSteps must be a positive integer.');
  }
}

/** Build provider entries from well-known environment variables. Keys are stored as "$NAME" references. */
export function providersFromEnv(env = process.env) {
  const providers = {};
  let model = env.SEED_MODEL || null;
  for (const preset of PRESETS) {
    const name = (preset.env || []).find((n) => env[n]);
    if (!name) continue;
    const entry = { type: preset.type, name: preset.name };
    const baseURL = (preset.baseURLEnv && env[preset.baseURLEnv]) || preset.baseURL;
    if (baseURL) entry.baseURL = baseURL;
    // The Anthropic SDK reads its own environment variables (and `ant auth login`
    // profiles); storing nothing lets it resolve credentials itself.
    if (preset.type !== 'anthropic') entry.apiKey = `$${name}`;
    providers[preset.id] = entry;
    if (!model && preset.defaultModel) model = `${preset.id}/${preset.defaultModel}`;
  }
  return { providers, model };
}
