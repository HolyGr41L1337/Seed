# Extending Seed

Seed's built-in interface is one input bar. Every other feature is an **extension**: a folder of plain JavaScript that the running app loads without a restart. This page is the reference for writing one. It is written for the AI agent inside Seed and for people.

## Quick start

1. Create a folder in the extensions directory (its path is in your system prompt and in `GET /api/extensions` → `dir`; by default `~/.seed/extensions/`):

   ```
   ~/.seed/extensions/hello/
     extension.json     optional: { "name", "description", "version" }
     client.js          optional: runs in the web page
     server.js          optional: runs in the Seed server process (Node.js)
     style.css          optional: loaded into the web page
   ```

2. Write `client.js`, `server.js`, or both. Each exports one function, `activate`.
3. Call the `reload_extensions` tool. It reloads everything and reports, per extension, whether the server side and the UI side loaded, with file and line for errors. Fix what it reports and call it again until it is clean.
4. Check the result when it matters: `ui_eval` runs JavaScript in the open page, for example `return !!document.querySelector('#hello-panel')`.

The folder name is the extension's name: letters, digits, `-` and `_`. Files are plain ES modules. There is no build step, no bundler and no `npm install`; use the browser's and Node's built-in APIs. Saving a file also triggers a reload automatically, but only `reload_extensions` returns the report.

Minimal UI extension:

```js
// ~/.seed/extensions/hello/client.js
export function activate(seed) {
  const button = seed.h('button', { class: 'seed-btn', onclick: () => seed.ui.toast('Hello!') }, 'Hello');
  seed.ui.mount('composer-bottom', button);
}
```

Minimal server extension (a new tool for the agent):

```js
// ~/.seed/extensions/hello/server.js
export function activate(ctx) {
  ctx.tools.register({
    name: 'roll_dice',
    description: 'Roll dice and return the numbers. Call it when the user asks for a random dice roll.',
    parameters: { type: 'object', properties: { count: { type: 'integer', description: 'How many dice (default 1).' } } },
    kind: 'read',
    run: ({ count = 1 }) => Array.from({ length: count }, () => 1 + Math.floor(Math.random() * 6)).join(', '),
  });
}
```

Complete, working examples are in `examples/extensions/` in the app folder:

| Example | Shows |
| --- | --- |
| `history-sidebar` | a panel in the left slot, the REST API, live events, app state, a slash command, storage |
| `theme-toggle` | a button inside the input bar, a command with an argument, cleanup on unload |
| `memory` | tools for the agent, text added to the system prompt, HTTP routes, and a UI that calls them |

## Rules that keep extensions working

- **Register everything through the object you are given** (`seed` in the page, `ctx` on the server). Whatever you register that way is removed automatically when the extension reloads, so a reload never leaves duplicates behind. For anything you set up yourself (a `setInterval`, a listener on `window`, a change to `document.documentElement`), return a cleanup function from `activate`.
- `activate` may be `async`. A thrown error marks the extension as failed and everything it registered so far is removed.
- Give elements you may want to find again an `id` or a class prefixed with the extension name.
- Style with the CSS variables and `.seed-*` classes below, so the extension follows light and dark mode. Do not hard-code colors.
- Text shown to the user should follow the interface language: `seed.tr('中文', 'English')`. The interface also comes in Japanese, French and Russian; pass those as a third argument when you have them, `seed.tr('中文', 'English', { ja: '日本語', fr: 'Français', ru: 'Русский' })`. A language without its own text gets the English one.
- Do not edit the files of the app itself. If the extension API cannot do something, say so.
- Extension code runs with the user's full authority: `client.js` can call the whole API, `server.js` can do anything Node.js can. Write only what the user asked for.

## The page layout and its slots

```
┌──────────────────────────── top ────────────────────────────┐
│ left │                  conversation                  │ right │
│      │                                                │       │
│      │              composer-top                      │       │
│      │  [ + ][ input bar ........ composer-actions ↑ ] │       │
│      │              composer-bottom                   │       │
│      │              home (home screen only)           │       │
└─────────────────────────── bottom ──────────────────────────┘
overlay: covers the whole page (dialogs, floating buttons)
```

All slots are empty and take no space until something is mounted. `left` and `right` are full-height columns (give them a width); `top` and `bottom` are full-width bars; `composer-actions` sits inside the input bar next to the send button, so mount only small icon buttons there.

