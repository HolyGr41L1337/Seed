// The agent loop against a scripted OpenAI-compatible API.
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { chat, lastAssistantText, makeApp, notices, openaiProvider, toolResults, waitFor } from './helpers/app.js';
import { startMockOpenAI } from './helpers/mock-openai.js';
import { cmd } from './helpers/shell.js';

let cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setup(script, { approval = 'full', provider = {}, config } = {}) {
  const mock = await startMockOpenAI(script);
  const made = await makeApp({ providers: { mock: openaiProvider(mock.url, { retryBaseMs: 5, ...provider }) }, model: 'mock/mock-model', approval, config });
  cleanups.push(made.cleanup, mock.close);
  return { mock, ...made };
}

const answer = (app, convId) => async (decision) => {
  const run = await waitFor(() => (app.runs.get(convId)?.approvals.size ? app.runs.get(convId) : null));
  const [id] = run.approvals.keys();
  app.runs.resolveApproval(convId, id, decision);
};

describe('agent loop', () => {
  it('runs tools until the model answers, and replays reasoning', async () => {
    const { app, mock, work } = await setup([
      { reasoning: 'Write first.', text: 'Creating it.', toolCalls: [{ name: 'write_file', args: { path: 'hello.txt', content: 'hi\n' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'hello.txt' } }, { name: 'shell', args: { command: cmd.cat('hello.txt') } }] },
      { text: 'Done.' },
    ]);
    const { conv, result, events } = await chat(app, 'create hello.txt');
    assert.deepEqual(result, { status: 'completed', error: null });
    assert.equal(lastAssistantText(conv), 'Done.');
    assert.equal(await fsp.readFile(path.join(work, 'hello.txt'), 'utf8'), 'hi\n');
    assert.deepEqual(toolResults(conv).map((r) => r.content), ['Created hello.txt (1 lines).', '     1\thi', 'hi']);
    assert.equal(conv.title, 'create hello.txt');
    assert.equal(conv.usage.output, 30);

    // The second request carries the first turn, including its reasoning.
    const second = mock.requests[1].body.messages;
    assert.deepEqual(second.map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
    assert.equal(second[2].reasoning_content, 'Write first.');
    assert.equal(second[2].tool_calls[0].function.name, 'write_file');
    // The system prompt and the tool list are byte-identical on every request of a conversation.
    assert.equal(mock.requests[2].body.messages[0].content, mock.requests[0].body.messages[0].content);
    assert.deepEqual(mock.requests[2].body.tools, mock.requests[0].body.tools);

    const types = events.map((e) => e.type);
    for (const t of ['run.started', 'message.added', 'message.started', 'delta', 'tool_use.started', 'message.completed', 'tool.started', 'tool.completed', 'run.completed']) {
      assert.ok(types.includes(t), `event ${t}`);
    }
    assert.ok(events.every((e, i) => i === 0 || e.seq > events[i - 1].seq), 'events are ordered');
  });

  it('tells the model about bad tool calls instead of running them', async () => {
    const { app } = await setup([
      { toolCalls: [{ name: 'read_file', args: '{"path": "a.txt"' }, { name: 'no_such_tool', args: {} }, { name: 'read_file', args: { offset: 2 } }] },
      { text: 'ok' },
    ]);
    const { conv } = await chat(app, 'go');
    const [badJson, unknown, invalid] = toolResults(conv);
    assert.match(badJson.content, /not valid JSON/);
    assert.match(badJson.content, /INVALID_JSON/);
    assert.match(unknown.content, /no tool named "no_such_tool"/);
    assert.match(invalid.content, /input\.path is required/);
    assert.ok([badJson, unknown, invalid].every((r) => r.is_error));
  });

  it('accepts tool calls that arrive without an index', async () => {
    const { app } = await setup([
      { noIndex: true, toolCalls: [{ name: 'list_dir', args: {} }, { name: 'glob', args: { pattern: '*.md' } }] },
      { text: 'ok' },
    ]);
    const { conv } = await chat(app, 'go');
    assert.equal(toolResults(conv).length, 2);
    assert.ok(toolResults(conv).every((r) => !r.is_error));
  });

  it('does not run a tool call that was cut off by the output limit', async () => {
    const { app, work } = await setup([
      { toolCalls: [{ name: 'write_file', args: { path: 'big.txt', content: 'partial' } }], finish: 'length' },
      { text: 'short answer', finish: 'length' },
    ]);
    const { conv } = await chat(app, 'go');
    assert.match(toolResults(conv)[0].content, /cut off because the response reached the output token limit/);
    await assert.rejects(fsp.access(path.join(work, 'big.txt')));
    assert.match(notices(conv).join('\n'), /output limit and was cut off/);
  });

  it('pauses after the configured number of tool rounds', async () => {
    const { app, mock } = await setup(
      Array.from({ length: 5 }, () => ({ toolCalls: [{ name: 'list_dir', args: {} }] })),
      { config: { agent: { maxSteps: 2 } } },
    );
    const { conv, result } = await chat(app, 'loop');
    assert.equal(result.status, 'completed');
    assert.equal(mock.calls, 2);
    assert.match(notices(conv).join('\n'), /Paused after 2 tool rounds/);
  });

  it('refuses a second message while a run is in progress', async () => {
    const { app } = await setup([{ text: 'slow', delayMs: 200 }]);
    const conv = await app.createConversation({});
    const run = await app.runs.start(conv, { content: [{ type: 'text', text: 'a' }] });
    await assert.rejects(app.runs.start(conv, { content: [{ type: 'text', text: 'b' }] }), /already working/);
    await run.done;
  });

  it('repairs a conversation that was interrupted between a tool call and its result', async () => {
    const { app, mock } = await setup([{ text: 'continuing' }]);
    const conv = await app.createConversation({});
    conv.messages.push(
      { id: 'm1', role: 'user', content: [{ type: 'text', text: 'go' }], createdAt: 1 },
      { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 'call_x', name: 'shell', input: { command: 'ls' } }], createdAt: 2 },
    );
    await chat(app, 'again', { conv });
    const sent = mock.requests[0].body.messages;
    assert.deepEqual(sent.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
    assert.match(sent[3].content, /interrupted/);
  });
});

