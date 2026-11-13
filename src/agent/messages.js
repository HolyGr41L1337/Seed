// The canonical conversation format shared by every provider adapter.
//
//   Message = { id, role: 'user' | 'assistant' | 'notice', content: Block[], createdAt, meta? }
//   Block   = { type: 'text', text }
//           | { type: 'thinking', text, redacted? }             (assistant; display only)
//           | { type: 'tool_use', id, name, input, inputError? } (assistant)
//           | { type: 'tool_result', tool_use_id, content, is_error?, display? } (user)
//           | { type: 'image', mediaType, data }                 (user; base64)
//
// A 'notice' message is something the harness tells the user (an error, "the
// context was compacted", ...). It is part of the transcript but is never
// sent to the model.
//
// Assistant messages keep `meta.raw` — the provider's own content array —
// so the same provider gets its output back byte-for-byte (thinking
// signatures stay valid, prompt caches keep matching).

export function textOf(message) {
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export function toolUses(message) {
  return message.content.filter((b) => b.type === 'tool_use');
}

/** Normalize API input (a string or an array of blocks) into user content blocks. */
export function userContent(input) {
  if (typeof input === 'string') {
    if (!input.trim()) throw badRequest('Message content is empty.');
    return [{ type: 'text', text: input }];
  }
  if (!Array.isArray(input) || !input.length) throw badRequest('content must be a string or a non-empty array of blocks.');
  const blocks = [];
  for (const b of input) {
    if (b?.type === 'text' && typeof b.text === 'string') {
      if (b.text) blocks.push({ type: 'text', text: b.text });
    } else if (b?.type === 'image' && typeof b.data === 'string' && /^image\/(png|jpeg|gif|webp)$/.test(b.mediaType)) {
      blocks.push({ type: 'image', mediaType: b.mediaType, data: b.data });
    } else {
      throw badRequest('Unsupported content block. Use {type:"text",text} or {type:"image",mediaType,data}.');
    }
  }
  if (!blocks.length) throw badRequest('Message content is empty.');
  return blocks;
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * Make sure every assistant tool call has a result in the next user message.
 * A crash or a cancelled run can leave calls unanswered, which every
 * provider rejects. Appends synthetic results; never rewrites existing ones.
 * Returns true when something was added.
 */
export function repairHistory(messages, makeMessage) {
  let changed = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const calls = toolUses(m);
    if (!calls.length) continue;
    let j = i + 1;
    while (messages[j]?.role === 'notice') j++;
    const next = messages[j];
    const answered = new Set(
      next?.role === 'user' ? next.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id) : [],
    );
    const missing = calls.filter((c) => !answered.has(c.id));
    if (!missing.length) continue;
    const results = missing.map((c) => ({
      type: 'tool_result',
      tool_use_id: c.id,
      content: 'Error: this tool call was interrupted before it produced a result.',
      is_error: true,
    }));
    if (next?.role === 'user' && answered.size) {
      next.content.unshift(...results);
    } else {
      messages.splice(i + 1, 0, makeMessage('user', results));
    }
    changed = true;
  }
  return changed;
}

const SUMMARY_HEADER =
  'This conversation was getting long, so the earlier part was replaced by the summary below. ' +
  'It was written by you. Treat it as your own notes about the work so far.';

/** The messages the model sees: everything, or the compaction summary plus what came after it. */
export function contextMessages(conv) {
  if (!conv.context) return conv.messages.filter((m) => m.role !== 'notice');
  const { summary, from, midRun } = conv.context;
  const text =
    `${SUMMARY_HEADER}\n\n<summary>\n${summary}\n</summary>` +
    (midRun
      ? '\n\nYou were in the middle of the task when the summary was made. Continue from where you left off; do not start over and do not ask the user to repeat anything.'
      : '');
  const head = { id: 'm_summary', role: 'user', content: [{ type: 'text', text }], createdAt: 0 };
  return [head, ...conv.messages.slice(from).filter((m) => m.role !== 'notice')];
}

/**
 * Check a tool input against the tool's JSON schema.
 * Returns { value } (with harmless coercions applied) or { error }.
 * Covers the subset of JSON Schema that tool definitions use.
 */
export function checkInput(schema, value, path = 'input') {
  if (!schema || typeof schema !== 'object') return { value };
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null;

  if (types) {
    let actual = typeOf(value);
    if (!matches(types, actual)) {
      // Models sometimes quote numbers and booleans; accept the obvious cases.
      if (typeof value === 'string') {
        const t = value.trim();
        if ((types.includes('integer') || types.includes('number')) && t !== '' && Number.isFinite(Number(t))) {
          const n = Number(t);
          if (!types.includes('integer') || types.includes('number') || Number.isInteger(n)) value = n;
        } else if (types.includes('boolean') && (t === 'true' || t === 'false')) {
          value = t === 'true';
        } else if ((types.includes('object') || types.includes('array')) && /^[[{]/.test(t)) {
          try {
            value = JSON.parse(t);
          } catch {
            /* keep the string; reported below */
          }
        }
      }
      actual = typeOf(value);
      if (!matches(types, actual)) {
        return { error: `${path} must be ${types.join(' or ')}, got ${actual}` };
      }
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return { error: `${path} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}` };
  }
  if (typeOf(value) === 'object') {
    const out = { ...value };
    for (const key of schema.required || []) {
      if (out[key] === undefined || out[key] === null) return { error: `${path}.${key} is required` };
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (out[key] === undefined) continue;
      if (out[key] === null && !(schema.required || []).includes(key)) {
        delete out[key]; // optional parameter passed as null: treat as absent
        continue;
      }
      const checked = checkInput(sub, out[key], `${path}.${key}`);
      if (checked.error) return checked;
      out[key] = checked.value;
    }
    return { value: out };
  }
  if (typeOf(value) === 'array' && schema.items) {
    const out = [];
    for (let i = 0; i < value.length; i++) {
      const checked = checkInput(schema.items, value[i], `${path}[${i}]`);
      if (checked.error) return checked;
      out.push(checked.value);
    }
    return { value: out };
  }
  return { value };
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matches(types, actual) {
  return types.includes(actual) || (actual === 'integer' && types.includes('number'));
}
