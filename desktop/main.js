// Seed desktop app: starts the Seed server inside the app and shows its web UI
// in a window. Everything else (the agent, the API, extensions) is the same
// code the command line runs. Data lives in ~/.seed (or $SEED_HOME), shared
// with the command line.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, Menu, app as electron, clipboard, dialog, ipcMain, nativeTheme, session, shell } from 'electron';
import { App } from '../src/app.js';
import { APP_DIR, VERSION } from '../src/util.js';

const IS_MAC = process.platform === 'darwin';
// Menu and dialog text follows the system language: Chinese, English, Japanese,
// French or Russian; any other language gets English.
const language = () => String(electron.getLocale() || '').slice(0, 2).toLowerCase();
const tr = (chinese, english, others) => (language() === 'zh' ? chinese : others?.[language()] ?? english);

let seed = null; // the Seed app
let address = null; // { url, urlWithToken, port }
let win = null;
let quitting = false;

/**
 * Apps opened from the Finder or the Dock get a minimal PATH (/usr/bin:/bin:...),
 * without Homebrew, nvm, pyenv and the like. The agent's commands need the
 * user's real PATH, so ask their login shell for it once at start-up.
 */
function loadLoginShellPath() {
  if (process.platform === 'win32') return;
  const shellPath = process.env.SHELL || (IS_MAC ? '/bin/zsh' : '/bin/bash');
  try {
    const out = spawnSync(shellPath, ['-ilc', 'printf "__SEED_PATH__%s__SEED_PATH__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 8000,
      env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' },
    }).stdout;
    const found = /__SEED_PATH__(.*?)__SEED_PATH__/s.exec(out || '')?.[1];
    if (found) process.env.PATH = found;
  } catch {
    /* keep the PATH we have */
  }
}

/**
 * Send the agent's HTTP requests (model APIs, fetch_url) through Chromium's
 * network stack, which follows the operating system's proxy settings, so a
 * proxy set in the system (or by a proxy tool) just works. An HTTPS_PROXY
 * environment variable still wins when it is set.
 */
function useSystemNetwork() {
  const net = session.fromPartition('seed-network'); // no cookies shared with the window
  const proxy = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'].map((k) => process.env[k]).find(Boolean);
  if (proxy) net.setProxy({ proxyRules: proxy, proxyBypassRules: process.env.NO_PROXY || process.env.no_proxy || '<local>' });
  const nodeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    return /^https?:/i.test(url || '') ? net.fetch(input, init) : nodeFetch(input, init);
  };
}

async function startServer() {
  // No workspace is given: new conversations use the saved default folder, or the home folder.
  seed = new App({});
  await seed.init();
  seed.guardProcess();
  address = await seed.listen();
}

const runInPage = (code) => win?.webContents.executeJavaScript(code).catch(() => {});
const toast = (text) => runInPage(`window.seed && window.seed.ui.toast(${JSON.stringify(text)})`);

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 420,
    minHeight: 480,
    title: 'Seed',
    show: false,
    autoHideMenuBar: !IS_MAC,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1210' : '#ffffff',
    icon: process.platform === 'linux' ? path.join(APP_DIR, 'build', 'icon-win.png') : undefined,
    // macOS: no title bar; the traffic lights sit over the page, which leaves room for them.
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
    },
  });
  win.once('ready-to-show', () => win.show());

  const origin = new URL(address.url).origin;
  const external = (url) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
  };
  // Links in answers open in the user's browser; the window only ever shows Seed.
  win.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) {
      event.preventDefault();
      external(url);
    }
  });
  win.on('closed', () => {
    win = null;
  });
  win.loadURL(address.urlWithToken);
}

async function pickFolder(defaultPath) {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: tr('选择工作目录', 'Choose the workspace folder', { ja: '作業フォルダーを選択', fr: 'Choisir le dossier de travail', ru: 'Выберите рабочую папку' }),
    defaultPath: defaultPath || seed.cwd,
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled || !filePaths[0] ? null : filePaths[0];
}

// The page asks for the folder picker (the workspace label under the input bar).
ipcMain.handle('seed:choose-folder', (event, defaultPath) => {
  if (!address || new URL(event.senderFrame?.url || 'about:blank').origin !== new URL(address.url).origin) return null;
  return pickFolder(defaultPath);
});

async function openFolder() {
  const folder = await pickFolder();
  if (!folder) return;
  const filePaths = [folder];
  await seed.config.update({ workspace: filePaths[0] });
  await runInPage(`location.hash = '#/'`);
  toast(tr(`新对话将在 ${filePaths[0]} 中进行`, `New conversations will work in ${filePaths[0]}`, {
      ja: `新しい会話は ${filePaths[0]} で作業します`,
      fr: `Les nouvelles conversations travailleront dans ${filePaths[0]}`,
      ru: `Новые диалоги будут работать в ${filePaths[0]}`,
    }));
}

function copyApiInfo() {
  const token = seed.config.server.token;
  clipboard.writeText(
    [
      `API: ${address.url}/api`,
      `OpenAI-compatible base URL: ${address.url}/v1`,
      `API key / access token: ${token}`,
      `Model: seed`,
    ].join('\n'),
  );
  toast(tr('已复制 API 地址和访问令牌', 'Copied the API address and access token', { ja: 'API アドレスとアクセストークンをコピーしました', fr: "Adresse de l'API et jeton d'accès copiés", ru: 'Адрес API и токен доступа скопированы' }));
}