describe('approvals', () => {
  it('asks before changes, and remembers "always allow" for the conversation', async () => {
    const { app, work } = await setup(
      [
        { toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: '1' } }] },
        { toolCalls: [{ name: 'write_file', args: { path: 'b.txt', content: '2' } }, { name: 'shell', args: { command: cmd.touch('c.txt') } }] },
        { text: 'done' },
      ],
      { approval: 'ask' },
    );
    const conv = await app.createConversation({});
    const events = [];
    const run = await app.runs.start(conv, { content: [{ type: 'text', text: 'go' }], onEvent: (e) => events.push(e) });
    const reply = answer(app, conv.id);

    await reply('allow_always'); // a.txt → grants "write"
    await reply('allow'); // b.txt needs no prompt now; this answers the shell command
    const result = await run.done;
    assert.equal(result.status, 'completed');
    assert.deepEqual(conv.grants, { write: true });
    for (const f of ['a.txt', 'b.txt', 'c.txt']) await fsp.access(path.join(work, f));
    const requests = events.filter((e) => e.type === 'approval.requested').map((e) => e.approval);
    assert.deepEqual(requests.map((a) => a.category), ['write', 'exec']);
    assert.equal(requests[1].detail, cmd.touch('c.txt'));
    assert.equal(requests[0].preview.type, 'write');
  });

  it('stops and waits for the user after a declined action', async () => {
    const { app, mock, work } = await setup(
      [{ toolCalls: [{ name: 'shell', args: { command: cmd.touch('no.txt') } }, { name: 'write_file', args: { path: 'never.txt', content: 'x' } }] }, { text: 'unreachable' }],
      { approval: 'ask' },
    );
    const conv = await app.createConversation({});
    const run = await app.runs.start(conv, { content: [{ type: 'text', text: 'go' }] });
    await answer(app, conv.id)('deny');
    const result = await run.done;
    assert.equal(result.status, 'completed');
    assert.equal(mock.calls, 1, 'the model is not called again until the user speaks');
    const [first, second] = toolResults(conv);
    assert.match(first.content, /user declined this action/);
    assert.match(second.content, /Not run/);
    await assert.rejects(fsp.access(path.join(work, 'no.txt')));
    await assert.rejects(fsp.access(path.join(work, 'never.txt')));
  });

  it('refuses instead of asking when nobody can answer', async () => {
    const { app, work } = await setup([{ toolCalls: [{ name: 'shell', args: { command: cmd.touch('no.txt') } }, { name: 'list_dir', args: {} }] }, { text: 'I could only look.' }], { approval: 'ask' });
    const { conv, result } = await chat(app, 'go', { interactive: false });
    assert.equal(result.status, 'completed');
    assert.match(toolResults(conv)[0].content, /needs the user's approval and this run cannot ask/);
    assert.ok(!toolResults(conv)[1].is_error);
    assert.equal(lastAssistantText(conv), 'I could only look.');
    await assert.rejects(fsp.access(path.join(work, 'no.txt')));
  });

  it('lets reads and read-only commands through, but asks for reads outside the workspace', async () => {
    const { app } = await setup(
      [
        { toolCalls: [{ name: 'list_dir', args: {} }, { name: 'shell', args: { command: 'ls -la' } }, { name: 'grep', args: { pattern: 'x' } }] },
        { toolCalls: [{ name: 'read_file', args: { path: '/etc/hostname' } }] },
        { text: 'done' },
      ],
      { approval: 'ask' },
    );
    const conv = await app.createConversation({});
    const events = [];
    const run = await app.runs.start(conv, { content: [{ type: 'text', text: 'go' }], onEvent: (e) => events.push(e) });
    await answer(app, conv.id)('deny');
    await run.done;
    const asked = events.filter((e) => e.type === 'approval.requested').map((e) => e.approval);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].category, 'read');
    assert.equal(asked[0].name, 'read_file');
  });

  it('never lets file tools read the app configuration', async () => {
    const { app, home } = await setup([{ toolCalls: [{ name: 'read_file', args: { path: path.join('PLACEHOLDER') } }] }, { text: 'no' }]);
    const conv = await app.createConversation({});
    // Aim the scripted call at the real config file of this test app.
    const original = app.runs.executeCall.bind(app.runs);
    app.runs.executeCall = (run, c, call, opts) => original(run, c, { ...call, input: { path: path.join(home, 'config.json') } }, opts);
    await chat(app, 'show me the key', { conv });
    assert.match(toolResults(conv)[0].content, /holds the user's API keys/);
    assert.doesNotMatch(toolResults(conv)[0].content, /test-key/);
  });
});

