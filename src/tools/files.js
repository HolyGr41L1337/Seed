// File tools: read_file, write_file, edit_file, list_dir.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { canonicalPath, expandHome, isInside, writeFileAtomic } from '../util.js';

const MAX_READ_BYTES = 20 * 1024 * 1024;
const MAX_READ_CHARS = 60_000;
const MAX_LINE_CHARS = 2_000;
const DEFAULT_LINE_LIMIT = 2_000;

export const IGNORED_DIRS = new Set([
  '.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache',
  '.next', '.nuxt', '.turbo', '.gradle', '.idea',
]);

export function resolveToolPath(ctx, p) {
  return path.resolve(ctx.cwd, expandHome(String(p || '.')));
}

/** Short path for messages: relative when inside the workspace. */
export function displayPath(ctx, abs) {
  return isInside(ctx.cwd, abs) ? path.relative(ctx.cwd, abs) || '.' : abs;
}

/** Files the tools never touch, whatever the approval mode: they hold the user's API keys. */
export function protectedReason(ctx, abs) {
  const real = canonicalPath(abs);
  for (const file of ctx.protectedFiles || []) {
    if (canonicalPath(file) === real) {
      return `${abs} holds the user's API keys and access token, so the file tools do not open it. Use the seed_api tool (GET /api/config) to see the configuration without secrets.`;
    }
  }
  return null;
}

function fail(message) {
  return { content: `Error: ${message}`, is_error: true };
}

