// Tools that let the agent operate the app itself: reload the extensions it
// writes, look at the live UI, call the app's own REST API, and call tools
// that were registered after the conversation started.
import { checkInput } from '../agent/messages.js';
import { describeCall } from '../agent/permissions.js';
import { truncateMiddle } from '../util.js';

export function appTools(app) {
  const reloadExtensions = {
    name: 'reload_extensions',
    description:
      'Reload all extensions of this app and report, for each one, whether its server code and its UI code loaded, with the error messages if not. ' +
      'Call it after you create or change files in the extensions folder, and again after each fix, until nothing reports an error.',
    parameters: { type: 'object', properties: {} },
    kind: 'read',
    async run() {
      await app.extensions.reload();
      await app.extensions.waitForClients(3500);
      return app.extensions.report();
    },
  };

  const seedApi = {
    name: 'seed_api',
    description:
      "Call this app's own REST API: read or change settings (GET/PATCH /api/config), list models (GET /api/models), " +
      'work with conversations (GET /api/conversations, ...), manage extensions (GET /api/extensions, PATCH /api/extensions/<name>, ...), ' +
      'or call a route that an extension added (/ext/<name>/...). The full list of endpoints is in docs/API.md in the app folder. ' +
      'Secrets such as API keys are never returned.',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] },
        path: { type: 'string', description: 'Path with optional query string, for example "/api/config" or "/api/conversations?limit=20".' },
        body: { type: 'object', description: 'JSON body for POST, PATCH and PUT.' },
      },
      required: ['method', 'path'],
    },
    kind: (args) => (args.method === 'GET' ? 'read' : 'app'),
    describe: (args) => ({ title: 'Change app settings or data', detail: `${args.method} ${args.path}`, preview: args.body ? { type: 'json', value: args.body } : null }),
    async run(args, ctx) {
      if (!/^\/(api|ext)\//.test(args.path)) return { content: 'Error: path must start with /api/ or /ext/.', is_error: true };
      // Whatever this call starts must not get more freedom than the run that makes it.
      const mode = ctx.mode || ctx.conversation.approval || app.config.approval;
      const res = await app.api.dispatch({
        method: args.method,
        url: args.path,
        body: args.body,
        actor: { source: 'agent', conversationId: ctx.conversation.id, mode },
      });
      const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body, null, 2);
      return { content: `HTTP ${res.status}\n${truncateMiddle(text ?? '', 30_000)}`, is_error: res.status >= 400 };
    },
  };

  const uiEval = {
    name: 'ui_eval',
    description:
      'Run JavaScript in the app\'s open web page and return the result, to inspect or check the live UI: for example ' +
      '`return document.querySelector("#history-sidebar")?.innerText` or `return seed.state.get()`. ' +
      'The code is the body of an async function with `seed` (the UI API) in scope; use `return` to send a value back. ' +
      'Fails when no UI page is open.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'JavaScript function body. Use `return` for the result.' } },
      required: ['code'],
    },
    kind: 'app',
    describe: (args) => ({ title: 'Run code in the app page', detail: args.code }),
    async run(args, ctx) {
      const result = await app.clients.eval(args.code, { conversationId: ctx.conversation.id, timeoutMs: 10_000 });
      if (!result.ok) return { content: `Error: ${result.error}`, is_error: true };
      return { content: truncateMiddle(result.value ?? 'undefined', 20_000) };
    },
  };

  const extCall = {
    name: 'ext_call',
    description:
      'Call a tool by name. Use it for tools that an extension registered after this conversation began, which are therefore missing from your tool list. ' +
      'Call it with an unknown or empty name to get the list of such tools with their parameters.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the tool to call.' },
        arguments: { type: 'object', description: 'Arguments for that tool.' },
      },
      required: ['name'],
    },
    kind(args, ctx) {
      const tool = args.name !== 'ext_call' && app.tools.get(args.name);
      return tool ? describeCall(tool, args.arguments || {}, ctx) : 'read';
    },
    describe(args, ctx) {
      const tool = args.name !== 'ext_call' && app.tools.get(args.name);
      return tool?.describe?.(args.arguments || {}, ctx) || { title: `Call ${args.name}`, detail: JSON.stringify(args.arguments || {}) };
    },
    async run(args, ctx) {
      const tool = args.name !== 'ext_call' && app.tools.get(args.name);
      if (!tool) {
        const known = new Set(((await app.store.getToolset(ctx.conversation.toolset)) || []).map((t) => t.name));
        const extra = app.tools.definitions().filter((t) => !known.has(t.name));
        if (!extra.length) return { content: `There is no tool named "${args.name}", and no tools have been added since this conversation began.` };
        return {
          content:
            `There is no tool named "${args.name}". Tools added since this conversation began:\n\n` +
            extra.map((t) => `${t.name}: ${t.description}\nparameters: ${JSON.stringify(t.parameters)}`).join('\n\n'),
        };
      }
      const checked = checkInput(tool.parameters, args.arguments || {});
      if (checked.error) return { content: `Error: invalid arguments for ${args.name}: ${checked.error}`, is_error: true };
      return tool.run(checked.value, ctx);
    },
  };

  return [reloadExtensions, seedApi, uiEval, extCall];
}
