// Search tools: glob (find files by name) and grep (find text in files).
import { spawn, spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { IGNORED_DIRS, displayPath, resolveToolPath } from './files.js';

const MAX_WALK = 50_000;

/** Translate a glob (`**`, `*`, `?`, `{a,b}`, `[abc]`) into a RegExp over "/"-separated relative paths. */
export function globToRegExp(glob) {
  let pattern = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!pattern.includes('/')) pattern = `**/${pattern}`; // a bare name matches at any depth
  let re = '';
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      re += '(?:';
      braces++;
    } else if (c === '}' && braces) {
      re += ')';
      braces--;
    } else if (c === ',' && braces) re += '|';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else {
        re += `[${pattern.slice(i + 1, end).replace(/\\/g, '\\\\').replace(/^!/, '^')}]`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Walk a directory tree, skipping dependency and VCS folders. Yields { rel, abs }. */
export async function* walkFiles(root, { includeIgnored = () => false } = {}) {
  let seen = 0;
  const stack = [''];
  while (stack.length) {
    const relDir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name) || includeIgnored(e.name)) stack.push(rel);
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (++seen > MAX_WALK) return;
        yield { rel, abs: path.join(root, rel) };
      }
    }
  }
}

export const globTool = {
  name: 'glob',
  description:
    'Find files by name pattern, newest first. Supports `**` (any folders), `*`, `?` and `{a,b}`: ' +
    'for example "src/**/*.ts" or "*.{json,yaml}". A pattern without "/" matches at any depth. ' +
    'Dependency and VCS folders (node_modules, .git, ...) are skipped unless the pattern names them.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, relative to `path`.' },
      path: { type: 'string', description: 'Directory to search. Defaults to the workspace directory.' },
    },
    required: ['pattern'],
  },
  kind: (args, ctx) => ({ kind: 'read', paths: [resolveToolPath(ctx, args.path)] }),
  describe: (args) => ({ title: 'Find files', detail: args.pattern }),
  async run(args, ctx) {
    const root = resolveToolPath(ctx, args.path);
    let re;
    try {
      re = globToRegExp(args.pattern);
    } catch (err) {
      return { content: `Error: invalid pattern: ${err.message}`, is_error: true };
    }
    const named = (name) => args.pattern.split(/[\\/]/).includes(name);
    const hits = [];
    for await (const f of walkFiles(root, { includeIgnored: named })) {
      if (!re.test(f.rel)) continue;
      let mtime = 0;
      try {
        mtime = (await fsp.stat(f.abs)).mtimeMs;
      } catch {
        /* vanished */
      }
      hits.push({ ...f, mtime });
    }
    if (!hits.length) return { content: `No files match "${args.pattern}" in ${displayPath(ctx, root)}.` };
    hits.sort((a, b) => b.mtime - a.mtime);
    const shown = hits.slice(0, 200).map((h) => displayPath(ctx, h.abs));
    return { content: shown.join('\n') + (hits.length > 200 ? `\n[... ${hits.length - 200} more not shown; narrow the pattern]` : '') };
  },
};

let ripgrep; // undefined = not checked yet
function hasRipgrep() {
  if (ripgrep === undefined) {
    try {
      ripgrep = spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;
    } catch {
      ripgrep = false;
    }
  }
  return ripgrep;
}

export const grepTool = {
  name: 'grep',
  description:
    'Search file contents with a regular expression. Returns matching lines as "path:line:text". ' +
    'Searches the workspace recursively by default (dependency and VCS folders such as node_modules and .git are skipped); ' +
    'narrow it with `path` (a file or directory) and `glob` (for example "*.py"). ' +
    'Escape regex metacharacters to search for literal text, e.g. "foo\\\\(" to find "foo(".',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the workspace directory.' },
      glob: { type: 'string', description: 'Only search files whose name matches this glob.' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive search.' },
      context: { type: 'integer', description: 'Lines of context to show around each match (0-5).' },
      max_results: { type: 'integer', description: 'Maximum number of output lines (default 100, maximum 500).' },
    },
    required: ['pattern'],
  },
  kind: (args, ctx) => ({ kind: 'read', paths: [resolveToolPath(ctx, args.path)] }),
  describe: (args) => ({ title: 'Search in files', detail: args.pattern }),
  async run(args, ctx) {
    const target = resolveToolPath(ctx, args.path);
    const max = Math.min(Math.max(args.max_results || 100, 1), 500);
    const context = Math.min(Math.max(args.context || 0, 0), 5);
    try {
      await fsp.access(target);
    } catch {
      return { content: `Error: path not found: ${target}`, is_error: true };
    }
    const result = hasRipgrep()
      ? await grepWithRipgrep(args, ctx, target, max, context)
      : await grepInProcess(args, ctx, target, max, context);
    if (result.error) return { content: `Error: ${result.error}`, is_error: true };
    if (!result.lines.length) return { content: `No matches for /${args.pattern}/ in ${displayPath(ctx, target)}.` };
    return {
      content: result.lines.join('\n') + (result.more ? `\n[... more matches not shown; narrow the search or raise max_results]` : ''),
    };
  },
};

