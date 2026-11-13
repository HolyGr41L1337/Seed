import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { checkInput, contextMessages, repairHistory, userContent } from '../src/agent/messages.js';
import { categoryOf, decide } from '../src/agent/permissions.js';
import { sseData } from '../src/providers/sse.js';
import { newMessage } from '../src/store.js';
import { editFileTool, listDirTool, readFileTool, writeFileTool } from '../src/tools/files.js';
import { globToRegExp, globTool, grepTool } from '../src/tools/search.js';
import { isReadOnlyCommand, shellTool } from '../src/tools/shell.js';
import { htmlToText } from '../src/tools/web.js';
import { deepMerge, isInside, truncateMiddle } from '../src/util.js';

let dir;
let ctx;

before(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'seed-tools-')));
  ctx = { cwd: dir, protectedFiles: [path.join(dir, 'secret', 'config.json')], emit() {} };
  await fsp.mkdir(path.join(dir, 'src/deep'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'node_modules/pkg'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'secret'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'secret/config.json'), '{"apiKey":"sk-secret"}');
  await fsp.writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  await fsp.writeFile(path.join(dir, 'src/main.js'), 'const a = 1;\nfunction hello() {\n  return a;\n}\n');
  await fsp.writeFile(path.join(dir, 'src/deep/util.ts'), 'export const TODO = "fix me";\n');
  await fsp.writeFile(path.join(dir, 'node_modules/pkg/index.js'), 'function hello() {}\n');
  await fsp.writeFile(path.join(dir, 'win.txt'), 'first\r\nsecond\r\nthird\r\n');
  await fsp.writeFile(path.join(dir, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
});

after(() => fsp.rm(dir, { recursive: true, force: true }));

describe('file tools', () => {
  it('reads with line numbers, offset and limit', async () => {
    const all = await readFileTool.run({ path: 'a.txt' }, ctx);
    assert.equal(all.content, '     1\tone\n     2\ttwo\n     3\tthree');
    const part = await readFileTool.run({ path: 'a.txt', offset: 2, limit: 1 }, ctx);
    assert.match(part.content, /^ {5}2\ttwo\n\n\[Showing lines 2-2 of 3\. Continue with offset=3\.\]$/);
  });

  it('refuses binary files, directories, missing files and the protected config', async () => {
    assert.match((await readFileTool.run({ path: 'bin.dat' }, ctx)).content, /binary file/);
    assert.equal((await readFileTool.run({ path: 'src' }, ctx)).is_error, true);
    assert.match((await readFileTool.run({ path: 'nope.txt' }, ctx)).content, /file not found/);
    const blocked = await readFileTool.run({ path: 'secret/config.json' }, ctx);
    assert.equal(blocked.is_error, true);
    assert.doesNotMatch(blocked.content, /sk-secret/);
    assert.equal((await writeFileTool.run({ path: 'secret/config.json', content: '{}' }, ctx)).is_error, true);
    assert.equal((await editFileTool.run({ path: 'secret/config.json', old_string: 'sk', new_string: 'x' }, ctx)).is_error, true);
  });

  it('writes files and creates parent folders', async () => {
    const created = await writeFileTool.run({ path: 'new/dir/file.txt', content: 'hello\n' }, ctx);
    assert.match(created.content, /^Created new\/dir\/file\.txt \(1 lines\)/);
    assert.equal(await fsp.readFile(path.join(dir, 'new/dir/file.txt'), 'utf8'), 'hello\n');
    const replaced = await writeFileTool.run({ path: 'new/dir/file.txt', content: 'a\nb\n' }, ctx);
    assert.match(replaced.content, /^Replaced .* \(1 → 2 lines\)/);
  });

  it('edits exactly one place and explains failures', async () => {
    const ok = await editFileTool.run({ path: 'src/main.js', old_string: 'return a;', new_string: 'return a + 1;' }, ctx);
    assert.match(ok.content, /Edited src\/main\.js \(1 replacement\)/);
    assert.match(ok.content, /3\t {2}return a \+ 1;/);
    assert.match(await fsp.readFile(path.join(dir, 'src/main.js'), 'utf8'), /return a \+ 1;/);

    assert.match((await editFileTool.run({ path: 'src/main.js', old_string: 'nothing here', new_string: 'x' }, ctx)).content, /was not found/);
    assert.match((await editFileTool.run({ path: 'src/main.js', old_string: '     2\tfunction hello', new_string: 'x' }, ctx)).content, /line-number prefixes/);
    await fsp.writeFile(path.join(dir, 'dup.txt'), 'x\nx\nx\n');
    assert.match((await editFileTool.run({ path: 'dup.txt', old_string: 'x', new_string: 'y' }, ctx)).content, /occurs 3 times/);
    const all = await editFileTool.run({ path: 'dup.txt', old_string: 'x', new_string: 'y', replace_all: true }, ctx);
    assert.match(all.content, /3 replacements/);
    assert.equal(await fsp.readFile(path.join(dir, 'dup.txt'), 'utf8'), 'y\ny\ny\n');
  });

  it('keeps Windows line endings when editing', async () => {
    const res = await editFileTool.run({ path: 'win.txt', old_string: 'first\nsecond', new_string: 'FIRST\nSECOND' }, ctx);
    assert.ok(!res.is_error, res.content);
    assert.equal(await fsp.readFile(path.join(dir, 'win.txt'), 'utf8'), 'FIRST\r\nSECOND\r\nthird\r\n');
  });

  it('lists directories as a tree without expanding dependency folders', async () => {
    const flat = await listDirTool.run({}, ctx);
    assert.match(flat.content, /src\/\n/);
    assert.match(flat.content, /a\.txt {2}\(14 B\)/);
    const tree = await listDirTool.run({ depth: 3 }, ctx);
    assert.match(tree.content, /src\/\n {2}deep\/\n {4}util\.ts/);
    assert.match(tree.content, /node_modules\/\n/);
    assert.doesNotMatch(tree.content, /pkg/);
  });
});