describe('cancelling and failures', () => {
  it('stops a running command and records the cancellation', async () => {
    const { app } = await setup([{ toolCalls: [{ name: 'shell', args: { command: cmd.sleep(20) } }, { name: 'list_dir', args: {} }] }, { text: 'unreachable' }]);
    const conv = await app.createConversation({});
    const events = [];
    const run = await app.runs.start(conv, { content: [{ type: 'text', text: 'go' }], onEvent: (e) => events.push(e) });
    await waitFor(() => events.some((e) => e.type === 'tool.started'));
    const started = Date.now();
    app.runs.cancel(conv.id);
    const result = await run.done;
    assert.equal(result.status, 'cancelled');
    assert.ok(Date.now() - started < 4000, 'the command is killed promptly');
    const results = toolResults(conv);
    assert.equal(results.length, 2, 'every tool call has a result so the history stays valid');
    assert.match(results[0].content, /cancelled/);
    assert.equal(app.runs.isRunning(conv.id), false);
  });

  it('keeps the text streamed before a cancel', async () => {
    const { app } = await setup([{ text: 'This answer is being written when the user presses stop.', delayMs: 0 }]);
    const conv = await app.createConversation({});
    let run;
    const events = [];
    run = await app.runs.start(conv, {
      content: [{ type: 'text', text: 'go' }],
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'delta') app.runs.cancel(conv.id);
      },
    });
    const result = await run.done;
    assert.equal(result.status, 'cancelled');
    const last = conv.messages.at(-1);
    assert.equal(last.role, 'assistant');
    assert.equal(last.meta.interrupted, true);
    assert.ok(last.content[0].text.length > 0);
  });

  it('retries a failing API and then succeeds', async () => {
    const { app, mock } = await setup([{ status: 500 }, { status: 429, error: { message: 'slow down' } }, { text: 'finally' }]);
    const { conv, result, events } = await chat(app, 'go');
    assert.equal(result.status, 'completed');
    assert.equal(lastAssistantText(conv), 'finally');
    assert.equal(mock.calls, 3);
    assert.equal(events.filter((e) => e.type === 'run.retry').length, 2);
  });

  it('retries when the stream breaks, and discards the partial output', async () => {
    const { app } = await setup([{ text: 'broken half', abortMidStream: true }, { text: 'whole answer' }]);
    const { conv, events } = await chat(app, 'go');
    assert.equal(lastAssistantText(conv), 'whole answer');
    assert.ok(events.some((e) => e.type === 'message.reset'));
    assert.equal(conv.messages.filter((m) => m.role === 'assistant').length, 1);
  });

  it('reports an error the API will not recover from', async () => {
    const { app, mock } = await setup([{ status: 401, error: { message: 'Authentication Fails' } }]);
    const { conv, result } = await chat(app, 'go');
    assert.equal(result.status, 'error');
    assert.equal(result.error.kind, 'auth');
    assert.match(result.error.message, /Authentication Fails/);
    assert.equal(mock.calls, 1, 'authentication errors are not retried');
    assert.match(notices(conv)[0], /Authentication Fails/);
  });

  it('learns whether the API wants earlier reasoning sent back', async () => {
    const { app, mock } = await setup([
      { reasoning: 'thinking', toolCalls: [{ name: 'list_dir', args: {} }] },
      // This API rejects reasoning in the input. The first try sends it (the model produced some)...
      (body) =>
        body.messages.some((m) => 'reasoning_content' in m)
          ? { status: 400, error: { message: 'reasoning_content is not allowed in input messages' } }
          : { text: 'unexpected' },
      // ...the retry leaves it out...
      (body) => ({ text: body.messages.some((m) => 'reasoning_content' in m) ? 'sent again' : 'ok without it' }),
      // ...and later requests remember.
      (body) => ({ text: body.messages.some((m) => 'reasoning_content' in m) ? 'still sent' : 'remembered' }),
    ]);
    const { conv } = await chat(app, 'go');
    assert.equal(lastAssistantText(conv), 'ok without it');
    assert.equal(mock.calls, 3);
    const again = await chat(app, 'more', { conv });
    assert.equal(mock.calls, 4);
    assert.equal(lastAssistantText(again.conv), 'remembered');
  });
});

