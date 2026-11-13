// Provider adapter for the Anthropic Messages API, through the official SDK.
//
// Two request shapes:
//   - the real API (api.anthropic.com): adaptive thinking with summaries,
//     prompt caching, eager tool-input streaming, a server-side fallback for
//     classifier refusals, and "drop_block" so an edited history degrades
//     instead of failing;
//   - any other base URL (a gateway or an Anthropic-compatible endpoint):
//     the plain, widely supported request with no beta features.
//
// Assistant turns are replayed from `meta.raw` — the content array exactly
// as the API returned it — because thinking blocks are only valid unmodified
// and in the conversation that produced them.
import Anthropic from '@anthropic-ai/sdk';
import { resolveSecret } from '../config.js';
import { isAbort } from '../util.js';
import { ProviderError, kindFromStatus } from './errors.js';

const BETA_FALLBACK = 'server-side-fallback-2026-07-01';
const BETA_BINDING = 'thinking-binding-controls-2026-08-01';
const OFFICIAL = /^https:\/\/api\.anthropic\.com\/?$/;
const MAX_JSON_RETRIES = 2;

export class AnthropicProvider {
  constructor(id, cfg) {
    this.id = id;
    this.type = 'anthropic';
    this.cfg = cfg;
    const options = { maxRetries: 3 };
    const key = resolveSecret(cfg.apiKey);
    if (key) options.apiKey = key;
    if (cfg.baseURL) options.baseURL = cfg.baseURL;
    if (cfg.headers) options.defaultHeaders = cfg.headers;
    // With no key in the config the SDK resolves credentials itself
    // (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, an `ant auth login` profile).
    this.client = new Anthropic(options);
    this.official = cfg.features === 'full' || (cfg.features !== 'basic' && OFFICIAL.test(this.client.baseURL));
    if (!this.official && key) {
      // The SDK sends the key as a bearer token. Gateways and Anthropic-compatible
      // endpoints often read the older x-api-key header instead, so send both there.
      this.client = new Anthropic({ ...options, defaultHeaders: { 'x-api-key': key, ...(cfg.headers || {}) } });
    }
    this.infoCache = new Map();
  }

  async listModels() {
    try {
      const models = [];
      for await (const m of this.client.models.list()) {
        models.push({
          id: m.id,
          name: m.display_name,
          created: m.created_at ? Date.parse(m.created_at) / 1000 : undefined,
          contextWindow: m.max_input_tokens || undefined,
        });
      }
      return models;
    } catch (err) {
      throw mapError(err);
    }
  }

  /** What the model supports. Asked from the Models API when possible, inferred from the id otherwise. */
  async info(model) {
    if (this.infoCache.has(model)) return this.infoCache.get(model);
    const opt = this.cfg.modelOptions?.[model] || {};
    let info = inferFromId(model);
    if (this.official) {
      try {
        const m = await this.client.beta.models.retrieve(model, { betas: [BETA_FALLBACK] });
        const caps = m.capabilities;
        info = {
          contextWindow: m.max_input_tokens || info.contextWindow,
          maxOutput: m.max_tokens || info.maxOutput,
          adaptive: caps?.thinking?.types?.adaptive?.supported ?? info.adaptive,
          effort: caps?.effort?.supported ?? info.effort,
          effortLevels: caps?.effort
            ? ['low', 'medium', 'high', 'xhigh', 'max'].filter((l) => caps.effort[l]?.supported)
            : info.effortLevels,
          fallbacks: (m.allowed_fallback_models?.length || 0) > 0,
        };
      } catch (err) {
        // Wrong key: fail now with a clear message. Anything else: keep the inferred values.
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw mapError(err);
      }
    }
    info = {
      ...info,
      contextWindow: opt.contextWindow || this.cfg.contextWindow || info.contextWindow,
      compactAt: opt.compactAt || this.cfg.compactAt || null,
    };
    this.infoCache.set(model, info);
    return info;
  }

