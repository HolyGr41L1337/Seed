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
const zh = () => /^zh/i.test(electron.getLocale() || '');
const tr = (chinese, english) => (zh() ? chinese : english);

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
    title: tr('选择工作目录', 'Choose the workspace folder'),
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
  toast(tr(`新对话将在 ${filePaths[0]} 中进行`, `New conversations will work in ${filePaths[0]}`));
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
  toast(tr('已复制 API 地址和访问令牌', 'Copied the API address and access token'));
}

function buildMenu() {
  const template = [
    ...(IS_MAC ? [{ role: 'appMenu' }] : []),
    {
      label: tr('文件', 'File'),
      submenu: [
        { label: tr('新对话', 'New Conversation'), accelerator: 'CmdOrCtrl+N', click: () => runInPage(`location.hash = '#/'`) },
        { label: tr('选择工作目录…', 'Open Folder…'), accelerator: 'CmdOrCtrl+O', click: () => openFolder() },
        { type: 'separator' },
        { label: tr('复制 API 接入信息', 'Copy API Connection Info'), click: copyApiInfo },
        { label: tr('打开数据文件夹', 'Open Data Folder'), click: () => shell.openPath(seed.home) },
        { type: 'separator' },
        IS_MAC ? { role: 'close' } : { role: 'quit', label: tr('退出', 'Quit') },
      ],
    },
    { role: 'editMenu', label: tr('编辑', 'Edit') },
    {
      label: tr('视图', 'View'),
      submenu: [
        { role: 'reload', label: tr('重新载入', 'Reload') },
        {
          label: tr('安全模式（不加载界面扩展）', 'Safe Mode (no UI extensions)'),
          click: () => win?.loadURL(`${address.url}/?safe=1`),
        },
        { role: 'toggleDevTools', label: tr('开发者工具', 'Developer Tools') },
        { type: 'separator' },
        { role: 'resetZoom', label: tr('实际大小', 'Actual Size') },
        { role: 'zoomIn', label: tr('放大', 'Zoom In') },
        { role: 'zoomOut', label: tr('缩小', 'Zoom Out') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: tr('全屏', 'Full Screen') },
      ],
    },
    ...(IS_MAC ? [{ role: 'windowMenu' }] : []),
    {
      role: 'help',
      label: tr('帮助', 'Help'),
      submenu: [
        { label: tr('打开说明文档文件夹', 'Open the Documentation Folder'), click: () => shell.openPath(path.join(APP_DIR, 'docs')) },
        { label: tr('打开示例扩展文件夹', 'Open the Example Extensions Folder'), click: () => shell.openPath(path.join(APP_DIR, 'examples', 'extensions')) },
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
    dialog.showErrorBox(tr('Seed 无法启动', 'Seed could not start'), String(err?.stack || err));
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
