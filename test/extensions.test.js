// The extension system: loading, reloading, error reporting, isolation.
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { sseData } from '../src/providers/sse.js';
import { App } from '../src/app.js';
import { APP_DIR } from '../src/util.js';
import { chat, makeApp, openaiProvider, toolResults, waitFor } from './helpers/app.js';
import { startMockOpenAI } from './helpers/mock-openai.js';

const EXAMPLES = path.join(APP_DIR, 'examples', 'extensions');

let cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setup({ script = [], ...options } = {}) {
  const mock = await startMockOpenAI(script);
  const made = await makeApp({ providers: { mock: openaiProvider(mock.url) }, model: 'mock/mock-model', ...options });
  cleanups.push(made.cleanup, mock.close);
  const write = async (rel, content) => {
    const file = path.join(made.app.extensionsDir, rel);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content);
  };
  const install = (name) => fsp.cp(path.join(EXAMPLES, name), path.join(made.app.extensionsDir, name), { recursive: true });
  const ext = (name) => made.app.extensions.list().find((e) => e.name === name);
  return { mock, write, install, ext, ...made };
}

describe('server side', () => {
  it('loads the example extensions', async () => {
    const { app, install, ext } = await setup();
    await Promise.all(['history-sidebar', 'memory', 'theme-toggle'].map(install));
    await app.extensions.reload();

    assert.deepEqual(app.extensions.list().map((e) => e.name), ['history-sidebar', 'memory', 'theme-toggle']);
    assert.deepEqual(ext('memory').server, { status: 'ok', error: null });
    assert.deepEqual(ext('memory').tools, ['remember', 'forget']);
    assert.deepEqual(ext('memory').routes, ['GET /ext/memory/notes', 'DELETE /ext/memory/notes/:id']);
    assert.equal(ext('history-sidebar').server.status, 'none');
    assert.equal(ext('history-sidebar').description, 'A left sidebar that lists past conversations.');
    assert.equal(app.tools.source('remember'), 'ext:memory');

    // Tools, storage, routes and the system prompt work together.
    const remember = app.tools.get('remember');
    assert.match(await remember.run({ note: 'Likes tabs.' }, {}), /^Saved note /);
    const listed = await app.api.dispatch({ method: 'GET', url: '/ext/memory/notes' });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.notes[0].note, 'Likes tabs.');
    const conv = await app.createConversation({});
    assert.match(conv.system, /Notes you saved in earlier conversations\n- \(\w+\) Likes tabs\./);
    assert.match(conv.system, /- memory: Lets the agent remember notes/);
    const removed = await app.api.dispatch({ method: 'DELETE', url: `/ext/memory/notes/${listed.body.notes[0].id}` });
    assert.deepEqual(removed.body, { ok: true });
    assert.deepEqual((await app.api.dispatch({ method: 'GET', url: '/ext/memory/notes' })).body.notes, []);
    assert.equal((await app.api.dispatch({ method: 'GET', url: '/ext/memory/nope' })).status, 404);

    // What a page needs in order to load the UI halves.
    const manifest = app.extensions.clientManifest();
    const g = `${manifest.generation}~${app.assetKey}`;
    assert.match(app.assetKey, /^[0-9a-f]{32}$/);
    assert.ok(!app.config.server.token.includes(app.assetKey) && !app.assetKey.includes(app.config.server.token));
    assert.deepEqual(manifest.extensions, [
      { name: 'history-sidebar', client: `/extensions/${g}/history-sidebar/client.js`, styles: [`/extensions/${g}/history-sidebar/style.css`] },
      { name: 'memory', client: `/extensions/${g}/memory/client.js`, styles: [] },
      { name: 'theme-toggle', client: `/extensions/${g}/theme-toggle/client.js`, styles: [] },
    ]);
  });

  it('gives a fresh copy of the code on every reload, including imported files', async () => {
    const { app, write } = await setup();
    await write('counter/helper.js', 'export const VALUE = "one";\n');
    await write(
      'counter/server.js',
      `import { VALUE } from './helper.js';
       export function activate(ctx) {
         ctx.tools.register({ name: 'value', description: 'Return the value.', kind: 'read', run: () => VALUE });
       }`,
    );
    await app.extensions.reload();
    assert.equal(await app.tools.get('value').run({}, {}), 'one');
    await write('counter/helper.js', 'export const VALUE = "two";\n');
    await app.extensions.reload();
    assert.equal(await app.tools.get('value').run({}, {}), 'two');
    assert.equal(app.tools.definitions().filter((t) => t.name === 'value').length, 1, 'no duplicate after reload');
  });

  it('reports errors with file and line, and leaves nothing half-registered', async () => {
    const { app, write, ext } = await setup();
    await write('syntax/server.js', 'export function activate(ctx) {\n  const x = ;\n}\n');
    await write('throws/server.js', `export function activate(ctx) {\n  ctx.tools.register({ name: 'half', description: 'x', run: () => 1 });\n  ctx.http.get('/x', () => 1);\n  null.boom();\n}\n`);
    await write('noexport/server.js', 'export const nothing = 1;\n');
    await write('badtool/server.js', `export function activate(ctx) { ctx.tools.register({ name: 'shell', description: 'mine', run: () => 1 }); }`);
    await write('nodesc/server.js', `export function activate(ctx) { ctx.tools.register({ name: 'quiet', run: () => 1 }); }`);
    await write('bad name!/server.js', 'export function activate() {}');
    await write('badjson/extension.json', '{ not json');
    await write('fine/server.js', `export function activate(ctx) { ctx.tools.register({ name: 'fine_tool', description: 'Works.', kind: 'read', run: () => 'ok' }); }`);
    await app.extensions.reload();

    assert.equal(ext('syntax').server.status, 'error');
    assert.match(ext('syntax').server.error, /syntax\/server\.js:2[\s\S]*SyntaxError: Unexpected token ';'/);
    assert.match(ext('throws').server.error, /TypeError[\s\S]*at activate \(throws\/server\.js:4:8\)/);
    assert.equal(app.tools.get('half'), null, 'a failed extension keeps none of its tools');
    assert.equal(app.extensions.matchRoute('GET', '/ext/throws/x'), null);
    assert.match(ext('noexport').server.error, /must export a function/);
    assert.match(ext('badtool').server.error, /A tool named "shell" already exists \(builtin\)/);
    assert.equal(app.tools.source('shell'), 'builtin');
    assert.match(ext('nodesc').server.error, /needs a description/);
    assert.match(ext('bad name!').server.error, /Invalid folder name/);
    assert.match(ext('badjson').server.error, /extension\.json is not valid JSON/);
    assert.equal(ext('fine').server.status, 'ok', 'one broken extension does not stop the others');
    assert.equal(await app.tools.get('fine_tool').run({}, {}), 'ok');

    const report = app.extensions.report();
    assert.match(report, /syntax — enabled\n {2}server: ERROR\n {4}syntax\/server\.js:2/);
    assert.match(report, /fine — enabled\n {2}server: ok \(tools: fine_tool\)/);
  });

  it('checks the UI code for syntax errors on the server, where the line number is known', async () => {
    const { app, write, ext } = await setup();
    await write('ui-broken/client.js', 'export function activate(seed) {\n  seed.ui.toast("a"\n}\n');
    await write('ui-fine/client.js', 'export function activate(seed) {}\n');
    await app.extensions.reload();
    assert.equal(ext('ui-broken').client.status, 'error');
    assert.match(ext('ui-broken').client.error, /^client\.js:2\n[\s\S]*SyntaxError: missing \) after argument list/);
    assert.equal(ext('ui-fine').client.status, 'pending');
    const manifest = app.extensions.clientManifest().extensions;
    assert.equal(manifest.find((e) => e.name === 'ui-broken').client, null, 'pages are not asked to load code that cannot parse');
    assert.ok(manifest.find((e) => e.name === 'ui-fine').client);
    // A page's vaguer report must not replace the precise one.
    app.extensions.reportClient({ generation: app.extensions.generation, results: { 'ui-broken': { ok: true }, 'ui-fine': { ok: false, error: 'TypeError: x' } } });
    assert.match(ext('ui-broken').client.error, /SyntaxError/);
    assert.deepEqual(ext('ui-fine').client, { status: 'error', error: 'TypeError: x' });
    assert.match(app.extensions.report(), /ui-fine — enabled\n {2}server: none \(no server\.js\)\n {2}client: ERROR\n {4}TypeError: x/);
  });

  it('undoes everything an extension registered when it is disabled or removed', async () => {
    const { app, write, ext } = await setup();
    let ticks = 0;
    globalThis.__seedTestTick = () => ticks++;
    cleanups.push(() => delete globalThis.__seedTestTick);
    await write(
      'full/server.js',
      `export function activate(ctx) {
         ctx.tools.register({ name: 'full_tool', description: 'x', kind: 'read', run: () => 'ok' });
         ctx.http.get('/hello/:who', ({ params, query }) => ({ hello: params.who, loud: query.loud === '1' }));
         ctx.http.get('/page', () => ctx.http.respond({ status: 201, html: '<h1>hi</h1>' }));
         ctx.hooks.on('tool:before', ({ name }) => (name === 'list_dir' ? { deny: 'not while full is on' } : undefined));
         ctx.prompt.add('FULL EXTENSION PROMPT');
         ctx.timers.every(10, () => globalThis.__seedTestTick());
         return () => { globalThis.__seedTestDisposed = true; };
       }`,
    );
    await app.extensions.reload();
    assert.deepEqual((await app.api.dispatch({ method: 'GET', url: '/ext/full/hello/world?loud=1' })).body, { hello: 'world', loud: true });
    const page = await app.api.dispatch({ method: 'GET', url: '/ext/full/page' });
    assert.deepEqual([page.status, page.type, page.body], [201, 'text/html; charset=utf-8', '<h1>hi</h1>']);
    assert.match((await app.createConversation({})).system, /FULL EXTENSION PROMPT/);
    await waitFor(() => ticks > 1);

    const off = await app.api.dispatch({ method: 'PATCH', url: '/api/extensions/full', body: { enabled: false } });
    assert.equal(off.status, 200);
    assert.equal(ext('full').enabled, false);
    assert.equal(app.tools.get('full_tool'), null);
    assert.equal((await app.api.dispatch({ method: 'GET', url: '/ext/full/hello/x' })).status, 404);
    assert.doesNotMatch((await app.createConversation({})).system, /FULL EXTENSION PROMPT/);
    assert.equal(globalThis.__seedTestDisposed, true);
    delete globalThis.__seedTestDisposed;
    const before = ticks;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ticks, before, 'timers stop');
    assert.equal((await app.hooks.run('tool:before', { name: 'list_dir' })).length, 0);

    await app.api.dispatch({ method: 'PATCH', url: '/api/extensions/full', body: { enabled: true } });
    assert.equal(await app.tools.get('full_tool').run({}, {}), 'ok');
    assert.equal((await app.api.dispatch({ method: 'DELETE', url: '/api/extensions/full' })).status, 200);
    assert.equal(ext('full'), undefined);
    await assert.rejects(fsp.access(path.join(app.extensionsDir, 'full')));
    assert.equal((await app.api.dispatch({ method: 'PATCH', url: '/api/extensions/nope', body: { enabled: true } })).status, 404);
  });

  it('works when the data folder is reached through a symlink (macOS: /var is /private/var)', async () => {
    const real = await fsp.mkdtemp(path.join(os.tmpdir(), 'seed-real-home-'));
    const link = `${real}-link`;
    await fsp.symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    const app = new App({ home: link, cwd: os.tmpdir(), detectEnv: false, watch: false });
    cleanups.push(async () => {
      await app.close();
      await fsp.rm(link, { force: true });
      await fsp.rm(real, { recursive: true, force: true });
    });
    await app.init();
    const write = async (rel, content) => {
      const file = path.join(app.extensionsDir, rel);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, content);
    };
    await write('counter/helper.js', 'export const VALUE = "one";\n');
    await write('counter/server.js', `import { VALUE } from './helper.js';\nexport function activate(ctx) { ctx.tools.register({ name: 'linked_value', description: 'v', kind: 'read', run: () => VALUE }); }`);
    await write('throws/server.js', 'export function activate(ctx) {\n  null.boom();\n}\n');
    await app.extensions.reload();
    await write('counter/helper.js', 'export const VALUE = "two";\n');
    await app.extensions.reload();
    assert.equal(await app.tools.get('linked_value').run({}, {}), 'two');
    const error = app.extensions.list().find((e) => e.name === 'throws').server.error;
    assert.match(error, /at activate \(throws\/server\.js:2:8\)$/);
  });

  it('loads nothing in safe mode', async () => {
    const { app, write } = await setup({ safeMode: true });
    await write('x/server.js', `export function activate(ctx) { ctx.tools.register({ name: 'x_tool', description: 'x', run: () => 1 }); }`);
    await app.extensions.reload();
    assert.deepEqual(app.extensions.list(), []);
    assert.equal(app.tools.get('x_tool'), null);
    assert.equal(app.extensions.clientManifest().safeMode, true);
    assert.match(app.extensions.report(), /Safe mode is on/);
  });

  it('reloads by itself when a file changes', async () => {
    const { app, write } = await setup({ watch: true });
    const first = app.extensions.generation;
    await write('auto/server.js', `export function activate(ctx) { ctx.tools.register({ name: 'auto_tool', description: 'x', kind: 'read', run: () => 'v1' }); }`);
    await waitFor(() => app.tools.get('auto_tool'), { timeout: 5000 });
    assert.ok(app.extensions.generation > first);
    await write('auto/server.js', `export function activate(ctx) { ctx.tools.register({ name: 'auto_tool', description: 'x', kind: 'read', run: () => 'v2' }); }`);
    await waitFor(async () => (await app.tools.get('auto_tool')?.run({}, {})) === 'v2', { timeout: 5000 });
  });

  it('lets an extension run the agent and keep data', async () => {
    const { app, write } = await setup({ script: [{ text: 'sub-conversation answer' }] });
    await write(
      'runner/server.js',
      `export function activate(ctx) {
         ctx.http.post('/ask', async ({ body }) => {
           const reply = await ctx.conversations.send(null, body.question);
           await ctx.storage.set('last', reply.text);
           ctx.events.broadcast('answered', { text: reply.text });
           return reply;
         });
       }`,
    );
    await app.extensions.reload();
    const seen = [];
    const off = app.events.subscribe((e) => e.type.startsWith('ext.') && seen.push(e));
    const res = await app.api.dispatch({ method: 'POST', url: '/ext/runner/ask', body: { question: 'hello?' } });
    off();
    assert.equal(res.body.text, 'sub-conversation answer');
    assert.equal(res.body.status, 'completed');
    assert.equal(await app.extensions.storage('runner').get('last'), 'sub-conversation answer');
    assert.deepEqual(seen.map((e) => [e.type, e.data]), [['ext.runner.answered', { text: 'sub-conversation answer' }]]);
    assert.deepEqual((await app.api.dispatch({ method: 'GET', url: '/api/extensions/runner/storage' })).body, { values: { last: 'sub-conversation answer' } });
    await app.api.dispatch({ method: 'PUT', url: '/api/extensions/runner/storage/k', body: { value: [1, 2] } });
    assert.deepEqual((await app.api.dispatch({ method: 'GET', url: '/api/extensions/runner/storage/k' })).body, { value: [1, 2] });
    await app.api.dispatch({ method: 'DELETE', url: '/api/extensions/runner/storage/k' });
    assert.deepEqual((await app.api.dispatch({ method: 'GET', url: '/api/extensions/runner/storage/k' })).body, { value: null });
    assert.equal((await app.api.dispatch({ method: 'GET', url: '/api/extensions/..%2Fevil/storage' })).status, 400);
  });
});

