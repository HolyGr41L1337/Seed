// A scripted stand-in for an OpenAI-compatible API (DeepSeek, OpenAI, ...).
// Each POST /chat/completions takes the next response from the script.
//
//   response = { text?, reasoning?, toolCalls?: [{ id?, name, args }], finish?, usage?,
//                status?, error?, noIndex?, delayMs? }
//   A function (body, index) => response may be used instead of an object.
import http from 'node:http';

export async function startMockOpenAI(script = [], { models = ['mock-model', 'mock-small'] } = {}) {
  const requests = [];
  let index = 0;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;

    if (req.method === 'GET' && req.url.endsWith('/models')) {
      if (req.headers.authorization === 'Bearer bad-key') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Authentication Fails (no such user)', type: 'authentication_error' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: models.map((id, i) => ({ id, object: 'model', created: 1700000000 + i })) }));
    }
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'not found' } }));
    }

    const n = index++;
    requests.push({ body, headers: req.headers });
    let step = script[n] ?? { text: `(no scripted response #${n})` };
    if (typeof step === 'function') step = await step(body, n);
    if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));

    if (step.status && step.status !== 200) {
      res.writeHead(step.status, { 'content-type': 'application/json', ...(step.headers || {}) });
      return res.end(JSON.stringify({ error: step.error || { message: `mock error ${step.status}` } }));
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const base = { id: `chatcmpl-${n}`, object: 'chat.completion.chunk', created: 1700000000, model: body.model };
    const delta = (d, finish = null) => send({ ...base, choices: [{ index: 0, delta: d, finish_reason: finish }] });

    delta({ role: 'assistant', content: '' });
    res.write(': keep-alive comment\n\n');
    if (step.reasoning) for (const part of split(step.reasoning, 3)) delta({ reasoning_content: part });
    if (step.text) for (const part of split(step.text, 4)) delta({ content: part });
    for (const [i, tc] of (step.toolCalls || []).entries()) {
      const args = typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {});
      const pieces = split(args, 3);
      const idx = step.noIndex ? {} : { index: i };
      delta({ tool_calls: [{ ...idx, id: tc.id || `call_${n}_${i}`, type: 'function', function: { name: tc.name, arguments: pieces[0] || '' } }] });
      for (const piece of pieces.slice(1)) delta({ tool_calls: [{ ...idx, function: { arguments: piece } }] });
    }
    if (step.abortMidStream) {
      await new Promise((r) => setTimeout(r, 40)); // let the chunks above reach the client first
      return res.destroy();
    }
    delta({}, step.finish || (step.toolCalls?.length ? 'tool_calls' : 'stop'));
    send({ ...base, choices: [], usage: step.usage || { prompt_tokens: 100 + n, completion_tokens: 10, total_tokens: 110 + n } });
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    get calls() {
      return index;
    },
    push: (...steps) => script.push(...steps),
    close: () => new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve))),
  };
}

function split(text, parts) {
  if (!text) return [];
  const size = Math.max(1, Math.ceil(text.length / parts));
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
