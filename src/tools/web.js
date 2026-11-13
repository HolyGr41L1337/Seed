// fetch_url: read a web page or an HTTP API as text.
import { truncateMiddle } from '../util.js';

const MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_CHARS = 20_000;

/** Crude but dependable HTML → text: drop scripts and styles, keep link targets and block structure. */
export function htmlToText(html) {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, (head) => {
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
      return title ? `# ${title[1].trim()}\n\n` : '';
    })
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_, href, label) => {
      const inner = label.replace(/<[^>]+>/g, '').trim();
      return inner ? `${inner} (${href})` : '';
    })
    .replace(/<h([1-6])\b[^>]*>/gi, (_, n) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|main|aside|nav|ul|ol|table|tr|h[1-6]|pre|blockquote|figure|form)\s*>/gi, '\n\n')
    .replace(/<\/(td|th)\s*>/gi, ' | ')
    .replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  return text
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©', laquo: '«', raquo: '»' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      try {
        return String.fromCodePoint(n);
      } catch {
        return whole;
      }
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

export const fetchUrlTool = {
  name: 'fetch_url',
  description:
    'Fetch a URL with an HTTP GET and return the response as text. HTML pages are converted to readable text with link targets kept; ' +
    'JSON and plain text are returned as they are. Use it to read documentation, a page the user mentions, or a JSON API. ' +
    'It cannot run JavaScript or log in.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The http(s) URL to fetch.' },
      max_chars: { type: 'integer', description: `Maximum characters to return (default ${DEFAULT_CHARS}, maximum 100000).` },
    },
    required: ['url'],
  },
  kind: (args) => ({ kind: 'network', url: args.url }),
  describe: (args) => ({ title: 'Fetch a URL', detail: args.url }),
  async run(args, ctx) {
    let url;
    try {
      url = new URL(args.url);
      if (!/^https?:$/.test(url.protocol)) throw new Error('only http and https URLs are supported');
    } catch (err) {
      return { content: `Error: invalid URL: ${err.message}`, is_error: true };
    }
    const max = Math.min(Math.max(args.max_chars || DEFAULT_CHARS, 500), 100_000);
    const timeout = AbortSignal.timeout(30_000);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    try {
      const res = await fetch(url, {
        signal,
        redirect: 'follow',
        headers: { 'user-agent': 'seed-harness/0.1 (+fetch_url tool)', accept: 'text/html,application/json,text/plain,*/*;q=0.8' },
      });
      const type = res.headers.get('content-type') || '';
      if (!/text|json|xml|javascript|html|yaml|csv/i.test(type) && type) {
        return { content: `${res.status} ${res.statusText}. The response is ${type}, not text; its content is not shown.` };
      }
      const reader = res.body?.getReader();
      const chunks = [];
      let size = 0;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
        if (size > MAX_BYTES) {
          await reader.cancel();
          break;
        }
      }
      let body = Buffer.concat(chunks).toString('utf8');
      if (/html/i.test(type) || /^\s*<(!doctype|html)/i.test(body)) body = htmlToText(body);
      const head = res.ok ? '' : `[HTTP ${res.status} ${res.statusText}]\n`;
      return { content: head + (truncateMiddle(body, max) || '(empty response)'), is_error: !res.ok };
    } catch (err) {
      if (ctx.signal?.aborted) return { content: 'Error: cancelled.', is_error: true };
      const reason = err.name === 'TimeoutError' ? 'timed out after 30s' : err.cause?.code || err.cause?.message || err.message;
      return { content: `Error: could not fetch ${url.href}: ${reason}`, is_error: true };
    }
  },
};
