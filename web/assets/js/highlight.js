// A small syntax highlighter for code blocks in answers. It recognizes
// comments, strings, numbers, keywords, literals and function calls for the
// languages models write most, and builds DOM nodes (never HTML strings).

const C_LIKE = { line: '//', block: true };
const HASH = { line: '#', block: false };

const KEYWORDS = {
  js: 'abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in instanceof interface keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield',
  py: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return self try while with yield',
  sh: 'case do done elif else esac export fi for function if in local return then until while echo cd source set unset exit',
  ps: 'begin break catch class continue data do dynamicparam else elseif end exit filter finally for foreach from function if in param process return switch throw trap try until using var while',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
  rust: 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while',
  c: 'auto break case catch char class const continue default delete do double else enum extern final float for friend goto if inline int long namespace new operator override private protected public return short signed sizeof static struct switch template this throw try typedef typename union unsigned using virtual void volatile while bool string var val fun when is in object package import interface extends implements abstract',
  sql: 'select from where and or not insert into values update set delete create table index view drop alter add primary key foreign references join left right inner outer on group by order having limit offset as distinct union all case when then else end null is in like between exists',
  css: '',
};
const LITERALS = new Set('true false null undefined None True False nil NaN Infinity'.split(' '));

const LANGS = {
  js: { keywords: 'js', comments: C_LIKE, template: true },
  py: { keywords: 'py', comments: HASH, triple: true },
  sh: { keywords: 'sh', comments: HASH, variables: true },
  ps: { keywords: 'ps', comments: HASH, variables: true, insensitive: true },
  go: { keywords: 'go', comments: C_LIKE, template: true },
  rust: { keywords: 'rust', comments: C_LIKE },
  c: { keywords: 'c', comments: C_LIKE },
  sql: { keywords: 'sql', comments: { line: '--', block: true }, insensitive: true },
  css: { keywords: 'css', comments: { line: null, block: true } },
  json: { keywords: null, comments: { line: null, block: false } },
  yaml: { keywords: null, comments: HASH },
};

const ALIASES = {
  javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', typescript: 'js', tsx: 'js', vue: 'js', svelte: 'js',
  python: 'py', py3: 'py',
  bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', shellscript: 'sh', dockerfile: 'sh', makefile: 'sh',
  powershell: 'ps', ps1: 'ps', pwsh: 'ps',
  golang: 'go', rs: 'rust',
  cpp: 'c', 'c++': 'c', h: 'c', hpp: 'c', cs: 'c', csharp: 'c', java: 'c', kotlin: 'c', kt: 'c', swift: 'c', php: 'c', scala: 'c', dart: 'c',
  postgres: 'sql', mysql: 'sql', sqlite: 'sql',
  scss: 'css', less: 'css',
  jsonc: 'json', json5: 'json',
  yml: 'yaml', toml: 'yaml', ini: 'yaml', env: 'yaml',
  ruby: 'py', rb: 'py', r: 'py',
};

const cache = new Map();

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compile(name) {
  if (cache.has(name)) return cache.get(name);
  const lang = LANGS[name];
  const parts = [];
  if (lang.comments.block) parts.push('(?<c1>\\/\\*[\\s\\S]*?(?:\\*\\/|$))');
  if (lang.comments.line) parts.push(`(?<c2>${escapeRe(lang.comments.line)}[^\\n]*)`);
  if (lang.triple) parts.push('(?<s3>"""[\\s\\S]*?(?:"""|$)|\'\'\'[\\s\\S]*?(?:\'\'\'|$))');
  parts.push('(?<s>"(?:[^"\\\\\\n]|\\\\.)*"?|\'(?:[^\'\\\\\\n]|\\\\.)*\'?)');
  if (lang.template) parts.push('(?<s2>`(?:[^`\\\\]|\\\\[\\s\\S])*`?)');
  if (lang.variables) parts.push('(?<v>\\$\\{?[A-Za-z_][\\w]*\\}?)');
  parts.push('(?<n>\\b(?:0x[\\da-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b)');
  parts.push('(?<w>[A-Za-z_$][\\w$]*)(?<call>\\s*\\()?');
  const keywords = new Set(lang.keywords ? KEYWORDS[lang.keywords].split(' ').filter(Boolean).map((k) => (lang.insensitive ? k.toLowerCase() : k)) : []);
  const compiled = { re: new RegExp(parts.join('|'), 'g'), keywords, insensitive: !!lang.insensitive };
  cache.set(name, compiled);
  return compiled;
}

/** Highlighted code as a DocumentFragment; plain text for unknown languages or very long code. */
export function highlight(code, langName) {
  const frag = document.createDocumentFragment();
  const key = String(langName || '').toLowerCase();
  const name = LANGS[key] ? key : ALIASES[key];
  if (!name || code.length > 40_000) {
    frag.append(code);
    return frag;
  }
  const { re, keywords, insensitive } = compile(name);
  const span = (cls, text) => {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
  };
  let last = 0;
  for (const m of code.matchAll(re)) {
    const g = m.groups;
    if (m.index > last) frag.append(code.slice(last, m.index));
    last = m.index + m[0].length;
    if (g.c1 !== undefined || g.c2 !== undefined) frag.append(span('tok-c', m[0]));
    else if (g.s !== undefined || g.s2 !== undefined || g.s3 !== undefined) frag.append(span('tok-s', m[0]));
    else if (g.v !== undefined) frag.append(span('tok-v', m[0]));
    else if (g.n !== undefined) frag.append(span('tok-n', m[0]));
    else if (g.w !== undefined) {
      const word = g.w;
      const test = insensitive ? word.toLowerCase() : word;
      if (keywords.has(test)) frag.append(span('tok-k', word));
      else if (LITERALS.has(word)) frag.append(span('tok-l', word));
      else if (g.call !== undefined) frag.append(span('tok-f', word));
      else frag.append(word);
      if (g.call !== undefined) frag.append(g.call);
    } else frag.append(m[0]);
  }
  if (last < code.length) frag.append(code.slice(last));
  return frag;
}
