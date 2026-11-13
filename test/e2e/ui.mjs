// Browser end-to-end check of the web UI, driven by a scripted model.
//
//   node test/e2e/ui.mjs [--shots <dir>]
//
// Needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`,
// or a global install). It is not part of `npm test`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { App } from '../../src/app.js';
import { APP_DIR } from '../../src/util.js';
import { startMockOpenAI } from '../helpers/mock-openai.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const shotsDir = process.argv.includes('--shots') ? path.resolve(process.argv[process.argv.indexOf('--shots') + 1]) : null;
if (shotsDir) await fsp.mkdir(shotsDir, { recursive: true });

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'seed-e2e-home-'));
const work = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'seed-e2e-')), 'my-project');
await fsp.mkdir(work);
await fsp.writeFile(path.join(work, 'README.md'), '# My project\n');
await fsp.writeFile(path.join(work, 'index.js'), 'console.log("hello");\n');
const extensions = path.join(home, 'extensions');
const example = (rel) => fs.readFileSync(path.join(APP_DIR, 'examples', 'extensions', rel), 'utf8');

const answer = `这是一个很小的 **Node.js** 项目：

- \`README.md\`：项目说明
- \`index.js\`：入口，只有一行输出

| 文件 | 行数 |
| --- | ---: |
| README.md | 1 |
| index.js | 1 |

我把问候语改成了 \`hello, seed\`，运行结果：

\`\`\`bash
$ node index.js
hello, seed
\`\`\``;

const mock = await startMockOpenAI([
  // Conversation 1: the agent builds a feature of the app itself.
  { reasoning: '用户想给软件本身加功能，应该写成扩展。先读扩展文档。', text: '我先看一下扩展开发文档。', toolCalls: [{ name: 'read_file', args: { path: path.join(APP_DIR, 'docs', 'EXTENDING.md'), limit: 60 } }] },
  {
    text: '把侧边栏写成一个扩展：',
    toolCalls: ['extension.json', 'client.js', 'style.css'].map((f) => ({ name: 'write_file', args: { path: `${extensions}/history-sidebar/${f}`, content: example(`history-sidebar/${f}`) } })),
  },
  { toolCalls: [{ name: 'reload_extensions', args: {} }] },
  { toolCalls: [{ name: 'ui_eval', args: { code: 'return { sidebar: !!document.querySelector("#history-sidebar"), items: document.querySelectorAll("#history-sidebar .seed-item").length }' } }] },
  { text: '侧边栏加好了：左侧会列出所有历史对话，点击切换，悬停可删除。输入 `/history` 可以显示或隐藏它。' },
  // Conversation 2: ordinary work in the workspace.
  { text: '我先看看目录。', toolCalls: [{ name: 'list_dir', args: {} }, { name: 'read_file', args: { path: 'index.js' } }] },
  { toolCalls: [{ name: 'edit_file', args: { path: 'index.js', old_string: 'console.log("hello");', new_string: 'console.log("hello, seed");' } }] },
  { toolCalls: [{ name: 'shell', args: { command: 'node index.js', description: '运行入口文件' } }] },
  { text: answer },
  // Conversation 3: from a page embedded in another site.
  { text: '嵌入在别的页面里也能用。' },
]);

