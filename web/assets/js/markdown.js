// A small Markdown renderer that builds DOM nodes directly.
//
// Model output is untrusted, so nothing here goes through innerHTML: raw HTML
// in the text stays text, links are limited to http(s)/mailto, and images are
// shown as links instead of being loaded (a remote image URL would let a
// page learn things about the conversation just by being requested).
import { h } from './dom.js';
import { t } from './i18n.js';

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** @returns {DocumentFragment} */
export function renderMarkdown(source) {
  const root = document.createDocumentFragment();
  blocks(String(source ?? '').replace(/\r\n?/g, '\n').split('\n'), root);
  return root;
}

function blocks(lines, parent) {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const [, indent, marker, lang] = fence;
      const body = [];
      i++;
      // An unclosed fence (text still streaming) runs to the end.
      while (i < lines.length && !isClosingFence(lines[i], marker)) body.push(lines[i++].replace(new RegExp(`^\\s{0,${indent.length}}`), ''));
      i++;
      parent.append(codeBlock(body.join('\n'), lang));
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const el = h(`h${heading[1].length}`);
      inline(heading[2], el);
      parent.append(el);
      i++;
      continue;
    }

    if (RULE.test(line)) {
      parent.append(h('hr'));
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && (QUOTE.test(lines[i]) || (lines[i].trim() && inner.length && !startsBlock(lines[i])))) {
        const m = QUOTE.exec(lines[i]);
        inner.push(m ? m[1] : lines[i]);
        i++;
      }
      const el = h('blockquote');
      blocks(inner, el);
      parent.append(el);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = cells(line);
      const aligns = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : null));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      parent.append(table(header, aligns, rows));
      continue;
    }

    const item = LIST.exec(line);
    if (item) {
      i = list(lines, i, parent);
      continue;
    }

    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) para.push(lines[i++]);
    const p = h('p');
    inline(para.join('\n'), p);
    parent.append(p);
  }
}

function isClosingFence(line, marker) {
  const trimmed = line.trim();
  return trimmed.length >= marker.length && trimmed[0] === marker[0] && /^(`+|~+)$/.test(trimmed) && trimmed.length >= marker.length;
}

function startsBlock(line) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST.test(line);
}

function cells(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function table(header, aligns, rows) {
  const cell = (tag, text, index) => {
    const el = h(tag, aligns[index] ? { style: { textAlign: aligns[index] } } : null);
    inline(text ?? '', el);
    return el;
  };
  return h(
    'table',
    h('thead', h('tr', header.map((c, i) => cell('th', c, i)))),
    h('tbody', rows.map((r) => h('tr', header.map((_, i) => cell('td', r[i], i))))),
  );
}

/** Parse a list starting at lines[start]; returns the index after it. */
function list(lines, start, parent) {
  const first = LIST.exec(lines[start]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const el = h(ordered ? 'ol' : 'ul');
  if (ordered) {
    const n = parseInt(first[2], 10);
    if (n !== 1) el.setAttribute('start', String(n));
  }
  let i = start;
  while (i < lines.length) {
    const m = LIST.exec(lines[i]);
    if (!m || m[1].length > baseIndent + 1 || m[1].length < baseIndent || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = m[1].length + m[2].length + 1;
    const body = [m[3]];
    i++;
    // Following lines belong to this item while they are indented, or blank and followed by indented text.
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        const next = lines.slice(i + 1).find((l) => l.trim());
        if (next !== undefined && indentOf(next) >= contentIndent) {
          body.push('');
          i++;
          continue;
        }
        break;
      }
      if (indentOf(line) >= Math.min(contentIndent, baseIndent + 2)) {
        body.push(line.slice(Math.min(indentOf(line), contentIndent)));
        i++;
        continue;
      }
      if (LIST.test(line) || startsBlock(line)) break;
      body.push(line.trim()); // lazy continuation of the paragraph
      i++;
    }
    const li = h('li');
    const task = /^\[([ xX])\]\s+(.*)$/s.exec(body[0]);
    if (task) {
      li.append(h('input', { type: 'checkbox', disabled: true, checked: task[1] !== ' ' }), ' ');
      body[0] = task[2];
    }
    const holder = document.createDocumentFragment();
    blocks(body, holder);
    // A single paragraph item reads better without the paragraph wrapper.
    const only = holder.childNodes.length >= 1 && holder.firstChild.nodeName === 'P';
    if (only) {
      const p = holder.firstChild;
      while (p.firstChild) li.append(p.firstChild);
      p.remove();
    }
    li.append(holder);
    el.append(li);
    // Blank lines between items do not end the list.
    let j = i;
    while (j < lines.length && !lines[j].trim()) j++;
    const next = j < lines.length ? LIST.exec(lines[j]) : null;
    if (next && next[1].length === baseIndent && /\d/.test(next[2]) === ordered) i = j;
  }
  parent.append(el);
  return i;
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function codeBlock(code, lang) {
  const copy = h('button', { type: 'button' }, t('copy'));
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      copy.textContent = t('copied');
      setTimeout(() => (copy.textContent = t('copy')), 1400);
    } catch {
      /* clipboard not available */
    }
  });
  return h(
    'div',
    { class: 'code' },
    h('div', { class: 'code-head' }, h('span', lang || ''), copy),
    h('pre', h('code', lang ? { class: `language-${lang}`, dataset: { lang } } : null, code)),
  );
}

// ---- inline ------------------------------------------------------------------

const INLINE = new RegExp(
  [
    '(?<tick>`+)(?<code>[\\s\\S]*?[^`])\\k<tick>(?!`)',
    '(?<img>!?)\\[(?<label>(?:[^\\]\\\\]|\\\\.)*)\\]\\(\\s*<?(?<href>[^\\s)>]+)>?(?:\\s+"[^"]*")?\\s*\\)',
    '\\*\\*\\*(?=\\S)(?<both>[\\s\\S]*?\\S)\\*\\*\\*',
    '(?<bm>\\*\\*|__)(?=\\S)(?<bold>[\\s\\S]*?\\S)\\k<bm>',
    '(?<![\\w*])\\*(?=[^\\s*])(?<em1>[^*]*?[^\\s*])\\*(?![\\w*])',
    '(?<![\\w_])_(?=[^\\s_])(?<em2>[^_]*?[^\\s_])_(?![\\w_])',
    '~~(?=\\S)(?<strike>[\\s\\S]*?\\S)~~',
    '(?<url>https?:\\/\\/[^\\s<>()\\[\\]]*[^\\s<>()\\[\\].,;:!?\'"，。；：！？）】》])',
    '(?<br> {2,}|\\\\)\\n',
  ].join('|'),
  'g',
);

