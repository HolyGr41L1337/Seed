// Provider registry: turns config entries into adapter instances.
//
// An adapter implements:
//   listModels({ signal }) → [{ id, name?, created?, contextWindow? }]
//   info(model)            → { contextWindow, compactAt? }
//   stream({ model, system, messages, tools, signal, onDelta })
//       → { content: Block[], raw?, stopReason, stopDetails?, model, usage, recover? }
//   onDelta receives { type: 'text' | 'thinking', text }, { type: 'tool_use_start', id, name },
//   { type: 'tool_use_progress', id, name, bytes }, { type: 'reset' }, { type: 'retry', attempt, message },
//   { type: 'notice', message }.
//   stopReason: 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause' | 'context_overflow'
import { ConfigError } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatProvider } from './openai.js';
import { pickDefaultModel, presetById } from './presets.js';

export class Providers {
  constructor(config) {
    this.config = config;
    this.factories = new Map([
      ['openai', (id, cfg) => new OpenAICompatProvider(id, cfg)],
      ['anthropic', (id, cfg) => new AnthropicProvider(id, cfg)],
    ]);
    this.instances = new Map(); // providerId → { key, provider }
  }

  /** Extensions can add adapter types. Returns a function that removes the type again. */
  registerType(type, factory) {
    this.factories.set(type, factory);
    return () => {
      if (this.factories.get(type) === factory) this.factories.delete(type);
      this.instances.clear();
    };
  }

  create(id, cfg) {
    const factory = this.factories.get(cfg.type);
    if (!factory) throw new ConfigError(`Unknown provider type "${cfg.type}".`);
    return factory(id, cfg);
  }

  get(providerId) {
    const cfg = this.config.data.providers[providerId];
    if (!cfg) throw new ConfigError(`Provider "${providerId}" is not configured.`);
    const key = JSON.stringify(cfg);
    const cached = this.instances.get(providerId);
    if (cached?.key === key) return cached.provider;
    const provider = this.create(providerId, cfg);
    this.instances.set(providerId, { key, provider });
    return provider;
  }

  /** "provider/model" (or the default) → { provider, model, ref, providerId }. */
  resolve(ref) {
    const r = this.config.resolveModel(ref);
    return { provider: this.get(r.providerId), model: r.model, ref: r.ref, providerId: r.providerId };
  }

  /**
   * Check a provider entry before saving it: list its models, or, when the
   * endpoint has no model list, send one tiny message to the given model.
   */
  async test(entry, { model, presetId, signal } = {}) {
    const provider = this.create('test', entry);
    let models = [];
    try {
      models = await provider.listModels({ signal });
    } catch (err) {
      if (err.kind === 'auth' || !model) throw err;
      await provider.stream({
        model,
        system: '',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        tools: [],
        signal,
      });
    }
    const preset = presetById(presetId);
    const suggested = model || pickDefaultModel(preset, models) || models[0]?.id || null;
    return { models, suggested };
  }
}
