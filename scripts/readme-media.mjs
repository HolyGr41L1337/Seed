// Makes the pictures the READMEs use: a short demo animation and two
// screenshots for each interface language (Chinese, English, Japanese, French,
// Russian), light and dark, plus the badges and download buttons.
//
//   node scripts/readme-media.mjs                 everything
//   node scripts/readme-media.mjs --only en-dark  one language and theme
//   node scripts/readme-media.mjs --only badges   only the badges and buttons
//
// Needs Playwright with Chromium, ffmpeg for the animation, and the fonts Inter
// and Noto Sans CJK (on Ubuntu: fonts-inter, fonts-noto-cjk), so that the
// pictures look the same whichever machine makes them. The app in the pictures
// is the real one; the model is a scripted stand-in that streams at a readable
// pace, and the sidebar it "writes" is examples/extensions/history-sidebar.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { App } from '../src/app.js';
import { APP_DIR } from '../src/util.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const OUT = path.join(APP_DIR, 'docs', 'images');
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const VIEWPORT = { width: 1080, height: 680 };
const GIF_WIDTH = 1440;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const example = (rel) => fs.readFileSync(path.join(APP_DIR, 'examples', 'extensions', rel), 'utf8');

const TEXT = {
  zh: {
    locale: 'zh-CN',
    chars: 2,
    typing: 95,
    cjk: 'Noto Sans CJK SC',
    grow: '给这个软件加一个历史对话侧边栏',
    reasoning: '用户想给软件本身加功能，应该写成扩展。先读扩展文档。',
    readDocs: '我先看一下扩展开发文档。',
    write: '把侧边栏写成一个扩展：',
    grown: '侧边栏加好了：左侧会列出所有历史对话，点击切换，悬停可删除。输入 `/history` 可以显示或隐藏它。',
    task: '看看这个项目，把问候语改成 hello, seed 然后运行一下',
    look: '我先看看目录。',
    run: '运行入口文件',
    answer: `这是一个很小的 **Node.js** 项目：

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
\`\`\``,
  },
  en: {
    locale: 'en-US',
    chars: 5,
    typing: 42,
    cjk: 'Noto Sans CJK SC',
    grow: 'Add a conversation history sidebar to this app',
    reasoning: 'The user wants a new feature in the app itself, so it should be an extension. Read the extension guide first.',
    readDocs: 'Let me read the extension guide first.',
    write: 'Writing the sidebar as an extension:',
    grown: 'The sidebar is in. It lists your past conversations on the left: click one to switch, hover to delete. Type `/history` to show or hide it.',
    task: 'Look at this project, change the greeting to hello, seed and run it',
    look: 'Let me look at the folder first.',
    run: 'Run the entry file',
    answer: `This is a very small **Node.js** project:

- \`README.md\`: the description
- \`index.js\`: the entry file, one line of output

| File | Lines |
| --- | ---: |
| README.md | 1 |
| index.js | 1 |

I changed the greeting to \`hello, seed\`. The result:

\`\`\`bash
$ node index.js
hello, seed
\`\`\``,
  },
  ja: {
    locale: 'ja-JP',
    chars: 2,
    typing: 95,
    cjk: 'Noto Sans CJK JP',
    grow: 'このアプリに会話履歴のサイドバーを追加して',
    reasoning: 'アプリ自体に機能を追加したいという依頼なので、拡張機能として書くべきだ。まず拡張機能のガイドを読もう。',
    readDocs: 'まず拡張機能のガイドを読みます。',
    write: 'サイドバーを拡張機能として書きます：',
    grown: 'サイドバーを追加しました。左側にこれまでの会話が並びます。クリックで切り替え、マウスを重ねると削除できます。`/history` で表示・非表示を切り替えられます。',
    task: 'このプロジェクトを見て、あいさつ文を hello, seed に変えて実行して',
    look: 'まずフォルダーを見てみます。',
    run: 'エントリーファイルを実行',
    answer: `とても小さな **Node.js** プロジェクトです：

- \`README.md\`：プロジェクトの説明
- \`index.js\`：エントリーファイル。出力は 1 行だけ

| ファイル | 行数 |
| --- | ---: |
| README.md | 1 |
| index.js | 1 |

あいさつ文を \`hello, seed\` に変更しました。実行結果：

\`\`\`bash
$ node index.js
hello, seed
\`\`\``,
  },
  fr: {
    locale: 'fr-FR',
    chars: 5,
    typing: 42,
    cjk: 'Noto Sans CJK SC',
    grow: "Ajoute une barre latérale d'historique des conversations à cette application",
    reasoning: "L'utilisateur veut une nouvelle fonctionnalité dans l'application elle-même : il faut en faire une extension. Lisons d'abord le guide des extensions.",
    readDocs: 'Je commence par lire le guide des extensions.',
    write: "J'écris la barre latérale sous forme d'extension :",
    grown: "La barre latérale est en place. Elle liste vos conversations passées à gauche : cliquez pour changer de conversation, survolez pour supprimer. Tapez `/history` pour l'afficher ou la masquer.",
    task: 'Regarde ce projet, remplace le message par hello, seed et lance-le',
    look: "Je regarde d'abord le dossier.",
    run: "Lancer le fichier d'entrée",
    answer: `C'est un tout petit projet **Node.js** :

- \`README.md\` : la description
- \`index.js\` : le fichier d'entrée, une seule ligne de sortie

| Fichier | Lignes |
| --- | ---: |
| README.md | 1 |
| index.js | 1 |

J'ai remplacé le message par \`hello, seed\`. Le résultat :

\`\`\`bash
$ node index.js
hello, seed
\`\`\``,
  },
  ru: {
    locale: 'ru-RU',
    chars: 4,
    typing: 42,
    cjk: 'Noto Sans CJK SC',
    grow: 'Добавь в это приложение боковую панель с историей диалогов',
    reasoning: 'Пользователь хочет новую функцию в самом приложении, значит, это должно быть расширение. Сначала прочитаю руководство по расширениям.',
    readDocs: 'Сначала прочитаю руководство по расширениям.',
    write: 'Пишу боковую панель как расширение:',
    grown: 'Боковая панель готова. Слева показаны прошлые диалоги: нажмите, чтобы переключиться, наведите курсор, чтобы удалить. Команда `/history` показывает и скрывает панель.',
    task: 'Посмотри этот проект, замени приветствие на hello, seed и запусти',
    look: 'Сначала посмотрю папку.',
    run: 'Запустить входной файл',
    answer: `Это совсем небольшой проект на **Node.js**:

- \`README.md\`: описание
- \`index.js\`: входной файл, одна строка вывода

| Файл | Строк |
| --- | ---: |
| README.md | 1 |
| index.js | 1 |

Я заменил приветствие на \`hello, seed\`. Результат:

\`\`\`bash
$ node index.js
hello, seed
\`\`\``,
  },
};

