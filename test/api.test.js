// The HTTP API: access control, REST endpoints, event streams and the OpenAI-compatible endpoint.
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { sseData } from '../src/providers/sse.js';
import { makeApp, openaiProvider, waitFor } from './helpers/app.js';
import { startMockOpenAI } from './helpers/mock-openai.js';
import { cmd } from './helpers/shell.js';

let app, mock, base, token, work, cleanup;

const script = [];
const next = (...steps) => script.push(...steps);

before(async () => {
  mock = await startMockOpenAI(script);
  ({ app, work, cleanup } = await makeApp({ providers: { mock: openaiProvider(mock.url, { retryBaseMs: 5 }) }, model: 'mock/mock-model', approval: 'full' }));
  base = (await app.listen()).url;
  token = app.config.server.token;
});

after(async () => {
  await cleanup();
  await mock.close();
});

const call = async (method, url, body, headers = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
};
const get = (url, headers) => call('GET', url, undefined, headers);
const post = (url, body = {}, headers) => call('POST', url, body, headers);

/** Read a server-sent event stream until `until(event)` is true. */
async function readEvents(res, until) {
  const events = [];
  for await (const data of sseData(res.body)) {
    if (data === '[DONE]') {
      events.push('[DONE]');
      break;
    }
    const event = JSON.parse(data);
    events.push(event);
    if (until?.(event)) break;
  }
  return events;
}