function grepWithRipgrep(args, ctx, target, max, context) {
  return new Promise((resolve) => {
    const rgArgs = ['--line-number', '--no-heading', '--with-filename', '--color', 'never', '--max-columns', '300', '--max-columns-preview'];
    if (args.ignore_case) rgArgs.push('-i');
    if (context) rgArgs.push('-C', String(context));
    if (args.glob) rgArgs.push('-g', args.glob);
    // Same folders the built-in search skips, whether or not a .gitignore lists them.
    for (const name of IGNORED_DIRS) rgArgs.push('-g', `!**/${name}/**`);
    rgArgs.push('-e', args.pattern, '--', target);
    const child = spawn('rg', rgArgs, { cwd: ctx.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = [];
    let pending = '';
    let stderr = '';
    let more = false;
    const onAbort = () => child.kill();
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (buf) => {
      pending += buf.toString('utf8');
      const parts = pending.split('\n');
      pending = parts.pop();
      for (const line of parts) {
        if (lines.length >= max) {
          more = true;
          child.kill();
          return;
        }
        lines.push(relativize(line, ctx));
      }
    });
    child.stderr.on('data', (buf) => (stderr += buf.toString('utf8')));
    child.on('error', (err) => resolve({ error: err.message }));
    child.on('close', (code) => {
      ctx.signal?.removeEventListener('abort', onAbort);
      if (pending && lines.length < max) lines.push(relativize(pending, ctx));
      if (code === 2 && !lines.length) return resolve({ error: stderr.trim().split('\n').slice(0, 5).join('\n') || 'search failed' });
      resolve({ lines, more });
    });
  });
}

function relativize(line, ctx) {
  const prefix = ctx.cwd.endsWith(path.sep) ? ctx.cwd : ctx.cwd + path.sep;
  return line.startsWith(prefix) ? line.slice(prefix.length) : line;
}

async function grepInProcess(args, ctx, target, max, context) {
  let re;
  try {
    re = new RegExp(args.pattern, args.ignore_case ? 'i' : '');
  } catch (err) {
    return { error: `invalid regular expression: ${err.message}` };
  }
  const nameRe = args.glob ? globToRegExp(args.glob) : null;
  const lines = [];
  let more = false;

  const searchFile = async (abs) => {
    let buf;
    try {
      const stat = await fsp.stat(abs);
      if (stat.size > 2 * 1024 * 1024) return;
      buf = await fsp.readFile(abs);
    } catch {
      return;
    }
    if (buf.subarray(0, 4096).includes(0)) return;
    const rows = buf.toString('utf8').split('\n');
    const shown = displayPath(ctx, abs);
    let lastPrinted = -1;
    for (let i = 0; i < rows.length; i++) {
      if (!re.test(rows[i])) continue;
      const from = Math.max(lastPrinted + 1, i - context);
      const to = Math.min(rows.length - 1, i + context);
      for (let j = from; j <= to; j++) {
        if (lines.length >= max) {
          more = true;
          return;
        }
        const text = rows[j].length > 300 ? rows[j].slice(0, 300) + '…' : rows[j];
        lines.push(`${shown}${j === i ? ':' : '-'}${j + 1}${j === i ? ':' : '-'}${text}`);
      }
      lastPrinted = to;
    }
  };

  const stat = await fsp.stat(target);
  if (stat.isFile()) await searchFile(target);
  else {
    for await (const f of walkFiles(target)) {
      if (ctx.signal?.aborted || more) break;
      if (nameRe && !nameRe.test(f.rel)) continue;
      await searchFile(f.abs);
    }
  }
  return { lines, more };
}
