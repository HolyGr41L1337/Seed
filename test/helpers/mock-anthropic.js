// A scripted stand-in for the Anthropic Messages API (streaming).
//
//   response = { blocks: [ { type: 'thinking', thinking, signature? }
//                        | { type: 'text', text }
//                        | { type: 'tool_use', id?, name, input }
//                        | { type: 'fallback', from, to } ],
//                stop_reason?, stop_details?, usage?, input_transformations?, status?, error? }
import http from 'node:http';

export async function startMockAnthropic(script = [], { modelInfo = {} } = {}) {
  const requests = [];
  let index = 0;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url, 'http://x');
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_mock' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return json(200, {
        data: [
          { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-01T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000 },
          { type: 'model', id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-08-01T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000 },
        ],
        has_more: false,
        first_id: 'claude-opus-5-5',
        last_id: 'claude-haiku-5-5',
      });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/v1/models/')) {
      const id = decodeURIComponent(url.pathname.slice('/v1/models/'.length));
      const supported = { supported: true };
      return json(200, {
        type: 'model',
        id,
        display_name: id,
        created_at: '2026-09-01T00:00:00Z',
        max_input_tokens: 1000000,
        max_tokens: 128000,
        allowed_fallback_models: ['claude-opus-5', 'claude-opus-4-8'],
        capabilities: {
          thinking: { supported: true, types: { adaptive: supported, enabled: { supported: false } } },
          effort: { supported: true, low: supported, medium: supported, high: supported, xhigh: supported, max: supported },
        },
        ...modelInfo,
      });
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/messages') return json(404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } });

    const n = index++;
    requests.push({ body, headers: req.headers });
    let step = script[n] ?? { blocks: [{ type: 'text', text: `(no scripted response #${n})` }] };
    if (typeof step === 'function') step = await step(body, n);
    if (step.status && step.status !== 200) {
      return json(step.status, { type: 'error', error: step.error || { type: 'invalid_request_error', message: `mock error ${step.status}` } });
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': `req_mock_${n}` });
    const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const usage = step.usage || { input_tokens: 50 + n, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 };
    send({
      type: 'message_start',
      message: {
        id: `msg_mock_${n}`,
        type: 'message',
        role: 'assistant',
        model: step.model || body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usage, output_tokens: 1 },
        ...(step.input_transformations ? { input_transformations: step.input_transformations } : {}),
      },
    });
    (step.blocks || []).forEach((block, i) => {
      if (block.type === 'text') {
        send({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
        for (const part of split(block.text, 3)) send({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: part } });
      } else if (block.type === 'thinking') {
        send({ type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '', signature: '' } });
        for (const part of split(block.thinking, 2)) send({ type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: part } });
        send({ type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature: block.signature || `sig_${n}_${i}` } });
      } else if (block.type === 'tool_use') {
        send({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: block.id || `toolu_${n}_${i}`, name: block.name, input: {} } });
        const text = block.rawInput ?? JSON.stringify(block.input ?? {});
        for (const part of split(text, 3)) send({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: part } });
      } else if (block.type === 'fallback') {
        send({ type: 'content_block_start', index: i, content_block: { type: 'fallback', from: block.from, to: block.to } });
      }
      send({ type: 'content_block_stop', index: i });
    });
    const hasTool = (step.blocks || []).some((b) => b.type === 'tool_use');
    send({
      type: 'message_delta',
      delta: { stop_reason: step.stop_reason || (hasTool ? 'tool_use' : 'end_turn'), stop_sequence: null, ...(step.stop_details ? { stop_details: step.stop_details } : {}) },
      usage: { output_tokens: usage.output_tokens },
    });
    send({ type: 'message_stop' });
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    get calls() {
      return index;
    },
    close: () => new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve))),
  };
}

function split(text, parts) {
  if (!text) return [''];
  const size = Math.max(1, Math.ceil(text.length / parts));
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