describe('search tools', () => {
  it('translates globs', () => {
    assert.ok(globToRegExp('**/*.js').test('src/main.js'));
    assert.ok(globToRegExp('*.js').test('src/deep/x.js'), 'a bare name matches at any depth');
    assert.ok(globToRegExp('src/*.js').test('src/main.js'));
    assert.ok(!globToRegExp('src/*.js').test('src/deep/main.js'));
    assert.ok(globToRegExp('*.{ts,tsx}').test('a/b.tsx'));
    assert.ok(!globToRegExp('*.{ts,tsx}').test('a/b.js'));
    assert.ok(globToRegExp('src/**').test('src/deep/util.ts'));
  });

  it('finds files and skips node_modules unless named', async () => {
    const js = await globTool.run({ pattern: '**/*.js' }, ctx);
    assert.match(js.content, /src\/main\.js/);
    assert.doesNotMatch(js.content, /node_modules/);
    const named = await globTool.run({ pattern: 'node_modules/**/*.js' }, ctx);
    assert.match(named.content, /node_modules\/pkg\/index\.js/);
    assert.match((await globTool.run({ pattern: '*.nothing' }, ctx)).content, /No files match/);
  });

  it('greps with path:line output, filters and context', async () => {
    const hits = await grepTool.run({ pattern: 'function hello' }, ctx);
    assert.match(hits.content, /src\/main\.js:2:\s?function hello\(\) \{/);
    assert.doesNotMatch(hits.content, /node_modules/);
    const filtered = await grepTool.run({ pattern: 'todo', ignore_case: true, glob: '*.ts' }, ctx);
    assert.match(filtered.content, /util\.ts:1:/);
    assert.match((await grepTool.run({ pattern: 'zzz-not-there' }, ctx)).content, /No matches/);
    assert.equal((await grepTool.run({ pattern: '(' }, ctx)).is_error, true);
  });
});

describe('shell', () => {
  it('returns output and the exit code', async () => {
    const ok = await shellTool.run({ command: 'echo hi && echo err >&2' }, ctx);
    assert.equal(ok.content, 'hi\nerr');
    const failed = await shellTool.run({ command: 'echo before; exit 3' }, ctx);
    assert.match(failed.content, /before\n\[exit code: 3\]/);
    assert.ok(!failed.is_error, 'a failing command is a result, not a tool error');
  });

  it('runs in the workspace and streams output', async () => {
    const chunks = [];
    const res = await shellTool.run({ command: 'pwd' }, { ...ctx, emit: (t) => chunks.push(t) });
    assert.equal(res.content, dir);
    assert.equal(chunks.join('').trim(), dir);
  });

  it('times out and can be cancelled', async () => {
    const slow = await shellTool.run({ command: 'sleep 5', timeout_ms: 1000 }, ctx);
    assert.match(slow.content, /timed out after 1s/);
    assert.equal(slow.is_error, true);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const cancelled = await shellTool.run({ command: 'sleep 5' }, { ...ctx, signal: controller.signal });
    assert.match(cancelled.content, /cancelled by the user/);
  });

  it('classifies read-only commands narrowly', () => {
    for (const c of ['ls -la', 'cat src/a.js', 'git status', 'git log --oneline -5', 'git diff', 'grep -rn foo src', 'head -n 5 README.md', 'git branch -a']) {
      assert.equal(isReadOnlyCommand(c), true, c);
    }
    for (const c of [
      'rm -rf x', 'ls; rm x', 'cat /etc/passwd', 'cat ../x', 'cat ~/.ssh/id_rsa', 'echo hi > f', 'ls $(rm x)', 'git push', 'git -c core.pager=x status',
      'git log --output=x', 'git branch -D foo', 'rg --pre cat foo', 'env', 'npm test', 'ls | sh', 'cat a && rm b', 'git remote add x y',
    ]) {
      assert.equal(isReadOnlyCommand(c), false, c);
    }
  });
});

describe('approval policy', () => {
  const roots = { cwd: '/work/project', extensionsDir: '/home/u/.seed/extensions', appDir: '/opt/seed' };
  const cat = (d) => categoryOf(d, roots);

  it('sorts calls into categories', () => {
    assert.equal(cat({ kind: 'read', paths: ['/work/project/a.js'] }), null);
    assert.equal(cat({ kind: 'read', paths: ['/opt/seed/docs/EXTENDING.md'] }), null);
    assert.equal(cat({ kind: 'read', paths: ['/etc/passwd'] }), 'read');
    assert.equal(cat({ kind: 'read' }), null);
    assert.equal(cat({ kind: 'write', paths: ['/work/project/a.js'] }), 'write');
    assert.equal(cat({ kind: 'write', paths: ['/work/other/a.js'] }), 'write_outside');
    assert.equal(cat({ kind: 'write', paths: ['/work/project-evil/a.js'] }), 'write_outside');
    assert.equal(cat({ kind: 'write', paths: ['/home/u/.seed/extensions/x/client.js'] }), 'extension');
    assert.equal(cat({ kind: 'exec', command: 'npm test' }), 'exec');
    assert.equal(cat({ kind: 'exec', command: 'git status' }), null);
    assert.equal(cat({ kind: 'network', url: 'https://example.com' }), 'network');
    assert.equal(cat({ kind: 'app' }), 'app');
    assert.equal(cat({ kind: 'something-else' }), 'exec');
  });

  it('judges a path by where it really is, not by a symlink\'s name', async () => {
    const outside = await fsp.realpath(await fsp.mkdtemp(path.join(os.homedir(), '.seed-test-outside-')));
    try {
      await fsp.symlink(outside, path.join(dir, 'link-out'));
      const here = { cwd: dir, extensionsDir: path.join(outside, 'no-extensions'), appDir: path.join(outside, 'no-app') };
      assert.equal(categoryOf({ kind: 'write', paths: [path.join(dir, 'plain.txt')] }, here), 'write');
      assert.equal(categoryOf({ kind: 'write', paths: [path.join(dir, 'link-out', 'x.txt')] }, here), 'write_outside');
      assert.equal(categoryOf({ kind: 'write', paths: [path.join(dir, 'link-out', 'new', 'deep', 'x.txt')] }, here), 'write_outside');
      assert.equal(categoryOf({ kind: 'read', paths: [path.join(dir, 'link-out', 'x.txt')] }, here), 'read');
      // The protected config file stays protected when reached through a link.
      await fsp.symlink(path.join(dir, 'secret'), path.join(dir, 'link-secret'));
      const viaLink = await readFileTool.run({ path: 'link-secret/config.json' }, ctx);
      assert.equal(viaLink.is_error, true);
      assert.doesNotMatch(viaLink.content, /sk-secret/);
    } finally {
      await fsp.rm(path.join(dir, 'link-out'), { force: true });
      await fsp.rm(path.join(dir, 'link-secret'), { force: true });
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it('applies the three modes and grants', () => {
    const d = (mode, descriptor, grants) => decide({ mode, descriptor, grants, roots }).decision;
    const write = { kind: 'write', paths: ['/work/project/a.js'] };
    const ext = { kind: 'write', paths: ['/home/u/.seed/extensions/x/server.js'] };
    const exec = { kind: 'exec', command: 'npm test' };
    assert.equal(d('ask', write), 'ask');
    assert.equal(d('ask', write, { write: true }), 'allow');
    assert.equal(d('auto-edit', write), 'allow');
    assert.equal(d('auto-edit', ext), 'ask', 'extension code is not an ordinary edit');
    assert.equal(d('auto-edit', exec), 'ask');
    assert.equal(d('auto-edit', { kind: 'network' }), 'ask');
    assert.equal(d('ask', exec, { exec: true }), 'allow');
    assert.equal(d('full', exec), 'allow');
    assert.equal(d('full', ext), 'allow');
    assert.equal(d('ask', { kind: 'read', paths: ['/work/project/x'] }), 'allow');
    assert.equal(d('ask', { kind: 'read', paths: ['/etc/hosts'] }), 'ask');
  });
});

describe('messages', () => {
  it('validates and gently coerces tool input', () => {
    const schema = {
      type: 'object',
      properties: { path: { type: 'string' }, limit: { type: 'integer' }, all: { type: 'boolean' }, mode: { type: 'string', enum: ['a', 'b'] }, items: { type: 'array', items: { type: 'string' } } },
      required: ['path'],
    };
    assert.deepEqual(checkInput(schema, { path: 'x', limit: '20', all: 'true' }).value, { path: 'x', limit: 20, all: true });
    assert.deepEqual(checkInput(schema, { path: 'x', limit: null }).value, { path: 'x' });
    assert.match(checkInput(schema, {}).error, /input\.path is required/);
    assert.match(checkInput(schema, { path: 5 }).error, /input\.path must be string, got integer/);
    assert.match(checkInput(schema, { path: 'x', mode: 'c' }).error, /must be one of "a", "b"/);
    assert.match(checkInput(schema, { path: 'x', items: ['a', 2] }).error, /input\.items\[1\] must be string/);
    assert.match(checkInput(schema, 'not an object').error, /input must be object/);
    assert.deepEqual(checkInput({ type: 'object', properties: {} }, {}).value, {});
  });

  it('accepts user content as text or blocks', () => {
    assert.deepEqual(userContent('hi'), [{ type: 'text', text: 'hi' }]);
    assert.deepEqual(userContent([{ type: 'text', text: 'a' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }]).map((b) => b.type), ['text', 'image']);
    assert.throws(() => userContent('   '), /empty/);
    assert.throws(() => userContent([{ type: 'video' }]), /Unsupported/);
  });

  it('repairs unanswered tool calls', () => {
    const messages = [
      newMessage('user', [{ type: 'text', text: 'go' }]),
      newMessage('assistant', [{ type: 'tool_use', id: 't1', name: 'shell', input: {} }, { type: 'tool_use', id: 't2', name: 'shell', input: {} }]),
      newMessage('notice', [{ type: 'text', text: 'oops' }]),
    ];
    assert.equal(repairHistory(messages, newMessage), true);
    assert.equal(messages[2].role, 'user');
    assert.deepEqual(messages[2].content.map((b) => b.tool_use_id), ['t1', 't2']);
    assert.equal(repairHistory(messages, newMessage), false, 'idempotent');

    const partial = [
      newMessage('assistant', [{ type: 'tool_use', id: 'a', name: 'x', input: {} }, { type: 'tool_use', id: 'b', name: 'x', input: {} }]),
      newMessage('user', [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }]),
    ];
    repairHistory(partial, newMessage);
    assert.deepEqual(partial[1].content.map((b) => b.tool_use_id).sort(), ['a', 'b']);
  });

  it('builds the model context from the summary plus later messages, without notices', () => {
    const conv = {
      messages: [
        newMessage('user', [{ type: 'text', text: 'old' }]),
        newMessage('assistant', [{ type: 'text', text: 'old answer' }]),
        newMessage('notice', [{ type: 'text', text: 'compacted' }]),
        newMessage('user', [{ type: 'text', text: 'new' }]),
      ],
      context: null,
    };
    assert.equal(contextMessages(conv).length, 3);
    conv.context = { summary: 'SUMMARY', from: 3, midRun: false };
    const ctxMessages = contextMessages(conv);
    assert.equal(ctxMessages.length, 2);
    assert.match(ctxMessages[0].content[0].text, /<summary>\nSUMMARY\n<\/summary>/);
    assert.equal(ctxMessages[1].content[0].text, 'new');
  });
});

describe('small utilities', () => {
  it('parses server-sent events', async () => {
    async function* chunks() {
      const enc = new TextEncoder();
      yield enc.encode('data: {"a":1}\n\n: comment\n\nda');
      yield enc.encode('ta: two\r\n\r\nevent: x\ndata: line1\ndata: line2\n\ndata: [DONE]\n\n');
      yield enc.encode('data: tail');
    }
    const out = [];
    for await (const d of sseData(chunks())) out.push(d);
    assert.deepEqual(out, ['{"a":1}', 'two', 'line1\nline2', '[DONE]', 'tail']);
  });

  it('converts HTML to readable text', () => {
    const text = htmlToText('<html><head><title>T &amp; C</title><style>p{}</style></head><body><h1>Hi</h1><script>x()</script><p>One <a href="https://a.b/c">link</a>.</p><ul><li>a</li><li>b</li></ul></body></html>');
    assert.match(text, /^# T & C/);
    assert.match(text, /# Hi/);
    assert.match(text, /One link \(https:\/\/a\.b\/c\)\./);
    assert.match(text, /- a\n- b/);
    assert.doesNotMatch(text, /x\(\)|p\{\}/);
  });

  it('merges, truncates and compares paths', () => {
    assert.deepEqual(deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { b: null, e: 3 }, d: [2] }), { a: { c: 2, e: 3 }, d: [2] });
    const cut = truncateMiddle('a'.repeat(1000), 100);
    assert.ok(cut.length < 200 && cut.includes('900 characters truncated'));
    assert.equal(isInside('/a/b', '/a/b/c'), true);
    assert.equal(isInside('/a/b', '/a/b'), true);
    assert.equal(isInside('/a/b', '/a/bc'), false);
    assert.equal(isInside('/a/b', '/a'), false);
  });
});