describe('access control', () => {
  it('serves the web app and the health check without a token, and nothing else', async () => {
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.match(await (await fetch(`${base}/`)).text(), /<title>Seed<\/title>/);
    assert.equal((await fetch(`${base}/assets/js/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/extensions/1/x/client.js`)).status, 404, 'extension files need their keyed path');
    for (const url of ['/api/info', '/api/config', '/api/conversations', '/api/events', '/v1/models', '/ext/x/y']) {
      const res = await fetch(base + url);
      assert.equal(res.status, 401, url);
      await res.body?.cancel();
    }
    assert.equal((await fetch(`${base}/api/info`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await get('/api/info')).status, 200);
  });

  it('does not serve files outside the web folder', async () => {
    for (const url of ['/..%2f..%2fpackage.json', '/%2e%2e/package.json', '/assets/../../package.json', '/assets/%2e%2e/%2e%2e/src/app.js']) {
      const res = await fetch(base + url);
      assert.ok([403, 404].includes(res.status), `${url} → ${res.status}`);
      assert.doesNotMatch(await res.text(), /seed-harness|class App/);
    }
  });

  it('signs the web UI in with a cookie that only works from its own origin', async () => {
    assert.equal((await fetch(`${base}/api/auth/login`, { method: 'POST', body: JSON.stringify({ token: 'nope' }) })).status, 401);
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', body: JSON.stringify({ token }) });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.ok(!setCookie.includes(token), 'the cookie is not the token itself');
    const cookie = setCookie.split(';')[0];

    assert.equal((await fetch(`${base}/api/info`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/info`, { headers: { cookie, 'sec-fetch-site': 'same-origin' } })).status, 200);
    assert.equal((await fetch(`${base}/api/info`, { headers: { cookie, 'sec-fetch-site': 'cross-site' } })).status, 401);
    assert.equal((await fetch(`${base}/api/info`, { headers: { cookie, 'sec-fetch-site': 'same-site' } })).status, 401, 'another port on localhost is not the app');
    assert.equal((await fetch(`${base}/api/info`, { headers: { cookie, origin: 'http://evil.example' } })).status, 401);
    assert.equal((await fetch(`${base}/api/info`, { headers: { cookie, origin: base } })).status, 200);
    assert.deepEqual(await (await fetch(`${base}/api/auth/status`, { headers: { cookie } })).json(), { authenticated: true });
    assert.deepEqual(await (await fetch(`${base}/api/auth/status`)).json(), { authenticated: false });
  });

  it('opens CORS for token requests only', async () => {
    const preflight = await fetch(`${base}/api/chat`, { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.equal((await get('/api/info')).headers.get('access-control-allow-origin'), '*');
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', body: JSON.stringify({ token }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/api/info`, { headers: { cookie } })).headers.get('access-control-allow-origin'), null);
  });

  it('rejects malformed requests', async () => {
    const bad = await fetch(`${base}/api/chat`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{not json' });
    assert.equal(bad.status, 400);
    assert.equal((await get('/api/nope')).status, 404);
    assert.equal((await get('/api/conversations/not-an-id')).status, 400);
    assert.equal((await get('/api/conversations/c_missing')).status, 404);
  });
});

describe('settings and providers', () => {
  it('never returns secrets', async () => {
    const { body } = await get('/api/config');
    const text = JSON.stringify(body);
    assert.ok(!text.includes('test-key'));
    assert.ok(!text.includes(token));
    assert.equal(body.providers.mock.hasKey, true);
    assert.equal(body.providers.mock.apiKey, undefined);
    assert.equal(body.providers.mock.keyHint, '••••', 'short keys are masked completely');
    assert.equal(body.model, 'mock/mock-model');
  });

  it('validates changes', async () => {
    assert.equal((await call('PATCH', '/api/config', { approval: 'sometimes' })).status, 400);
    assert.equal((await call('PATCH', '/api/config', { server: { token: 'x' } })).status, 400);
    assert.equal((await call('PATCH', '/api/config', { providers: { bad: { type: 'nope' } } })).status, 400);
    const ok = await call('PATCH', '/api/config', { agent: { instructions: 'Be brief.' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.agent.instructions, 'Be brief.');
    assert.equal(ok.body.agent.maxSteps, 200, 'a patch merges into the settings');
    await call('PATCH', '/api/config', { agent: { instructions: '' } });
  });

  it('tests and connects a provider', async () => {
    const tested = await post('/api/providers/test', { type: 'openai', baseURL: mock.url, apiKey: 'k' });
    assert.equal(tested.status, 200);
    assert.deepEqual(tested.body.models.map((m) => m.id), ['mock-model', 'mock-small']);
    assert.equal(tested.body.suggested, 'mock-model');

    const rejected = await post('/api/providers/test', { type: 'openai', baseURL: mock.url, apiKey: 'bad-key' });
    assert.equal(rejected.status, 502, 'a model API error is not a Seed auth error');
    assert.equal(rejected.body.error.kind, 'auth');
    assert.equal(rejected.body.error.upstreamStatus, 401);

    const unreachable = await post('/api/providers/test', { type: 'openai', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k' });
    assert.equal(unreachable.status, 502);
    assert.equal(unreachable.body.error.kind, 'network');

    const connected = await post('/api/providers', { id: 'second', type: 'openai', baseURL: mock.url, apiKey: 'k2', setDefault: false });
    assert.equal(connected.status, 200);
    assert.equal(connected.body.model, 'second/mock-model');
    assert.equal(connected.body.config.model, 'mock/mock-model', 'the default stays when setDefault is false');
    assert.deepEqual(connected.body.config.providers.second.models, ['mock-model']);

    const models = await get('/api/models');
    assert.deepEqual(models.body.providers.map((p) => p.id).sort(), ['mock', 'second']);
    assert.equal(models.body.providers[0].models[0].ref, `${models.body.providers[0].id}/mock-model`);

    assert.equal((await call('DELETE', '/api/providers/second')).status, 200);
    assert.equal((await get('/api/config')).body.providers.second, undefined);
    assert.equal((await post('/api/providers', { id: 'x y', type: 'openai', baseURL: mock.url })).status, 400);
    assert.equal((await post('/api/providers', { id: 'nourl', type: 'openai' })).status, 400);
  });

  it('describes the app and its tools', async () => {
    const info = (await get('/api/info')).body;
    assert.equal(info.name, 'seed');
    assert.equal(info.cwd, work);
    assert.equal(info.connected, true);
    const tools = (await get('/api/tools')).body.tools;
    assert.ok(tools.find((t) => t.name === 'shell' && t.source === 'builtin'));
    assert.equal((await get(`/api/resolve-dir?path=${encodeURIComponent(work)}`)).body.path, work);
    assert.equal((await get('/api/resolve-dir?path=/definitely/not/here')).status, 400);
  });
});

describe('conversations', () => {
  it('creates, lists, updates and deletes', async () => {
    const created = await post('/api/conversations', { title: 'Notes' });
    assert.equal(created.status, 200);
    const id = created.body.id;
    assert.match(id, /^c_/);
    assert.equal(created.body.system, undefined, 'the system prompt is not sent unless asked for');
    assert.match((await get(`/api/conversations/${id}?full=1`)).body.system, /You are Seed/);

    const list = (await get('/api/conversations')).body;
    assert.ok(list.conversations.find((c) => c.id === id && c.title === 'Notes' && c.running === false));
    assert.equal((await get('/api/conversations?q=zzz')).body.conversations.length, 0);

    const sub = path.join(work, 'sub');
    await fsp.mkdir(sub);
    const patched = await call('PATCH', `/api/conversations/${id}`, { title: 'Renamed', approval: 'auto-edit', cwd: 'sub', model: 'mock/mock-small' });
    assert.equal(patched.body.title, 'Renamed');
    assert.equal(patched.body.approval, 'auto-edit');
    assert.equal(patched.body.cwd, sub);
    assert.equal(patched.body.model, 'mock/mock-small');
    assert.equal((await call('PATCH', `/api/conversations/${id}`, { approval: 'yolo' })).status, 400);
    assert.equal((await call('PATCH', `/api/conversations/${id}`, { cwd: 'missing-dir' })).status, 400);

    // The model is told about the new workspace with the next message.
    next({ text: 'ok' });
    await post(`/api/conversations/${id}/messages`, { content: 'hi', wait: true });
    assert.match(mock.requests.at(-1).body.messages.at(-1).content, /workspace directory of this conversation is now .*sub\.\]\n\nhi$/);
    assert.equal(mock.requests.at(-1).body.model, 'mock-small');

    assert.equal((await call('DELETE', `/api/conversations/${id}`)).status, 200);
    assert.equal((await get(`/api/conversations/${id}`)).status, 404);
    assert.equal((await call('DELETE', `/api/conversations/${id}`)).status, 404);
  });

  it('answers in one call with /api/chat and continues the conversation', async () => {
    next({ toolCalls: [{ name: 'write_file', args: { path: 'chat.txt', content: 'x' } }] }, { text: 'Created chat.txt.' }, { text: 'Yes.' });
    const first = await post('/api/chat', { message: 'make chat.txt' });
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'completed');
    assert.equal(first.body.text, 'Created chat.txt.');
    assert.deepEqual(first.body.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
    assert.ok(!JSON.stringify(first.body).includes('"raw"'));
    await fsp.access(path.join(work, 'chat.txt'));

    const second = await post('/api/chat', { conversationId: first.body.conversationId, message: 'sure?' });
    assert.equal(second.body.text, 'Yes.');
    assert.equal(second.body.messages.length, 2);
    assert.equal((await get(`/api/conversations/${first.body.conversationId}`)).body.messages.length, 6);
    assert.equal((await post('/api/chat', { message: '   ' })).status, 400);
    assert.equal((await post('/api/chat', { message: 'x', approval: 'nope' })).status, 400);
  });

  it('streams a run and reports the outcome at the end', async () => {
    next({ reasoning: 'hm', text: 'streamed answer' });
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'stream please', stream: true }),
    });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const events = await readEvents(res, (e) => e.type === 'done');
    const types = events.map((e) => e.type);
    assert.deepEqual(types.slice(0, 2), ['run.started', 'message.added']);
    assert.ok(types.includes('delta') && types.includes('run.completed'));
    assert.equal(events.filter((e) => e.type === 'delta' && e.kind === 'text').map((e) => e.text).join(''), 'streamed answer');
    const done = events.at(-1);
    assert.equal(done.status, 'completed');
    assert.equal(done.text, 'streamed answer');
  });

  it('returns at once by default and announces progress on the event stream', async () => {
    next({ text: 'background answer', delayMs: 60 });
    const conv = (await post('/api/conversations')).body;
    const stream = await fetch(`${base}/api/events?conversation=${conv.id}`, { headers: { authorization: `Bearer ${token}` } });
    const reading = readEvents(stream, (e) => e.type === 'run.completed');
    const accepted = await post(`/api/conversations/${conv.id}/messages`, { content: 'go' });
    assert.equal(accepted.status, 202);
    assert.match(accepted.body.runId, /^r_/);
    assert.equal((await post(`/api/conversations/${conv.id}/messages`, { content: 'again' })).status, 409);

    const snapshot = (await get(`/api/conversations/${conv.id}`)).body;
    assert.equal(snapshot.run.status, 'running');
    assert.ok(Number.isInteger(snapshot.seq));

    const events = await reading;
    assert.equal(events[0].type, 'hello');
    assert.ok(events.every((e) => !e.conversationId || e.conversationId === conv.id), 'filtered to one conversation');
    assert.equal(events.at(-1).status, 'completed');
    assert.equal((await get(`/api/conversations/${conv.id}`)).body.run, null);
  });

  it('waits for an approval decision made through the API', async () => {
    next({ toolCalls: [{ name: 'shell', args: { command: cmd.touch('approved.txt') } }] }, { text: 'done' });
    const conv = (await post('/api/conversations', { approval: 'ask' })).body;
    const stream = await fetch(`${base}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'go', stream: true }),
    });
    let approval;
    const events = [];
    for await (const data of sseData(stream.body)) {
      const event = JSON.parse(data);
      events.push(event);
      if (event.type === 'approval.requested') {
        approval = event.approval;
        assert.equal((await get(`/api/conversations/${conv.id}`)).body.run.approvals[0].id, approval.id);
        assert.equal((await post(`/api/conversations/${conv.id}/approvals/${approval.id}`, { decision: 'maybe' })).status, 400);
        assert.equal((await post(`/api/conversations/${conv.id}/approvals/${approval.id}`, { decision: 'allow' })).status, 200);
      }
      if (event.type === 'done') break;
    }
    assert.equal(approval.category, 'exec');
    assert.equal(events.at(-1).status, 'completed');
    await fsp.access(path.join(work, 'approved.txt'));
    assert.equal((await post(`/api/conversations/${conv.id}/approvals/${approval.id}`, { decision: 'allow' })).status, 404);
  });

  it('cancels a run, and cancels it when a streaming client disconnects', async () => {
    next({ toolCalls: [{ name: 'shell', args: { command: cmd.sleep(20) } }] });
    const conv = (await post('/api/conversations')).body;
    await post(`/api/conversations/${conv.id}/messages`, { content: 'go' });
    await waitFor(async () => (await get(`/api/conversations/${conv.id}`)).body.run?.tools.some((t) => t.status === 'running'));
    assert.deepEqual((await post(`/api/conversations/${conv.id}/cancel`)).body, { cancelled: true });
    await waitFor(async () => (await get(`/api/conversations/${conv.id}`)).body.run === null);
    assert.deepEqual((await post(`/api/conversations/${conv.id}/cancel`)).body, { cancelled: false });

    next({ toolCalls: [{ name: 'shell', args: { command: cmd.sleep(20) } }] });
    const controller = new AbortController();
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'long task', stream: true }),
    });
    const [started] = await readEvents(res, (e) => e.type === 'tool.started').then((e) => e.filter((x) => x.type === 'run.started'));
    controller.abort();
    await waitFor(() => !app.runs.isRunning(started.conversationId));
    const saved = await app.store.get(started.conversationId);
    assert.match(saved.messages.at(-1).content[0].content, /cancelled/);
  });
});

describe('OpenAI-compatible endpoint', () => {
  it('lists models', async () => {
    const { body } = await get('/v1/models');
    assert.equal(body.object, 'list');
    assert.ok(body.data.some((m) => m.id === 'seed'));
  });

  it('answers a chat completion with the agent\'s final text', async () => {
    next({ toolCalls: [{ name: 'list_dir', args: {} }] }, { text: 'It has a few files.' });
    const res = await post('/v1/chat/completions', {
      model: 'seed',
      messages: [
        { role: 'system', content: 'Answer in one sentence.' },
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
        { role: 'user', content: [{ type: 'text', text: 'what is in this folder?' }] },
      ],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.object, 'chat.completion');
    assert.equal(res.body.choices[0].message.content, 'It has a few files.');
    assert.equal(res.body.choices[0].finish_reason, 'stop');
    assert.match(res.body.choices[0].message.reasoning_content, /\[tool\] list_dir/);
    assert.ok(res.body.usage.total_tokens > 0);
    assert.match(res.headers.get('x-seed-conversation'), /^c_/);

    const sent = mock.requests.at(-2).body.messages;
    assert.match(sent[0].content, /You are Seed[\s\S]*Answer in one sentence\.$/);
    assert.deepEqual(sent.slice(1).map((m) => [m.role, m.content]), [
      ['user', 'earlier question'],
      ['assistant', 'earlier answer'],
      ['user', 'what is in this folder?'],
    ]);
    const ids = (await get('/api/conversations')).body.conversations.map((c) => c.id);
    assert.ok(!ids.includes(res.headers.get('x-seed-conversation')), 'stateless requests are not saved');
  });

  it('streams chunks in the OpenAI format', async () => {
    next({ reasoning: 'thinking…', text: 'Hello ' }, { text: 'unused' });
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'seed', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const chunks = await readEvents(res);
    assert.equal(chunks.at(-1), '[DONE]');
    const data = chunks.slice(0, -1);
    assert.ok(data.every((c) => c.object === 'chat.completion.chunk'));
    assert.equal(data[0].choices[0].delta.role, 'assistant');
    assert.equal(data.map((c) => c.choices[0]?.delta?.content || '').join(''), 'Hello ');
    assert.equal(data.map((c) => c.choices[0]?.delta?.reasoning_content || '').join(''), 'thinking…');
    assert.equal(data.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason, 'stop');
    assert.ok(data.at(-1).usage.total_tokens > 0);
    script.pop(); // the unused step
  });

  it('refuses actions that need approval unless the request allows them', async () => {
    await call('PATCH', '/api/config', { approval: 'ask' });
    try {
      next({ toolCalls: [{ name: 'write_file', args: { path: 'compat.txt', content: 'x' } }] }, { text: 'I could not write it.' });
      const refused = await post('/v1/chat/completions', { model: 'seed', messages: [{ role: 'user', content: 'write compat.txt' }] });
      assert.equal(refused.body.choices[0].message.content, 'I could not write it.');
      assert.match(refused.body.choices[0].message.reasoning_content, /\[tool error\].*needs the user's approval/s);
      await assert.rejects(fsp.access(path.join(work, 'compat.txt')));

      next({ toolCalls: [{ name: 'write_file', args: { path: 'compat.txt', content: 'x' } }] }, { text: 'Written.' });
      const allowed = await post('/v1/chat/completions', { model: 'seed', messages: [{ role: 'user', content: 'write compat.txt' }] }, { 'x-seed-approval': 'auto-edit', 'x-seed-tools': 'none' });
      assert.equal(allowed.body.choices[0].message.content, 'Written.');
      assert.equal(allowed.body.choices[0].message.reasoning_content, undefined);
      await fsp.access(path.join(work, 'compat.txt'));
    } finally {
      await call('PATCH', '/api/config', { approval: 'full' });
    }
  });

  it('can continue a saved conversation and reports bad requests in the OpenAI shape', async () => {
    next({ text: 'first' }, { text: 'second' });
    const conv = (await post('/api/conversations')).body;
    await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'one' }] }, { 'x-seed-conversation': conv.id });
    await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'ignored history' }, { role: 'user', content: 'two' }], harness: { conversation_id: conv.id } });
    const saved = (await get(`/api/conversations/${conv.id}`)).body;
    assert.deepEqual(saved.messages.map((m) => m.content[0].text), ['one', 'first', 'two', 'second']);

    const bad = await post('/v1/chat/completions', { messages: [{ role: 'assistant', content: 'x' }] });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.type, 'invalid_request_error');
    assert.equal((await post('/v1/chat/completions', { messages: [] })).status, 400);
    assert.equal((await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }, { 'x-seed-conversation': 'c_missing' })).status, 404);
  });

  it('passes a model API failure on as an error', async () => {
    next({ status: 401, error: { message: 'bad key' } });
    const res = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] });
    assert.equal(res.status, 502);
    assert.match(res.body.error.message, /bad key/);
  });
});

describe('the agent using the app\'s own API', () => {
  const agentCall = (conv, method, url, body) => app.api.dispatch({ method, url, body, actor: { source: 'agent', conversationId: conv.id, mode: 'ask' } });

  it('can read and change ordinary settings but not its own permissions', async () => {
    const conv = await app.createConversation({});
    const config = await agentCall(conv, 'GET', '/api/config');
    assert.equal(config.status, 200);
    assert.ok(!JSON.stringify(config.body).includes('test-key'));
    assert.equal((await agentCall(conv, 'PATCH', '/api/config', { model: 'mock/mock-small' })).status, 200);
    await agentCall(conv, 'PATCH', '/api/config', { model: 'mock/mock-model' });

    for (const patch of [{ approval: 'full' }, { server: { host: '0.0.0.0' } }]) {
      const res = await agentCall(conv, 'PATCH', '/api/config', patch);
      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /not allowed to change/);
    }
    assert.equal(app.config.approval, 'full', 'unchanged (the test app runs in full mode)');
    assert.equal((await agentCall(conv, 'PATCH', `/api/conversations/${conv.id}`, { title: 'x' })).status, 403);
    assert.equal((await agentCall(conv, 'DELETE', `/api/conversations/${conv.id}`)).status, 403);
    assert.equal((await agentCall(conv, 'POST', `/api/conversations/${conv.id}/messages`, { content: 'hi' })).status, 403);
    assert.equal((await agentCall(conv, 'POST', `/api/conversations/${conv.id}/approvals/a_1`, { decision: 'allow' })).status, 403);
    assert.equal((await agentCall(conv, 'DELETE', '/api/providers/mock')).status, 403);

    const other = await app.createConversation({});
    assert.equal((await agentCall(conv, 'PATCH', `/api/conversations/${other.id}`, { approval: 'full' })).status, 403);
    assert.equal((await agentCall(conv, 'PATCH', `/api/conversations/${other.id}`, { title: 'renamed by agent' })).status, 200);
  });

  it('starts other conversations with no more freedom than it has itself', async () => {
    next({ toolCalls: [{ name: 'shell', args: { command: cmd.touch('sub-agent.txt') } }] }, { text: 'blocked, as expected' });
    const conv = await app.createConversation({});
    const res = await agentCall(conv, 'POST', '/api/chat', { message: 'do something', approval: 'full' });
    assert.equal(res.status, 200);
    assert.equal(res.body.text, 'blocked, as expected');
    assert.match(res.body.messages[2].content[0].content, /needs the user's approval and this run cannot ask/);
    await assert.rejects(fsp.access(path.join(work, 'sub-agent.txt')));
  });

  it('passes a stricter per-run mode on to the conversations it starts', async () => {
    // The app default is "full", but this run was started in "ask" mode without anyone to ask.
    next(
      { toolCalls: [{ name: 'seed_api', args: { method: 'GET', path: '/api/info' } }] },
      { text: 'done' },
    );
    const seen = [];
    const original = app.api.dispatch.bind(app.api);
    app.api.dispatch = (req) => (seen.push(req.actor), original(req));
    try {
      await app.api.dispatch({ method: 'POST', url: '/api/chat', body: { message: 'check', approval: 'ask', interactive: false }, actor: { source: 'user' } });
    } finally {
      app.api.dispatch = original;
    }
    assert.deepEqual(seen.find((a) => a.source === 'agent')?.mode, 'ask');
  });

  it('is reachable through the seed_api tool', async () => {
    next(
      { toolCalls: [{ name: 'seed_api', args: { method: 'GET', path: '/api/info' } }, { name: 'seed_api', args: { method: 'PATCH', path: '/api/config', body: { approval: 'full' } } }, { name: 'seed_api', args: { method: 'GET', path: '/etc/passwd' } }] },
      { text: 'done' },
    );
    const done = await post('/api/chat', { message: 'look at yourself' });
    const results = done.body.messages[2].content;
    assert.match(results[0].content, /^HTTP 200\n\{\n {2}"name": "seed"/);
    assert.match(results[1].content, /^HTTP 400[\s\S]*not allowed to change \\"approval\\"/);
    assert.equal(results[1].is_error, true);
    assert.match(results[2].content, /path must start with \/api\/ or \/ext\//);
  });
});

describe('first run with a key from the environment', () => {
  it('chooses a model by asking the API, so the first message just works', async () => {
    const api = await startMockOpenAI([{ text: 'hello from the chosen model' }], { models: ['deepseek-reasoner', 'deepseek-chat'] });
    // The provider id matches a preset, as it does for a key found in the environment; no model is configured.
    const made = await makeApp({ providers: { deepseek: openaiProvider(api.url) } });
    try {
      const res = await made.app.api.dispatch({ method: 'POST', url: '/api/chat', body: { message: 'hi' } });
      assert.equal(res.status, 200);
      assert.equal(res.body.text, 'hello from the chosen model');
      assert.equal(made.app.config.data.model, 'deepseek/deepseek-chat');
      assert.equal(api.requests[0].body.model, 'deepseek-chat');
    } finally {
      await made.cleanup();
      await api.close();
    }
  });
});