  async stream(args) {
    const onDelta = args.onDelta || (() => {});
    const info = await this.info(args.model);
    let stripThinking = false;
    for (let jsonRetries = 0; ; ) {
      let emitted = false;
      try {
        const result = await this.streamOnce({
          ...args,
          info,
          stripThinking,
          onDelta: (d) => ((emitted = true), onDelta(d)),
        });
        if (stripThinking) result.recover = 'strip_thinking';
        return result;
      } catch (err) {
        if (isAbort(err) || args.signal?.aborted) throw err;
        if (emitted) onDelta({ type: 'reset' });
        // The stream helper could not parse a tool input at all: re-issue the turn.
        if (err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError) && jsonRetries < MAX_JSON_RETRIES) {
          jsonRetries++;
          onDelta({ type: 'retry', attempt: jsonRetries, message: 'The model produced an unreadable tool call; asking again.' });
          continue;
        }
        // An endpoint without "drop_block" rejects thinking blocks whose conversation
        // changed. The documented recovery is to resend once without them.
        if (err instanceof Anthropic.BadRequestError && !stripThinking && !this.official && hasThinking(args.messages)) {
          stripThinking = true;
          continue;
        }
        throw mapError(err);
      }
    }
  }

  async streamOnce({ model, system, messages, tools, signal, onDelta, info, stripThinking }) {
    const opt = this.cfg.modelOptions?.[model] || {};
    const params = { ...(this.cfg.params || {}), ...(opt.params || {}) };
    const betas = [];

    const body = {
      model,
      // Thinking counts toward max_tokens, so leave room for it. An explicit setting wins.
      max_tokens: params.maxTokens || Math.min(64000, info.maxOutput || 64000),
      messages: toAnthropicMessages(messages, { stripThinking }),
    };
    if (system) body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    if (tools?.length) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
        // Stream large inputs (file bodies) as they are written. The API then no longer
        // validates them, so the agent checks every input against the schema itself.
        ...(this.official ? { eager_input_streaming: true } : {}),
      }));
    }
    if (info.adaptive) {
      body.thinking = { type: 'adaptive', display: 'summarized' };
      if (this.official) {
        body.thinking.block_binding = { prefix_mismatch_behavior: 'drop_block' };
        betas.push(BETA_BINDING);
      }
    }
    if (info.effort) {
      const effort = params.effort || defaultEffort(model);
      if (!info.effortLevels || info.effortLevels.includes(effort)) body.output_config = { effort };
    }
    if (this.official) {
      body.cache_control = { type: 'ephemeral' }; // caches the growing conversation automatically
      if (info.fallbacks && params.fallbacks !== false) {
        // A safety classifier can decline a harmless request. Let the API retry
        // it on the model Anthropic recommends instead of stopping the task.
        body.fallbacks = 'default';
        betas.push(BETA_FALLBACK);
      }
    } else {
      markLastBlockForCaching(body.messages);
    }

    const stream = betas.length
      ? this.client.beta.messages.stream({ ...body, betas }, { signal })
      : this.client.messages.stream(body, { signal });

    const toolBytes = new Map(); // content block index → { id, name, bytes }
    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'tool_use') {
          toolBytes.set(event.index, { id: block.id, name: block.name, bytes: 0 });
          onDelta({ type: 'tool_use_start', id: block.id, name: block.name });
        } else if (block.type === 'fallback') {
          onDelta({ type: 'notice', message: `${block.from?.model} declined this request; ${block.to?.model} is continuing.` });
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') onDelta({ type: 'text', text: delta.text });
        else if (delta.type === 'thinking_delta') {
          if (delta.thinking) onDelta({ type: 'thinking', text: delta.thinking });
        } else if (delta.type === 'input_json_delta') {
          const t = toolBytes.get(event.index);
          if (t) {
            t.bytes += delta.partial_json.length;
            onDelta({ type: 'tool_use_progress', id: t.id, name: t.name, bytes: t.bytes });
          }
        }
      }
    }
    const message = await stream.finalMessage();

    const dropped = (message.input_transformations || []).some(
      (t) => t.type === 'thinking_dropped' && t.reason === 'prefix_binding_mismatch',
    );
    const u = message.usage || {};
    const input = u.input_tokens || 0;
    const cacheRead = u.cache_read_input_tokens || 0;
    const cacheWrite = u.cache_creation_input_tokens || 0;
    const output = u.output_tokens || 0;

    return {
      content: normalizeContent(message.content),
      raw: message.content,
      stopReason: STOP_REASONS[message.stop_reason] || 'end',
      stopDetails: message.stop_details || null,
      model: message.model || model,
      usage: { input, output, cacheRead, cacheWrite, context: input + cacheRead + cacheWrite + output },
      ...(dropped ? { recover: 'strip_thinking' } : {}),
    };
  }
}

const STOP_REASONS = {
  end_turn: 'end',
  stop_sequence: 'end',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
  pause_turn: 'pause',
  model_context_window_exceeded: 'context_overflow',
};

/** Effort is the main cost/quality control on current models; set it explicitly. */
function defaultEffort(model) {
  return /fable|mythos/.test(model) ? 'high' : 'medium';
}

/** Used when the Models API is not available (a gateway, or a non-Claude model behind this protocol). */
function inferFromId(model) {
  const modern = /^(?:anthropic\.)?claude-(?:fable|mythos|opus-[5-9]|sonnet-[5-9]|haiku-[5-9]|opus-4-[6-9]|sonnet-4-[6-9])/.test(model);
  const isClaude = /claude/.test(model);
  return {
    contextWindow: modern ? 1_000_000 : 200_000,
    maxOutput: modern ? 128_000 : isClaude ? 64_000 : 8_192,
    adaptive: modern,
    effort: modern,
    effortLevels: null,
    fallbacks: false,
  };
}

