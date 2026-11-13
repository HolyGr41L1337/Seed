// The Anthropic adapter against a scripted Messages API.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { toAnthropicMessages } from '../src/providers/anthropic.js';
import { toOpenAIMessages } from '../src/providers/openai.js';
import { chat, lastAssistantText, makeApp, notices, openaiProvider, toolResults } from './helpers/app.js';
import { startMockAnthropic } from './helpers/mock-anthropic.js';
import { startMockOpenAI } from './helpers/mock-openai.js';

let cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setup(script, { features = 'full', model = 'claude-opus-5-5', provider = {}, mockOptions } = {}) {
  const mock = await startMockAnthropic(script, mockOptions);
  const made = await makeApp({
    providers: { claude: { type: 'anthropic', baseURL: mock.url, apiKey: 'sk-ant-test', features, ...provider } },
    model: `claude/${model}`,
  });
  cleanups.push(made.cleanup, mock.close);
  return { mock, ...made };
}

describe('request shape', () => {
  it('uses the full feature set on the real API', async () => {
    const { app, mock } = await setup([{ blocks: [{ type: 'text', text: 'hi' }] }]);
    await chat(app, 'hello');
    const { body, headers } = mock.requests[0];
    assert.equal(body.model, 'claude-opus-5-5');
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 64000);
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    assert.deepEqual(body.output_config, { effort: 'medium' });
    assert.equal(body.fallbacks, 'default');
    assert.deepEqual(body.cache_control, { type: 'ephemeral' });
    assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
    assert.ok(body.tools.every((t) => t.eager_input_streaming === true && t.input_schema.type === 'object'));
    assert.equal(body.temperature, undefined);
    assert.equal(body.tool_choice, undefined);
    const betas = headers['anthropic-beta'].split(',');
    assert.ok(betas.includes('thinking-binding-controls-2026-08-01'));
    assert.ok(betas.includes('server-side-fallback-2026-07-01'));
    assert.equal(headers.authorization, 'Bearer sk-ant-test');
  });

  it('sends a plain request to other endpoints', async () => {
    const { app, mock } = await setup([{ blocks: [{ type: 'text', text: 'hi' }] }], { features: 'basic' });
    await chat(app, 'hello');
    const { body, headers } = mock.requests[0];
    assert.equal(headers['anthropic-beta'], undefined);
    assert.equal(headers['x-api-key'], 'sk-ant-test', 'gateways often read this header');
    assert.equal(body.fallbacks, undefined);
    assert.equal(body.cache_control, undefined);
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
    assert.ok(body.tools.every((t) => !('eager_input_streaming' in t)));
    assert.deepEqual(body.messages.at(-1).content.at(-1).cache_control, { type: 'ephemeral' }, 'explicit cache breakpoint on the last block');
  });

  it('sends no thinking or effort settings to models it does not know', async () => {
    const { app, mock } = await setup([{ blocks: [{ type: 'text', text: 'hi' }] }], { features: 'basic', model: 'some-other-model' });
    await chat(app, 'hello');
    const { body } = mock.requests[0];
    assert.equal(body.thinking, undefined);
    assert.equal(body.output_config, undefined);
    assert.equal(body.max_tokens, 8192);
  });

  it('takes effort and max_tokens from the settings, and a higher default effort for Fable', async () => {
    const fable = await setup([{ blocks: [{ type: 'text', text: 'hi' }] }], { model: 'claude-fable-5-2' });
    await chat(fable.app, 'hello');
    assert.deepEqual(fable.mock.requests[0].body.output_config, { effort: 'high' });

    const tuned = await setup([{ blocks: [{ type: 'text', text: 'hi' }] }], { provider: { params: { effort: 'low', maxTokens: 20000, fallbacks: false } } });
    await chat(tuned.app, 'hello');
    assert.deepEqual(tuned.mock.requests[0].body.output_config, { effort: 'low' });
    assert.equal(tuned.mock.requests[0].body.max_tokens, 20000);
    assert.equal(tuned.mock.requests[0].body.fallbacks, undefined);
  });
});