const ESCAPABLE = /\\([\\`*_{}[\]()#+\-.!~|>])/g;

function safeHref(url) {
  const value = String(url).trim();
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (/^[#/]/.test(value) && !value.startsWith('//')) return value;
  return null;
}

function link(href, build) {
  const a = h('a', { href, target: '_blank', rel: 'noopener noreferrer' });
  build(a);
  return a;
}

function wrap(tag, text, parent) {
  const el = h(tag);
  inline(text, el);
  parent.append(el);
  return el;
}

function inline(text, parent) {
  let last = 0;
  // Plain text; a single line break stays a line break (no stray spaces between CJK characters).
  const plain = (s) => {
    if (!s) return;
    s.replace(ESCAPABLE, '$1')
      .split('\n')
      .forEach((part, k) => {
        if (k) parent.append(h('br'));
        if (part) parent.append(part);
      });
  };
  // matchAll works on its own copy of the pattern, so nested calls do not disturb each other.
  for (const m of text.matchAll(INLINE)) {
    const g = m.groups;
    plain(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (g.code !== undefined) {
      parent.append(h('code', g.code.replace(/^ (.*) $/s, '$1')));
    } else if (g.href !== undefined) {
      const href = safeHref(g.href);
      if (!href) plain(m[0]);
      else if (g.img === '!') parent.append(link(href, (a) => a.append(`🖼 ${g.label.replace(ESCAPABLE, '$1') || href}`)));
      else parent.append(link(href, (a) => inline(g.label, a)));
    } else if (g.both !== undefined) {
      wrap('em', g.both, wrap('strong', '', parent));
    } else if (g.bold !== undefined) {
      wrap('strong', g.bold, parent);
    } else if (g.em1 !== undefined || g.em2 !== undefined) {
      wrap('em', g.em1 ?? g.em2, parent);
    } else if (g.strike !== undefined) {
      wrap('del', g.strike, parent);
    } else if (g.url !== undefined) {
      parent.append(link(g.url, (a) => a.append(g.url)));
    } else if (g.br !== undefined) {
      parent.append(h('br'));
    }
  }
  plain(text.slice(last));
}

/** Render inline Markdown only (no paragraphs), for short labels. */
export function renderInline(text) {
  const span = document.createDocumentFragment();
  inline(String(text ?? ''), span);
  return span;
}
