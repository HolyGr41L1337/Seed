// Test helpers: an app with throw-away data and workspace folders.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { App } from '../../src/app.js';

/**
 * @param {{ providers?: object, model?: string, approval?: string, config?: object, safeMode?: boolean, watch?: boolean }} [o]
 */
export async function makeApp(o = {}) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'seed-home-'));
  const work = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'seed-work-')));
  // Keep the test workspace out of the temp-dir rule ("writes to the temp folder count as workspace writes").
  const app = new App({
    home,
    cwd: work,
    detectEnv: false,
    watch: o.watch === true,
    safeMode: o.safeMode,
    overrides: { server: { port: 0 } },
  });
  const patch = { ...(o.config || {}) };
  if (o.providers) patch.providers = o.providers;
  if (o.model) patch.model = o.model;
  patch.approval = o.approval || 'full';
  await app.config.update(patch);
  await app.init();
  const cleanup = async () => {
    await app.close().catch(() => {});
    await fsp.rm(home, { recursive: true, force: true });
    await fsp.rm(work, { recursive: true, force: true });
  };
  return { app, home, work, cleanup };
}

/** Send one user message and wait for the run to finish. */
export async function chat(app, text, { conv, ...opts } = {}) {
  const conversation = conv || (await app.createConversation({}));
  const events = [];
  const run = await app.runs.start(conversation, {
    content: [{ type: 'text', text }],
    onEvent: (e) => events.push(e),
    ...opts,
  });
  const result = await run.done;
  return { conv: conversation, result, events, run };
}

export function lastAssistantText(conv) {
  const m = conv.messages.findLast((x) => x.role === 'assistant');
  return m ? m.content.filter((b) => b.type === 'text').map((b) => b.text).join('') : '';
}

export function toolResults(conv) {
  return conv.messages.filter((m) => m.role === 'user').flatMap((m) => m.content.filter((b) => b.type === 'tool_result'));
}

export function notices(conv) {
  return conv.messages.filter((m) => m.role === 'notice').map((m) => m.content[0].text);
}

export const openaiProvider = (url, extra = {}) => ({ type: 'openai', name: 'Mock', baseURL: url, apiKey: 'test-key', ...extra });

export async function waitFor(check, { timeout = 3000, every = 15 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, every));
  }
}