Useful element ids: `#app` (`data-view` is `home`, `chat` or `page`), `#thread` (messages), `#composer`, `#input` (the textarea), `#dock` (the bar and what surrounds it).

### Styling

CSS variables: `--bg`, `--surface`, `--surface-2`, `--fg`, `--muted`, `--faint`, `--border`, `--border-strong`, `--accent`, `--accent-hover`, `--accent-fg`, `--accent-soft`, `--danger`, `--danger-soft`, `--warn`, `--warn-soft`, `--shadow`, `--radius`, `--font`, `--mono`.

Classes: `.seed-btn` (+ `.primary`, `.danger`, `.ghost`, `.small`), `.icon-button`, `.seed-input`, `.seed-panel` with `.seed-panel-head` and `.seed-list`, `.seed-item` (+ `.active`, child `.grow`), `.seed-muted`, `.seed-title`, `.card` with `.row`, `.spinner`.

The theme is chosen by `prefers-color-scheme`; setting `document.documentElement.dataset.theme` to `"light"` or `"dark"` forces one.

## UI API: `client.js`

```js
export function activate(seed) { /* ... */ return optionalCleanupFunction; }
```

| Member | What it does |
| --- | --- |
| `seed.h(tag, props?, ...children)` | Creates an element. Props: `class`, `style` (string or object), `dataset`, `on<event>` handlers, attributes. Children: nodes, strings, arrays; `null` and `false` are skipped. |
| `seed.icon(name, size?)` | Inline SVG icon. Names: `send, stop, plus, check, x, dot, chevron, caret, down, copy, trash, settings, sidebar, search, edit, alert, terminal, file, folder, eye, globe, sparkle, refresh, plug, wrench, list, chip, shield`. |
| `seed.tr(chinese, english, others?)` | Picks the text for the interface language. `others` is an optional object with more languages: `{ ja, fr, ru }`. `seed.lang` is `"zh"`, `"en"`, `"ja"`, `"fr"` or `"ru"`. |
| `seed.ui.mount(slot, content, options?)` | Puts content into a slot. `content` is a DOM node, or a function `(container) => cleanup?`. Options: `width` (number of pixels or CSS length; for `left` and `right`), `id`. Returns a function that removes it. |
| `seed.ui.addStyle(cssText)` | Adds a stylesheet (a `style.css` file in the folder is loaded automatically). |
| `seed.ui.toast(text, { type: 'error', action: { label, run } }?)` | Short message at the top of the page. |
| `seed.ui.modal({ title, content, actions?, width?, onClose? })` | Dialog. `actions`: `[{ label, primary?, danger?, run?(close) }]`. Returns `{ close, body, element }`. |
| `seed.ui.confirm(text, { danger?, confirmLabel? }?)` | Yes/no dialog; resolves to `true` or `false`. |
| `seed.views.register(name, { title?, render(container, param) })` | A full page at `#/x/<name>` that replaces the conversation area (for settings pages, dashboards). `render` may return a cleanup function. |
| `seed.views.open(name, param?)` | Navigates to that page. |
| `seed.commands.register({ name, description, args?, run(argText) })` | Adds a slash command. Set `args` (a hint such as `'<city>'`) when the command takes arguments. |
| `seed.keys.bind('mod+k', fn)` | Keyboard shortcut. `mod` is Cmd on macOS and Ctrl elsewhere; also `ctrl`, `shift`, `alt`. |
| `seed.state.get()` | `{ view, conversationId, conversation, running, page, config, info, safeMode }`. `conversation` is the open conversation with its `messages`; `config` has `providers`, `model`, `approval`. |
| `seed.state.subscribe(fn)` | `fn(state)` after every state change. |
| `seed.events.on(type, fn)` | Live events from the server by type (table below), `'*'` for all, plus local ones: `route`, `conversation.opened`, `send`, `extensions.loaded`. |
| `seed.chat.open(id)`, `.new()` | Opens a conversation, or the home screen. |
| `seed.chat.send(content)` | Sends a message as the user: a string, or blocks such as `[{ type: 'text', text }, { type: 'image', mediaType: 'image/png', data: base64 }]`. |
| `seed.chat.stop()` | Stops the current run. |
| `seed.chat.getDraft()`, `.setDraft(text)`, `.insert(text)`, `.focus()` | The text in the input bar. |
| `seed.chat.onBeforeSend(fn)` | `fn(content)` before each send: return new content, `false` to cancel, or nothing. |
| `seed.chat.registerToolRenderer(toolName, fn)` | Custom display under a tool call: `fn({ name, input, result, status })` returns a node or `null`. `result` is `{ content, is_error }`. |
| `seed.chat.addMessageAction({ label, title?, run(message, element) })` | A button under each answer. |
| `seed.chat.onRender(fn)` | `fn(element, message)` after each message is drawn; use it for syntax highlighting, math, diagrams. |
| `seed.markdown.render(text)` | Markdown to a `DocumentFragment` (safe: no raw HTML). |
| `seed.storage.get(key, fallback?)`, `.set(key, value)`, `.delete(key)`, `.all()` | Small JSON store for this extension, kept on the server and shared with its `server.js`. All async. |
| `seed.api.get(path)`, `.post(path, body)`, `.patch`, `.put`, `.del` | The app's REST API (`docs/API.md`). They return parsed JSON and throw an `Error` with `.status` on failure. |
| `seed.api.ext.get(path)`, `.post`, `.put`, `.patch`, `.del` | This extension's own server routes (`/ext/<name><path>`). |
| `seed.navigate(hash)` | Sets `location.hash`: `#/` home, `#/c/<id>` conversation, `#/x/<view>` page. |

