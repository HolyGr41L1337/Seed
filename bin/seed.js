#!/usr/bin/env node
// Seed command line: start the app, or run one task in the terminal.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { parseArgs } from 'node:util';

const HELP = `Seed — an AI agent that starts as one input bar and grows on request.

Usage
  seed [options]                  Start the app: web UI + API
  seed exec [options] <prompt>    Run one task in this terminal and exit
  seed url [options]              Print the app address with the access token

Options
  --port <n>          Port to listen on (default 7333)
  --host <address>    Address to listen on (default 127.0.0.1)
  --cwd <dir>         Workspace directory (default: the current directory)
  --home <dir>        Data directory (default: ~/.seed, or $SEED_HOME)
  --model <p/m>       Model for "exec", as <provider>/<model>
  --approval <mode>   ask | auto-edit | full
  --json              With "exec": print events as JSON lines
  --no-open           Do not open the browser
  --safe              Start without loading extensions
  -h, --help          Show this help
  -v, --version       Show the version

Model APIs can be connected in the web UI, or through environment variables:
ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY (+ OPENAI_BASE_URL), OPENROUTER_API_KEY.
`;

// Node's fetch ignores HTTP(S)_PROXY unless asked. When a proxy is configured,
// run the real process with the switch that makes it honor those variables.
// Returns true when this process only supervises that one.
function restartWithProxySupport() {
  const env = process.env;
  const hasProxy = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((k) => env[k]);
  if (!hasProxy || env.NODE_USE_ENV_PROXY) return false;
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!(major >= 24 || (major === 22 && minor >= 21))) return false;
  // The proxy support prints an "experimental" warning on every start; it is expected here.
  const child = spawn(process.execPath, [...process.execArgv, '--disable-warning=UNDICI-EHPA', ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...env, NODE_USE_ENV_PROXY: '1' },
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    });
  }
  child.on('error', (err) => {
    console.error(err.message);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  return true;
}

function parse() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        cwd: { type: 'string' },
        home: { type: 'string' },
        model: { type: 'string' },
        approval: { type: 'string' },
        json: { type: 'boolean' },
        'no-open': { type: 'boolean' },
        safe: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    console.error(`${err.message}\n\nRun "seed --help" for usage.`);
    process.exit(2);
  }
}

function overridesFrom(values) {
  const overrides = {};
  const server = {};
  if (values.port !== undefined) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error('--port must be a number between 0 and 65535.');
      process.exit(2);
    }
    server.port = port;
    server.strictPort = true;
  }
  if (values.host) server.host = values.host;
  if (Object.keys(server).length) overrides.server = server;
  if (values.approval) {
    if (!['ask', 'auto-edit', 'full'].includes(values.approval)) {
      console.error('--approval must be ask, auto-edit or full.');
      process.exit(2);
    }
    overrides.approval = values.approval;
  }
  return overrides;
}

function openBrowser(url) {
  const platform = process.platform;
  if (platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  const [cmd, args] =
    platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    /* no browser to open; the address is printed anyway */
  }
}

