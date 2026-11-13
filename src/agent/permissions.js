// Approval policy: decides whether a tool call runs straight away or waits
// for the user. Pure functions, so the rules are easy to read and to test.
//
// Modes
//   ask        every change waits for approval (commands, file edits, network, app changes)
//   auto-edit  file edits inside the workspace run without asking; the rest still asks
//   full       nothing asks
//
// Reads inside the workspace never ask. Each approval prompt offers
// "always allow" for its category within the conversation (a grant).
import os from 'node:os';
import { canonicalPath, isInside } from '../util.js';
import { isReadOnlyCommand } from '../tools/shell.js';

export const CATEGORIES = ['read', 'write', 'write_outside', 'extension', 'exec', 'network', 'app'];

/** Turn a tool's `kind` into { kind, paths?, command?, url? }. */
export function describeCall(tool, args, ctx) {
  let d = typeof tool.kind === 'function' ? tool.kind(args, ctx) : tool.kind;
  if (typeof d === 'string') d = { kind: d };
  if (!d || typeof d.kind !== 'string') d = { kind: 'exec' };
  if (d.kind === 'exec' && d.command === undefined && typeof args?.command === 'string') d = { ...d, command: args.command };
  return d;
}

/**
 * @param {{ kind: string, paths?: string[], command?: string }} d
 * @param {{ cwd: string, extensionsDir: string, appDir: string }} roots
 * @returns {string|null} the approval category, or null when no approval is ever needed
 */
export function categoryOf(d, roots) {
  // Compare real locations, so a symlink inside the workspace cannot pass
  // for a workspace file while pointing somewhere else.
  const real = (p) => canonicalPath(p);
  const tmp = real(os.tmpdir());
  const cwd = real(roots.cwd);
  const extensionsDir = real(roots.extensionsDir);
  const paths = (d.paths || []).map(real);
  switch (d.kind) {
    case 'read': {
      const open = [cwd, real(roots.appDir), extensionsDir, tmp];
      return paths.every((p) => open.some((root) => isInside(root, p))) ? null : 'read';
    }
    case 'write': {
      // Extension code runs with the user's full authority, so editing it is its own category.
      if (paths.some((p) => isInside(extensionsDir, p))) return 'extension';
      return paths.every((p) => isInside(cwd, p) || isInside(tmp, p)) ? 'write' : 'write_outside';
    }
    case 'exec':
      return d.command !== undefined && isReadOnlyCommand(d.command) ? null : 'exec';
    case 'network':
      return 'network';
    case 'app':
      return 'app';
    default:
      return 'exec';
  }
}

/**
 * @returns {{ decision: 'allow' | 'ask', category: string|null }}
 */
export function decide({ mode, descriptor, grants = {}, roots }) {
  const category = categoryOf(descriptor, roots);
  if (category === null || mode === 'full' || grants[category]) return { decision: 'allow', category };
  if (mode === 'auto-edit' && category === 'write') return { decision: 'allow', category };
  return { decision: 'ask', category };
}
