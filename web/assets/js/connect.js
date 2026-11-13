// The "connect a model API" card. Shown under the bar until a provider is
// connected, and again on /connect.
import { api } from './api.js';
import { clear, h } from './dom.js';
import { t, tr } from './i18n.js';
import { state } from './state.js';

let presetsCache = null;

function presetLabel(preset) {
  if (preset.id === 'custom') return tr('自定义（OpenAI 兼容）', 'Custom (OpenAI-compatible)');
  if (preset.id === 'custom-anthropic') return tr('自定义（Anthropic 兼容）', 'Custom (Anthropic-compatible)');
  if (preset.id === 'ollama') return tr('Ollama（本地）', 'Ollama (local)');
  return preset.name;
}

/**
 * @param {{ onDone: (result: { config: object, model: string }) => void, onCancel?: () => void }} options
 * @returns {Promise<HTMLElement>}
 */
export async function connectCard({ onDone, onCancel }) {
  if (!presetsCache) presetsCache = (await api.get('/api/providers/presets')).presets;
  const presets = presetsCache;
  const existing = state.config?.providers || {};
  let current = presets.find((p) => existing[p.id]) || presets[0];
  let showBaseURL = false;
  const values = {}; // preset id → { apiKey, baseURL, model }

  const root = h('div', { class: 'connect' });
  const presetRow = h('div', { class: 'presets' });
  const fields = h('div');
  const errorEl = h('div', { class: 'connect-error' });
  const submit = h('button', { type: 'submit', class: 'seed-btn primary' }, t('connect'));
  const form = h(
    'form',
    { autocomplete: 'off' },
    fields,
    h(
      'div',
      { class: 'connect-actions' },
      submit,
      onCancel ? h('button', { type: 'button', class: 'seed-btn ghost', onclick: onCancel }, t('cancel')) : null,
      errorEl,
    ),
  );
  root.append(h('h3', t('connectTitle')), h('p', { class: 'sub' }, t('connectSub')), presetRow, form);

  const valueOf = (preset) => (values[preset.id] ||= { apiKey: '', baseURL: existing[preset.id]?.baseURL || preset.baseURL || '', model: '' });

  function render() {
    clear(presetRow);
    for (const preset of presets) {
      presetRow.append(
        h('button', {
          type: 'button',
          class: 'preset',
          'aria-pressed': String(preset.id === current.id),
          onclick: () => {
            current = preset;
            showBaseURL = false;
            errorEl.textContent = '';
            render();
          },
        }, presetLabel(preset)),
      );
    }

    clear(fields);
    const v = valueOf(current);
    const saved = existing[current.id];
    const needsURL = current.custom || current.noKey || showBaseURL;
    const field = (label, inputEl, extra) => h('div', { class: 'field' }, h('label', label), inputEl, extra);

    if (!current.noKey) {
      const key = h('input', {
        class: 'seed-input',
        type: 'password',
        name: 'seed-api-key',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: saved?.keyHint ? tr(`已保存 ${saved.keyHint}，留空则沿用`, `saved ${saved.keyHint}; leave empty to keep it`) : current.keyHint || (current.custom ? t('keyOptional') : ''),
        value: v.apiKey,
        oninput: (e) => (v.apiKey = e.target.value),
      });
      const help = current.keyUrl
        ? h('div', { class: 'help' }, h('a', { href: current.keyUrl, target: '_blank', rel: 'noopener noreferrer' }, `${t('getKey')} ↗`))
        : null;
      fields.append(field(t('apiKey'), key, help));
      queueMicrotask(() => key.focus());
    }
    if (needsURL) {
      fields.append(
        field(
          t('baseURL'),
          h('input', {
            class: 'seed-input',
            type: 'url',
            spellcheck: 'false',
            placeholder: current.type === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.example.com/v1',
            value: v.baseURL,
            oninput: (e) => (v.baseURL = e.target.value),
          }),
        ),
      );
    }
    fields.append(
      field(
        t('model'),
        h('input', {
          class: 'seed-input',
          type: 'text',
          spellcheck: 'false',
          placeholder: current.custom ? t('modelRequired') : current.defaultModel ? `${current.defaultModel}（${t('modelAuto')}）` : t('modelAuto'),
          value: v.model,
          oninput: (e) => (v.model = e.target.value),
        }),
      ),
    );
    if (!needsURL) {
      fields.append(
        h('div', { class: 'field' }, h('button', { type: 'button', class: 'link-button', style: { justifySelf: 'start' }, onclick: () => ((showBaseURL = true), render()) }, t('advanced'))),
      );
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const v = valueOf(current);
    const saved = existing[current.id];
    errorEl.textContent = '';
    if (!current.noKey && !current.custom && current.type !== 'anthropic' && !v.apiKey.trim() && !saved?.hasKey) {
      errorEl.textContent = t('needKey');
      return;
    }
    if (current.type === 'anthropic' && !current.custom && !v.apiKey.trim() && !saved?.hasKey) {
      errorEl.textContent = t('needKey');
      return;
    }
    if ((current.custom || current.noKey) && !v.baseURL.trim()) {
      errorEl.textContent = t('needBaseURL');
      return;
    }
    submit.disabled = true;
    submit.textContent = t('connecting');
    try {
      const result = await api.post('/api/providers', {
        id: current.id,
        presetId: current.id,
        type: current.type,
        name: current.custom ? undefined : current.name,
        baseURL: v.baseURL.trim() || undefined,
        apiKey: v.apiKey.trim() || undefined,
        model: v.model.trim() || undefined,
      });
      onDone({ ...result, name: presetLabel(current) });
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      submit.disabled = false;
      submit.textContent = t('connect');
    }
  });

  render();
  return root;
}