function buildMenu() {
  const template = [
    ...(IS_MAC ? [{ role: 'appMenu' }] : []),
    {
      label: tr('文件', 'File', { ja: 'ファイル', fr: 'Fichier', ru: 'Файл' }),
      submenu: [
        { label: tr('新对话', 'New Conversation', { ja: '新しい会話', fr: 'Nouvelle conversation', ru: 'Новый диалог' }), accelerator: 'CmdOrCtrl+N', click: () => runInPage(`location.hash = '#/'`) },
        { label: tr('选择工作目录…', 'Open Folder…', { ja: '作業フォルダーを選択…', fr: 'Ouvrir un dossier…', ru: 'Открыть папку…' }), accelerator: 'CmdOrCtrl+O', click: () => openFolder() },
        { type: 'separator' },
        { label: tr('复制 API 接入信息', 'Copy API Connection Info', { ja: 'API 接続情報をコピー', fr: "Copier les informations de connexion à l'API", ru: 'Скопировать данные для подключения к API' }), click: copyApiInfo },
        { label: tr('打开数据文件夹', 'Open Data Folder', { ja: 'データフォルダーを開く', fr: 'Ouvrir le dossier des données', ru: 'Открыть папку с данными' }), click: () => shell.openPath(seed.home) },
        { type: 'separator' },
        IS_MAC ? { role: 'close' } : { role: 'quit', label: tr('退出', 'Quit', { ja: '終了', fr: 'Quitter', ru: 'Выйти' }) },
      ],
    },
    { role: 'editMenu', label: tr('编辑', 'Edit', { ja: '編集', fr: 'Édition', ru: 'Правка' }) },
    {
      label: tr('视图', 'View', { ja: '表示', fr: 'Affichage', ru: 'Вид' }),
      submenu: [
        { role: 'reload', label: tr('重新载入', 'Reload', { ja: '再読み込み', fr: 'Recharger', ru: 'Перезагрузить' }) },
        {
          label: tr('安全模式（不加载界面扩展）', 'Safe Mode (no UI extensions)', { ja: 'セーフモード（UI 拡張機能を読み込まない）', fr: "Mode sans échec (sans extensions d'interface)", ru: 'Безопасный режим (без расширений интерфейса)' }),
          click: () => win?.loadURL(`${address.url}/?safe=1`),
        },
        { role: 'toggleDevTools', label: tr('开发者工具', 'Developer Tools', { ja: '開発者ツール', fr: 'Outils de développement', ru: 'Инструменты разработчика' }) },
        { type: 'separator' },
        { role: 'resetZoom', label: tr('实际大小', 'Actual Size', { ja: '実際のサイズ', fr: 'Taille réelle', ru: 'Реальный размер' }) },
        { role: 'zoomIn', label: tr('放大', 'Zoom In', { ja: '拡大', fr: 'Zoom avant', ru: 'Увеличить' }) },
        { role: 'zoomOut', label: tr('缩小', 'Zoom Out', { ja: '縮小', fr: 'Zoom arrière', ru: 'Уменьшить' }) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: tr('全屏', 'Full Screen', { ja: 'フルスクリーン', fr: 'Plein écran', ru: 'Полноэкранный режим' }) },
      ],
    },
    ...(IS_MAC ? [{ role: 'windowMenu' }] : []),
    {
      role: 'help',
      label: tr('帮助', 'Help', { ja: 'ヘルプ', fr: 'Aide', ru: 'Справка' }),
      submenu: [
        { label: tr('打开说明文档文件夹', 'Open the Documentation Folder', { ja: 'ドキュメントのフォルダーを開く', fr: 'Ouvrir le dossier de la documentation', ru: 'Открыть папку с документацией' }), click: () => shell.openPath(path.join(APP_DIR, 'docs')) },
        { label: tr('打开示例扩展文件夹', 'Open the Example Extensions Folder', { ja: 'サンプル拡張機能のフォルダーを開く', fr: "Ouvrir le dossier des exemples d'extensions", ru: 'Открыть папку с примерами расширений' }), click: () => shell.openPath(path.join(APP_DIR, 'examples', 'extensions')) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function main() {
  if (!electron.requestSingleInstanceLock()) {
    electron.quit();
    return;
  }
  electron.on('second-instance', () => {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  electron.setAboutPanelOptions({ applicationName: 'Seed', applicationVersion: VERSION });
  loadLoginShellPath();
  await electron.whenReady();
  useSystemNetwork();
  try {
    await startServer();
  } catch (err) {
    dialog.showErrorBox(tr('Seed 无法启动', 'Seed could not start', { ja: 'Seed を起動できませんでした', fr: "Seed n'a pas pu démarrer", ru: 'Не удалось запустить Seed' }), String(err?.stack || err));
    electron.exit(1);
    return;
  }
  buildMenu();
  createWindow();

  electron.on('activate', () => {
    if (!win) createWindow();
  });
  // On macOS the app (and its API) keeps running without a window, as Mac apps do.
  electron.on('window-all-closed', () => {
    if (!IS_MAC) electron.quit();
  });
  electron.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    const timer = setTimeout(() => electron.exit(0), 4000);
    seed
      .close()
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        electron.exit(0);
      });
  });
}

main();