function hasThinking(messages) {
  return messages.some(
    (m) => m.role === 'assistant' && Array.isArray(m.meta?.raw) && m.meta.raw.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking'),
  );
}

const safeId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '_');

/** Canonical conversation → Messages API `messages`. */
export function toAnthropicMessages(messages, { stripThinking = false } = {}) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      let content;
      if (m.meta?.providerType === 'anthropic' && Array.isArray(m.meta.raw)) {
        content = echoContent(m.meta.raw);
        if (stripThinking) content = content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
      } else {
        // Produced by another kind of provider: keep the text and the tool calls.
        content = [];
        for (const b of m.content) {
          if (b.type === 'text' && b.text.trim()) content.push({ type: 'text', text: b.text });
          else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: safeId(b.id), name: b.name, input: b.input ?? {} });
        }
      }
      if (content.length) out.push({ role: 'assistant', content });
    } else if (m.role === 'user') {
      const results = [];
      const rest = [];
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          results.push({
            type: 'tool_result',
            tool_use_id: safeId(b.tool_use_id),
            content: String(b.content ?? '') || '(no output)',
            ...(b.is_error ? { is_error: true } : {}),
          });
        } else if (b.type === 'text' && b.text) rest.push({ type: 'text', text: b.text });
        else if (b.type === 'image') rest.push({ type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.data } });
      }
      // Tool results must come first in the message that answers the tool calls.
      if (results.length || rest.length) out.push({ role: 'user', content: [...results, ...rest] });
    }
  }
  return out;
}

/**
 * How to send a previous response back. Normally unchanged. After a
 * mid-response fallback only text may be echoed from before the last
 * `fallback` block; the block itself stays where it was.
 */
function echoContent(raw) {
  const boundary = raw.findLastIndex((b) => b.type === 'fallback');
  if (boundary === -1) return raw;
  return raw.filter((b, i) => i >= boundary || b.type === 'text' || b.type === 'fallback');
}

/** API response content → canonical blocks for display and tool execution. */
function normalizeContent(raw) {
  const boundary = raw.findLastIndex((b) => b.type === 'fallback');
  const blocks = [];
  raw.forEach((b, i) => {
    if (b.type === 'text') {
      if (b.text) blocks.push({ type: 'text', text: b.text });
    } else if (i < boundary) {
      // Output of a model that declined part-way: its text stays, nothing else counts.
    } else if (b.type === 'thinking') {
      if (b.thinking) blocks.push({ type: 'thinking', text: b.thinking });
    } else if (b.type === 'tool_use') {
      blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} });
    }
  });
  return blocks;
}

function markLastBlockForCaching(messages) {
  const last = messages[messages.length - 1];
  if (!last?.content?.length) return;
  const content = last.content.slice();
  const tail = content[content.length - 1];
  if (tail.type === 'thinking' || tail.type === 'redacted_thinking') return;
  content[content.length - 1] = { ...tail, cache_control: { type: 'ephemeral' } };
  messages[messages.length - 1] = { ...last, content };
}

/** SDK exception → ProviderError, most specific class first. */
function mapError(err) {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return Object.assign(new Error('Aborted'), { name: 'AbortError' });
  const info = { status: err.status, cause: err };
  if (err instanceof Anthropic.AuthenticationError) {
    return new ProviderError(`The API key was rejected (${err.message}).`, { ...info, kind: 'auth' });
  }
  if (err instanceof Anthropic.PermissionDeniedError) return new ProviderError(err.message, { ...info, kind: 'auth' });
  if (err instanceof Anthropic.NotFoundError) return new ProviderError(err.message, { ...info, kind: 'bad_request' });
  if (err instanceof Anthropic.RateLimitError) return new ProviderError(err.message, { ...info, kind: 'rate_limit', retryable: true });
  if (err instanceof Anthropic.BadRequestError) return new ProviderError(err.message, { ...info, kind: 'bad_request' });
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(`Cannot reach the Anthropic API: ${err.cause?.message || err.message}`, { ...info, kind: 'network', retryable: true });
  }
  if (err instanceof Anthropic.InternalServerError) return new ProviderError(err.message, { ...info, kind: 'server', retryable: true });
  if (err instanceof Anthropic.APIError) return new ProviderError(err.message, { ...info, kind: kindFromStatus(err.status || 0) });
  if (err instanceof Anthropic.AnthropicError) return new ProviderError(err.message, { kind: 'other', cause: err });
  return err;
}