// A scripted OpenAI-compatible endpoint that streams like a model would.
async function startPacedModel(script, pace) {
  let index = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'your-model', object: 'model' }] }));
    }
    const n = index++;
    const step = script[n] ?? { text: '…' };
    const wait = (ms) => (pace.fast ? null : sleep(ms));
    const pieces = (text, size) => {
      const all = Array.from(text || '');
      const out = [];
      for (let i = 0; i < all.length; i += size) out.push(all.slice(i, i + size).join(''));
      return out;
    };
    const base = { id: `chatcmpl-${n}`, object: 'chat.completion.chunk', created: 1700000000, model: body.model };
    const delta = (d, finish = null) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    delta({ role: 'assistant', content: '' });
    await wait(450);
    for (const part of pieces(step.reasoning, pace.chars * 2)) (delta({ reasoning_content: part }), await wait(40));
    for (const part of pieces(step.text, pace.chars)) (delta({ content: part }), await wait(40));
    for (const [i, tc] of (step.toolCalls || []).entries()) {
      const args = JSON.stringify(tc.args ?? {});
      const parts = pieces(args, Math.max(1, Math.ceil(args.length / 5)));
      delta({ tool_calls: [{ index: i, id: `call_${n}_${i}`, type: 'function', function: { name: tc.name, arguments: parts[0] || '' } }] });
      for (const part of parts.slice(1)) (await wait(70), delta({ tool_calls: [{ index: i, function: { arguments: part } }] }));
      await wait(260);
    }
    delta({}, step.toolCalls?.length ? 'tool_calls' : 'stop');
    res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve))),
  };
}

