// Tiny DOM helpers shared by the app and by extensions (seed.h, seed.icon).

/**
 * Create an element: h('button', { class: 'seed-btn', onclick: fn }, 'Label').
 * Props: `class`, `style` (string or object), `dataset`, `on<event>` handlers,
 * boolean attributes, anything else as an attribute. Children: nodes, strings,
 * numbers, arrays; null/false are skipped.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'open') el[key] = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

const ICONS = {
  send: 'M12 19V5m0 0-6 6m6-6 6 6',
  stop: 'M7 7h10v10H7z',
  plus: 'M12 5v14M5 12h14',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6 6 18',
  dot: 'M12 12h.01',
  chevron: 'm9 6 6 6-6 6',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  trash: 'M5 7h14M10 7V5h4v2m-7 0 1 12h8l1-12',
  settings: 'M4 7h9m4 0h3M4 17h3m4 0h9M15 5v4M9 15v4',
  sidebar: 'M4 5h16v14H4zM9 5v14',
  search: 'M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Zm9 2-4-4',
  edit: 'M4 20h4L19 9l-4-4L4 16v4Z',
  alert: 'M12 8v5m0 3h.01M10.3 4 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0Z',
  terminal: 'm5 8 4 4-4 4m7 0h7',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z',
};

/** An inline SVG icon by name. Unknown names give an empty icon. */
export function icon(name, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('class', 'icon');
  svg.setAttribute('fill', name === 'stop' ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] || '');
  svg.append(path);
  return svg;
}

export const iconNames = () => Object.keys(ICONS);