describe('long conversations', () => {
  it('summarizes when the context budget is exceeded and continues from the summary', async () => {
    const { app, mock } = await setup(
      [
        { text: 'first answer', usage: { prompt_tokens: 900, completion_tokens: 200 } },
        { text: 'SUMMARY: the user asked about apples.' }, // the compaction request
        { text: 'second answer', usage: { prompt_tokens: 100, completion_tokens: 10 } },
      ],
      { provider: { compactAt: 1000 } },
    );
    const { conv } = await chat(app, 'tell me about apples');
    assert.equal(conv.lastContext, 1100);
    await chat(app, 'and pears?', { conv });

    // Request 2 asked for the summary, with the same system prompt and tools as the conversation.
    const summaryRequest = mock.requests[1].body;
    assert.match(summaryRequest.messages.at(-1).content, /about to be replaced by a summary/);
    assert.deepEqual(summaryRequest.tools, mock.requests[0].body.tools);
    assert.ok(!summaryRequest.messages.some((m) => m.content === 'and pears?'), 'the new question is not part of what gets summarized');

    // Request 3 starts from the summary and still has the user's exact new message.
    const next = mock.requests[2].body.messages;
    assert.equal(next.length, 2);
    assert.equal(next[0].role, 'system');
    assert.match(next[1].content, /<summary>\nSUMMARY: the user asked about apples\.\n<\/summary>/);
    assert.match(next[1].content, /and pears\?$/);

    assert.equal(conv.context.summary, 'SUMMARY: the user asked about apples.');
    assert.equal(conv.messages.filter((m) => m.role !== 'notice').length, 4, 'the full transcript is kept for the user');
    assert.match(notices(conv).join('\n'), /summarized/);
    assert.equal(lastAssistantText(conv), 'second answer');
  });

  it('recovers from a context-length error by summarizing', async () => {
    const { app, mock } = await setup([
      { text: 'one' },
      { status: 400, error: { message: "This model's maximum context length is 65536 tokens.", code: 'context_length_exceeded' } },
      { status: 400, error: { message: "This model's maximum context length is 65536 tokens.", code: 'context_length_exceeded' } }, // summary with full history fails too
      { text: 'TRANSCRIPT SUMMARY' }, // summary from the shortened transcript
      { text: 'after recovery' },
    ]);
    const { conv } = await chat(app, 'first');
    const second = await chat(app, 'second', { conv });
    assert.equal(second.result.status, 'completed');
    assert.equal(lastAssistantText(conv), 'after recovery');
    assert.equal(conv.context.summary, 'TRANSCRIPT SUMMARY');
    assert.match(mock.requests[3].body.messages[1].content, /<conversation>[\s\S]*USER: first[\s\S]*ASSISTANT: one/);
    assert.equal(mock.requests[3].body.tools, undefined);
  });
});