### Live events

Events about a conversation carry `conversationId`. The ones extensions usually need:

| Type | Fields |
| --- | --- |
| `conversation.created`, `conversation.updated` | `conversation: { id, title, ... }` |
| `conversation.deleted` | `conversationId` |
| `run.started`, `run.completed` | `runId`; `status` is `completed`, `cancelled` or `error`, with `error` |
| `message.added` | `message` (a user message, tool results, or a notice) |
| `message.completed` | `message` (an assistant message), `usage`, `contextTokens` |
| `delta` | `kind` (`text` or `thinking`), `text`: streamed output |
| `tool.started`, `tool.output`, `tool.completed` | `toolUseId`, `name`, `input` / `text` / `result`, `ms` |
| `approval.requested`, `approval.resolved` | `approval` / `approvalId`, `decision` |
| `config.changed` | `config` |
| `extensions.changed` | `generation` |
| `ext.<extension>.<type>` | `data`: sent by that extension's server with `ctx.events.broadcast(type, data)` |

A message is `{ id, role: 'user' | 'assistant' | 'notice', content: [blocks], createdAt, meta }`. Blocks: `{ type: 'text', text }`, `{ type: 'thinking', text }`, `{ type: 'tool_use', id, name, input }`, `{ type: 'tool_result', tool_use_id, content, is_error }`, `{ type: 'image', mediaType, data }`. Assistant `meta` has `model`, `ref` and `usage: { input, output, cacheRead, cacheWrite, context }`.

## Server API: `server.js`

```js
export function activate(ctx) { /* ... */ return optionalCleanupFunction; }
```

`server.js` is an ES module running inside the Seed server (Node.js 20 or later): use `import fs from 'node:fs'`, `fetch`, and so on. It can import other files of its folder with relative paths.

| Member | What it does |
| --- | --- |
| `ctx.name`, `ctx.dir` | The extension's name and folder. |
| `ctx.app` | `{ version, appDir, home, url() }`. |
| `ctx.log(...args)` | Prints to the server's terminal with the extension name. |
| `ctx.tools.register(tool)` | Adds a tool the agent can call (below). |
| `ctx.http.get(path, handler)`, `.post`, `.put`, `.patch`, `.delete` | Adds a route at `/ext/<name><path>`; `:param` segments are supported. The handler gets `{ method, path, params, query, headers, body }` (JSON body already parsed) and returns the JSON to send. For other responses return `ctx.http.respond({ status?, headers?, json | text | html })`. Routes need the app's access token like every other API call. |
| `ctx.hooks.on(name, fn)` | Runs `fn` at a point of the agent loop (below). |
| `ctx.prompt.add(textOrFunction)` | Adds text to the system prompt of conversations created from now on. A function is called (synchronously) each time. |
| `ctx.storage.get(key, fallback?)`, `.set`, `.delete`, `.all()` | The same store as `seed.storage` in the page. |
| `ctx.events.broadcast(type, data)` | Sends `ext.<name>.<type>` to every open page. |
| `ctx.conversations.list()`, `.get(id)`, `.create({ cwd?, model? })` | Conversation data. |
| `ctx.conversations.send(id \| null, text, { model?, approval?, cwd? }?)` | Sends a message (creating a conversation when the id is `null`) and waits; resolves to `{ conversationId, status, text, error }`. Tool calls that would need approval are refused unless `approval` is `'auto-edit'` or `'full'`. |
| `ctx.conversations.notify(id, text)` | Adds a notice to a conversation: the user sees it, the model does not. |
| `ctx.config.get()` | Settings without secrets. |
| `ctx.timers.every(ms, fn)`, `.after(ms, fn)` | Timers that stop on reload. |
| `ctx.providers.register(type, factory)` | Adds a kind of model API; see `src/providers/index.js` for the adapter interface. |
| `ctx.onDispose(fn)` | Runs `fn` when the extension unloads. |

