// Smoke test of the desktop app, driven by Playwright's Electron support.
//
//   node test/e2e/desktop.mjs                      the app from this checkout (`electron .`)
//   node test/e2e/desktop.mjs --app <executable>   a packaged build, e.g.
//        dist/mac-arm64/Seed.app/Contents/MacOS/Seed   dist/win-unpacked/Seed.exe
//
// Needs Playwright (`npm i -D playwright`; no browser download is needed for
// Electron). On Linux without a display, run it under xvfb-run.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockAnthropic } from '../helpers/mock-anthropic.js';
import { startMockOpenAI } from '../helpers/mock-openai.js';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const packaged = process.argv.includes('--app') ? path.resolve(process.argv[process.argv.indexOf('--app') + 1]) : null;
const step = (name) => console.log(`  ✓ ${name}`);

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'seed-desktop-home-'));
const work = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'seed-desktop-work-')));
const token = crypto.randomBytes(18).toString('base64url');

const openai = await startMockOpenAI([
  { text: '先运行一个命令。', toolCalls: [{ name: 'shell', args: { command: 'echo seed-desktop-ok; echo second-line' } }] },
  { toolCalls: [{ name: 'write_file', args: { path: 'desktop-ok.txt', content: '你好，桌面\n' } }] },
  { text: '命令和文件都没问题。' },
]);
const anthropic = await startMockAnthropic([{ blocks: [{ type: 'thinking', thinking: 'ok' }, { type: 'text', text: 'Claude 通过桌面应用回答。' }] }]);

await fsp.writeFile(
  path.join(home, 'config.json'),
  JSON.stringify({
    providers: {
      mock: { type: 'openai', name: 'Mock', baseURL: openai.url, apiKey: 'k' },
      claude: { type: 'anthropic', name: 'Claude', baseURL: anthropic.url, apiKey: 'sk-ant-test', features: 'basic' },
    },
    model: 'mock/mock-model',
    approval: 'ask',
    workspace: work,
    server: { host: '127.0.0.1', port: 0, token },
  }),
);

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const app = await electron.launch({
  // The `electron` package of this checkout exports the path of its binary.
  executablePath: packaged || require('electron'),
  args: [...(packaged ? [] : [ROOT]), ...(isRoot ? ['--no-sandbox'] : [])],
  env: { ...process.env, SEED_HOME: home, SEED_NO_OPEN: '1' },
  timeout: 60_000,
});
const problems = [];
let ok = false;

try {
  const page = await app.firstWindow();
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.waitForSelector('#hint .status', { timeout: 30_000 });
  const base = new URL(page.url()).origin;
  assert.ok(!page.url().includes('token='), 'the token is removed from the address');
  assert.equal(await page.title(), 'Seed');
  assert.equal(await page.getAttribute('#app', 'data-view'), 'home');
  assert.equal(await page.locator('#connect').isHidden(), true, 'a configured app opens on the bare input bar');
  step(`the window opens on the input bar (${packaged ? 'packaged build' : 'from source'}, ${process.platform})`);

  const menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.flatMap((i) => [i.label, ...(i.submenu?.items || []).map((s) => s.label)]));
  assert.ok(menu.some((l) => /Open Folder|选择工作目录/.test(l)));
  assert.ok(menu.some((l) => /Copy API|复制 API/.test(l)));
  step('the application menu is in place');

  const api = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return res.json();
  };
  assert.equal((await api('GET', '/api/info')).cwd, work, 'the saved workspace is used');
  step('the API answers with the app\'s token');

  // A conversation: the model API is reached through the app's network layer,
  // a command runs in the platform's shell, a file is written in the workspace.
  await page.fill('#input', '在桌面应用里跑一下');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.approval:not([hidden])', { timeout: 30_000 });
  await page.click('.approval:not([hidden]) .seed-btn:nth-child(2)'); // always allow commands
  await page.waitForSelector('.approval:not([hidden])', { timeout: 30_000 });
  await page.click('.approval:not([hidden]) .seed-btn.primary'); // the file write
  await page.waitForFunction(() => /命令和文件都没问题/.test(document.querySelector('#thread')?.textContent || ''), null, { timeout: 30_000 });
  await page.click('.tool[data-tool="shell"] .tool-head');
  const shellOutput = await page.textContent('.tool[data-tool="shell"] .tool-body');
  assert.match(shellOutput, /seed-desktop-ok/, `shell output: ${shellOutput}`);
  assert.equal(await fsp.readFile(path.join(work, 'desktop-ok.txt'), 'utf8'), '你好，桌面\n');
  step('a run with a shell command and a file edit works');

  // The Anthropic SDK goes through the same network layer.
  const conversations = await api('GET', '/api/conversations');
  await api('PATCH', `/api/conversations/${conversations.conversations[0].id}`, { model: 'claude/claude-opus-5-5' });
  await page.fill('#input', '换成 Claude');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /Claude 通过桌面应用回答/.test(document.querySelector('#thread')?.textContent || ''), null, { timeout: 30_000 });
  assert.equal(anthropic.calls, 1);
  step('the Claude provider works from the desktop app');

  // Extension UI code is syntax-checked with the app's own runtime.
  await fsp.mkdir(path.join(home, 'extensions', 'broken'), { recursive: true });
  await fsp.writeFile(path.join(home, 'extensions', 'broken', 'client.js'), 'export function activate(seed) {\n  const x = ;\n}\n');
  await api('POST', '/api/extensions/reload');
  const broken = (await api('GET', '/api/extensions')).extensions.find((e) => e.name === 'broken');
  assert.match(broken.client.error || '', /client\.js:2[\s\S]*SyntaxError/, JSON.stringify(broken));
  step('extension errors are reported with file and line');

  assert.deepEqual(problems.filter((p) => !/Failed to load resource/.test(p)), []);
  ok = true;
} catch (err) {
  console.error('\nDesktop check failed:', err);
  try {
    const page = app.windows()[0];
    console.error('thread:', (await page.textContent('#thread'))?.slice(0, 1500));
    console.error('model API calls:', openai.calls, anthropic.calls);
  } catch {
    /* the window is gone */
  }
  if (problems.length) console.error('page problems:', problems);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  await openai.close();
  await anthropic.close();
  await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
}
if (ok) console.log('\nAll desktop checks passed.');
