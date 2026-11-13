// Client-side extension host: loads each extension's client.js and gives it
// the `seed` API. Everything an extension registers through that object is
// removed again when the extension is reloaded or disabled.
import { api } from './api.js';
import { composer } from './composer.js';
import { clear, h, icon, iconNames } from './dom.js';
import { lang, t, tr } from './i18n.js';
import { renderInline, renderMarkdown } from './markdown.js';
import { emit, on, state, subscribe } from './state.js';
import { messageActions, renderHooks, thread, toolRenderers } from './thread.js';
import { confirmDialog, modal, toast } from './ui.js';

export const SLOTS = ['top', 'left', 'right', 'bottom', 'composer-top', 'composer-actions', 'composer-bottom', 'home', 'overlay'];

/** name → { title?, render(container, param) } — full-page views opened at #/x/<name> */
export const views = new Map();
/** (content) => content | false | undefined, run before a message is sent */
export const beforeSendHooks = new Set();

/** Set by app.js: the actions extensions can trigger. */
export const actions = {
  openConversation: (id) => {},
  newConversation: () => {},
  send: async (content) => {},
  stop: () => {},
  refreshView: () => {},
};

const loaded = new Map(); // extension name → { disposers, links }
let loading = null;
let again = false;

function publicState() {
  return {
    view: state.view,
    conversationId: state.conversationId,
    conversation: state.conversation,
    running: state.running,
    page: state.page,
    config: state.config,
    info: state.info,
    safeMode: state.safeMode,
  };
}

function mount(extension, slot, content, options = {}) {
  const target = document.querySelector(`[data-slot="${CSS.escape(String(slot))}"]`);
  if (!target) throw new Error(`ui.mount: unknown slot "${slot}". Slots: ${SLOTS.join(', ')}.`);
  const wrapper = h('div', { class: 'ext-mount', dataset: { ext: extension } });
  if (options.id) wrapper.id = options.id;
  if (options.width != null && (slot === 'left' || slot === 'right')) {
    wrapper.style.width = typeof options.width === 'number' ? `${options.width}px` : String(options.width);
  }
  let cleanup = null;
  if (typeof content === 'function') cleanup = content(wrapper);
  else if (content instanceof Node) wrapper.append(content);
  else throw new Error('ui.mount: content must be a DOM node, or a function (container) => optional cleanup function.');
  target.append(wrapper);
  return () => {
    try {
      if (typeof cleanup === 'function') cleanup();
    } finally {
      wrapper.remove();
    }
  };
}

function addStyle(extension, css) {
  const el = h('style', { dataset: { ext: extension } }, String(css));
  document.head.append(el);
  return () => el.remove();
}

function bindKey(combo, fn) {
  const parts = String(combo).toLowerCase().split('+').map((p) => p.trim());
  const key = parts.pop();
  const want = { mod: parts.includes('mod'), ctrl: parts.includes('ctrl'), meta: parts.includes('meta') || parts.includes('cmd'), shift: parts.includes('shift'), alt: parts.includes('alt') };
  const mac = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
  const handler = (event) => {
    if (event.key.toLowerCase() !== key) return;
    const ctrl = want.ctrl || (want.mod && !mac);
    const meta = want.meta || (want.mod && mac);
    if (event.ctrlKey !== ctrl || event.metaKey !== meta || event.shiftKey !== want.shift || event.altKey !== want.alt) return;
    event.preventDefault();
    fn(event);
  };
  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}

/**
 * Build the `seed` object for one extension. `disposers` collects the undo
 * function of everything registered through it.
 */
