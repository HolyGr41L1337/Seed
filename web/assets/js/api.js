// Client for the app's REST API and event stream.
//
// Normally the page is signed in with a session cookie. Where the browser
// refuses the cookie (the page is embedded in another site's frame, as IDE
// and cloud "preview" panes do), the page keeps the access token for the
// tab instead and sends it with every request.

export const clientId = `ui_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

const TOKEN_KEY = 'seed.token';
let bearer = null;

export function useToken(token) {
  bearer = token || null;
  try {
    if (bearer) sessionStorage.setItem(TOKEN_KEY, bearer);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: the token lives until the page is reloaded */
  }
}

export function storedToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function authHeaders() {
  return bearer ? { authorization: `Bearer ${bearer}` } : {};
}

export class ApiError extends Error {
  constructor(message, status, kind) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'x-seed-client': clientId, ...authHeaders(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch (err) {
    throw new ApiError(`Cannot reach the Seed server: ${err.message}`, 0, 'network');
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const message = data?.error?.message || (typeof data === 'string' && data) || `${res.status} ${res.statusText}`;
    throw new ApiError(message, res.status, data?.error?.kind);
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  patch: (path, body = {}) => request('PATCH', path, body),
  put: (path, body = {}) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
};
api.delete = api.del;

/**
 * Follow the server's event stream, reconnecting when it drops.
 * `onStatus('down' | 'up')` reports a lost and a restored connection.
 * Returns a function that stops it.
 */
export function connectEvents(onEvent, onStatus = () => {}) {
  let stopped = false;
  let wasOpen = false;
  let down = false;
  let controller = null;
  let delay = 500;

  const deliver = (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    try {
      onEvent(event);
    } catch (err) {
      // A failing handler must not stop the stream; report it where extension errors are collected.
      setTimeout(() => {
        throw err;
      });
    }
  };

  (async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetch(`/api/events?client=${encodeURIComponent(clientId)}`, {
          headers: authHeaders(),
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`event stream: ${res.status}`);
        if (down) onStatus('up');
        down = false;
        wasOpen = true;
        delay = 500;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            for (const line of frame.split('\n')) if (line.startsWith('data:')) deliver(line.slice(5).trim());
          }
        }
      } catch {
        /* dropped or refused: try again below */
      }
      if (stopped) return;
      if (wasOpen && !down) onStatus('down');
      down = true;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 5000);
    }
  })();

  return () => {
    stopped = true;
    controller?.abort();
  };
}
