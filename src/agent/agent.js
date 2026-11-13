// The agent loop: send the conversation to the model, run the tools it asks
// for (after approval where needed), feed the results back, repeat until the
// model answers without tool calls.
//
// One run per conversation at a time. Everything the run does is announced
// on the event hub so any number of clients can follow it live.
import { APP_DIR, estimateTokens, isAbort, newId, truncateMiddle } from '../util.js';
import { newMessage, publicMessage, titleFrom } from '../store.js';
import { checkInput, contextMessages, repairHistory } from './messages.js';
import { decide, describeCall } from './permissions.js';
import { compactConversation, compactionThreshold } from './compaction.js';

const MAX_RESULT_CHARS = 60_000;
const MAX_TRUNCATED_CALLS = 3;

class Run {
  constructor(conversationId) {
    this.id = newId('r_');
    this.conversationId = conversationId;
    this.controller = new AbortController();
    this.status = 'running';
    this.partial = null; // { blocks } of the assistant message being streamed
    this.tools = new Map(); // toolUseId → { name, input, status, output }
    this.approvals = new Map(); // approvalId → { request, resolve }
    this.listeners = new Set();
    this.done = null; // Promise<{ status, error }>
  }

  get signal() {
    return this.controller.signal;
  }
}

export class RunError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.name = 'RunError';
    this.status = status;
  }
}

export class Runs {
  constructor(app) {
    this.app = app;
    /** @type {Map<string, Run>} */
    this.active = new Map();
  }

  get(conversationId) {
    return this.active.get(conversationId) || null;
  }

  isRunning(conversationId) {
    return this.active.has(conversationId);
  }

  /** State of an in-flight run, for a client that connects in the middle of it. */
  snapshot(conversationId) {
    const run = this.active.get(conversationId);
    if (!run) return null;
    return {
      id: run.id,
      status: run.status,
      partial: run.partial,
      tools: [...run.tools].map(([toolUseId, t]) => ({ toolUseId, ...t })),
      approvals: [...run.approvals.values()].map((a) => a.request),
    };
  }

  /**
   * Add the user's message and start working on it.
   * @param {object} conv conversation (live object from the store)
   * @param {{ content: object[], model?: string, approval?: string, interactive?: boolean, onEvent?: Function }} opts
   * @returns {Run}
   */
  async start(conv, opts) {
    if (this.active.has(conv.id)) throw new RunError('This conversation is already working on a request. Wait for it or cancel it first.');
    const { app } = this;
    if (!opts.model && !conv.model) await app.ensureDefaultModel();
    // Fail before touching the conversation when no model can be resolved.
    app.providers.resolve(opts.model || conv.model);

    const run = new Run(conv.id);
    if (opts.onEvent) run.listeners.add(opts.onEvent);
    this.active.set(conv.id, run);
    try {
      if (repairHistory(conv.messages, newMessage)) await app.store.save(conv);
      const content = [...opts.content];
      if (conv.pendingNote) {
        content.unshift({ type: 'text', text: conv.pendingNote });
        delete conv.pendingNote;
      }
      const message = newMessage('user', content);
      conv.messages.push(message);
      if (!conv.title) conv.title = titleFrom(content.find((b) => b.type === 'text')?.text || '');
      await app.store.save(conv);
      this.emit(run, { type: 'run.started', runId: run.id });
      this.emit(run, { type: 'message.added', message });
      this.emit(run, { type: 'conversation.updated', conversation: { id: conv.id, title: conv.title, updatedAt: conv.updatedAt } });
    } catch (err) {
      this.active.delete(conv.id);
      throw err;
    }
    run.done = this.drive(run, conv, opts);
    return run;
  }