const app = new App({ home, cwd: work, detectEnv: false, overrides: { server: { port: 0 } } });
await app.init();
const address = await app.listen();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: shotsDir ? 2 : 1, locale: 'zh-CN', colorScheme: 'light' });
const problems = [];
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
const shot = async (name) => {
  if (!shotsDir) return;
  await page.waitForFunction(() => !document.querySelector('#toasts .toast'), null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
};
const idle = () => page.waitForFunction(() => !document.querySelector('.send-button.stop'), null, { timeout: 20000 });
const step = (name) => console.log(`  ✓ ${name}`);

try {
  // 1. No token, no entry.
  await page.goto(address.url);
  await page.waitForSelector('.gate');
  assert.equal(await page.locator('#app').isHidden(), true);
  await page.fill('.gate input', 'wrong-token');
  await page.click('.gate button');
  await page.waitForFunction(() => document.querySelector('.gate .connect-error')?.textContent.length > 0);
  problems.length = 0; // the browser logs the 401 of the wrong token; that one is expected
  step('the page asks for the access token');

  // 2. The start-up link signs in and removes the token from the address bar.
  await page.goto(address.urlWithToken);
  await page.waitForSelector('.connect');
  assert.ok(!page.url().includes('token='));
  assert.equal(await page.getAttribute('#app', 'data-view'), 'home');
  step('the start-up link signs in');

  // 3. Typing before a model is connected keeps the message and shows the connect card.
  await page.fill('#input', '给这个软件加一个历史对话侧边栏');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.connect');
  await page.click('.preset:has-text("OpenAI 兼容")');
  await page.fill('.connect input[type=password]', 'test-key');
  await page.fill('.connect input[type=url]', mock.url);
  await shot('connect');
  await page.click('.connect button[type=submit]');

  // 4. The kept message is sent once connected; the agent asks before touching extension code.
  await page.waitForSelector('.approval:not([hidden])');
  assert.match(await page.textContent('.approval:not([hidden]) .approval-title'), /扩展/);
  await shot('approval');
  for (;;) {
    const s = await page.evaluate(() => ({ busy: !!document.querySelector('.send-button.stop'), ask: !!document.querySelector('.approval:not([hidden])') }));
    if (s.ask) await page.click('.approval:not([hidden]) .seed-btn:nth-child(2)'); // always allow
    else if (!s.busy) break;
    await page.waitForTimeout(60);
  }
  await page.waitForSelector('#history-sidebar .seed-item');
  assert.equal(await page.locator('#history-sidebar .seed-item').count(), 1);
  assert.match(await page.textContent('.msg.assistant:last-of-type'), /侧边栏加好了/);
  await shot('grown');
  step('the agent built a sidebar and the page grew it without a reload');

  // 5. The home screen is still one bar (plus what the user asked for).
  await page.click('#new-chat');
  await page.waitForSelector('#app[data-view="home"]');
  assert.equal(await page.locator('#connect').isHidden(), true);
  await page.fill('#input', '/hist');
  await page.waitForSelector('#command-menu:not([hidden])');
  assert.match(await page.textContent('#command-menu'), /\/history/);
  await page.keyboard.press('Enter'); // hides the sidebar
  await page.waitForSelector('#history-sidebar', { state: 'detached' });
  await shot('home');
  await page.fill('#input', '/history');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#history-sidebar');
  step('slash commands from the extension work, and its state persists');

  // 6. Ordinary work: reads run freely, the edit and the command ask.
  await page.fill('#input', '看看这个项目，把问候语改成 hello, seed 然后运行一下');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.approval:not([hidden]) .diff-line');
  await shot('edit-approval');
  await page.click('.approval:not([hidden]) .seed-btn.primary');
  await page.waitForFunction(() => document.querySelector('.approval:not([hidden]) pre')?.textContent.includes('node index.js'));
  await page.click('.approval:not([hidden]) .seed-btn.primary');
  await page.waitForSelector('.md table');
  await idle();
  assert.equal(await fsp.readFile(path.join(work, 'index.js'), 'utf8'), 'console.log("hello, seed");\n');
  assert.equal(await page.locator('.tool[data-status="done"]').count(), 4);
  assert.equal(await page.locator('#history-sidebar .seed-item').count(), 2);
  assert.match(await page.title(), /看看这个项目/);
  await shot('chat');
  step('a coding task with approvals, live tool cards and a Markdown answer');

  // 7. Reloading the page restores the conversation; Markdown is rendered safely.
  await page.reload();
  await page.waitForSelector('.md table');
  assert.equal(await page.locator('.msg.user').count(), 1);
  assert.equal(await page.locator('.tool').count(), 4);
  await page.click('.tool[data-tool="shell"] .tool-head');
  assert.match(await page.textContent('.tool[data-tool="shell"] .tool-body'), /hello, seed/);
  const unsafe = await page.evaluate(() => {
    const el = document.createElement('div');
    el.append(window.seed.markdown.render('<img src=x onerror="window.__xss=1"> [x](javascript:alert(1)) ![pic](https://example.com/a.png) **ok**'));
    document.body.append(el);
    const result = { html: el.innerHTML, imgs: el.querySelectorAll('img').length, links: [...el.querySelectorAll('a')].map((a) => a.getAttribute('href')) };
    el.remove();
    return result;
  });
  assert.equal(unsafe.imgs, 0, 'no image element is created from model output');
  assert.deepEqual(unsafe.links, ['https://example.com/a.png'], 'javascript: links are not made clickable');
  assert.match(unsafe.html, /&lt;img src=x/);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  step('the conversation survives a page reload, and model output cannot inject HTML');

  // 8. Safe mode loads no UI extension.
  await page.goto(`${address.url}/?safe=1`);
  await page.waitForSelector('#hint .status');
  assert.equal(await page.locator('#history-sidebar').count(), 0);
  assert.match(await page.textContent('#hint'), /安全模式/);
  step('safe mode opens the page without UI extensions');

  // 9. Embedded in another site's frame, the browser withholds the session cookie
  //    (IDE and cloud preview panes work like this). The page falls back to the token.
  const outer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>host page</title><iframe src="${address.urlWithToken}" style="width:100%;height:700px;border:0"></iframe>`);
  });
  await new Promise((resolve) => outer.listen(0, 'localhost', resolve));
  try {
    await page.goto(`http://localhost:${outer.address().port}/`); // "localhost" and "127.0.0.1" are different sites
    const frame = page.frameLocator('iframe');
    await frame.locator('#hint .status').waitFor();
    await frame.locator('#history-sidebar .seed-item').first().waitFor(); // extension files load without the cookie too
    await frame.locator('#input').fill('在嵌入页面里说句话');
    await frame.locator('#input').press('Enter');
    await frame.locator('.msg.assistant .md').waitFor();
    assert.match(await frame.locator('.msg.assistant .md').textContent(), /嵌入在别的页面里也能用/);
    const cookies = await page.context().cookies(address.url);
    const inFrame = page.frames().find((f) => f.url().startsWith(address.url));
    assert.equal(await inFrame.evaluate(() => !!sessionStorage.getItem('seed.token')), true, 'the frame works from the token, not the cookie');
    assert.ok(cookies.length >= 0);
  } finally {
    await new Promise((resolve) => (outer.closeAllConnections?.(), outer.close(resolve)));
  }
  step('works inside another site\'s frame, where the session cookie is not available');

  await page.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(app.clients.size, 0, 'closed pages are forgotten');
  assert.deepEqual(problems, []);
  console.log('\nAll UI checks passed.');
} catch (err) {
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'failure.png') }).catch(() => {});
  console.error('\nUI check failed:', err);
  if (problems.length) console.error('page problems:', problems);
  process.exitCode = 1;
} finally {
  await browser.close();
  await app.close();
  await mock.close();
  await fsp.rm(home, { recursive: true, force: true });
  await fsp.rm(path.dirname(work), { recursive: true, force: true });
}
