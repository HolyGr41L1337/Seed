// Provider adapter for the OpenAI-compatible Chat Completions protocol:
// DeepSeek, OpenAI, OpenRouter, Moonshot, DashScope, SiliconFlow, Ollama,
// LM Studio, vLLM and anything else that speaks `POST /chat/completions`
// with `stream: true` and `tools`.
import { resolveSecret } from '../config.js';
import { isAbort, newId, sleep } from '../util.js';
import { ProviderError, backoffMs, isRetryableStatus, kindFromStatus } from './errors.js';
import { sseData } from './sse.js';

const MAX_RETRIES = 3;
const DEFAULT_CONTEXT_WINDOW = 128_000;

export class OpenAICompatProvider {
  /**
   * @param {string} id provider id from the config
   * @param {object} cfg provider config entry
   */
  constructor(id, cfg) {
    this.id = id;
    this.type = 'openai';
    this.cfg = cfg;
    this.baseURL = String(cfg.baseURL || '').replace(/\/+$/, '');
    /** model → boolean: whether to send `reasoning_content` back (learned from the API's own errors) */
    this.echoOverride = new Map();
    this.modelMeta = new Map();
  }

  headers() {
    const key = resolveSecret(this.cfg.apiKey);
    return {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(this.cfg.headers || {}),
    };
  }

  async listModels({ signal } = {}) {
    const res = await request(`${this.baseURL}/models`, { headers: this.headers(), signal });
    const json = await res.json().catch(() => ({}));
    const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    const models = list
      .filter((m) => m && typeof m.id === 'string')
      .map((m) => ({
        id: m.id,
        name: m.name || m.display_name || undefined,
        created: m.created || undefined,
        contextWindow: m.context_length || m.context_window || undefined,
      }));
    for (const m of models) if (m.contextWindow) this.modelMeta.set(m.id, m);
    return models;
  }

  async info(model) {
    const opt = this.cfg.modelOptions?.[model] || {};
    const contextWindow =
      opt.contextWindow || this.cfg.contextWindow || this.modelMeta.get(model)?.contextWindow || DEFAULT_CONTEXT_WINDOW;
    return { contextWindow, compactAt: opt.compactAt || this.cfg.compactAt || null };
  }

  /**
   * Run one model turn.
   * @param {{ model: string, system: string, messages: object[], tools: object[], signal?: AbortSignal,
   *           onDelta?: (d: object) => void, extraParams?: object }} args
   */
  async stream(args) {
    const onDelta = args.onDelta || (() => {});
    let echo = this.shouldEcho(args.model, args.messages);
    let flipped = false;
    for (let attempt = 0; ; attempt++) {
      let emitted = false;
      try {
        return await this.streamOnce({ ...args, echo, onDelta: (d) => ((emitted = true), onDelta(d)) });
      } catch (err) {
        if (isAbort(err) || args.signal?.aborted) throw err;
        if (emitted) onDelta({ type: 'reset' });
        // Thinking-mode APIs disagree on whether earlier reasoning must be sent
        // back with tool calls. The error names the field, so flip once and remember.
        if (err instanceof ProviderError && err.status === 400 && /reasoning_content/i.test(err.message) && !flipped) {
          flipped = true;
          echo = !echo;
          this.echoOverride.set(args.model, echo);
          continue;
        }
        if (err instanceof ProviderError && err.retryable && attempt < MAX_RETRIES) {
          onDelta({ type: 'retry', attempt: attempt + 1, message: err.message });
          await sleep(backoffMs(attempt, err.retryAfter, this.cfg.retryBaseMs), args.signal);
          continue;
        }
        throw err;
      }
    }
  }

  shouldEcho(model, messages) {
    const mode = this.cfg.reasoningEcho || 'auto';
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    if (this.echoOverride.has(model)) return this.echoOverride.get(model);
    // auto: once this kind of provider has produced reasoning in the conversation, keep sending it back.
    return messages.some(
      (m) => m.role === 'assistant' && m.meta?.providerType === 'openai' && m.content.some((b) => b.type === 'thinking' && b.text),
    );
  }