  cancel(conversationId) {
    const run = this.active.get(conversationId);
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  resolveApproval(conversationId, approvalId, decision) {
    const run = this.active.get(conversationId);
    const pending = run?.approvals.get(approvalId);
    if (!pending) throw new RunError('This approval request is no longer pending.', 404);
    if (!['allow', 'allow_always', 'deny'].includes(decision)) {
      throw new RunError('decision must be "allow", "allow_always" or "deny".', 400);
    }
    pending.resolve(decision);
  }

  emit(run, event) {
    const stamped = this.app.events.emit({ ...event, conversationId: run.conversationId });
    for (const fn of run.listeners) {
      try {
        fn(stamped);
      } catch {
        /* listener errors are not the run's problem */
      }
    }
  }

  async notice(run, conv, text, level = 'info') {
    const message = newMessage('notice', [{ type: 'text', text }], { level });
    conv.messages.push(message);
    this.emit(run, { type: 'message.added', message });
  }

  async drive(run, conv, opts) {
    const { app } = this;
    let status = 'completed';
    let error = null;
    try {
      await app.hooks.run('run:start', { conversation: conv });
      status = await this.loop(run, conv, opts);
    } catch (err) {
      if (run.signal.aborted || isAbort(err)) {
        status = 'cancelled';
      } else {
        status = 'error';
        error = { message: err.message || String(err), kind: err.kind || 'internal', status: err.status };
        if (!err.kind) console.error('[seed] run failed:', err);
        await this.notice(run, conv, error.message, 'error').catch(() => {});
      }
    } finally {
      for (const pending of run.approvals.values()) pending.resolve('cancelled');
      run.status = status;
      run.partial = null;
      repairHistory(conv.messages, newMessage); // a cancelled or failed run can leave tool calls unanswered
      await app.store.save(conv).catch((err) => console.error('[seed] could not save conversation:', err.message));
      this.active.delete(conv.id);
      this.emit(run, { type: 'run.completed', runId: run.id, status, ...(error ? { error } : {}) });
      await app.hooks.run('run:end', { conversation: conv, status, error });
    }
    return { status, error };
  }

  async loop(run, conv, opts) {
    const { app } = this;
    const tools = (await app.store.getToolset(conv.toolset)) || app.tools.definitions();
    const maxSteps = app.config.data.agent.maxSteps;
    let truncatedCalls = 0;
    let overflowRecovered = false;

    for (let step = 0; ; step++) {
      if (run.signal.aborted) return 'cancelled';
      const { provider, model, ref, providerId } = app.providers.resolve(opts.model || conv.model);
      const info = await provider.info(model);

      // Compact first when the last request came close to the budget.
      if ((conv.lastContext || 0) > compactionThreshold(info)) {
        await this.compact(run, conv, { provider, model, tools, info });
      }

      run.partial = { blocks: [] };
      this.emit(run, { type: 'message.started', model: ref });
      let result;
      try {
        result = await provider.stream({
          model,
          system: conv.system,
          messages: contextMessages(conv),
          tools,
          signal: run.signal,
          onDelta: (d) => this.onDelta(run, d),
        });
      } catch (err) {
        if (run.signal.aborted || isAbort(err)) {
          await this.keepPartial(run, conv, { providerId, provider, ref });
          return 'cancelled';
        }
        run.partial = null;
        this.emit(run, { type: 'message.reset' });
        if (err.kind === 'context_overflow' && !overflowRecovered) {
          overflowRecovered = true;
          if (await this.compact(run, conv, { provider, model, tools, info })) continue;
        }
        throw err;
      }
      run.partial = null;

      const usage = result.usage || null;
      conv.lastContext = usage?.context || estimateTokens(conv.system) + estimateTokens(contextMessages(conv)) + estimateTokens(result.content);
      if (usage) {
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) conv.usage[key] = (conv.usage[key] || 0) + (usage[key] || 0);
      }

      if (result.recover === 'strip_thinking') stripStoredThinking(conv);

      if (result.stopReason === 'refusal') {
        // A declined response is not kept: partial output of a refused turn is not a real answer.
        this.emit(run, { type: 'message.reset' });
        const category = result.stopDetails?.category ? ` (${result.stopDetails.category})` : '';
        await this.notice(
          run,
          conv,
          `The model declined this request${category}.${result.stopDetails?.explanation ? ' ' + result.stopDetails.explanation : ''} You can rephrase it or switch to another model.`,
          'warn',
        );
        return 'completed';
      }

      const calls = result.content.filter((b) => b.type === 'tool_use');
      if (result.content.length || result.raw?.length) {
        const message = newMessage('assistant', result.content, {
          provider: providerId,
          providerType: provider.type,
          model: result.model,
          ref,
          usage,
          stopReason: result.stopReason,
          ...(result.raw ? { raw: result.raw } : {}),
        });
        conv.messages.push(message);
        await app.store.save(conv);
        this.emit(run, { type: 'message.completed', message: publicMessage(message), usage, contextTokens: conv.lastContext });
        app.hooks.run('message', { conversation: conv, message });
      } else {
        this.emit(run, { type: 'message.reset' });
      }

      if (result.stopReason === 'pause') continue; // the provider asks to be called again to finish the turn

      if (result.stopReason === 'context_overflow') {
        if (await this.compact(run, conv, { provider, model, tools, info })) continue;
        await this.notice(run, conv, 'The conversation no longer fits in the model\'s context window. Start a new conversation to continue.', 'error');
        return 'completed';
      }

      if (result.stopReason === 'max_tokens') {
        if (!calls.length) {
          await this.notice(run, conv, 'The reply reached the model\'s output limit and was cut off. Say "continue" to let it go on.', 'warn');
          return 'completed';
        }
        // A tool call cut off mid-input must not run: its arguments are incomplete.
        truncatedCalls++;
        const results = calls.map((c) => ({
          type: 'tool_result',
          tool_use_id: c.id,
          is_error: true,
          content:
            'Error: this tool call was cut off because the response reached the output token limit, so it was not run. ' +
            'Try again with a smaller input. For a large file, write the first part with write_file and add the rest in several edit_file or shell (`cat >> file <<\'EOF\'`) calls.',
        }));
        await this.appendResults(run, conv, results);
        if (truncatedCalls >= MAX_TRUNCATED_CALLS) {
          await this.notice(run, conv, 'The model keeps running into its output limit while calling tools. Stopped here.', 'error');
          return 'completed';
        }
        continue;
      }

      if (!calls.length) return 'completed';

      // Run the tools, one after another.
      const results = [];
      let declined = false;
      for (const call of calls) {
        if (run.signal.aborted) {
          results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: 'Error: cancelled by the user before this tool ran.' });
          continue;
        }
        if (declined) {
          results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: 'Not run: the user declined an earlier action in this turn.' });
          continue;
        }
        const outcome = await this.executeCall(run, conv, call, opts);
        results.push(outcome.block);
        if (outcome.declined) declined = true;
      }
      await this.appendResults(run, conv, results);

      if (run.signal.aborted) return 'cancelled';
      if (declined) return 'completed'; // wait for the user's instructions
      if (step + 1 >= maxSteps) {
        await this.notice(run, conv, `Paused after ${maxSteps} tool rounds. Say "continue" to keep going.`, 'warn');
        return 'completed';
      }
    }
  }

  async appendResults(run, conv, results) {
    const message = newMessage('user', results);
    conv.messages.push(message);
    await this.app.store.save(conv);
    this.emit(run, { type: 'message.added', message });
  }

  onDelta(run, d) {
    const blocks = run.partial?.blocks;
    if (!blocks) return;
    if (d.type === 'text' || d.type === 'thinking') {
      const last = blocks[blocks.length - 1];
      if (last?.type === d.type) last.text += d.text;
      else blocks.push({ type: d.type, text: d.text });
      this.emit(run, { type: 'delta', kind: d.type, text: d.text });
    } else if (d.type === 'tool_use_start') {
      blocks.push({ type: 'tool_use', id: d.id, name: d.name, pending: true, bytes: 0 });
      this.emit(run, { type: 'tool_use.started', toolUseId: d.id, name: d.name });
    } else if (d.type === 'tool_use_progress') {
      const block = blocks.find((b) => b.type === 'tool_use' && b.id === d.id);
      if (!block) return;
      const now = Date.now();
      block.bytes = d.bytes;
      if (now - (block.sentAt || 0) > 150) {
        block.sentAt = now;
        this.emit(run, { type: 'tool_use.progress', toolUseId: d.id, bytes: d.bytes });
      }
    } else if (d.type === 'reset') {
      run.partial.blocks = [];
      this.emit(run, { type: 'message.reset' });
    } else if (d.type === 'retry') {
      this.emit(run, { type: 'run.retry', attempt: d.attempt, message: d.message });
    } else if (d.type === 'notice') {
      this.emit(run, { type: 'run.notice', message: d.message });
    }
  }

  /** A cancelled reply: keep what the user already saw, as plain text. */
  async keepPartial(run, conv, { providerId, provider, ref }) {
    const text = (run.partial?.blocks || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    run.partial = null;
    if (!text.trim()) {
      this.emit(run, { type: 'message.reset' });
      return;
    }
    const message = newMessage('assistant', [{ type: 'text', text }], {
      provider: providerId,
      providerType: provider.type,
      ref,
      interrupted: true,
    });
    conv.messages.push(message);
    this.emit(run, { type: 'message.completed', message });
  }

  async compact(run, conv, { provider, model, tools, info }) {
    this.emit(run, { type: 'compaction.started' });
    let made = false;
    try {
      made = await compactConversation({ conv, provider, model, tools, signal: run.signal, info });
    } finally {
      this.emit(run, { type: 'compaction.completed', compacted: made });
    }
    if (made) {
      await this.notice(run, conv, 'Earlier messages were summarized to free up context. The full history is still shown here.', 'info');
      await this.app.store.save(conv);
    }
    return made;
  }

  /**
   * Validate, approve and run one tool call.
   * @returns {{ block: object, declined?: boolean }}
   */
  async executeCall(run, conv, call, opts) {
    const { app } = this;
    const started = Date.now();
    const fail = (content, extra = {}) => {
      const block = { type: 'tool_result', tool_use_id: call.id, content: `Error: ${content}`, is_error: true };
      this.emit(run, { type: 'tool.completed', toolUseId: call.id, name: call.name, result: block, ms: Date.now() - started });
      run.tools.delete(call.id);
      return { block, ...extra };
    };

    const state = { name: call.name, input: call.input, status: 'running', output: '' };
    run.tools.set(call.id, state);

    if (call.inputError !== undefined) {
      return fail(
        `the arguments for ${call.name} were not valid JSON, so the tool was not run. ` +
          `${JSON.stringify({ INVALID_JSON: String(call.inputError).slice(0, 2000) })} Send the arguments again as a single JSON object.`,
      );
    }
    const tool = app.tools.get(call.name);
    if (!tool) {
      const names = app.tools.definitions().map((t) => t.name).join(', ');
      return fail(`there is no tool named "${call.name}". Available tools: ${names}.`);
    }
    const checked = checkInput(tool.parameters, call.input);
    if (checked.error) {
      return fail(`invalid arguments for ${call.name}: ${checked.error}. Check the tool's parameters and call it again.`);
    }
    let args = checked.value;

    const mode = opts.approval || conv.approval || app.config.approval;
    const ctx = {
      cwd: conv.cwd,
      signal: run.signal,
      app,
      conversation: conv,
      toolUseId: call.id,
      mode, // the approval mode this run works under
      protectedFiles: [app.config.file],
      emit: (text) => this.toolOutput(run, call.id, state, String(text)),
    };

    // Extensions may adjust or veto the call.
    for (const r of await app.hooks.run('tool:before', { conversation: conv, name: call.name, args })) {
      if (typeof r.deny === 'string') return fail(`blocked by an extension: ${r.deny}`);
      if (r.args && typeof r.args === 'object') args = r.args;
    }

    // Approval.
    let descriptor;
    let info = {};
    try {
      descriptor = describeCall(tool, args, ctx);
      info = tool.describe?.(args, ctx) || {};
    } catch (err) {
      return fail(`could not prepare ${call.name}: ${err.message}`);
    }
    const roots = { cwd: conv.cwd, extensionsDir: app.extensionsDir, appDir: APP_DIR };
    const { decision, category } = decide({ mode, descriptor, grants: conv.grants, roots });
    if (decision === 'ask') {
      if (opts.interactive === false) {
        return fail(
          'this action needs the user\'s approval and this run cannot ask for it, so it was not performed. ' +
            'Continue with what you can do without it and tell the user what was skipped.',
        );
      }
      state.status = 'awaiting_approval';
      const answer = await this.requestApproval(run, {
        toolUseId: call.id,
        name: call.name,
        category,
        title: info.title || call.name,
        detail: info.detail || '',
        preview: info.preview || null,
        input: args,
      });
      if (answer === 'cancelled') return fail('cancelled by the user before this tool ran.');
      if (answer === 'deny') {
        return fail('the user declined this action. Do not retry it or work around it; wait for the user\'s instructions.', { declined: true });
      }
      if (answer === 'allow_always') {
        conv.grants = { ...conv.grants, [category]: true };
      }
      state.status = 'running';
    }

    this.emit(run, { type: 'tool.started', toolUseId: call.id, name: call.name, input: args, title: info.title || null });

    let result;
    try {
      result = await tool.run(args, ctx);
    } catch (err) {
      if (run.signal.aborted) result = { content: 'Error: cancelled by the user.', is_error: true };
      else result = { content: `Error: ${call.name} failed: ${err.message || err}`, is_error: true };
    }
    this.flushToolOutput(run, call.id, state);
    if (typeof result === 'string') result = { content: result };
    else if (!result || typeof result !== 'object') result = { content: result === undefined ? '(no output)' : JSON.stringify(result) };
    if (typeof result.content !== 'string') result.content = JSON.stringify(result.content ?? null, null, 2);

    for (const r of await app.hooks.run('tool:after', { conversation: conv, name: call.name, args, result })) {
      if (r.result && typeof r.result.content === 'string') result = r.result;
    }

    const block = {
      type: 'tool_result',
      tool_use_id: call.id,
      content: truncateMiddle(result.content, MAX_RESULT_CHARS) || '(no output)',
      ...(result.is_error ? { is_error: true } : {}),
      ...(result.display ? { display: result.display } : {}),
    };
    run.tools.delete(call.id);
    this.emit(run, { type: 'tool.completed', toolUseId: call.id, name: call.name, result: block, ms: Date.now() - started });
    return { block };
  }

  requestApproval(run, fields) {
    return new Promise((resolve) => {
      const request = { id: newId('a_'), ...fields };
      const settle = (decision) => {
        if (!run.approvals.delete(request.id)) return;
        run.signal.removeEventListener('abort', onAbort);
        this.emit(run, { type: 'approval.resolved', approvalId: request.id, toolUseId: request.toolUseId, decision });
        resolve(decision);
      };
      const onAbort = () => settle('cancelled');
      run.approvals.set(request.id, { request, resolve: settle });
      if (run.signal.aborted) return settle('cancelled');
      run.signal.addEventListener('abort', onAbort, { once: true });
      this.emit(run, { type: 'approval.requested', approval: request });
    });
  }

  /** Stream tool output to clients in small batches. */
  toolOutput(run, toolUseId, state, text) {
    state.output = (state.output + text).slice(-8000);
    state.buffer = (state.buffer || '') + text;
    if (state.timer) return;
    state.timer = setTimeout(() => this.flushToolOutput(run, toolUseId, state), 80);
  }

  flushToolOutput(run, toolUseId, state) {
    clearTimeout(state.timer);
    state.timer = null;
    if (!state.buffer) return;
    const text = state.buffer;
    state.buffer = '';
    this.emit(run, { type: 'tool.output', toolUseId, text });
  }
}

/** One-time recovery after the API reported thinking blocks that no longer match the conversation. */
function stripStoredThinking(conv) {
  for (const m of conv.messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.meta?.raw)) continue;
    const kept = m.meta.raw.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
    if (kept.length === m.meta.raw.length) continue;
    if (kept.length) m.meta.raw = kept;
    else delete m.meta.raw;
  }
}