describe('extensibility of the loop', () => {
  it('lets hooks veto and rewrite tool calls', async () => {
    const { app, work } = await setup([
      { toolCalls: [{ name: 'shell', args: { command: 'echo secret' } }, { name: 'write_file', args: { path: 'x.txt', content: 'x' } }, { name: 'list_dir', args: {} }] },
      { text: 'done' },
    ]);
    app.hooks.on('tool:before', ({ name, args }) => {
      if (name === 'shell') return { deny: 'no shell today' };
      if (name === 'write_file') return { args: { ...args, path: 'renamed.txt' } };
    });
    app.hooks.on('tool:after', ({ name, result }) => (name === 'list_dir' ? { result: { content: `${result.content}\n(seen by hook)` } } : undefined));
    const { conv } = await chat(app, 'go');
    const [shell, write, list] = toolResults(conv);
    assert.match(shell.content, /blocked by an extension: no shell today/);
    assert.match(write.content, /Created renamed\.txt/);
    await fsp.access(path.join(work, 'renamed.txt'));
    assert.match(list.content, /\(seen by hook\)$/);
  });

  it('keeps a conversation\'s tool list fixed and reaches later tools through ext_call', async () => {
    const { app, mock } = await setup([
      { toolCalls: [{ name: 'ext_call', args: { name: 'ping' } }] },
      { toolCalls: [{ name: 'ext_call', args: { name: 'ping', arguments: { text: 'hey' } } }] },
      { text: 'done' },
      { text: 'new conversation' },
    ]);
    const conv = await app.createConversation({});
    app.tools.register({ name: 'ping', description: 'Echo text back.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, kind: 'read', run: ({ text }) => `pong ${text}` }, 'ext:test');
    await chat(app, 'go', { conv });
    assert.ok(!mock.requests[0].body.tools.some((t) => t.function.name === 'ping'), 'not added to a running conversation');
    assert.match(toolResults(conv)[0].content, /invalid arguments for ping: input\.text is required/);
    assert.equal(toolResults(conv)[1].content, 'pong hey');

    const fresh = await chat(app, 'hi');
    assert.ok(mock.requests[3].body.tools.some((t) => t.function.name === 'ping'), 'a new conversation gets it as a normal tool');
    assert.ok(fresh.conv.toolset !== conv.toolset);
  });
});
