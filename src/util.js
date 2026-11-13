// Small shared helpers. No dependencies.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of the installed app (the folder that holds package.json). */
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;

/** Where Seed keeps its data: config, conversations, extensions. */
export function resolveHome(custom) {
  return path.resolve(custom || process.env.SEED_HOME || path.join(os.homedir(), '.seed'));
}

export function newId(prefix = '') {
  return prefix + crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x');
}

export function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

export function readJsonSync(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read ${file}: ${err.message}`);
  }
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read ${file}: ${err.message}`);
  }
}

/** Write through a temporary file so a crash never leaves a half-written file. */
export async function writeFileAtomic(file, data, options = {}) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, data, options);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export function writeJsonAtomic(file, value, options = {}) {
  return writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n', options);
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(message = 'Aborted') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function isAbort(err) {
  return !!err && (err.name === 'AbortError' || err.name === 'APIUserAbortError' || err.code === 'ABORT_ERR');
}

/** Keep the head and the tail of a long text; say how much was cut. */
export function truncateMiddle(text, max, label = 'characters') {
  if (typeof text !== 'string' || text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  const cut = text.length - max;
  return `${text.slice(0, head)}\n\n[... ${cut} ${label} truncated ...]\n\n${text.slice(text.length - tail)}`;
}

// eslint-disable-next-line no-control-regex
const ANSI = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text) {
  return text.replace(ANSI, '');
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deep merge of plain objects; arrays and scalars are replaced. `null` deletes a key. */
export function deepMerge(target, patch) {
  if (!isPlainObject(patch)) return patch;
  const out = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (value === null) delete out[key];
    else if (isPlainObject(value)) out[key] = deepMerge(out[key], value);
    else out[key] = value;
  }
  return out;
}

/** True when `child` is `parent` or inside it (lexical check on resolved paths). */
export function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * The real location of a path, following symlinks. Works for paths that do
 * not exist yet: the nearest existing parent is resolved and the rest appended.
 */
export function canonicalPath(p) {
  let current = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/** Rough token estimate for providers that report no usage. */
export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let cjk = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x2e80) cjk++;
  return Math.ceil((text.length - cjk) / 3.6 + cjk / 1.3);
}

export function homeRelative(p) {
  const home = os.homedir();
  return p === home ? '~' : p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

export function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}