// Takes screenshots as fast as the page allows and keeps the ones that differ.
class Recorder {
  constructor(page, dir) {
    Object.assign(this, { page, dir, frames: [], running: false });
  }
  start() {
    this.running = true;
    this.loop = (async () => {
      let last = '';
      while (this.running) {
        const at = Date.now();
        const png = await this.page.screenshot({ type: 'png', caret: 'initial' }).catch(() => null);
        if (!png) break;
        const hash = crypto.createHash('sha1').update(png).digest('hex');
        if (hash !== last) {
          const file = path.join(this.dir, `f${String(this.frames.length).padStart(4, '0')}.png`);
          await fsp.writeFile(file, png);
          this.frames.push({ at, file });
          last = hash;
        }
        await sleep(Math.max(0, 60 - (Date.now() - at)));
      }
    })();
  }
  async stop() {
    this.running = false;
    await this.loop;
    this.end = Date.now();
  }
  // No still moment lasts longer than `maxHold`; the last frame stays for `tail`.
  async gif(file, overlay, { maxHold = 1100, tail = 3200 } = {}) {
    const lines = [];
    this.frames.forEach((f, i) => {
      const next = this.frames[i + 1];
      const ms = next ? Math.min(maxHold, next.at - f.at) : tail;
      lines.push(`file '${f.file}'`, `duration ${(Math.max(20, ms) / 1000).toFixed(3)}`);
    });
    lines.push(`file '${this.frames.at(-1).file}'`);
    const list = path.join(this.dir, 'frames.txt');
    await fsp.writeFile(list, lines.join('\n') + '\n');
    const filter = `[0][1]overlay=format=auto,scale=${GIF_WIDTH}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-i', overlay, '-filter_complex', filter, '-fps_mode', 'vfr', '-loop', '0', file]);
  }
}

// A screenshot of a white app on a white page has no visible edge, so every
// picture gets rounded corners and a thin border. GitHub's page colours:
const FRAME = { light: { border: '#d1d9e0', page: '#ffffff' }, dark: { border: '#3d444d', page: '#0d1117' } };

// A still picture: real transparency outside the rounded corners.
async function framed(browser, png, theme) {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.setContent(
    `<body style="margin:0;background:transparent"><img id="shot" style="display:block;border-radius:12px;border:1px solid ${FRAME[theme].border}" src="data:image/png;base64,${png.toString('base64')}"></body>`,
  );
  const img = page.locator('#shot');
  await img.evaluate((el) => el.decode().then(() => (el.style.width = `${el.naturalWidth / 2}px`)));
  const out = await img.screenshot({ omitBackground: true });
  await page.close();
  return out;
}

// For the animation, whose format has no soft transparency: a picture to lay
// over each frame, see-through in the middle, page-coloured outside the corners.
async function frameOverlay(browser, theme, file) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  const { border, page: matte } = FRAME[theme];
  await page.setContent(
    `<body style="margin:0;background:transparent;overflow:hidden"><div style="position:fixed;inset:0;border-radius:12px;border:1px solid ${border};box-shadow:0 0 0 40px ${matte}"></div></body>`,
  );
  await page.screenshot({ path: file, omitBackground: true });
  await page.close();
}

async function capture(lang, theme, { demo = true } = {}) {
  const t = TEXT[lang];
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'seed-media-'));
  const home = path.join(tmp, 'home');
  const work = path.join(tmp, 'my-project');
  const framesDir = path.join(tmp, 'frames');
  for (const dir of [home, work, framesDir]) await fsp.mkdir(dir);
  await fsp.writeFile(path.join(work, 'README.md'), '# My project\n');
  await fsp.writeFile(path.join(work, 'index.js'), 'console.log("hello");\n');
  const extension = path.join(home, 'extensions', 'history-sidebar');

  const pace = { fast: !demo, chars: t.chars };
  const model = await startPacedModel(
    [
      { reasoning: t.reasoning, text: t.readDocs, toolCalls: [{ name: 'read_file', args: { path: path.join(APP_DIR, 'docs', 'EXTENDING.md'), limit: 60 } }] },
      { text: t.write, toolCalls: ['extension.json', 'client.js', 'style.css'].map((f) => ({ name: 'write_file', args: { path: `${extension}/${f}`, content: example(`history-sidebar/${f}`) } })) },
      { toolCalls: [{ name: 'reload_extensions', args: {} }] },
      { toolCalls: [{ name: 'ui_eval', args: { code: 'return { sidebar: !!document.querySelector("#history-sidebar"), items: document.querySelectorAll("#history-sidebar .seed-item").length }' } }] },
      { text: t.grown },
      { text: t.look, toolCalls: [{ name: 'list_dir', args: {} }, { name: 'read_file', args: { path: 'index.js' } }] },
      { toolCalls: [{ name: 'edit_file', args: { path: 'index.js', old_string: 'console.log("hello");', new_string: 'console.log("hello, seed");' } }] },
      { toolCalls: [{ name: 'shell', args: { command: 'node index.js', description: t.run } }] },
      { text: t.answer },
    ],
    pace,
  );
  await fsp.writeFile(
    path.join(home, 'config.json'),
    JSON.stringify({ providers: { demo: { type: 'openai', name: 'Demo', baseURL: model.url, apiKey: 'k' } }, model: 'demo/your-model', approval: 'ask' }),
  );

  const app = new App({ home, cwd: work, detectEnv: false, overrides: { server: { port: 0 } } });
  await app.init();
  const address = await app.listen();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2, locale: t.locale, colorScheme: theme });
  const name = (kind, ext) => path.join(OUT, `${kind}-${lang}-${theme}.${ext}`);
  const shot = async (kind) => {
    await page.waitForFunction(() => !document.querySelector('#toasts .toast'), null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(300);
    await fsp.writeFile(name(kind, 'png'), await framed(browser, await page.screenshot(), theme));
  };
  const state = () => page.evaluate(() => ({ busy: !!document.querySelector('.send-button.stop'), ask: !!document.querySelector('.approval:not([hidden])') }));

  try {
    await page.goto(address.urlWithToken);
    await page.waitForSelector('#hint .status');
    // The same fonts in every picture: Inter for Latin and Cyrillic text, Noto for Chinese and Japanese.
    await page.addStyleTag({ content: `:root { --font: Inter, "${t.cjk}", sans-serif !important; }` });
    await page.evaluate(() => document.fonts.ready);

    // The demo: one sentence, and the app grows a sidebar.
    const recorder = new Recorder(page, framesDir);
    if (demo) {
      await page.waitForTimeout(400);
      recorder.start();
      await page.waitForTimeout(1300);
      await page.locator('#input').pressSequentially(t.grow, { delay: t.typing });
      await page.waitForTimeout(550);
    } else {
      await page.fill('#input', t.grow);
    }
    await page.keyboard.press('Enter');
    await page.waitForSelector('.send-button.stop');
    for (;;) {
      const s = await state();
      if (s.ask) {
        const allow = page.locator('.approval:not([hidden]) .seed-btn:nth-child(2)');
        if (demo) (await page.waitForTimeout(1500), await allow.hover(), await page.waitForTimeout(450));
        await allow.click();
        await page.mouse.move(VIEWPORT.width / 2, 40);
      } else if (!s.busy) break;
      await page.waitForTimeout(60);
    }
    await page.waitForSelector('#history-sidebar .seed-item');
    if (demo) {
      await page.waitForTimeout(700);
      await recorder.stop();
      const overlay = path.join(framesDir, 'overlay.png');
      await frameOverlay(browser, theme, overlay);
      await recorder.gif(name('demo', 'gif'), overlay);
    }

    // An ordinary coding task, for the two screenshots.
    pace.fast = true;
    await page.click('#new-chat');
    await page.waitForSelector('#app[data-view="home"]');
    await page.fill('#input', t.task);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.approval:not([hidden]) .diff-line');
    await shot('approval');
    await page.click('.approval:not([hidden]) .seed-btn.primary');
    await page.waitForFunction(() => document.querySelector('.approval:not([hidden]) pre')?.textContent.includes('node index.js'));
    await page.click('.approval:not([hidden]) .seed-btn.primary');
    await page.waitForSelector('.md table');
    await page.waitForFunction(() => !document.querySelector('.send-button.stop'));
    await page.setViewportSize({ width: VIEWPORT.width, height: 800 });
    await shot('chat');
    console.log(`  ✓ ${lang} ${theme}`);
  } finally {
    await browser.close();
    await app.close();
    await model.close();
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

// Badges and buttons are small SVG files, so the READMEs need no outside image
// service. Text widths are measured here and fixed with textLength, so they fit
// with whatever font the reader's system has.
async function badges() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const width = (text, font) =>
    page.evaluate(
      ([s, f]) => {
        const c = document.createElement('canvas').getContext('2d');
        c.font = f;
        return Math.ceil(c.measureText(s).width);
      },
      [text, font],
    );
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const sans = `-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif`;

  const badge = async (file, label, message, color = '#1f8a4c') => {
    const font = '600 11px "Liberation Sans", Arial, sans-serif';
    const lw = await width(label, font);
    const mw = await width(message, font);
    const a = lw + 16;
    const b = mw + 16;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${a + b}" height="20" role="img" aria-label="${esc(label)}: ${esc(message)}">
  <title>${esc(label)}: ${esc(message)}</title>
  <clipPath id="r"><rect width="${a + b}" height="20" rx="5"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${a}" height="20" fill="#3d444d"/>
    <rect x="${a}" width="${b}" height="20" fill="${color}"/>
  </g>
  <g fill="#fff" font-family="${sans}" font-size="11" font-weight="600" text-anchor="middle">
    <text x="${a / 2}" y="14" textLength="${lw}" lengthAdjust="spacingAndGlyphs">${esc(label)}</text>
    <text x="${a + b / 2}" y="14" textLength="${mw}" lengthAdjust="spacingAndGlyphs">${esc(message)}</text>
  </g>
</svg>
`;
    await fsp.writeFile(path.join(OUT, file), svg);
  };

