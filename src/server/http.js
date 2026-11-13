// HTTP server: static web UI, the REST API, the event stream (SSE), extension
// routes and files, and the OpenAI-compatible endpoint.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { APP_DIR, VERSION, newId } from '../util.js';
import { authenticate, checkToken, sessionCookie } from './auth.js';
import { chatCompletions, listModels } from './openai-compat.js';

const WEB_DIR = path.join(APP_DIR, 'web');
const MAX_BODY = 25 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-seed-client, x-seed-conversation, x-seed-cwd, x-seed-approval, x-seed-tools',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-max-age': '600',
};

export class HttpServer {
  constructor(app) {
    this.app = app;
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        console.error('[seed] request failed:', err);
        if (!res.headersSent) sendJson(res, 500, { error: { message: 'Internal error.' } });
        else res.end();
      });
    });
    this.server.on('clientError', (_err, socket) => socket.destroy());
    this.streams = new Set();
  }

  /** Listen on the configured port; when it is taken and was not chosen explicitly, try the next ones. */
  listen({ host, port, strictPort }) {
    return new Promise((resolve, reject) => {
      let attempt = 0;
      const tryListen = (p) => {
        const onError = (err) => {
          if (err.code === 'EADDRINUSE' && !strictPort && p !== 0 && attempt++ < 20) tryListen(p + 1);
          else reject(err);
        };
        this.server.once('error', onError);
        this.server.listen(p, host, () => {
          this.server.off('error', onError);
          resolve({ host, port: this.server.address().port });
        });
      };
      tryListen(port);
    });
  }

  close() {
    for (const end of this.streams) end();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }

  async handle(req, res) {
    const { app } = this;
    const url = new URL(req.url, 'http://seed.local');
    const pathname = url.pathname;
    const method = req.method || 'GET';
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');

    // Programs running in a browser on another origin authenticate with the token
    // (never the cookie), so answering preflights openly gives nothing away.
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }

    const token = app.config.server.token;

    if (pathname === '/api/health') return sendJson(res, 200, { ok: true, name: 'seed', version: VERSION });
    if (pathname === '/api/auth/status' && method === 'GET') {
      return sendJson(res, 200, { authenticated: authenticate(req, token).ok });
    }
    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await readBody(req, res);
      if (body === undefined) return;
      if (!checkToken(body?.token, token)) return sendJson(res, 401, { error: { message: 'That access token is not correct.' } });
      res.setHeader('set-cookie', sessionCookie(token));
      return sendJson(res, 200, { ok: true });
    }

    // Extension files for pages: the key in the path is the credential.
    if (pathname.startsWith('/extensions/')) {
      if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: { message: 'Method not allowed.' } });
      const file = app.extensions.clientFile(pathname);
      if (!file) return sendJson(res, 404, { error: { message: 'Not found.' } });
      return sendFile(req, res, file);
    }

    const isApi = /^\/(api|v1|ext)\//.test(pathname);
    if (!isApi) {
      if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: { message: 'Method not allowed.' } });
      return this.serveStatic(req, res, pathname);
    }

    const auth = authenticate(req, token);
    if (!auth.ok) {
      res.setHeader('www-authenticate', 'Bearer realm="seed"');
      return sendJson(res, 401, { error: { message: auth.reason, kind: 'auth' } }, CORS);
    }
    const cors = auth.via === 'bearer' ? CORS : {};

    if (pathname === '/api/events' && method === 'GET') return this.events(req, res, url, cors);

    let body;
    if (method !== 'GET' && method !== 'HEAD') {
      body = await readBody(req, res, cors);
      if (body === undefined) return;
    }
    const clientId = String(req.headers['x-seed-client'] || '') || null;

    if (pathname === '/v1/models' && method === 'GET') return sendJson(res, 200, listModels(app), cors);
    if (pathname === '/v1/chat/completions' && method === 'POST') return chatCompletions(app, req, res, body || {}, cors);

    const messagesRoute = /^\/api\/conversations\/([^/]+)\/messages$/.exec(pathname);
    if (method === 'POST' && body?.stream === true && (pathname === '/api/chat' || messagesRoute)) {
      const conversationId = messagesRoute ? decodeURIComponent(messagesRoute[1]) : body.conversationId || null;
      return this.streamRun(req, res, { conversationId, body, cors });
    }

    const result = await app.api.dispatch({ method, url: req.url, body, actor: { source: 'user' }, clientId, headers: req.headers });
    if (result.type) {
      const payload = typeof result.body === 'string' || Buffer.isBuffer(result.body) ? result.body : JSON.stringify(result.body);
      res.writeHead(result.status, { 'content-type': result.type, 'cache-control': 'no-store', ...cors, ...(result.headers || {}) });
      return res.end(payload);
    }
    return sendJson(res, result.status, result.body, { ...cors, ...(result.headers || {}) });
  }

  /** GET /api/events — everything that happens, as Server-Sent Events. */
  events(req, res, url, cors) {
    const { app } = this;
    const clientId = url.searchParams.get('client') || newId('ui_');
    const only = url.searchParams.get('conversation');
    const sse = openSse(res, cors);
    const send = (event) => {
      if (only && event.conversationId && event.conversationId !== only) return;
      sse.send(event);
    };
    sse.send({ type: 'hello', clientId, seq: app.events.seq, version: VERSION, generation: app.extensions.generation });
    const unsubscribe = app.events.subscribe(send);
    // Only real UI pages register as clients (they pass ?client=…); they can be asked to run ui_eval.
    const unregister = url.searchParams.get('client') ? app.clients.add(clientId, (e) => sse.send(e)) : () => {};
    const end = () => {
      unsubscribe();
      unregister();
      sse.close();
      this.streams.delete(end);
    };
    this.streams.add(end);
    // The response's "close" is what reports a client that went away
    // (the request's own "close" has already fired once its body was read).
    res.on('close', end);
  }

  /** POST …/messages or /api/chat with "stream": true — the run's events, then a final "done" event. */
  async streamRun(req, res, { conversationId, body, cors }) {
    const { app } = this;
    let sse = null;
    let finished = false;
    const queue = [];
    const onEvent = (event) => {
      if (sse) sse.send(event);
      else queue.push(event);
    };
    let started;
    let before = 0;
    try {
      if (conversationId) before = (await app.api.conversation(conversationId)).messages.length;
      started = await app.api.startChat({ conversationId, body, actor: { source: 'user' }, onEvent });
    } catch (err) {
      const status = Number.isInteger(err.status) ? err.status : 500;
      return sendJson(res, status, { error: { message: err.message, kind: err.kind } }, cors);
    }
    const { conv, run } = started;
    sse = openSse(res, cors);
    for (const event of queue) sse.send(event);
    // A client that goes away has stopped listening: stop the work too.
    res.on('close', () => {
      if (!finished) app.runs.cancel(conv.id);
    });
    const result = await run.done;
    finished = true;
    sse.send({ type: 'done', ...app.api.outcome(conv, before, result) });
    sse.close();
  }

  async serveStatic(req, res, pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return sendJson(res, 400, { error: { message: 'Bad path.' } });
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.join(WEB_DIR, path.normalize(rel));
    if (!file.startsWith(WEB_DIR + path.sep)) return sendJson(res, 403, { error: { message: 'Forbidden.' } });
    return sendFile(req, res, file);
  }
}

function openSse(res, cors = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
    ...cors,
  });
  res.write(': connected\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  ping.unref?.();
  return {
    send(event) {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    close() {
      clearInterval(ping);
      if (!res.writableEnded) res.end();
    },
  };
}

export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

async function sendFile(req, res, file, headers = {}) {
  let stat;
  try {
    stat = await fsp.stat(file);
    if (stat.isDirectory()) throw Object.assign(new Error('directory'), { code: 'ENOENT' });
  } catch {
    return sendJson(res, 404, { error: { message: 'Not found.' } }, headers);
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size,
    // Extension files change while the app runs; always revalidate.
    'cache-control': 'no-cache',
    ...headers,
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}

/** Read and parse a JSON body. Sends the error response itself and returns undefined on failure. */
function readBody(req, res, headers = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        failed = true;
        sendJson(res, 413, { error: { message: 'Request body too large.' } }, headers);
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        sendJson(res, 400, { error: { message: 'The request body is not valid JSON.' } }, headers);
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}