export function makeSeed(name, disposers) {
  const track = (dispose) => {
    disposers.push(dispose);
    return () => {
      const i = disposers.indexOf(dispose);
      if (i >= 0) disposers.splice(i, 1);
      dispose();
    };
  };
  const storagePath = (key) => `/api/extensions/${encodeURIComponent(name)}/storage${key === undefined ? '' : `/${encodeURIComponent(key)}`}`;
  const own = (path) => `/ext/${encodeURIComponent(name)}${path.startsWith('/') ? path : `/${path}`}`;

  const seed = {
    name,
    version: state.info?.version,
    lang,
    /** Create DOM: h('div', { class: 'x', onclick }, 'text', child). */
    h,
    /** Inline SVG icon by name; iconNames() lists them. */
    icon,
    iconNames,
    /** Pick text by interface language: tr('中文', 'English'). */
    tr,

    /** The app's REST API (docs/API.md). `api.ext` calls this extension's own server routes. */
    api: {
      get: api.get,
      post: api.post,
      patch: api.patch,
      put: api.put,
      del: api.del,
      delete: api.del,
      ext: {
        get: (path) => api.get(own(path)),
        post: (path, body) => api.post(own(path), body),
        put: (path, body) => api.put(own(path), body),
        patch: (path, body) => api.patch(own(path), body),
        del: (path) => api.del(own(path)),
      },
    },

    state: {
      get: publicState,
      /** fn(state) runs after every change. */
      subscribe: (fn) => track(subscribe(() => fn(publicState()))),
    },

    events: {
      /** Server events by type, "*" for all of them, or local ones: "route", "conversation.opened". */
      on: (type, fn) => track(on(type, fn)),
    },

    ui: {
      /** Put content into a slot: top, left, right, bottom, composer-top, composer-actions, composer-bottom, home, overlay. */
      mount: (slot, content, options) => track(mount(name, slot, content, options)),
      addStyle: (css) => track(addStyle(name, css)),
      toast,
      modal,
      confirm: confirmDialog,
    },

    views: {
      /** A full page at #/x/<viewName>: render(container, param) may return a cleanup function. */
      register(viewName, view) {
        if (!/^[\w-]{1,48}$/.test(viewName)) throw new Error(`views.register: invalid view name "${viewName}".`);
        if (typeof view?.render !== 'function') throw new Error('views.register: the view needs a render(container) function.');
        const entry = { ...view, extension: name };
        views.set(viewName, entry);
        actions.refreshView();
        return track(() => {
          if (views.get(viewName) === entry) views.delete(viewName);
          actions.refreshView();
        });
      },
      open: (viewName, param) => {
        location.hash = `#/x/${viewName}${param ? `/${encodeURIComponent(param)}` : ''}`;
      },
    },

    commands: {
      /** Add a slash command: { name, description, args?, run(argString) }. */
      register: (command) => track(composer.registerCommand(command, `ext:${name}`)),
    },

    keys: {
      /** Keyboard shortcut such as "mod+k" (mod = Cmd on macOS, Ctrl elsewhere). */
      bind: (combo, fn) => track(bindKey(combo, fn)),
    },

    chat: {
      open: (id) => actions.openConversation(id),
      new: () => actions.newConversation(),
      /** Send a message as the user: a string, or content blocks. */
      send: (content) => actions.send(content),
      stop: () => actions.stop(),
      getDraft: () => composer.getText(),
      setDraft: (text) => composer.setText(String(text)),
      insert: (text) => composer.insert(String(text)),
      focus: () => composer.focus(),
      /** Change or cancel outgoing messages: fn(content) → new content, false to cancel, nothing to keep. */
      onBeforeSend(fn) {
        beforeSendHooks.add(fn);
        return track(() => beforeSendHooks.delete(fn));
      },
      /** Custom display for a tool's result: fn({ name, input, result, status }) → Node or null. */
      registerToolRenderer(toolName, fn) {
        toolRenderers.set(toolName, fn);
        return track(() => {
          if (toolRenderers.get(toolName) === fn) toolRenderers.delete(toolName);
        });
      },
      /** A button under each assistant message: { label, title?, run(message, element) }. */
      addMessageAction(action) {
        messageActions.add(action);
        return track(() => messageActions.delete(action));
      },
      /** fn(element, message) runs after each message is rendered (for highlighting, math, ...). */
      onRender(fn) {
        renderHooks.add(fn);
        return track(() => renderHooks.delete(fn));
      },
      scrollToEnd: () => thread.scrollToEnd(),
    },

    /** A small key-value store for this extension, kept on the server and shared with its server.js. */
    storage: {
      get: async (key, fallback = null) => (await api.get(storagePath(key))).value ?? fallback,
      set: (key, value) => api.put(storagePath(key), { value }),
      delete: (key) => api.del(storagePath(key)),
      all: async () => (await api.get(storagePath())).values,
    },

    markdown: { render: renderMarkdown, renderInline },

    navigate: (hash) => {
      location.hash = hash;
    },
  };
  seed.on = seed.events.on;
  return seed;
}

function dispose(record) {
  for (const fn of record.disposers.splice(0).reverse()) {
    try {
      fn();
    } catch (err) {
      console.error('[seed] extension cleanup failed:', err);
    }
  }
  for (const link of record.links.splice(0)) link.remove();
}

