// Application entry: sign-in, routing, live events, sending messages and the
// built-in slash commands.
import { api, connectEvents, storedToken, useToken } from './api.js';
import { composer } from './composer.js';
import { connectCard } from './connect.js';
import { clear, h, icon } from './dom.js';
import { actions, beforeSendHooks, loadExtensions, makeSeed, runEval, views } from './extensions.js';
import { lang, t } from './i18n.js';
import { emit, setState, state } from './state.js';
import { thread } from './thread.js';
import { confirmDialog, modal, toast } from './ui.js';

const appEl = document.getElementById('app');
const pageEl = document.getElementById('page');
const threadEl = document.getElementById('thread');
const hintEl = document.getElementById('hint');
const connectEl = document.getElementById('connect');

let opening = false; // a conversation snapshot is being fetched
let buffered = []; // events that arrived meanwhile
let pendingText = null; // message typed before a model API was connected
let nextCwd = null; // workspace chosen with /cd before the conversation exists
let example = null;
let pageCleanup = null;
let connected = false; // the event stream has been open at least once

const isConnected = () => Object.keys(state.config?.providers || {}).length > 0;

function shortPath(dir) {
  if (!dir) return '';
  const home = state.info?.homeDir;
  let shown = home && (dir === home || dir.startsWith(`${home}/`)) ? `~${dir.slice(home.length)}` : dir;
  if (shown.length > 42) shown = `…${shown.slice(-40)}`;
  return shown;
}

function folderName(dir) {
  const home = state.info?.homeDir;
  if (home && dir === home) return '~';
  return dir.split(/[\\/]/).filter(Boolean).pop() || dir;
}

/**
 * Change the workspace. The desktop app opens the system folder picker; in a
 * browser the /cd command is put into the input bar.
 */
