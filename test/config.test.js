import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Config, providersFromEnv, resolveSecret } from '../src/config.js';
import { pickDefaultModel, presetById } from '../src/providers/presets.js';

async function tempHome() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'seed-config-'));
}

describe('configuration', () => {
  it('creates a private config file with an access token', async () => {
    const home = await tempHome();
    const config = new Config(home, { detectEnv: false });
    assert.match(config.server.token, /^[\w-]{20,}$/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(config.file).mode & 0o777, 0o600);
    const again = new Config(home, { detectEnv: false });
    assert.equal(again.server.token, config.server.token, 'the token survives restarts');
    await config.update({ approval: 'auto-edit' });
    if (process.platform !== 'win32') assert.equal(fs.statSync(config.file).mode & 0o777, 0o600);
    await fsp.rm(home, { recursive: true, force: true });
  });

  it('applies command-line overrides without saving them', async () => {
    const home = await tempHome();
    const config = new Config(home, { detectEnv: false, overrides: { server: { port: 9999 }, approval: 'full' } });
    assert.equal(config.server.port, 9999);
    assert.equal(config.approval, 'full');
    assert.equal(JSON.parse(fs.readFileSync(config.file, 'utf8')).server.port, 7333);
    assert.equal(config.data.approval, 'ask');
    await fsp.rm(home, { recursive: true, force: true });
  });

  it('resolves model references', async () => {
    const home = await tempHome();
    const config = new Config(home, { detectEnv: false });
    assert.throws(() => config.resolveModel(), /No model API is connected/);
    await config.update({ providers: { or: { type: 'openai', baseURL: 'https://openrouter.ai/api/v1' } } });
    assert.throws(() => config.resolveModel(), /No model selected/);
    // One provider: a bare id is enough, including ids that contain a slash.
    assert.deepEqual(config.resolveModel('anthropic/claude-x').ref, 'or/anthropic/claude-x');
    assert.deepEqual(config.resolveModel('or/anthropic/claude-x').model, 'anthropic/claude-x');
    await config.update({ providers: { ds: { type: 'openai', baseURL: 'https://api.deepseek.com' } }, model: 'ds/deepseek-chat' });
    assert.equal(config.resolveModel().providerId, 'ds');
    assert.throws(() => config.resolveModel('nope/model'), /Unknown provider/);
    assert.throws(() => config.resolveModel('bare-model'), /Unknown provider/);
    await fsp.rm(home, { recursive: true, force: true });
  });

  it('reads secrets from the environment when asked to', () => {
    process.env.SEED_TEST_SECRET = 'from-env';
    assert.equal(resolveSecret('$SEED_TEST_SECRET'), 'from-env');
    assert.equal(resolveSecret('$SEED_TEST_MISSING'), undefined);
    assert.equal(resolveSecret('literal'), 'literal');
    assert.equal(resolveSecret(''), undefined);
    delete process.env.SEED_TEST_SECRET;
  });

  it('finds providers in well-known environment variables without storing the keys', () => {
    const found = providersFromEnv({ DEEPSEEK_API_KEY: 'sk-1', ANTHROPIC_API_KEY: 'sk-ant-1', OPENAI_API_KEY: 'sk-2', OPENAI_BASE_URL: 'https://proxy.example/v1' });
    assert.deepEqual(Object.keys(found.providers), ['anthropic', 'deepseek', 'openai']);
    assert.equal(found.providers.deepseek.apiKey, '$DEEPSEEK_API_KEY');
    assert.equal(found.providers.anthropic.apiKey, undefined, 'the Anthropic SDK reads its own variables');
    assert.equal(found.providers.openai.baseURL, 'https://proxy.example/v1');
    assert.equal(found.model, 'anthropic/claude-opus-5-5');
    assert.ok(!JSON.stringify(found).includes('sk-1'));
    assert.deepEqual(providersFromEnv({}), { providers: {}, model: null });
  });

  it('chooses a default model from a live list', () => {
    const list = (...ids) => ids.map((id, i) => ({ id, created: i }));
    assert.equal(pickDefaultModel(presetById('anthropic'), list('claude-haiku-5-5', 'claude-opus-5-5')), 'claude-opus-5-5');
    assert.equal(pickDefaultModel(presetById('deepseek'), list('deepseek-reasoner', 'deepseek-chat')), 'deepseek-chat');
    assert.equal(pickDefaultModel(presetById('deepseek'), list('deepseek-v4-flash', 'deepseek-v4-pro')), 'deepseek-v4-pro');
    assert.equal(pickDefaultModel(presetById('openai'), list('gpt-4o', 'gpt-5-mini-audio-preview', 'gpt-5.2', 'text-embedding-3-large')), 'gpt-5.2');
    assert.equal(pickDefaultModel(presetById('custom'), list('a', 'b')), null);
    assert.equal(pickDefaultModel(presetById('anthropic'), []), 'claude-opus-5-5');
  });
});