### Tools

```js
ctx.tools.register({
  name: 'weather',                 // letters, digits, _ and -; must not clash with another tool
  description: 'Look up the current weather for a city. Call it when the user asks about weather.',
  parameters: {                    // JSON Schema of the arguments
    type: 'object',
    properties: { city: { type: 'string', description: 'City name, e.g. "Hangzhou".' } },
    required: ['city'],
  },
  kind: 'network',                 // decides whether the user is asked first
  describe: (args) => ({ title: 'Look up the weather', detail: args.city }),   // optional: text for the approval prompt
  async run(args, call) {          // return a string, or { content, is_error? }
    const res = await fetch(`https://wttr.in/${encodeURIComponent(args.city)}?format=3`, { signal: call.signal });
    return res.ok ? await res.text() : { content: `Weather service answered ${res.status}.`, is_error: true };
  },
});
```

- Write the description for the model: say what the tool does **and when to call it**. Describe every parameter.
- `kind` is one of `read` (never asks), `write`, `exec`, `network`, `app` (ask in the default mode). It may also be a function `(args, call) => kind` or `=> ({ kind: 'write', paths: [absolutePath] })`. Without `kind`, the tool counts as `exec`.
- `run` receives the checked arguments and `call = { cwd, signal, conversation, toolUseId, emit(text) }`. `cwd` is the conversation's workspace; `signal` aborts when the user presses stop; `emit` streams progress text to the page.
- Return errors as `{ content: 'what went wrong and what to try', is_error: true }` rather than throwing, so the model can react.
- A conversation's tool list is fixed when it starts. A tool registered later is still usable there at once, through `ext_call` (`{ "name": "weather", "arguments": { "city": "Hangzhou" } }`), and appears as a normal tool in new conversations.

### Hooks

| Name | Payload | A handler may return |
| --- | --- | --- |
| `run:start` | `{ conversation }` | |
| `run:end` | `{ conversation, status, error }` | |
| `message` | `{ conversation, message }` (each assistant message) | |
| `tool:before` | `{ conversation, name, args }` | `{ args }` to change the arguments, `{ deny: 'reason' }` to block the call |
| `tool:after` | `{ conversation, name, args, result }` | `{ result: { content, is_error? } }` to replace the result |

## Managing extensions

- `reload_extensions`: reload and report.
- `seed_api GET /api/extensions`: status of every extension, including runtime errors caught later.
- `seed_api PATCH /api/extensions/<name>` with `{ "enabled": false }`: turn one off without deleting it.
- `seed_api DELETE /api/extensions/<name>`: delete its folder.
- The user can type `/extensions` to see and manage them, and `/safe` to open the page without UI extensions if one of them breaks the interface (`seed --safe` starts the server without any extension).

## Common mistakes

- Using `require` or `module.exports`: files are ES modules. Use `import` and `export`.
- Importing npm packages: nothing is installed. Use built-in APIs, or `fetch` a service.
- Building UI with `innerHTML` and model or user text: use `seed.h` and text nodes, or `seed.markdown.render`.
- Adding listeners or timers outside `seed`/`ctx` and not returning a cleanup function: they pile up on every reload.
- Calling a server route with `fetch('/ext/...')` from somewhere without the session: in the page use `seed.api.ext.*`, which sends it.
- Forgetting `args` on a command that takes arguments: without it, choosing the command from the menu runs it immediately with no input.