async function chooseFolder() {
  const current = state.conversation?.cwd || nextCwd || state.info?.cwd;
  if (!window.seedDesktop?.chooseFolder) {
    composer.setText('/cd ');
    composer.focus();
    return;
  }
  const folder = await window.seedDesktop.chooseFolder(current);
  if (!folder) return;
  try {
    if (state.view === 'chat' && state.conversationId) {
      const conv = await api.patch(`/api/conversations/${state.conversationId}`, { cwd: folder });
      toast(t('cwdSet', conv.cwd));
    } else {
      await api.patch('/api/config', { workspace: folder }); // the default for new conversations
      nextCwd = null;
      toast(t('cwdSet', folder));
    }
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
}

// ---- chrome: placeholder, hint line, connect card -----------------------------------

function renderChrome() {
  appEl.dataset.view = state.view;
  document.getElementById('tagline').textContent = t('tagline');
  composer.showNewButton(state.view === 'chat');
  composer.setRunning(state.running);
  composer.setPlaceholder(!isConnected() ? t('placeholderConnect') : state.view === 'chat' ? t('placeholderChat') : t('placeholderHome'));

  clear(hintEl);
  if (state.view === 'home' && isConnected()) {
    example ||= t('examples')[Math.floor(Math.random() * t('examples').length)];
    hintEl.append(
      h('span', { class: 'try' }, t('try'), h('button', { type: 'button', onclick: () => (composer.setText(example), composer.focus()) }, `"${example}"`)),
    );
  }
  const conv = state.conversation;
  const model = conv?.model || state.config?.model;
  const mode = conv?.approval || state.config?.approval || 'ask';
  const cwd = conv?.cwd || nextCwd || state.info?.cwd;
  // Small labels for the model, the workspace and the approval mode; each one opens its setting.
  const chip = (iconName, label, title, onclick, warn = false) =>
    h('button', { type: 'button', class: `chip${warn ? ' warn' : ''}`, title, onclick }, icon(iconName, 14), h('span', label));
  const status = h('span', { class: 'status' });
  status.append(
    chip('chip', model ? model.split('/').slice(1).join('/') || model : t(isConnected() ? 'pickModel' : 'noModel'), model ? `${t('chipModel')}: ${model}` : '', () => modelCommand(''), !model),
  );
  if (cwd) status.append(chip('folder', folderName(cwd), `${t('workspace')}: ${cwd}`, () => chooseFolder()));
  status.append(chip('shield', t(`mode_${mode}`), t('commands.mode'), () => modeCommand(''), mode === 'full'));
  if (state.safeMode) status.append(h('span', { class: 'chip warn' }, t('safeMode')));
  hintEl.append(status);

  if (state.view === 'home' && !isConnected() && connectEl.hidden) showConnect();
  if (isConnected() && !connectEl.dataset.manual) hideConnect();
}

async function showConnect({ manual = false } = {}) {
  if (state.view !== 'home') {
    // In a conversation the card opens as a dialog.
    let dialog;
    const card = await connectCard({ onDone: (r) => (dialog.close(), onConnected(r)), onCancel: () => dialog.close() });
    dialog = modal({ title: '', content: card, width: 600 });
    card.style.border = '0';
    card.style.padding = '0';
    card.style.background = 'none';
    return;
  }
  connectEl.hidden = false;
  if (manual) connectEl.dataset.manual = '1';
  const card = await connectCard({ onDone: onConnected, onCancel: isConnected() ? hideConnect : null });
  connectEl.replaceChildren(card);
}

function hideConnect() {
  connectEl.hidden = true;
  delete connectEl.dataset.manual;
  clear(connectEl);
}

async function onConnected(result) {
  setState({ config: result.config });
  hideConnect();
  renderChrome();
  toast(t('connected', result.name, result.model?.split('/').slice(1).join('/') || ''));
  composer.focus();
  if (pendingText) {
    const text = pendingText;
    pendingText = null;
    await send(text);
  }
}

// ---- routing ---------------------------------------------------------------------------

function closePage() {
  if (pageCleanup) {
    try {
      pageCleanup();
    } catch (err) {
      console.error(err);
    }
    pageCleanup = null;
  }
  clear(pageEl);
  pageEl.hidden = true;
  threadEl.hidden = false;
}

function goHome() {
  closePage();
  thread.clear();
  setState({ view: 'home', conversationId: null, conversation: null, running: false, page: null });
  document.title = 'Seed';
  renderChrome();
  api.post('/api/client/view', { conversationId: null }).catch(() => {});
  composer.focus();
}

async function openConversation(id) {
  closePage();
  opening = true;
  buffered = [];
  setState({ view: 'chat', conversationId: id, conversation: null, running: false, page: null });
  renderChrome();
  let conv;
  try {
    conv = await api.get(`/api/conversations/${id}`);
  } catch (err) {
    opening = false;
    if (state.conversationId !== id) return;
    toast(err.status === 404 ? t('conversationMissing') : err.message, { type: 'error' });
    location.hash = '#/';
    return;
  }
  if (state.conversationId !== id) return; // the user moved on while loading
  setState({ conversation: conv, running: !!conv.run });
  thread.show(conv);
  opening = false;
  for (const event of buffered) if (event.seq > conv.seq) applyEvent(event);
  buffered = [];
  document.title = conv.title ? `${conv.title} · Seed` : 'Seed';
  renderChrome();
  api.post('/api/client/view', { conversationId: id }).catch(() => {});
  emit('conversation.opened', conv);
}

function openPage(name, param) {
  const view = views.get(name);
  closePage();
  setState({ view: 'page', page: name, conversationId: null, conversation: null, running: false });
  renderChrome();
  threadEl.hidden = true;
  pageEl.hidden = false;
  if (!view) {
    pageEl.append(h('p', { class: 'seed-muted' }, `${t('loadFailed')}: #/x/${name}`));
    return;
  }
  document.title = view.title ? `${view.title} · Seed` : 'Seed';
  try {
    const cleanup = view.render(pageEl, param ? decodeURIComponent(param) : undefined);
    if (typeof cleanup === 'function') pageCleanup = cleanup;
  } catch (err) {
    pageEl.append(h('p', { class: 'seed-muted' }, `${t('loadFailed')}: ${err.message}`));
    setTimeout(() => {
      throw err;
    });
  }
}

async function route() {
  const hash = location.hash || '#/';
  emit('route', { hash });
  let m;
  if ((m = /^#\/c\/([\w-]+)$/.exec(hash))) {
    if (state.view === 'chat' && state.conversationId === m[1]) return;
    return openConversation(m[1]);
  }
  if ((m = /^#\/x\/([\w-]+)(?:\/(.*))?$/.exec(hash))) return openPage(m[1], m[2]);
  return goHome();
}

// ---- live events -------------------------------------------------------------------------

function applyEvent(e) {
  const conv = state.conversation;
  if (conv) {
    if (e.type === 'message.added' || e.type === 'message.completed') conv.messages.push(e.message);
    if (e.type === 'conversation.updated') {
      Object.assign(conv, e.conversation);
      document.title = conv.title ? `${conv.title} · Seed` : 'Seed';
    }
  }
  if (e.type === 'run.started') setState({ running: true });
  if (e.type === 'run.completed') setState({ running: false });
  thread.handle(e);
  if (e.type === 'run.started' || e.type === 'run.completed' || e.type === 'conversation.updated') renderChrome();
}

function handleEvent(e) {
  if (e.type === 'hello') {
    // After a reconnect, events may have been missed: load the conversation again.
    if (connected && state.view === 'chat' && state.conversationId) openConversation(state.conversationId);
    connected = true;
    return;
  }
  if (e.type === 'ui.eval') return void runEval(e);
  if (e.type === 'config.changed') {
    setState({ config: e.config });
    renderChrome();
    // The default workspace can change with the settings (the desktop app's "Open Folder").
    api.get('/api/info').then((info) => (setState({ info }), renderChrome())).catch(() => {});
  } else if (e.type === 'extensions.changed') {
    loadExtensions();
  } else if (e.type === 'conversation.deleted' && e.conversationId === state.conversationId) {
    location.hash = '#/';
  }
  if (e.conversationId && e.conversationId === state.conversationId) {
    if (opening) buffered.push(e);
    else applyEvent(e);
  }
  emit(e.type, e);
  emit('*', e);
}

// ---- sending -----------------------------------------------------------------------------

async function send(content) {
  if (!isConnected()) {
    pendingText = typeof content === 'string' ? content : null;
    composer.setText('');
    await showConnect();
    return;
  }
  for (const hook of beforeSendHooks) {
    const changed = await hook(content);
    if (changed === false) return;
    if (changed !== undefined && changed !== null) content = changed;
  }
  const draft = typeof content === 'string' ? content : '';
  composer.setText('');
  try {
    let id = state.view === 'chat' ? state.conversationId : null;
    if (!id) {
      const conv = await api.post('/api/conversations', nextCwd ? { cwd: nextCwd } : {});
      nextCwd = null;
      id = conv.id;
      history.pushState(null, '', `#/c/${id}`);
      await openConversation(id);
    }
    emit('send', { conversationId: id, content });
    await api.post(`/api/conversations/${id}/messages`, { content });
  } catch (err) {
    toast(err.message, { type: 'error' });
    if (draft && !composer.getText()) composer.setText(draft);
  }
}

function stop() {
  if (state.conversationId) api.post(`/api/conversations/${state.conversationId}/cancel`).catch((err) => toast(err.message, { type: 'error' }));
}

// ---- slash commands --------------------------------------------------------------------------

function row(label, ...right) {
  return h('div', { class: 'row' }, h('span', { class: 'grow', title: typeof label === 'string' ? label : '' }, label), right);
}

async function chooseModel(ref) {
  await api.patch('/api/config', { model: ref });
  if (state.view === 'chat' && state.conversationId) await api.patch(`/api/conversations/${state.conversationId}`, { model: ref });
  toast(t('modelSet', ref));
}

/**
 * A list to choose one item from: the current one is marked, every row is
 * clickable, and long lists get a search box (OpenRouter lists hundreds of models).
 * items: [{ label, sub?, value, current?, group? }]
 */
function picker(items, onPick, { searchPlaceholder } = {}) {
  const list = h('div', { class: 'picker-list', role: 'listbox' });
  const search = items.length > 8 ? h('input', { class: 'seed-input picker-search', type: 'search', placeholder: searchPlaceholder || '', spellcheck: 'false' }) : null;
  const draw = () => {
    const q = (search?.value || '').trim().toLowerCase();
    clear(list);
    let group = null;
    let shown = 0;
    for (const item of items) {
      if (q && !`${item.label} ${item.sub || ''} ${item.group || ''}`.toLowerCase().includes(q)) continue;
      if (item.group && item.group !== group) {
        group = item.group;
        list.append(h('div', { class: 'picker-group' }, group));
      }
      shown++;
      list.append(
        h(
          'button',
          { type: 'button', class: `picker-item${item.current ? ' current' : ''}`, role: 'option', 'aria-selected': String(!!item.current), onclick: () => onPick(item) },
          h('span', { class: 'picker-check' }, item.current ? icon('check', 15) : null),
          h('span', { class: 'picker-text' }, h('span', { class: 'picker-label' }, item.label), item.sub ? h('span', { class: 'picker-sub' }, item.sub) : null),
        ),
      );
    }
    if (!shown) list.append(h('div', { class: 'picker-empty seed-muted' }, '—'));
  };
  search?.addEventListener('input', draw);
  search?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') list.querySelector('.picker-item')?.click();
  });
  draw();
  if (search) setTimeout(() => search.focus(), 0);
  return h('div', { class: 'picker' }, search, list);
}

async function modelCommand(arg) {
  if (arg) {
    try {
      await chooseModel(arg);
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
    return;
  }
  if (!isConnected()) return showConnect({ manual: true });
  const body = h('div', h('p', { class: 'seed-muted' }, '…'));
  let dialog;
  const connectMore = h('button', { type: 'button', class: 'link-button picker-footer', onclick: () => (dialog.close(), showConnect({ manual: true })) }, `+ ${t('connectAnother')}`);
  dialog = modal({ title: t('modelsTitle'), content: body, width: 560 });
  try {
    const data = await api.get('/api/models');
    const current = state.conversation?.model || data.current;
    const items = [];
    for (const provider of data.providers) {
      for (const m of provider.models) {
        items.push({ label: m.id, sub: m.name !== m.id ? m.name : '', value: m.ref, current: m.ref === current, group: provider.name });
      }
    }
    // The model in use may not be in the list the API returns.
    if (current && !items.some((i) => i.value === current)) {
      const provider = data.providers.find((p) => current.startsWith(`${p.id}/`));
      items.unshift({ label: current.split('/').slice(1).join('/'), value: current, current: true, group: provider?.name || '' });
    }
    clear(body).append(
      ...data.providers.filter((p) => p.error).map((p) => h('div', { class: 'connect-error', style: { marginBottom: '8px' } }, `${p.name}: ${p.error}`)),
      picker(
        items,
        async (item) => {
          if (item.current) return dialog.close();
          try {
            await chooseModel(item.value);
            dialog.close();
          } catch (err) {
            toast(err.message, { type: 'error' });
          }
        },
        { searchPlaceholder: t('searchModels') },
      ),
      connectMore,
    );
  } catch (err) {
    clear(body).append(h('div', { class: 'connect-error' }, err.message), connectMore);
  }
}

async function modeCommand(arg) {
  const modes = ['ask', 'auto-edit', 'full'];
  const set = async (mode) => {
    await api.patch('/api/config', { approval: mode });
    if (state.conversation?.approval) await api.patch(`/api/conversations/${state.conversationId}`, { approval: null });
    toast(t('modeSet', t(`mode_${mode}`)));
  };
  if (arg) {
    if (!modes.includes(arg)) return void toast(t('modeUsage'), { type: 'error' });
    return set(arg).catch((err) => toast(err.message, { type: 'error' }));
  }
  const current = state.conversation?.approval || state.config.approval;
  let dialog;
  const list = picker(
    modes.map((mode) => ({ label: t(`mode_${mode}`), sub: t(`modeDesc_${mode}`), value: mode, current: mode === current })),
    (item) => (item.current ? dialog.close() : set(item.value).then(() => dialog.close(), (err) => toast(err.message, { type: 'error' }))),
  );
  dialog = modal({ title: t('modeTitle'), content: list, width: 520 });
}

async function cdCommand(arg) {
  if (!arg) return void toast(t('cdUsage'), { type: 'error' });
  try {
    if (state.view === 'chat' && state.conversationId) {
      const conv = await api.patch(`/api/conversations/${state.conversationId}`, { cwd: arg });
      toast(t('cwdSet', conv.cwd));
    } else {
      nextCwd = (await api.get(`/api/resolve-dir?path=${encodeURIComponent(arg)}`)).path;
      toast(t('cwdSet', nextCwd));
      renderChrome();
    }
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
}

async function extensionsCommand() {
  const body = h('div');
  const dialog = modal({ title: t('extensionsTitle'), content: body, width: 620 });
  const draw = async () => {
    let data;
    try {
      data = await api.get('/api/extensions');
    } catch (err) {
      return void clear(body).append(h('div', { class: 'connect-error' }, err.message));
    }
    clear(body);
    if (!data.extensions.length) return void body.append(h('p', { class: 'seed-muted' }, t('noExtensions')));
    for (const ext of data.extensions) {
      const error = [ext.server?.status === 'error' ? ext.server.error : null, ext.client?.status === 'error' ? ext.client.error : null].filter(Boolean).join('\n');
      const act = (fn) => async () => {
        try {
          await fn();
        } catch (err) {
          toast(err.message, { type: 'error' });
        }
        draw();
      };
      body.append(
        h(
          'div',
          { class: 'card', style: { margin: '0 0 10px' } },
          h(
            'div',
            { class: 'row' },
            h('span', { class: 'grow' }, h('strong', ext.name), ext.description ? h('span', { class: 'seed-muted' }, `  ${ext.description}`) : null),
            h('button', { type: 'button', class: 'seed-btn small', onclick: act(() => api.patch(`/api/extensions/${encodeURIComponent(ext.name)}`, { enabled: !ext.enabled })) }, ext.enabled ? t('disable') : t('enable')),
            h('button', {
              type: 'button',
              class: 'seed-btn small danger',
              onclick: act(async () => {
                if (await confirmDialog(t('removeConfirm', ext.name), { danger: true, confirmLabel: t('remove') })) await api.del(`/api/extensions/${encodeURIComponent(ext.name)}`);
              }),
            }, t('remove')),
          ),
          error
            ? h(
                'div',
                h('pre', { class: 'connect-error', style: { whiteSpace: 'pre-wrap', margin: '8px 0', font: '12.5px var(--mono)' } }, error),
                h('button', {
                  type: 'button',
                  class: 'seed-btn small',
                  onclick: () => {
                    dialog.close();
                    composer.setText(t('fixPrompt', ext.name, error));
                    composer.focus();
                  },
                }, t('askFix')),
              )
            : null,
        ),
      );
    }
  };
  draw();
}

function helpCommand() {
  const card = h('div', { class: 'card', style: { margin: 0, padding: '4px 12px' } });
  for (const command of [...composer.commands.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    card.append(row(h('span', h('code', `/${command.name}${command.args ? ` ${command.args}` : ''}`), h('span', { class: 'seed-muted' }, `  ${command.description || ''}`))));
  }
  modal({ title: t('helpTitle'), content: card, width: 640 });
}

function registerCommands() {
  const add = (name, run, args) => composer.registerCommand({ name, description: t(`commands.${name}`), args, run });
  add('new', () => (location.hash === '#/' || !location.hash ? goHome() : (location.hash = '#/')));
  add('connect', () => showConnect({ manual: true }));
  add('model', modelCommand, '[provider/model]');
  add('mode', modeCommand, '[ask|auto-edit|full]');
  add('cd', cdCommand, '<dir>');
  add('compact', async () => {
    if (!state.conversationId) return;
    try {
      const result = await api.post(`/api/conversations/${state.conversationId}/compact`);
      toast(result.compacted ? t('compacted') : t('notCompacted'));
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  });
  add('extensions', extensionsCommand);
  add('stop', stop);
  add('safe', () => {
    const url = new URL(location.href);
    if (state.safeMode) url.searchParams.delete('safe');
    else url.searchParams.set('safe', '1');
    location.href = url.href;
  });
  add('help', helpCommand);
}

// ---- start-up -------------------------------------------------------------------------------

function showGate(wrong = false) {
  const input = h('input', { class: 'seed-input', type: 'password', placeholder: t('tokenPlaceholder'), autofocus: true });
  const error = h('p', { class: 'connect-error' }, wrong ? t('tokenWrong') : '');
  const form = h(
    'form',
    h('h1', t('tokenTitle')),
    h('p', t('tokenBody')),
    input,
    h('button', { type: 'submit', class: 'seed-btn primary' }, t('tokenSubmit')),
    error,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (await signIn(input.value.trim())) location.reload();
    else error.textContent = t('tokenWrong');
  });
  appEl.hidden = true;
  document.body.append(h('div', { class: 'gate' }, form));
  input.focus();
}

async function start() {
  const [info, config] = await Promise.all([api.get('/api/info'), api.get('/api/config')]);
  setState({ info, config, safeMode: state.safeMode || info.safeMode });

  composer.handlers.submit = send;
  composer.handlers.stop = stop;
  composer.handlers.newChat = () => (location.hash = '#/');
  composer.onUnknownCommand = (name) => toast(t('unknownCommand', name), { type: 'error' });
  composer.onBusy = () => toast(t('busy'));
  registerCommands();

  actions.openConversation = (id) => (location.hash = `#/c/${id}`);
  actions.newConversation = () => (location.hash = '#/');
  actions.send = send;
  actions.stop = stop;
  actions.refreshView = () => {
    if (state.view === 'page' && state.page) openPage(state.page);
  };
  // The global handle: used by ui_eval and handy in the browser console.
  window.seed = makeSeed('console', []);

  connectEvents(handleEvent, (status) => toast(status === 'down' ? t('offline') : t('reconnected'), status === 'down' ? { type: 'error' } : {}));
  window.addEventListener('hashchange', route);
  await loadExtensions();
  await route();
}

const isSignedIn = async () => (await api.get('/api/auth/status').catch(() => ({ authenticated: false }))).authenticated;

/**
 * Sign in with the access token. The server sets a session cookie; when the
 * browser does not keep it (a page embedded in another site's frame), the
 * token itself is kept for this tab and sent with every request instead.
 */
async function signIn(token) {
  if (!token) return false;
  try {
    await api.post('/api/auth/login', { token });
  } catch {
    return false;
  }
  if (await isSignedIn()) return true;
  useToken(token);
  if (await isSignedIn()) return true;
  useToken(null);
  return false;
}

async function boot() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  // In the desktop app: room for the macOS window buttons, and the native folder picker.
  if (window.seedDesktop) document.documentElement.classList.add('desktop', `desktop-${window.seedDesktop.platform}`);
  const url = new URL(location.href);
  if (url.searchParams.get('safe') === '1') state.safeMode = true;
  const token = url.searchParams.get('token');
  let wrong = false;
  if (token) {
    wrong = !(await signIn(token));
    // Keep the token out of the address bar and the history.
    url.searchParams.delete('token');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  } else if (!(await isSignedIn()) && storedToken()) {
    useToken(storedToken()); // a reload in a tab that works without the cookie
  }
  if (!(await isSignedIn())) {
    useToken(null);
    return showGate(wrong);
  }
  await start();
}

boot().catch((err) => {
  console.error(err);
  toast(`${t('loadFailed')}: ${err.message}`, { type: 'error', duration: 0 });
});