  const button = async (file, title, kind) => {
    const tf = '600 16px "Liberation Sans", Arial, sans-serif';
    const kf = '500 12px "Liberation Sans", Arial, sans-serif';
    const tw = await width(title, tf);
    const kw = await width(kind, kf);
    const w = 20 + 18 + 10 + tw + 10 + kw + 20;
    const id = file.replace(/\W/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="46" role="img" aria-label="${esc(title)} ${esc(kind)}">
  <title>${esc(title)} ${esc(kind)}</title>
  <defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#238f50"/>
      <stop offset="1" stop-color="#1a6e3d"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="46" rx="11" fill="url(#${id})"/>
  <rect x="0.5" y="0.5" width="${w - 1}" height="45" rx="10.5" fill="none" stroke="#fff" stroke-opacity="0.14"/>
  <g transform="translate(20 14)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 1v11M4.5 7.5 9 12l4.5-4.5M2 16.5h14"/>
  </g>
  <g fill="#fff" font-family="${sans}">
    <text x="48" y="28.5" font-size="16" font-weight="600" textLength="${tw}" lengthAdjust="spacingAndGlyphs">${esc(title)}</text>
    <text x="${48 + tw + 10}" y="28" font-size="12" font-weight="500" fill-opacity="0.72" textLength="${kw}" lengthAdjust="spacingAndGlyphs">${esc(kind)}</text>
  </g>
</svg>
`;
    await fsp.writeFile(path.join(OUT, file), svg);
  };

  await badge('badge-platform.svg', 'platform', 'macOS · Windows · Linux');
  await badge('badge-models.svg', 'models', 'DeepSeek · OpenAI · Claude · Ollama · …', '#2f6fbd');
  await badge('badge-api.svg', 'API', 'REST · OpenAI-compatible', '#8250df');
  await button('download-macos-arm64.svg', 'macOS', 'Apple silicon');
  await button('download-macos-x64.svg', 'macOS', 'Intel');
  await button('download-windows.svg', 'Windows', '.exe');
  await button('download-linux.svg', 'Linux', '.AppImage');
  await browser.close();
  console.log('  ✓ badges and buttons');
}

await fsp.mkdir(OUT, { recursive: true });
if (!only || only === 'badges') await badges();
for (const lang of Object.keys(TEXT)) {
  for (const theme of ['light', 'dark']) {
    if (only && only !== `${lang}-${theme}`) continue;
    await capture(lang, theme, { demo: !process.argv.includes('--no-demo') });
  }
}
