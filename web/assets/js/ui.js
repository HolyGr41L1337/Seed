// Toasts and dialogs.
import { h, icon } from './dom.js';
import { t } from './i18n.js';

const toasts = document.getElementById('toasts');

/**
 * Show a short message at the bottom of the page.
 * @param {string} text
 * @param {{ type?: 'info' | 'error', duration?: number, action?: { label: string, run: () => void } }} [options]
 */
export function toast(text, options = {}) {
  const el = h('div', { class: `toast${options.type === 'error' ? ' error' : ''}`, role: 'status' }, String(text));
  const close = () => el.remove();
  if (options.action) {
    el.append(
      h('button', {
        type: 'button',
        onclick: () => {
          close();
          options.action.run();
        },
      }, options.action.label),
    );
  }
  toasts.append(el);
  while (toasts.children.length > 4) toasts.firstChild.remove();
  const duration = options.duration ?? (options.type === 'error' || options.action ? 8000 : 3200);
  if (duration > 0) setTimeout(close, duration);
  return close;
}

/**
 * Open a dialog.
 * @param {{ title?: string, content: Node | string, actions?: { label: string, primary?: boolean, danger?: boolean, run?: (close: () => void) => void }[],
 *           onClose?: () => void, width?: number }} options
 * @returns {{ close: () => void, element: HTMLElement, body: HTMLElement }}
 */
export function modal(options) {
  const body = h('div', { class: 'modal-body' }, options.content);
  const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
  if (options.width) dialog.style.width = `min(${options.width}px, 100%)`;
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    options.onClose?.();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };
  dialog.append(
    h('div', { class: 'modal-head' }, h('span', options.title || ''), h('button', { type: 'button', class: 'icon-button', onclick: close, 'aria-label': 'Close' }, icon('x', 16))),
    body,
  );
  if (options.actions?.length) {
    dialog.append(
      h(
        'div',
        { class: 'modal-actions' },
        options.actions.map((a) =>
          h('button', {
            type: 'button',
            class: `seed-btn${a.primary ? ' primary' : ''}${a.danger ? ' danger' : ''}`,
            onclick: () => (a.run ? a.run(close) : close()),
          }, a.label),
        ),
      ),
    );
  }
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  return { close, element: dialog, body };
}

/** Ask a yes/no question. Resolves to true or false. */
export function confirmDialog(text, { confirmLabel = t('ok'), danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    modal({
      content: h('p', { style: { margin: '6px 0' } }, text),
      onClose: () => {
        if (!answered) resolve(false);
      },
      actions: [
        { label: t('cancel') },
        {
          label: confirmLabel,
          primary: !danger,
          danger,
          run: (close) => {
            answered = true;
            resolve(true);
            close();
          },
        },
      ],
    });
  });
}