function describeFsError(err, abs) {
  if (err.code === 'ENOENT') return `file not found: ${abs}`;
  if (err.code === 'EISDIR') return `${abs} is a directory (use list_dir)`;
  if (err.code === 'EACCES' || err.code === 'EPERM') return `permission denied: ${abs}`;
  return err.message;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function countLines(text) {
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

export const readFileTool = {
  name: 'read_file',
  description:
    'Read a text file. Returns the content with line numbers (the number, a tab, then the line; the numbers are not part of the file). ' +
    `Reads up to ${DEFAULT_LINE_LIMIT} lines from the start by default; use offset and limit for other parts of a large file. ` +
    'Paths are relative to the workspace directory unless absolute. Read a file before you edit it.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to read.' },
      offset: { type: 'integer', description: 'First line to return, counted from 1.' },
      limit: { type: 'integer', description: 'Maximum number of lines to return.' },
    },
    required: ['path'],
  },
  kind: (args, ctx) => ({ kind: 'read', paths: [resolveToolPath(ctx, args.path)] }),
  describe: (args) => ({ title: 'Read a file', detail: args.path }),
  async run(args, ctx) {
    const abs = resolveToolPath(ctx, args.path);
    const blocked = protectedReason(ctx, abs);
    if (blocked) return fail(blocked);
    let buf;
    try {
      const stat = await fsp.stat(abs);
      if (stat.isDirectory()) return fail(`${abs} is a directory (use list_dir)`);
      if (stat.size > MAX_READ_BYTES) {
        return fail(`${abs} is ${stat.size} bytes, too large to read at once. Inspect it with shell tools (head, tail, sed -n, grep).`);
      }
      buf = await fsp.readFile(abs);
    } catch (err) {
      return fail(describeFsError(err, abs));
    }
    if (looksBinary(buf)) return { content: `${abs} is a binary file (${buf.length} bytes); its content is not shown.` };
    const text = buf.toString('utf8');
    if (!text) return { content: '(the file is empty)' };

    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const start = Math.max(1, args.offset || 1);
    const limit = Math.max(1, args.limit || DEFAULT_LINE_LIMIT);
    if (start > lines.length) return fail(`offset ${start} is past the end of the file (${lines.length} lines)`);

    const out = [];
    let chars = 0;
    let n = start;
    for (; n <= lines.length && n < start + limit; n++) {
      let line = lines[n - 1];
      if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)}… [line truncated, ${line.length} characters]`;
      const row = `${String(n).padStart(6)}\t${line}`;
      if (chars + row.length > MAX_READ_CHARS && out.length) break;
      out.push(row);
      chars += row.length + 1;
    }
    let result = out.join('\n');
    if (n <= lines.length) {
      result += `\n\n[Showing lines ${start}-${n - 1} of ${lines.length}. Continue with offset=${n}.]`;
    }
    return { content: result };
  },
};

export const writeFileTool = {
  name: 'write_file',
  description:
    'Create a file or replace its whole content. Parent directories are created as needed. ' +
    'To change part of an existing file, use edit_file instead: it is safer and much cheaper than rewriting the file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to write.' },
      content: { type: 'string', description: 'The complete new content of the file.' },
    },
    required: ['path', 'content'],
  },
  kind: (args, ctx) => ({ kind: 'write', paths: [resolveToolPath(ctx, args.path)] }),
  describe: (args) => ({
    title: 'Write a file',
    detail: `${args.path} (${countLines(args.content)} lines)`,
    preview: { type: 'write', path: args.path, content: String(args.content).slice(0, 4000) },
  }),
  async run(args, ctx) {
    const abs = resolveToolPath(ctx, args.path);
    const blocked = protectedReason(ctx, abs);
    if (blocked) return fail(blocked);
    let before = null;
    try {
      before = await fsp.readFile(abs, 'utf8');
    } catch (err) {
      if (err.code === 'EISDIR') return fail(`${abs} is a directory`);
      if (err.code !== 'ENOENT') return fail(describeFsError(err, abs));
    }
    try {
      await writeFileAtomic(abs, args.content);
    } catch (err) {
      return fail(describeFsError(err, abs));
    }
    const lines = countLines(args.content);
    const shown = displayPath(ctx, abs);
    return {
      content: before === null ? `Created ${shown} (${lines} lines).` : `Replaced ${shown} (${countLines(before)} → ${lines} lines).`,
      display: { type: 'write', path: shown, created: before === null, lines },
    };
  },
};

export const editFileTool = {
  name: 'edit_file',
  description:
    'Replace exact text in a file. `old_string` must match the file exactly, including indentation and line breaks, ' +
    'and must identify one place: include enough surrounding lines to make it unique, or set replace_all to change every occurrence. ' +
    'Do not include the line-number prefixes that read_file shows. To create a new file, use write_file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to edit.' },
      old_string: { type: 'string', description: 'The exact text to replace.' },
      new_string: { type: 'string', description: 'The text to put in its place (empty to delete).' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of exactly one.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  kind: (args, ctx) => ({ kind: 'write', paths: [resolveToolPath(ctx, args.path)] }),
  describe: (args) => ({
    title: 'Edit a file',
    detail: args.path,
    preview: { type: 'edit', path: args.path, old: String(args.old_string).slice(0, 4000), new: String(args.new_string).slice(0, 4000) },
  }),
  async run(args, ctx) {
    const abs = resolveToolPath(ctx, args.path);
    const blocked = protectedReason(ctx, abs);
    if (blocked) return fail(blocked);
    let text;
    try {
      text = await fsp.readFile(abs, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT' && args.old_string === '') {
        await writeFileAtomic(abs, args.new_string);
        return { content: `Created ${displayPath(ctx, abs)} (${countLines(args.new_string)} lines).` };
      }
      return fail(describeFsError(err, abs));
    }
    let { old_string: oldText, new_string: newText } = args;
    if (oldText === '') return fail('old_string is empty. Give the exact text to replace, or use write_file to replace the whole file.');
    if (oldText === newText) return fail('old_string and new_string are identical; there is nothing to change.');

    // Files with Windows line endings: match the model's "\n" text against "\r\n".
    if (!text.includes(oldText) && text.includes('\r\n') && !oldText.includes('\r\n')) {
      const crlfOld = oldText.replace(/\n/g, '\r\n');
      if (text.includes(crlfOld)) {
        oldText = crlfOld;
        newText = newText.replace(/\r?\n/g, '\r\n');
      }
    }
    const count = text.split(oldText).length - 1;
    if (count === 0) {
      const hint = /^\s*\d+\t/m.test(oldText) ? ' It looks like old_string contains read_file line-number prefixes; remove them.' : '';
      return fail(
        `old_string was not found in ${displayPath(ctx, abs)}. It must match exactly, including whitespace and indentation.${hint} Read the file again to see its current content.`,
      );
    }
    if (count > 1 && !args.replace_all) {
      return fail(
        `old_string occurs ${count} times in ${displayPath(ctx, abs)}. Add surrounding lines to make it unique, or set replace_all to true.`,
      );
    }
    const at = text.indexOf(oldText);
    const next = args.replace_all ? text.split(oldText).join(newText) : text.slice(0, at) + newText + text.slice(at + oldText.length);
    try {
      await writeFileAtomic(abs, next);
    } catch (err) {
      return fail(describeFsError(err, abs));
    }

    // Show the edited region so the model can check the result without another read.
    const firstLine = text.slice(0, at).split('\n').length;
    const newLines = newText.split('\n').length;
    const all = next.split('\n');
    const from = Math.max(1, firstLine - 3);
    const to = Math.min(all.length, firstLine + newLines + 2);
    const snippet = all
      .slice(from - 1, to)
      .map((l, i) => `${String(from + i).padStart(6)}\t${l.length > 300 ? l.slice(0, 300) + '…' : l}`)
      .join('\n');
    const shown = displayPath(ctx, abs);
    return {
      content: `Edited ${shown} (${args.replace_all ? count : 1} replacement${count > 1 && args.replace_all ? 's' : ''}). The file now reads, around the change:\n${snippet}`,
      display: { type: 'edit', path: shown, old: args.old_string.slice(0, 4000), new: args.new_string.slice(0, 4000), count: args.replace_all ? count : 1 },
    };
  },
};

export const listDirTool = {
  name: 'list_dir',
  description:
    'List a directory. Directories end with "/"; files show their size. ' +
    'With depth 2 or 3 the listing is a tree (dependency and VCS folders such as node_modules and .git are not expanded).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list. Defaults to the workspace directory.' },
      depth: { type: 'integer', description: 'How many levels to show: 1 (default), 2 or 3.' },
    },
  },
  kind: (args, ctx) => ({ kind: 'read', paths: [resolveToolPath(ctx, args.path)] }),
  describe: (args) => ({ title: 'List a directory', detail: args.path || '.' }),
  async run(args, ctx) {
    const abs = resolveToolPath(ctx, args.path);
    const depth = Math.min(Math.max(args.depth || 1, 1), 3);
    const lines = [];
    let truncated = false;
    const MAX = 400;

    const walk = async (dir, level, indent) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (level === 1) throw err;
        return;
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of entries) {
        if (lines.length >= MAX) {
          truncated = true;
          return;
        }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          lines.push(`${indent}${e.name}/`);
          if (level < depth && !IGNORED_DIRS.has(e.name)) await walk(full, level + 1, indent + '  ');
        } else {
          let size = '';
          try {
            size = formatSize((await fsp.stat(full)).size);
          } catch {
            /* broken symlink */
          }
          lines.push(`${indent}${e.name}${size ? `  (${size})` : ''}`);
        }
      }
    };

    try {
      const stat = await fsp.stat(abs);
      if (!stat.isDirectory()) return fail(`${abs} is a file, not a directory`);
      await walk(abs, 1, '');
    } catch (err) {
      return fail(err.code === 'ENOENT' ? `directory not found: ${abs}` : describeFsError(err, abs));
    }
    if (!lines.length) return { content: `${abs} is empty.` };
    return { content: `${abs}\n${lines.join('\n')}${truncated ? `\n[... more entries not shown; list a subdirectory or use glob]` : ''}` };
  },
};

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