async function serve(values) {
  const { App } = await import('../src/app.js');
  const { VERSION, homeRelative } = await import('../src/util.js');
  const app = new App({ home: values.home, cwd: values.cwd || process.cwd(), safeMode: values.safe, overrides: overridesFrom(values) });
  await app.init();
  let address;
  try {
    address = await app.listen();
  } catch (err) {
    console.error(err.code === 'EADDRINUSE' ? `Port ${app.config.server.port} is already in use. Choose another with --port.` : err.message);
    process.exit(1);
  }
  const exposed = !['127.0.0.1', 'localhost', '::1'].includes(address.host);
  console.log(`
  Seed ${VERSION}${app.safeMode ? '  (safe mode: extensions are off)' : ''}

  Open        ${address.urlWithToken}
  Workspace   ${homeRelative(app.cwd)}
  Data        ${homeRelative(app.home)}
  API         ${address.url}/api    OpenAI-compatible: ${address.url}/v1
  Token       ${app.config.server.token}
${exposed ? `\n  Listening on ${address.host}: other machines can reach this server. Keep the token private.\n` : ''}
  Press Ctrl+C to stop.
`);
  if (!values['no-open'] && process.stdout.isTTY && !process.env.SEED_NO_OPEN) openBrowser(address.urlWithToken);

  app.guardProcess();
  let closingSince = 0;
  const stop = async () => {
    // A terminal sends Ctrl+C to the whole process group, so the signal can arrive twice
    // at once. Only a later, deliberate second signal forces the exit.
    if (closingSince) {
      if (Date.now() - closingSince > 1500) process.exit(1);
      return;
    }
    closingSince = Date.now();
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function printUrl(values) {
  const { Config } = await import('../src/config.js');
  const { resolveHome } = await import('../src/util.js');
  const config = new Config(resolveHome(values.home), { overrides: overridesFrom(values) });
  const { host, port, token } = config.server;
  const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  console.log(`http://${shown}:${port}/?token=${token}`);
}

async function exec(values, prompt) {
  if (!prompt.trim()) {
    console.error('Give the task as an argument: seed exec "what to do"');
    process.exit(2);
  }
  const { App } = await import('../src/app.js');
  const app = new App({ home: values.home, cwd: values.cwd || process.cwd(), safeMode: values.safe, watch: false, overrides: overridesFrom(values) });
  await app.init();

  const tty = process.stdout.isTTY;
  const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
  const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
  const interactive = !!process.stdin.isTTY && !values.json;
  let lastKind = null;
  let conv;

  const ask = (approval) =>
    new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      const what = `${approval.title}${approval.detail ? `: ${approval.detail}` : ''}`;
      rl.question(`\n${what}\nAllow? [y] yes  [a] always in this run  [n] no: `, (answer) => {
        rl.close();
        const a = answer.trim().toLowerCase();
        resolve(a === 'a' ? 'allow_always' : a === 'y' || a === 'yes' ? 'allow' : 'deny');
      });
    });

  const onEvent = (e) => {
    if (values.json) return void process.stdout.write(JSON.stringify(e) + '\n');
    if (e.type === 'delta') {
      if (lastKind && lastKind !== e.kind) process.stdout.write('\n');
      lastKind = e.kind;
      process.stdout.write(e.kind === 'thinking' ? dim(e.text) : e.text);
    } else if (e.type === 'message.completed') {
      if (lastKind) process.stdout.write('\n');
      lastKind = null;
    } else if (e.type === 'tool.started') {
      const detail = e.input?.command || e.input?.path || e.input?.pattern || e.input?.url || '';
      process.stderr.write(dim(`› ${e.name}${detail ? ` ${String(detail).split('\n')[0].slice(0, 120)}` : ''}\n`));
    } else if (e.type === 'tool.completed' && e.result?.is_error) {
      process.stderr.write(red(`  ${String(e.result.content).split('\n')[0].slice(0, 200)}\n`));
    } else if (e.type === 'approval.requested') {
      ask(e.approval).then((decision) => {
        try {
          app.runs.resolveApproval(conv.id, e.approval.id, decision);
        } catch {
          /* the run ended meanwhile */
        }
      });
    } else if (e.type === 'message.added' && e.message.role === 'notice') {
      process.stderr.write(`${e.message.meta?.level === 'error' ? red('!') : dim('i')} ${e.message.content[0].text}\n`);
    } else if (e.type === 'run.retry') {
      process.stderr.write(dim(`  retrying (${e.attempt}): ${e.message}\n`));
    }
  };

  let status = 1;
  try {
    conv = await app.createConversation({});
    const run = await app.runs.start(conv, {
      content: [{ type: 'text', text: prompt }],
      model: values.model,
      approval: values.approval,
      interactive,
      onEvent,
    });
    process.on('SIGINT', () => app.runs.cancel(conv.id));
    const result = await run.done;
    status = result.status === 'completed' ? 0 : result.status === 'cancelled' ? 130 : 1;
  } catch (err) {
    console.error(red(err.message));
  }
  await app.close().catch(() => {});
  process.exit(status);
}

async function main() {
  const { values, positionals } = parse();
  if (values.help) return void console.log(HELP);
  if (values.version) {
    const { VERSION } = await import('../src/util.js');
    return void console.log(VERSION);
  }
  if (restartWithProxySupport()) return;
  const [command, ...rest] = positionals;
  if (!command || command === 'serve') return serve(values);
  if (command === 'exec') return exec(values, rest.join(' '));
  if (command === 'url') return printUrl(values);
  console.error(`Unknown command "${command}".\n\nRun "seed --help" for usage.`);
  process.exit(2);
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