describe('conversation replay', () => {
  it('sends assistant turns back exactly as the API returned them', async () => {
    const { app, mock } = await setup([
      { blocks: [{ type: 'thinking', thinking: 'Plan.', signature: 'SIG1' }, { type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'toolu_1', name: 'list_dir', input: {} }] },
      { blocks: [{ type: 'thinking', thinking: '', signature: 'SIG2' }, { type: 'text', text: 'Empty folder.' }] },
      { blocks: [{ type: 'text', text: 'Yes.' }] },
    ]);
    const { conv } = await chat(app, 'what is here?');
    await chat(app, 'sure?', { conv });

    const third = mock.requests[2].body.messages;
    assert.deepEqual(third.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
    assert.deepEqual(third[1].content, [
      { type: 'thinking', thinking: 'Plan.', signature: 'SIG1' },
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 'toolu_1', name: 'list_dir', input: {} },
    ]);
    assert.equal(third[2].content[0].type, 'tool_result');
    assert.equal(third[2].content[0].tool_use_id, 'toolu_1');
    assert.deepEqual(third[3].content[0], { type: 'thinking', thinking: '', signature: 'SIG2' }, 'empty thinking blocks are replayed too');
    // The system prompt and tools never change within a conversation.
    assert.deepEqual(mock.requests[2].body.system, mock.requests[0].body.system);
    assert.deepEqual(mock.requests[2].body.tools, mock.requests[0].body.tools);

    // What clients see has no signatures, and no empty thinking.
    const first = conv.messages[1];
    assert.deepEqual(first.content.map((b) => b.type), ['thinking', 'text', 'tool_use']);
    assert.equal(first.content[0].signature, undefined);
    assert.deepEqual(conv.messages[3].content.map((b) => b.type), ['text']);
    assert.equal(conv.usage.cacheRead, 3000);
  });

  it('drops stored thinking once the API reports it no longer matches the conversation', async () => {
    const { app, mock } = await setup([
      { blocks: [{ type: 'thinking', thinking: 'A', signature: 'S1' }, { type: 'text', text: 'one' }] },
      {
        blocks: [{ type: 'thinking', thinking: 'B', signature: 'S2' }, { type: 'text', text: 'two' }],
        input_transformations: [{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }],
      },
      { blocks: [{ type: 'text', text: 'three' }] },
    ]);
    const { conv } = await chat(app, 'a');
    await chat(app, 'b', { conv });
    await chat(app, 'c', { conv });
    const sent = mock.requests[2].body.messages;
    assert.deepEqual(sent[1].content.map((b) => b.type), ['text'], 'the mismatched block is gone');
    assert.deepEqual(sent[3].content.map((b) => b.type), ['thinking', 'text'], 'thinking made after the drop is kept');
  });

  it('retries without thinking when a plain endpoint rejects the history', async () => {
    const { app, mock } = await setup(
      [
        { blocks: [{ type: 'thinking', thinking: 'A', signature: 'S1' }, { type: 'text', text: 'one' }] },
        { status: 400, error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block.' } },
        { blocks: [{ type: 'text', text: 'two' }] },
      ],
      { features: 'basic' },
    );
    const { conv } = await chat(app, 'a');
    const second = await chat(app, 'b', { conv });
    assert.equal(second.result.status, 'completed');
    assert.equal(lastAssistantText(conv), 'two');
    assert.deepEqual(mock.requests[2].body.messages[1].content.map((b) => b.type), ['text']);
    assert.deepEqual(conv.messages[1].meta.raw.map((b) => b.type), ['text'], 'and the stored copy is cleaned for later requests');
  });

  it('follows the echo rule after a mid-response fallback', () => {
    const raw = [
      { type: 'thinking', thinking: 'x', signature: 's' },
      { type: 'text', text: 'partial' },
      { type: 'tool_use', id: 't0', name: 'shell', input: {} },
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
      { type: 'thinking', thinking: 'y', signature: 's2' },
      { type: 'text', text: 'continued' },
      { type: 'tool_use', id: 't1', name: 'list_dir', input: {} },
    ];
    const [message] = toAnthropicMessages([{ role: 'assistant', content: [], meta: { providerType: 'anthropic', raw } }]);
    assert.deepEqual(message.content.map((b) => b.type), ['text', 'fallback', 'thinking', 'text', 'tool_use']);
    assert.equal(message.content[4].id, 't1');
  });

  it('runs only the tool calls made after a fallback', async () => {
    const { app } = await setup([
      {
        model: 'claude-opus-5',
        blocks: [
          { type: 'text', text: 'Starting. ' },
          { type: 'tool_use', id: 'declined', name: 'shell', input: { command: 'rm -rf never-run' } },
          { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
          { type: 'text', text: 'Continuing.' },
          { type: 'tool_use', id: 'kept', name: 'list_dir', input: {} },
        ],
      },
      { blocks: [{ type: 'text', text: 'done' }] },
    ]);
    const { conv } = await chat(app, 'go');
    assert.deepEqual(toolResults(conv).map((r) => r.tool_use_id), ['kept']);
    assert.equal(conv.messages[1].meta.model, 'claude-opus-5');
  });
});

describe('stop reasons and errors', () => {
  it('does not keep a declined response', async () => {
    const { app, mock } = await setup([
      { blocks: [{ type: 'text', text: 'I was going to' }], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'Flagged by a safety classifier.' } },
      { blocks: [{ type: 'text', text: 'fine' }] },
    ]);
    const { conv, result, events } = await chat(app, 'something');
    assert.equal(result.status, 'completed');
    assert.equal(conv.messages.filter((m) => m.role === 'assistant').length, 0);
    assert.match(notices(conv)[0], /declined this request \(cyber\)\. Flagged by a safety classifier\./);
    assert.ok(events.some((e) => e.type === 'message.reset'));
    await chat(app, 'something else', { conv });
    assert.deepEqual(mock.requests[1].body.messages.map((m) => m.role), ['user', 'user'], 'the refused turn left nothing behind');
  });

  it('does not run a tool call that was cut off', async () => {
    const { app } = await setup([
      { blocks: [{ type: 'tool_use', id: 'toolu_cut', name: 'write_file', input: { path: 'x.txt' } }], stop_reason: 'max_tokens' },
      { blocks: [{ type: 'text', text: 'smaller steps then' }] },
    ]);
    const { conv } = await chat(app, 'go');
    assert.match(toolResults(conv)[0].content, /cut off because the response reached the output token limit/);
    assert.equal(lastAssistantText(conv), 'smaller steps then');
  });

  it('validates tool input itself, because eager streaming skips the API\'s check', async () => {
    const { app } = await setup([
      { blocks: [{ type: 'tool_use', id: 'toolu_bad', name: 'read_file', input: { limit: 3 } }] },
      { blocks: [{ type: 'text', text: 'ok' }] },
    ]);
    const { conv } = await chat(app, 'go');
    assert.match(toolResults(conv)[0].content, /invalid arguments for read_file: input\.path is required/);
  });

  it('asks again when a tool input cannot be parsed at all', async () => {
    const { app, mock } = await setup([
      { blocks: [{ type: 'text', text: 'calling' }, { type: 'tool_use', id: 'toolu_x', name: 'read_file', rawInput: 'not json at all' }] },
      { blocks: [{ type: 'text', text: 'second try worked' }] },
    ]);
    const { conv, events } = await chat(app, 'go');
    assert.equal(lastAssistantText(conv), 'second try worked');
    assert.equal(mock.calls, 2);
    assert.ok(events.some((e) => e.type === 'run.retry'));
    assert.equal(conv.messages.filter((m) => m.role === 'assistant').length, 1, 'the unreadable turn was never stored');
  });

  it('reports a rejected key clearly and does not retry it', async () => {
    const { app, mock } = await setup([{ status: 401, error: { type: 'authentication_error', message: 'invalid x-api-key' } }]);
    const { result } = await chat(app, 'go');
    assert.equal(result.status, 'error');
    assert.equal(result.error.kind, 'auth');
    assert.match(result.error.message, /API key was rejected/);
    assert.equal(mock.calls, 1);
  });

  it('lists models', async () => {
    const { app } = await setup([]);
    const models = await app.providers.get('claude').listModels();
    assert.deepEqual(models.map((m) => m.id), ['claude-opus-5-5', 'claude-haiku-5-5']);
    assert.equal(models[0].contextWindow, 1000000);
  });
});

describe('switching between kinds of providers', () => {
  it('converts a conversation in both directions', async () => {
    const anthropic = await startMockAnthropic([
      { blocks: [{ type: 'thinking', thinking: 'Claude thinks.', signature: 'S' }, { type: 'text', text: 'from claude' }, { type: 'tool_use', id: 'toolu_9', name: 'list_dir', input: {} }] },
      { blocks: [{ type: 'text', text: 'claude done' }] },
      { blocks: [{ type: 'text', text: 'claude again' }] },
    ]);
    const openai = await startMockOpenAI([
      { reasoning: 'OpenAI-style thinking.', text: 'from the other model', toolCalls: [{ id: 'call.weird:id', name: 'list_dir', args: {} }] },
      { text: 'other done' },
    ]);
    const { app, cleanup } = await makeApp({
      providers: { claude: { type: 'anthropic', baseURL: anthropic.url, apiKey: 'k', features: 'basic' }, other: openaiProvider(openai.url) },
      model: 'claude/claude-opus-5-5',
    });
    cleanups.push(cleanup, anthropic.close, openai.close);

    const { conv } = await chat(app, 'start');
    await chat(app, 'now the other model', { conv, model: 'other/mock-model' });
    await chat(app, 'back to claude', { conv });

    // Claude's turn as the OpenAI-compatible API sees it: text and tool call, no foreign reasoning.
    const toOther = openai.requests[0].body.messages;
    const claudeTurn = toOther.find((m) => m.role === 'assistant');
    assert.equal(claudeTurn.content, 'from claude');
    assert.equal(claudeTurn.tool_calls[0].id, 'toolu_9');
    assert.equal(claudeTurn.reasoning_content, undefined);
    assert.ok(toOther.some((m) => m.role === 'tool' && m.tool_call_id === 'toolu_9'));

    // The other model's turn as Claude sees it: no thinking, ids made safe, and Claude's own turns verbatim.
    const toClaude = anthropic.requests[2].body.messages;
    const foreign = toClaude.find((m) => m.role === 'assistant' && m.content.some((b) => b.text === 'from the other model'));
    assert.deepEqual(foreign.content.map((b) => b.type), ['text', 'tool_use']);
    assert.equal(foreign.content[1].id, 'call_weird_id');
    assert.ok(toClaude.some((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result' && b.tool_use_id === 'call_weird_id')));
    assert.equal(toClaude[1].content[0].signature, 'S');
  });

  it('builds OpenAI messages with tool results first and merged user text', () => {
    const messages = toOpenAIMessages('SYS', [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 't', input: { x: 1 } }], meta: { providerType: 'openai' } },
      { role: 'user', content: [{ type: 'text', text: 'note' }, { type: 'tool_result', tool_use_id: 'c1', content: 'R' }] },
      { role: 'notice', content: [{ type: 'text', text: 'never sent' }] },
    ]);
    assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
    assert.equal(messages[1].content, 'a\n\nb');
    assert.equal(messages[2].content, null);
    assert.equal(messages[2].tool_calls[0].function.arguments, '{"x":1}');
    assert.equal(messages[3].content, 'R');
    assert.equal(messages[4].content, 'note');
  });
});
