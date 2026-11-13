// OpenAI-compatible endpoint. Any program that can talk to
// `POST /v1/chat/completions` can use Seed as if it were a model: point its
// base URL at http://localhost:<port>/v1 and use the access token as the API
// key. Behind the endpoint the full agent runs, tools included, and the
// final answer comes back as the completion.
//
// Tool use needs approval, and an OpenAI client cannot answer approval
// prompts, so actions that would ask are refused unless the request sets
// `x-seed-approval: auto-edit | full` (or "harness": { "approval": … }).
import { APPROVAL_MODES } from '../config.js';
import { newMessage } from '../store.js';
import { truncateMiddle } from '../util.js';
import { sendJson } from './http.js';

export function listModels(app) {
  const created = Math.floor(Date.now() / 1000);
  const ids = ['seed'];
  for (const [id, p] of Object.entries(app.config.data.providers)) {
    for (const m of p.models || []) ids.push(`${id}/${m}`);
  }
  return { object: 'list', data: ids.map((id) => ({ id, object: 'model', created, owned_by: 'seed' })) };
}

function textOfOpenAIContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

/** OpenAI message content → canonical user blocks (text and inline images). */
function userBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const blocks = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text });
    else if (part?.type === 'image_url') {
      const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s.exec(part.image_url?.url || '');
      if (m) blocks.push({ type: 'image', mediaType: m[1], data: m[2] });
    }
  }
  return blocks;
}

function openaiError(res, status, message, cors, type = 'invalid_request_error') {
  return sendJson(res, status, { error: { message, type } }, cors);
}

export async function chatCompletions(app, req, res, body, cors) {
  const harness = body.harness && typeof body.harness === 'object' ? body.harness : {};
  const header = (name) => (typeof req.headers[name] === 'string' ? req.headers[name] : undefined);
  const conversationId = harness.conversation_id || header('x-seed-conversation') || null;
  const approval = harness.approval || header('x-seed-approval') || undefined;
  const showTools = harness.show_tools || header('x-seed-tools') || 'reasoning'; // reasoning | content | none
  const cwd = harness.cwd || header('x-seed-cwd') || undefined;

  if (!Array.isArray(body.messages) || !body.messages.length) return openaiError(res, 400, '`messages` must be a non-empty array.', cors);
  if (approval && !APPROVAL_MODES.includes(approval)) {
    return openaiError(res, 400, `approval must be one of: ${APPROVAL_MODES.join(', ')}.`, cors);
  }
  const last = body.messages[body.messages.length - 1];
  if (last?.role !== 'user') return openaiError(res, 400, 'The last message must have the role "user".', cors);
  const content = userBlocks(last.content);
  if (!content.length) return openaiError(res, 400, 'The last message is empty.', cors);

  // "seed" means the default model; "<provider>/<model>" selects one.
  let model;
  if (typeof body.model === 'string' && body.model !== 'seed') {
    try {
      model = app.config.resolveModel(body.model.replace(/^seed[:/]/, '')).ref;
    } catch {
      model = undefined;
    }
  }

  let conv;
  try {
    if (conversationId) {
      conv = await app.store.get(String(conversationId));
      if (!conv) return openaiError(res, 404, `Conversation not found: ${conversationId}`, cors);
    } else {
      // Stateless use: rebuild the conversation from the messages the client sent.
      const system = body.messages
        .filter((m) => m.role === 'system' || m.role === 'developer')
        .map((m) => textOfOpenAIContent(m.content))
        .filter(Boolean)
        .join('\n\n');
      conv = await app.createConversation({ cwd, system, ephemeral: true });
      for (const m of body.messages.slice(0, -1)) {
        if (m.role === 'user') {
          const blocks = userBlocks(m.content);
          if (blocks.length) conv.messages.push(newMessage('user', blocks));
        } else if (m.role === 'assistant') {
          const text = textOfOpenAIContent(m.content);
          if (text) conv.messages.push(newMessage('assistant', [{ type: 'text', text }]));
        }
      }
    }
  } catch (err) {
    return openaiError(res, err.status || 500, err.message, cors);
  }

  const id = `chatcmpl-${conv.id}`;
  const created = Math.floor(Date.now() / 1000);
  const stream = body.stream === true;
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let text = '';
  let reasoning = '';
  let needBreak = false;
  let headersSent = false;

  const chunk = (delta, finish = null) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: body.model || 'seed',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const write = (obj) => {
    if (!stream || res.writableEnded) return;
    if (!headersSent) {
      headersSent = true;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
        ...cors,
        'x-seed-conversation': conv.id,
      });
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: '' }))}\n\n`);
    }
    res.write(`data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`);
  };
  const addText = (t) => {
    if (needBreak && text) t = `\n\n${t}`;
    needBreak = false;
    text += t;
    write(chunk({ content: t }));
  };
  const addReasoning = (t) => {
    reasoning += t;
    write(chunk({ reasoning_content: t }));
  };
  const toolNote = (t) => {
    if (showTools === 'none') return;
    if (showTools === 'content') addText(t);
    else addReasoning(t);
  };

  const onEvent = (e) => {
    if (e.type === 'delta') {
      if (e.kind === 'text') addText(e.text);
      else if (e.kind === 'thinking') addReasoning(e.text);
    } else if (e.type === 'message.completed') {
      needBreak = true;
      const u = e.usage;
      if (u) {
        usage.prompt_tokens += (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
        usage.completion_tokens += u.output || 0;
      }
    } else if (e.type === 'tool.started') {
      const summary = truncateMiddle(JSON.stringify(e.input ?? {}), 300);
      toolNote(`\n[tool] ${e.name} ${summary}\n`);
    } else if (e.type === 'tool.completed' && e.result?.is_error) {
      toolNote(`[tool error] ${truncateMiddle(String(e.result.content), 300)}\n`);
    }
  };

  let run;
  try {
    run = await app.runs.start(conv, { content, model, approval, interactive: false, onEvent });
  } catch (err) {
    return openaiError(res, err.status || 500, err.message, cors, err.status === 400 ? 'invalid_request_error' : 'server_error');
  }
  let finished = false;
  res.on('close', () => {
    if (!finished) app.runs.cancel(conv.id);
  });
  const result = await run.done;
  finished = true;
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

  if (result.status === 'error') {
    const message = result.error?.message || 'The agent run failed.';
    if (stream) {
      write({ error: { message, type: 'server_error' } });
      write('[DONE]');
      return res.end();
    }
    return openaiError(res, 502, message, cors, 'server_error');
  }

  if (stream) {
    write(chunk({}, 'stop'));
    if (body.stream_options?.include_usage) write({ ...chunk({}, null), choices: [], usage });
    write('[DONE]');
    return res.end();
  }
  return sendJson(
    res,
    200,
    {
      id,
      object: 'chat.completion',
      created,
      model: body.model || 'seed',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text, ...(reasoning ? { reasoning_content: reasoning } : {}) },
          finish_reason: 'stop',
        },
      ],
      usage,
    },
    { ...cors, 'x-seed-conversation': conv.id },
  );
}