function describe(err) {
  const stack = String(err?.stack || '');
  const message = String(err?.message || err);
  const text = stack.includes(message) ? stack : `${message}\n${stack}`;
  return text
    .split('\n')
    .filter((line) => !/^\s+at /.test(line) || line.includes('/extensions/'))
    .slice(0, 10)
    .join('\n')
    .replace(/https?:\/\/[^/\s]+\/extensions\/[^/\s]+\//g, '');
}

async function loadNow() {
  for (const record of loaded.values()) dispose(record);
  loaded.clear();
  if (state.safeMode) return;

  const manifest = await api.get('/api/extensions/client');
  if (manifest.safeMode) return;
  const results = {};
  for (const ext of manifest.extensions) {
    const record = { disposers: [], links: [] };
    loaded.set(ext.name, record);
    try {
      for (const href of ext.styles) {
        const link = h('link', { rel: 'stylesheet', href, dataset: { ext: ext.name } });
        document.head.append(link);
        record.links.push(link);
      }
      if (ext.client) {
        const mod = await import(ext.client);
        const activate = typeof mod.activate === 'function' ? mod.activate : mod.default;
        if (typeof activate !== 'function') throw new Error('client.js must export a function: export function activate(seed) { ... }');
        const cleanup = await activate(makeSeed(ext.name, record.disposers));
        if (typeof cleanup === 'function') record.disposers.push(cleanup);
      }
      results[ext.name] = { ok: true };
    } catch (err) {
      dispose(record);
      const error = describe(err);
      results[ext.name] = { ok: false, error };
      console.error(`[seed] extension "${ext.name}" failed to load:`, err);
      toast(t('extFailed', ext.name), {
        type: 'error',
        action: { label: t('askFix'), run: () => (composer.setText(t('fixPrompt', ext.name, error)), composer.focus()) },
      });
    }
  }
  await api.post('/api/extensions/client-report', { generation: manifest.generation, results }).catch(() => {});
  emit('extensions.loaded', { generation: manifest.generation, results });
}

/** (Re)load all client extensions. Calls made during a load run once more afterwards. */
export function loadExtensions() {
  if (loading) {
    again = true;
    return loading;
  }
  loading = (async () => {
    try {
      do {
        again = false;
        await loadNow();
      } while (again);
    } catch (err) {
      console.error('[seed] could not load extensions:', err);
    } finally {
      loading = null;
    }
  })();
  return loading;
}

// ---- runtime errors: tell the server which extension they came from ---------------

const recent = new Map();
function attribute(err, filename = '') {
  const text = String(err?.stack || err || '');
  const match = /\/extensions\/[^/\s]+\/([^/\s]+)\//.exec(text) || /\/extensions\/[^/\s]+\/([^/\s]+)\//.exec(filename);
  if (!match) return;
  const name = decodeURIComponent(match[1]);
  const message = String(err?.message || err);
  const key = `${name}:${message}`;
  if (Date.now() - (recent.get(key) || 0) < 5000) return;
  recent.set(key, Date.now());
  api.post('/api/extensions/client-error', { name, message, stack: describe(err) }).catch(() => {});
}
window.addEventListener('error', (event) => attribute(event.error || event.message, event.filename));
window.addEventListener('unhandledrejection', (event) => attribute(event.reason));

// ---- ui_eval: the agent looks at the live page --------------------------------------

function stringify(value) {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (value instanceof Element) return value.outerHTML.length > 6000 ? `${value.outerHTML.slice(0, 6000)}…` : value.outerHTML;
  if (value instanceof NodeList || value instanceof HTMLCollection) return `[${value.length} nodes] ${[...value].slice(0, 20).map((n) => n.nodeName.toLowerCase() + (n.id ? `#${n.id}` : '')).join(', ')}`;
  if (typeof value === 'function') return value.toString().slice(0, 2000);
  try {
    const seen = new WeakSet();
    return JSON.stringify(
      value,
      (_key, v) => {
        if (v instanceof Node) return `<${v.nodeName.toLowerCase()}>`;
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[circular]';
          seen.add(v);
        }
        return typeof v === 'function' ? '[function]' : v;
      },
      2,
    );
  } catch {
    return String(value);
  }
}

export async function runEval({ evalId, code }) {
  let payload;
  try {
    const AsyncFunction = (async () => {}).constructor;
    const value = await new AsyncFunction('seed', String(code))(window.seed);
    payload = { ok: true, value: stringify(value) };
  } catch (err) {
    payload = { ok: false, error: String(err?.stack || err) };
  }
  api.post('/api/client/eval-result', { evalId, ...payload }).catch(() => {});
}

export { clear };