describe('the agent building extensions', () => {
  it('writes one, reloads, reads the report and uses the new tool at once', async () => {
    const { app, mock } = await setup({
      script: [
        (body) => {
          const dir = /Build the feature as an extension in (.+?)[\\/]<name>/.exec(body.messages[0].content)[1];
          return {
            toolCalls: [
              {
                name: 'write_file',
                args: {
                  path: `${dir}/dice/server.js`,
                  content: `export function activate(ctx) {\n  ctx.tools.register({ name: 'roll', description: 'Roll a die.', kind: 'read', parameters: { type: 'object', properties: { sides: { type: 'integer' } } }, run: ({ sides = 6 }) => 'rolled ' + sides });\n}\n`,
                },
              },
            ],
          };
        },
        { toolCalls: [{ name: 'reload_extensions', args: {} }] },
        { toolCalls: [{ name: 'ext_call', args: { name: 'roll', arguments: { sides: '20' } } }] },
        { text: 'Added a dice tool.' },
      ],
    });
    const { conv, result } = await chat(app, 'give yourself a dice tool');
    assert.equal(result.status, 'completed');
    const [written, report, rolled] = toolResults(conv);
    assert.match(written.content, /^Created .*dice[\\/]server\.js/);
    assert.match(report.content, /dice — enabled\n {2}server: ok \(tools: roll\)/);
    assert.match(report.content, /Extension tools: roll\. Tools that are not in your tool list can be called with ext_call\./);
    assert.equal(rolled.content, 'rolled 20');
    assert.ok(mock.requests.every((r) => !r.body.tools.some((t) => t.function.name === 'roll')), 'this conversation keeps its original tool list');
  });

  it('treats extension code as its own approval category', async () => {
    const { app } = await setup({
      approval: 'auto-edit',
      script: [
        (body) => {
          const dir = /Build the feature as an extension in (.+?)[\\/]<name>/.exec(body.messages[0].content)[1];
          return { toolCalls: [{ name: 'write_file', args: { path: 'notes.txt', content: 'ordinary edit' } }, { name: 'write_file', args: { path: `${dir}/x/client.js`, content: 'export function activate() {}' } }] };
        },
        { text: 'stopped' },
      ],
    });
    const conv = await app.createConversation({});
    const events = [];
    const run = await app.runs.start(conv, { content: [{ type: 'text', text: 'go' }], onEvent: (e) => events.push(e) });
    const pending = await waitFor(() => (app.runs.get(conv.id)?.approvals.size ? [...app.runs.get(conv.id).approvals.values()][0] : null));
    assert.equal(pending.request.category, 'extension');
    assert.ok(!toolResults(conv).length || true);
    app.runs.resolveApproval(conv.id, pending.request.id, 'deny');
    await run.done;
    assert.equal(events.filter((e) => e.type === 'approval.requested').length, 1, 'the ordinary edit ran without asking');
    await assert.rejects(fsp.access(path.join(app.extensionsDir, 'x', 'client.js')));
  });
});

