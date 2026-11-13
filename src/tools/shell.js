// The `shell` tool: run a command in the conversation's working directory.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome, newId, stripAnsi, truncateMiddle } from '../util.js';

export const IS_WINDOWS = process.platform === 'win32';

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_RESULT_CHARS = 30_000;
const KEEP_HEAD = 200_000;
const KEEP_TAIL = 400_000;

let powershell; // resolved once: PowerShell 7 (pwsh) when installed, else Windows PowerShell
function windowsShell() {
  if (!powershell) {
    let hasPwsh = false;
    try {
      hasPwsh = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', windowsHide: true, timeout: 8000 }).status === 0;
    } catch {
      /* not installed */
    }
    powershell = hasPwsh ? 'pwsh.exe' : 'powershell.exe';
  }
  return powershell;
}

/** The shell the shell tool uses on this computer, for the system prompt. */
export function shellName() {
  if (IS_WINDOWS) return windowsShell() === 'pwsh.exe' ? 'PowerShell 7 (pwsh)' : 'Windows PowerShell 5.1';
  return path.basename(fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
}

/**
 * The script PowerShell runs: UTF-8 output (so non-English text survives),
 * the command, then an exit code that reflects how the last command ended.
 */
function powershellScript(command) {
  return [
    '$ProgressPreference = "SilentlyContinue"',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    command,
    'if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }',
  ].join('\n');
}

/** How to start `command`. `cleanup` (if any) removes a temporary script afterwards. */
export function shellInvocation(command) {
  if (IS_WINDOWS) {
    const file = windowsShell();
    const base = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
    const script = powershellScript(command);
    // An encoded command needs no quoting at all. Windows limits a command line to
    // about 32,000 characters, so long scripts go through a temporary file.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    if (encoded.length < 28_000) return { file, args: [...base, '-EncodedCommand', encoded] };
    const tmp = path.join(os.tmpdir(), `seed-${newId()}.ps1`);
    fs.writeFileSync(tmp, '\ufeff' + script, 'utf8'); // BOM: Windows PowerShell reads the file as UTF-8
    return { file, args: [...base, '-File', tmp], cleanup: () => fs.rmSync(tmp, { force: true }) };
  }
  const file = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  return { file, args: ['-c', command] };
}

function killTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, signal); // the whole process group
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run a command. Resolves with { output, exitCode, timedOut, cancelled }.
 * `onChunk` receives output text as it arrives.
 */
export function runCommand(command, { cwd, timeout = DEFAULT_TIMEOUT, signal, onChunk, env } = {}) {
  return new Promise((resolve, reject) => {
    const { file, args, cleanup } = shellInvocation(command);
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env: {
          ...process.env,
          SEED: '1',
          TERM: 'dumb',
          NO_COLOR: '1',
          PAGER: 'cat',
          GIT_PAGER: 'cat',
          GIT_TERMINAL_PROMPT: '0',
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (err) {
      cleanup?.();
      return reject(err);
    }

    let head = '';
    let tail = '';
    let dropped = 0;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const add = (buf) => {
      const text = stripAnsi(buf.toString('utf8'));
      if (!text) return;
      onChunk?.(text);
      if (head.length < KEEP_HEAD) {
        const room = KEEP_HEAD - head.length;
        head += text.slice(0, room);
        tail += text.slice(room);
      } else {
        tail += text;
      }
      if (tail.length > KEEP_TAIL * 2) {
        dropped += tail.length - KEEP_TAIL;
        tail = tail.slice(-KEEP_TAIL);
      }
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);

    const stop = (how) => {
      if (how === 'timeout') timedOut = true;
      else cancelled = true;
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 2000).unref();
    };
    const timer = setTimeout(() => stop('timeout'), timeout);
    const onAbort = () => stop('cancel');
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      cleanup?.();
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (tail.length > KEEP_TAIL) {
        dropped += tail.length - KEEP_TAIL;
        tail = tail.slice(-KEEP_TAIL);
      }
      let output = dropped ? `${head}\n[... ${dropped} characters dropped ...]\n${tail}` : head + tail;
      output = output.replace(/\r\n/g, '\n'); // Windows line endings
      resolve({ output, exitCode, exitSignal, timedOut, cancelled });
    };
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup?.();
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    // 'close' waits for the output pipes; a background child that keeps them open
    // would hold the tool forever, so settle shortly after the shell itself exits.
    child.on('exit', (code, sig) => setTimeout(() => finish(code, sig), 150).unref());
    child.on('close', (code, sig) => finish(code, sig));
  });
}

