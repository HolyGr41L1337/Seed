// Provider presets shown in the "connect your API" card and used for
// environment-variable auto-detection. A preset only pre-fills fields; every
// value can be changed by the user, and any OpenAI-compatible or
// Anthropic-compatible endpoint works through the two "custom" entries.

export const PRESETS = [
  {
    id: 'anthropic',
    name: 'Claude (Anthropic)',
    type: 'anthropic',
    baseURL: '',
    keyHint: 'sk-ant-…',
    keyUrl: 'https://platform.claude.com/',
    env: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    defaultModel: 'claude-opus-5-5',
    // Shown when the live model list cannot be fetched.
    models: ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'openai',
    baseURL: 'https://api.deepseek.com',
    keyHint: 'sk-…',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    env: ['DEEPSEEK_API_KEY'],
    prefer: ['deepseek-v4-pro', 'deepseek-chat', 'deepseek-v4-flash', 'deepseek-reasoner'],
    models: [],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai',
    baseURL: 'https://api.openai.com/v1',
    keyHint: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    env: ['OPENAI_API_KEY'],
    baseURLEnv: 'OPENAI_BASE_URL',
    preferPattern: '^gpt-\\d[\\w.]*$',
    models: [],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    keyHint: 'sk-or-…',
    keyUrl: 'https://openrouter.ai/keys',
    env: ['OPENROUTER_API_KEY'],
    models: [],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    type: 'openai',
    baseURL: 'http://localhost:11434/v1',
    noKey: true,
    models: [],
  },
  {
    id: 'custom',
    name: 'OpenAI-compatible',
    type: 'openai',
    baseURL: '',
    custom: true,
    models: [],
  },
  {
    id: 'custom-anthropic',
    name: 'Anthropic-compatible',
    type: 'anthropic',
    baseURL: '',
    custom: true,
    models: [],
  },
];

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

/**
 * Choose a sensible default from a live model list.
 * `models` is [{ id, created? }]. Returns a model id or null.
 */
export function pickDefaultModel(preset, models) {
  if (!models?.length) return preset?.defaultModel || null;
  const ids = models.map((m) => m.id);
  if (preset?.defaultModel && ids.includes(preset.defaultModel)) return preset.defaultModel;
  for (const wanted of preset?.prefer || []) if (ids.includes(wanted)) return wanted;
  if (preset?.preferPattern) {
    const re = new RegExp(preset.preferPattern);
    const skip = /audio|realtime|image|tts|transcribe|search|embedding|moderation|instruct/;
    const hits = models.filter((m) => re.test(m.id) && !skip.test(m.id));
    if (hits.length) {
      // Newest first; ties go to the shorter id (the family's main model).
      hits.sort((a, b) => (b.created || 0) - (a.created || 0) || a.id.length - b.id.length);
      return hits[0].id;
    }
  }
  return preset?.defaultModel || null;
}