  async streamOnce({ model, system, messages, tools, signal, onDelta, echo, extraParams }) {
    const body = {
      model,
      messages: toOpenAIMessages(system, messages, { echoReasoning: echo }),
      stream: true,
      ...(this.cfg.streamUsage === false ? {} : { stream_options: { include_usage: true } }),
      ...(tools?.length
        ? {
            tools: tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
      ...(this.cfg.params || {}),
      ...(this.cfg.modelOptions?.[model]?.params || {}),
      ...(extraParams || {}),
    };

    const res = await request(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });

    let text = '';
    let thinking = '';
    let finish = null;
    let usage = null;
    let servedModel = model;
    /** @type {{ id: string, name: string, args: string, announced: boolean }[]} */
    const calls = [];

    const callAt = (tc) => {
      // Providers differ: some send `index`, some only `id`, some neither.
      if (Number.isInteger(tc.index)) return (calls[tc.index] ||= { id: '', name: '', args: '', announced: false });
      if (tc.id) {
        const found = calls.find((c) => c && c.id === tc.id);
        if (found) return found;
        const fresh = { id: '', name: '', args: '', announced: false };
        calls.push(fresh);
        return fresh;
      }
      if (!calls.length || tc.function?.name) {
        const fresh = { id: '', name: '', args: '', announced: false };
        calls.push(fresh);
        return fresh;
      }
      return calls[calls.length - 1];
    };

    try {
      for await (const data of sseData(res.body)) {
        if (data === '[DONE]') break;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) {
          const message = chunk.error.message || JSON.stringify(chunk.error);
          throw new ProviderError(message, { code: chunk.error.code, kind: 'server', retryable: !text && !calls.length });
        }
        if (chunk.usage) usage = chunk.usage;
        if (chunk.model) servedModel = chunk.model;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};

        const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : delta.reasoning;
        if (typeof reasoning === 'string' && reasoning) {
          thinking += reasoning;
          onDelta({ type: 'thinking', text: reasoning });
        }
        if (typeof delta.content === 'string' && delta.content) {
          text += delta.content;
          onDelta({ type: 'text', text: delta.content });
        }
        for (const tc of delta.tool_calls || []) {
          const call = callAt(tc);
          if (tc.id) call.id = tc.id;
          if (tc.function?.name) call.name += tc.function.name;
          if (typeof tc.function?.arguments === 'string') call.args += tc.function.arguments;
          if (!call.id) call.id = newId('call_');
          if (call.name && !call.announced) {
            call.announced = true;
            onDelta({ type: 'tool_use_start', id: call.id, name: call.name });
          } else if (call.announced) {
            onDelta({ type: 'tool_use_progress', id: call.id, name: call.name, bytes: call.args.length });
          }
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    } catch (err) {
      if (isAbort(err) || signal?.aborted || err instanceof ProviderError) throw err;
      throw new ProviderError(`The connection to the model was interrupted: ${err.message}`, {
        kind: 'network',
        retryable: true,
        cause: err,
      });
    }

    const content = [];
    if (thinking) content.push({ type: 'thinking', text: thinking });
    if (text) content.push({ type: 'text', text });
    for (const call of calls.filter(Boolean)) {
      if (!call.name) continue;
      const block = { type: 'tool_use', id: call.id, name: call.name, input: {} };
      const raw = call.args.trim();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) block.input = parsed;
          else block.inputError = raw;
        } catch {
          block.inputError = raw;
        }
      }
      content.push(block);
    }
    const hasCalls = content.some((b) => b.type === 'tool_use');

    if (finish === null && !content.length) {
      throw new ProviderError('The model returned an empty response.', { kind: 'server', retryable: true });
    }

    let stopReason = 'end';
    if (finish === 'length') stopReason = 'max_tokens';
    else if (finish === 'content_filter') stopReason = 'refusal';
    else if (hasCalls) stopReason = 'tool_use';

    return { content, stopReason, model: servedModel, usage: mapUsage(usage) };
  }
}

function mapUsage(u) {
  if (!u) return null;
  const prompt = u.prompt_tokens || 0;
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
  const output = u.completion_tokens || 0;
  return {
    input: Math.max(0, prompt - cached),
    output,
    cacheRead: cached,
    cacheWrite: 0,
    context: prompt + output,
  };
}

/** fetch() with provider-flavored errors. */
async function request(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (isAbort(err) || init.signal?.aborted) throw err;
    const reason = err.cause?.code || err.cause?.message || err.message;
    throw new ProviderError(`Cannot reach ${new URL(url).host}: ${reason}`, { kind: 'network', retryable: true, cause: err });
  }
  if (res.ok) return res;
  const raw = await res.text().catch(() => '');
  let message = raw.slice(0, 2000);
  let code;
  try {
    const json = JSON.parse(raw);
    const e = json.error ?? json;
    message = (typeof e === 'string' ? e : e.message) || message;
    code = typeof e === 'object' ? e.code || e.type : undefined;
  } catch {
    /* not JSON */
  }
  const overflow =
    code === 'context_length_exceeded' || /context length|maximum context|context window|too many tokens|prompt is too long/i.test(message);
  const retryAfter = Number(res.headers.get('retry-after'));
  throw new ProviderError(`${res.status} ${message || res.statusText}`.trim(), {
    status: res.status,
    code,
    kind: overflow ? 'context_overflow' : kindFromStatus(res.status),
    retryable: isRetryableStatus(res.status),
    retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
  });
}

/** Canonical conversation → Chat Completions messages. */
export function toOpenAIMessages(system, messages, { echoReasoning = false } = {}) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });

  for (const m of messages) {
    if (m.role === 'user') {
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(b.content ?? '') || '(no output)' });
        }
      }
      const parts = [];
      for (const b of m.content) {
        if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.data}` } });
      }
      if (!parts.length) continue;
      const onlyText = parts.every((p) => p.type === 'text');
      const content = onlyText ? parts.map((p) => p.text).join('\n\n') : parts;
      const last = out[out.length - 1];
      // Some APIs reject two user messages in a row; merge plain-text neighbours.
      if (last?.role === 'user' && typeof last.content === 'string' && onlyText) last.content += '\n\n' + content;
      else out.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = m.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: b.inputError ?? JSON.stringify(b.input ?? {}) },
        }));
      if (!text && !calls.length) continue;
      const msg = { role: 'assistant', content: text || (calls.length ? null : '') };
      if (calls.length) msg.tool_calls = calls;
      if (echoReasoning) {
        const fromSameKind = m.meta?.providerType === 'openai';
        msg.reasoning_content = fromSameKind
          ? m.content.filter((b) => b.type === 'thinking').map((b) => b.text).join('')
          : '';
      }
      out.push(msg);
    }
  }
  return out;
}