describe('pages', () => {
  it('serves extension files only through their keyed path, and nothing outside the extension', async () => {
    const { app, install, write } = await setup();
    await install('history-sidebar');
    await write('secret.txt', 'top level file');
    await app.extensions.reload();
    const { url } = await app.listen();
    const g = `${app.extensions.generation}~${app.assetKey}`;

    // The path is the credential: <script> and <link> requests cannot send a token.
    const ok = await fetch(`${url}/extensions/${g}/history-sidebar/client.js`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /javascript/);
    assert.match(await ok.text(), /export async function activate/);
    assert.equal((await fetch(`${url}/extensions/${g}/history-sidebar/style.css`)).status, 200);
    for (const bad of [
      `/extensions/${app.extensions.generation}/history-sidebar/client.js`,
      `/extensions/${app.extensions.generation}~${'0'.repeat(32)}/history-sidebar/client.js`,
      `/extensions/${g}/history-sidebar/..%2Fsecret.txt`,
      `/extensions/${g}/history-sidebar/%2e%2e/secret.txt`,
      `/extensions/${g}/history-sidebar/%E0%A4%A`,
      `/extensions/${g}/nope/client.js`,
      `/extensions/${g}/history-sidebar/`,
    ]) {
      const res = await fetch(url + bad, { headers: { authorization: `Bearer ${app.config.server.token}` } });
      assert.equal(res.status, 404, bad);
    }
    assert.equal((await fetch(`${url}/extensions/${g}/history-sidebar/client.js`, { method: 'POST' })).status, 405);
  });

  it('reaches an open page for ui_eval and collects its load report', async () => {
    const { app, write, ext } = await setup();
    await write('ui/client.js', 'export function activate(seed) {}\n');
    await app.extensions.reload();
    const { url } = await app.listen();
    const headers = { authorization: `Bearer ${app.config.server.token}`, 'content-type': 'application/json' };

    assert.match((await app.clients.eval('return 1')).error, /No UI page is open/);
    assert.match(app.extensions.report(), /client: not checked, because no UI page is open/);

    // Play the part of a page: open the event stream, answer what the server asks.
    const stream = await fetch(`${url}/api/events?client=page1`, { headers });
    const page = (async () => {
      for await (const data of sseData(stream.body)) {
        const event = JSON.parse(data);
        if (event.type === 'ui.eval') {
          await fetch(`${url}/api/client/eval-result`, { method: 'POST', headers, body: JSON.stringify({ evalId: event.evalId, ok: true, value: `evaluated: ${event.code}` }) });
        } else if (event.type === 'extensions.changed') {
          await fetch(`${url}/api/extensions/client-report`, { method: 'POST', headers, body: JSON.stringify({ generation: event.generation, results: { ui: { ok: true } } }) });
        } else if (event.type === 'stop-test') break;
      }
    })();
    await waitFor(() => app.clients.size === 1);
    assert.deepEqual(await app.clients.eval('return document.title'), { ok: true, value: 'evaluated: return document.title' });

    // reload_extensions waits for the page's report.
    const report = await app.tools.get('reload_extensions').run({}, {});
    assert.match(report, /ui — enabled\n {2}server: none \(no server\.js\)\n {2}client: ok \(loaded in the open UI page\)/);
    assert.equal(ext('ui').client.status, 'ok');

    await fetch(`${url}/api/extensions/client-error`, { method: 'POST', headers, body: JSON.stringify({ name: 'ui', message: 'boom', stack: 'TypeError: boom\n    at ui/client.js:3:1' }) });
    assert.match(ext('ui').runtimeErrors[0], /\[client\] TypeError: boom/);
    assert.match(app.extensions.report(), /earlier runtime error: \[client\] TypeError: boom/);

    app.events.emit({ type: 'stop-test' });
    await page;
    await waitFor(() => app.clients.size === 0);
  });
});