export const shellTool = {
  name: 'shell',
  description:
    'Run a shell command on the user\'s computer and return its combined stdout and stderr. ' +
    'Commands run in the workspace directory (use the `cwd` parameter for another directory instead of `cd`). ' +
    'Each call starts a fresh shell: variables and `cd` do not carry over. ' +
    'Use it for builds, tests, git, package managers and anything the other tools do not cover. ' +
    'Prefer read_file, list_dir, glob and grep for reading and searching files. ' +
    'Commands must not wait for keyboard input. ' +
    (IS_WINDOWS
      ? 'Commands run in PowerShell, so use PowerShell syntax. To start a long-running process such as a dev server, ' +
        'start it in the background: `Start-Process npm -ArgumentList "run","dev" -RedirectStandardOutput dev.log -WindowStyle Hidden`.'
      : 'To start a long-running process such as a dev server, run it in the background and redirect its output: `nohup npm run dev > dev.log 2>&1 &`.'),
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      description: { type: 'string', description: 'A few words on what this command does, shown to the user.' },
      cwd: { type: 'string', description: 'Directory to run in. Defaults to the workspace directory.' },
      timeout_ms: {
        type: 'integer',
        description: `Time limit in milliseconds (default ${DEFAULT_TIMEOUT}, maximum ${MAX_TIMEOUT}).`,
      },
    },
    required: ['command'],
  },
  kind: 'exec',
  describe: (args) => ({ title: args.description || 'Run a command', detail: args.command }),
  async run(args, ctx) {
    const cwd = args.cwd ? path.resolve(ctx.cwd, expandHome(args.cwd)) : ctx.cwd;
    if (!fs.existsSync(cwd)) return { content: `Error: directory does not exist: ${cwd}`, is_error: true };
    const timeout = Math.min(Math.max(args.timeout_ms || DEFAULT_TIMEOUT, 1000), MAX_TIMEOUT);
    let result;
    try {
      result = await runCommand(args.command, { cwd, timeout, signal: ctx.signal, onChunk: ctx.emit });
    } catch (err) {
      return { content: `Error: could not start the command: ${err.message}`, is_error: true };
    }
    let text = truncateMiddle(result.output.trimEnd(), MAX_RESULT_CHARS) || '(no output)';
    if (result.cancelled) text += '\n[cancelled by the user]';
    else if (result.timedOut) {
      text += `\n[timed out after ${Math.round(timeout / 1000)}s and was stopped. For long-running processes, run them in the background.]`;
    } else if (result.exitCode !== 0) {
      text += `\n[exit code: ${result.exitCode ?? result.exitSignal}]`;
    }
    return {
      content: text,
      is_error: result.timedOut || result.cancelled,
      display: { type: 'shell', exitCode: result.exitCode, timedOut: result.timedOut },
    };
  },
};

/**
 * Commands that only read files inside the workspace. They run without
 * asking, even in "ask" mode. Deliberately narrow: one simple command, no
 * pipes, redirects, substitutions or chaining, no paths that leave the
 * workspace, and no option that writes a file or starts another program.
 */
const READ_ONLY = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'stat', 'du', 'df', 'which', 'whoami', 'uname', 'id',
  'echo', 'grep', 'rg', 'diff', 'cut', 'basename', 'dirname', 'realpath',
]);
const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'ls-files', 'blame', 'describe', 'tag']);
const LIST_ONLY_FLAGS = /^(-v|-vv|-a|-r|-l|--list|--show-current)$/;

export function isReadOnlyCommand(command) {
  const text = String(command).trim();
  if (!text || /[;&|<>`$(){}\n\\~!]/.test(text)) return false;
  const words = text.split(/\s+/);
  const name = words[0];
  const rest = words.slice(1);
  for (const w of rest) {
    const bare = w.replace(/^["']|["']$/g, '');
    if (bare.startsWith('-')) {
      if (/^--?(pre|pre-glob|hostname-bin|output|o|exec|ext-diff)\b/.test(bare)) return false;
    } else if (bare.startsWith('/') || bare.split('/').includes('..')) {
      return false; // outside the workspace: ask
    }
  }
  if (name === 'git') {
    const sub = rest[0];
    if (!READ_ONLY_GIT.has(sub)) return false; // also rejects `git -c ... status`
    // `git branch -D x`, `git tag -d x`, `git remote add` change things.
    if (['branch', 'tag', 'remote'].includes(sub) && !rest.slice(1).every((w) => LIST_ONLY_FLAGS.test(w))) return false;
    return true;
  }
  return READ_ONLY.has(name);
}
