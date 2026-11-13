// The conversation view: messages, live streaming, tool calls and approvals.
import { api } from './api.js';
import { clear, h, icon } from './dom.js';
import { t } from './i18n.js';
import { renderMarkdown } from './markdown.js';
import { state } from './state.js';

const threadEl = document.getElementById('thread');
const viewEl = document.getElementById('view');

/** Extension points (see extensions.js). */
export const toolRenderers = new Map(); // tool name → ({ name, input, result, status }) => Node | null
export const messageActions = new Set(); // { label, title?, run(message, element) }
export const renderHooks = new Set(); // (element, message) => void, after a message is rendered

let cards = new Map(); // toolUseId → ToolCard
let live = null; // the assistant message being streamed
let statusEl = null;
let stick = true;

viewEl.addEventListener('scroll', () => {
  stick = viewEl.scrollHeight - viewEl.scrollTop - viewEl.clientHeight < 90;
});

function scrollDown(force = false) {
  if (force || stick) viewEl.scrollTop = viewEl.scrollHeight;
}

function formatBytes(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function oneLine(text, max = 160) {
  const line = String(text ?? '').trim().split('\n')[0];
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** The short description shown in a tool call's header. */
function summarize(name, input = {}) {
  switch (name) {
    case 'shell':
      return `$ ${oneLine(input.command)}`;
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'list_dir':
      return oneLine(input.path || '.');
    case 'glob':
    case 'grep':
      return oneLine(input.pattern) + (input.path ? `  in ${input.path}` : '');
    case 'fetch_url':
      return oneLine(input.url);
    case 'seed_api':
      return `${input.method || ''} ${oneLine(input.path)}`;
    case 'ui_eval':
      return oneLine(input.code);
    case 'ext_call':
      return `${input.name || ''} ${input.arguments ? oneLine(JSON.stringify(input.arguments)) : ''}`;
    case 'reload_extensions':
      return '';
    default: {
      const json = JSON.stringify(input ?? {});
      return json === '{}' ? '' : oneLine(json);
    }
  }
}

function diffView(oldText, newText) {
  const pre = h('pre');
  for (const line of String(oldText).split('\n')) pre.append(h('span', { class: 'diff-line del' }, `- ${line}\n`));
  for (const line of String(newText).split('\n')) pre.append(h('span', { class: 'diff-line add' }, `+ ${line}\n`));
  return pre;
}

class ToolCard {
  constructor(call) {
    this.id = call.id;
    this.name = call.name;
    this.input = call.input || {};
    this.result = null;
    this.status = 'queued';
    this.open = false;
    this.liveText = '';

    this.mark = h('span', { class: 'tool-mark' });
    this.summaryEl = h('span', { class: 'tool-summary' });
    this.metaEl = h('span', { class: 'tool-meta' });
    this.head = h('div', { class: 'tool-head', onclick: () => this.toggle() }, this.mark, h('span', { class: 'tool-name' }, this.name), this.summaryEl, this.metaEl);
    this.liveEl = h('div', { class: 'tool-live', hidden: true }, h('pre'));
    this.approvalEl = h('div', { class: 'approval', hidden: true });
    this.body = h('div', { class: 'tool-body', hidden: true });
    this.el = h('div', { class: 'tool', dataset: { tool: this.name, id: this.id } }, this.head, this.approvalEl, this.liveEl, this.body);
    this.setInput(this.input);
    this.setStatus('queued');
  }

  setInput(input) {
    this.input = input || {};
    this.summaryEl.textContent = summarize(this.name, this.input);
    this.summaryEl.title = this.summaryEl.textContent;
  }

  setStatus(status, meta) {
    this.status = status;
    this.el.dataset.status = status;
    clear(this.mark);
    if (status === 'running' || status === 'preparing') this.mark.append(h('span', { class: 'spinner' }));
    else this.mark.append(icon(status === 'done' ? 'check' : status === 'error' || status === 'denied' ? 'x' : status === 'approval' ? 'alert' : 'dot', 14));
    const labels = { preparing: t('preparing'), queued: '', approval: '', running: '', denied: t('denied'), interrupted: t('interrupted') };
    this.metaEl.textContent = meta ?? labels[status] ?? '';
    if (status !== 'running') this.liveEl.hidden = true;
  }

  appendOutput(text) {
    this.liveText = (this.liveText + text).slice(-6000);
    const pre = this.liveEl.firstChild;
    pre.textContent = this.liveText.split('\n').slice(-9).join('\n');
    this.liveEl.hidden = this.status !== 'running';
    pre.scrollTop = pre.scrollHeight;
  }

  complete(result, ms) {
    this.result = result;
    this.hideApproval();
    const declined = result.is_error && /declined|Not run:/.test(result.content || '');
    this.setStatus(result.is_error ? (declined ? 'denied' : 'error') : 'done', ms != null && ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : undefined);
    if (this.open) this.renderBody();
    const custom = toolRenderers.get(this.name);
    if (custom) this.renderCustom(custom);
  }

  renderCustom(custom) {
    let node = null;
    try {
      node = custom({ name: this.name, input: this.input, result: this.result, status: this.status });
    } catch (err) {
      setTimeout(() => {
        throw err;
      });
    }
    if (!(node instanceof Node)) return;
    this.customEl?.remove();
    this.customEl = h('div', { class: 'tool-body tool-custom' }, node);
    this.el.append(this.customEl);
  }

  toggle(force) {
    this.open = force ?? !this.open;
    this.body.hidden = !this.open;
    if (this.open) this.renderBody();
  }

  renderBody() {
    clear(this.body);
    const { name, input, result } = this;
    const section = (label, node) => h('div', h('div', { class: 'label' }, label), node);
    if (name === 'edit_file' && typeof input.old_string === 'string') {
      this.body.append(section(input.path || t('input'), diffView(input.old_string, input.new_string ?? '')));
    } else if (name === 'write_file' && typeof input.content === 'string') {
      this.body.append(section(input.path || t('input'), h('pre', input.content.length > 6000 ? `${input.content.slice(0, 6000)}\n…` : input.content)));
    } else if (name === 'shell') {
      this.body.append(section(t('input'), h('pre', input.command || '')));
    } else if (Object.keys(input).length) {
      this.body.append(section(t('input'), h('pre', JSON.stringify(input, null, 2))));
    }
    if (result) this.body.append(section(t('output'), h('pre', String(result.content ?? ''))));
    else if (this.liveText) this.body.append(section(t('output'), h('pre', this.liveText)));
  }

  showApproval(approval) {
    this.setStatus('approval');
    clear(this.approvalEl);
    const category = t(`approvalTitle.${approval.category}`);
    const preview = approval.preview;
    let previewEl = null;
    if (preview?.type === 'edit') previewEl = diffView(preview.old, preview.new);
    else if (preview?.type === 'write') previewEl = h('pre', preview.content);
    else if (preview?.type === 'json') previewEl = h('pre', JSON.stringify(preview.value, null, 2));
    else if (approval.detail) previewEl = h('pre', approval.detail);

    const buttons = [];
    const answer = async (decision) => {
      for (const b of buttons) b.disabled = true;
      try {
        await api.post(`/api/conversations/${state.conversationId}/approvals/${approval.id}`, { decision });
      } catch {
        for (const b of buttons) b.disabled = false;
      }
    };
    buttons.push(
      h('button', { type: 'button', class: 'seed-btn primary', onclick: () => answer('allow') }, t('allow')),
      h('button', { type: 'button', class: 'seed-btn', onclick: () => answer('allow_always') }, t('allowAlways')),
      h('button', { type: 'button', class: 'seed-btn', onclick: () => answer('deny') }, t('deny')),
    );
    this.approvalEl.append(
      h('div', { class: 'approval-title' }, category),
      previewEl,
      h('div', { class: 'approval-buttons' }, buttons),
    );
    this.approvalEl.hidden = false;
    scrollDown();
  }

  hideApproval() {
    this.approvalEl.hidden = true;
    clear(this.approvalEl);
  }
}

/** update_plan shows as a checklist instead of a generic tool card. */
class PlanCard {
  constructor(call) {
    this.id = call.id;
    this.name = call.name;
    this.el = h('div', { class: 'plan', dataset: { tool: 'update_plan' } });
    this.setInput(call.input);
  }

  setInput(input) {
    clear(this.el);
    for (const step of Array.isArray(input?.steps) ? input.steps : []) {
      this.el.append(h('div', { class: `plan-step ${step.status || 'pending'}` }, h('span', { class: 'box' }), h('span', String(step.text ?? ''))));
    }
  }

  setStatus() {}
  appendOutput() {}
  complete() {}
  showApproval() {}
  hideApproval() {}
  toggle() {}
}

function makeCard(call) {
  const card = call.name === 'update_plan' ? new PlanCard(call) : new ToolCard(call);
  cards.set(call.id, card);
  return card;
}

function thinkingBlock(text, isLive = false) {
  const body = h('div', { class: 'thinking-text' }, text);
  const el = h('details', { class: `thinking${isLive ? ' live' : ''}`, open: isLive }, h('summary', isLive ? t('thinkingLive') : t('thinking')), body);
  el.setText = (value) => (body.textContent = value);
  return el;
}

function markdownBlock(text) {
  const el = h('div', { class: 'md' });
  el.append(renderMarkdown(text));
  return el;
}

function runRenderHooks(el, message) {
  for (const hook of renderHooks) {
    try {
      hook(el, message);
    } catch (err) {
      setTimeout(() => {
        throw err;
      });
    }
  }
}

function actionsRow(message, el) {
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
  // Only for answers, not for the steps in between that end in tool calls.
  if (!text || message.content.some((b) => b.type === 'tool_use')) return null;
  const copy = h('button', { type: 'button' }, t('copy'));
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = t('copied');
      setTimeout(() => (copy.textContent = t('copy')), 1400);
    } catch {
      /* clipboard not available */
    }
  });
  const row = h('div', { class: 'msg-actions' }, copy);
  for (const action of messageActions) {
    row.append(h('button', { type: 'button', title: action.title || action.label, onclick: () => action.run(message, el) }, action.label));
  }
  return row;
}

function renderMessage(message) {
  if (message.role === 'notice') {
    return h('div', { class: `notice ${message.meta?.level || 'info'}`, dataset: { id: message.id } }, h('span', message.content[0]?.text || ''));
  }
  if (message.role === 'user') {
    for (const b of message.content) {
      if (b.type === 'tool_result') cards.get(b.tool_use_id)?.complete(b);
    }
    const shown = message.content.filter((b) => b.type === 'text' || b.type === 'image');
    if (!shown.length) return null;
    const bubble = h('div', { class: 'bubble' });
    for (const b of shown) {
      if (b.type === 'image') bubble.append(h('img', { src: `data:${b.mediaType};base64,${b.data}`, alt: '' }));
      else bubble.append(b.text);
    }
    const el = h('div', { class: 'msg user', dataset: { id: message.id } }, bubble);
    runRenderHooks(el, message);
    return el;
  }
  const el = h('div', { class: 'msg assistant', dataset: { id: message.id } });
  for (const b of message.content) {
    if (b.type === 'thinking') {
      if (b.text) el.append(thinkingBlock(b.text));
    } else if (b.type === 'text') el.append(markdownBlock(b.text));
    else if (b.type === 'tool_use') el.append(makeCard(b).el);
  }
  if (message.meta?.interrupted) el.append(h('div', { class: 'status-line' }, t('interrupted')));
  const actions = actionsRow(message, el);
  if (actions) el.append(actions);
  runRenderHooks(el, message);
  return el;
}

function appendMessage(message) {
  const el = renderMessage(message);
  if (!el) return;
  // Keep the live message and the status line at the end.
  if (live) threadEl.insertBefore(el, live.el);
  else if (statusEl) threadEl.insertBefore(el, statusEl);
  else threadEl.append(el);
}

// ---- live streaming ------------------------------------------------------------

function startLive() {
  endLive();
  live = { el: h('div', { class: 'msg assistant live' }), blocks: [], nodes: [], frame: 0 };
  live.typing = h('div', { class: 'typing' }, h('i'), h('i'), h('i'));
  live.el.append(live.typing);
  if (statusEl) threadEl.insertBefore(live.el, statusEl);
  else threadEl.append(live.el);
  scrollDown();
}

function endLive() {
  if (!live) return;
  cancelAnimationFrame(live.frame);
  // Cards created while the call was being written belong to the live element only.
  for (const block of live.blocks) if (block.type === 'tool_use') cards.delete(block.id);
  live.el.remove();
  live = null;
}

function scheduleLive() {
  if (!live || live.frame) return;
  live.frame = requestAnimationFrame(() => {
    if (!live) return;
    live.frame = 0;
    renderLive();
  });
}

function renderLive() {
  live.typing.remove();
  live.blocks.forEach((block, i) => {
    let node = live.nodes[i];
    if (!node) {
      if (block.type === 'thinking') node = thinkingBlock('', true);
      else if (block.type === 'text') node = h('div', { class: 'md' });
      else {
        const card = new ToolCard({ id: block.id, name: block.name, input: {} });
        card.setStatus('preparing');
        block.card = card;
        node = card.el;
      }
      live.nodes[i] = node;
      live.el.append(node);
      block.dirty = true;
    }
    if (!block.dirty) return;
    block.dirty = false;
    if (block.type === 'thinking') node.setText(block.text);
    else if (block.type === 'text') node.replaceChildren(renderMarkdown(block.text));
    else block.card.setStatus('preparing', block.bytes ? `${t('preparing')} ${formatBytes(block.bytes)}` : undefined);
  });
  // A finished thinking block folds away once the answer starts.
  live.blocks.forEach((block, i) => {
    if (block.type === 'thinking' && i < live.blocks.length - 1 && live.nodes[i]?.open && !block.folded) {
      block.folded = true;
      live.nodes[i].open = false;
      live.nodes[i].classList.remove('live');
      live.nodes[i].querySelector('summary').textContent = t('thinking');
    }
  });
  scrollDown();
}

function liveDelta(kind, text) {
  if (!live) startLive();
  const last = live.blocks[live.blocks.length - 1];
  if (last?.type === kind) {
    last.text += text;
    last.dirty = true;
  } else live.blocks.push({ type: kind, text, dirty: true });
  scheduleLive();
}

function setStatusLine(text) {
  if (!text) {
    statusEl?.remove();
    statusEl = null;
    return;
  }
  if (!statusEl) {
    statusEl = h('div', { class: 'status-line' });
    threadEl.append(statusEl);
  }
  statusEl.textContent = text;
  scrollDown();
}

// ---- public --------------------------------------------------------------------

export const thread = {
  element: threadEl,

  clear() {
    endLive();
    setStatusLine(null);
    cards = new Map();
    clear(threadEl);
    stick = true;
  },

  /** Render a conversation snapshot, including a run that is in progress. */
  show(conv) {
    this.clear();
    for (const message of conv.messages) appendMessage(message);
    const run = conv.run;
    if (run) {
      for (const tool of run.tools || []) {
        const card = cards.get(tool.toolUseId);
        if (!card) continue;
        if (tool.status === 'running') {
          card.setStatus('running');
          if (tool.output) card.appendOutput(tool.output);
        }
      }
      for (const approval of run.approvals || []) cards.get(approval.toolUseId)?.showApproval(approval);
      if (run.partial) {
        startLive();
        for (const block of run.partial.blocks) {
          if (block.type === 'tool_use') live.blocks.push({ type: 'tool_use', id: block.id, name: block.name, bytes: block.bytes, dirty: true });
          else live.blocks.push({ type: block.type, text: block.text, dirty: true });
        }
        if (live.blocks.length) renderLive();
      }
    }
    scrollDown(true);
  },

  /** Apply one live event of the open conversation. */
  handle(e) {
    switch (e.type) {
      case 'message.added':
        appendMessage(e.message);
        scrollDown(e.message.role === 'user');
        break;
      case 'message.started':
        setStatusLine(null);
        startLive();
        break;
      case 'delta':
        liveDelta(e.kind, e.text);
        break;
      case 'tool_use.started':
        if (!live) startLive();
        live.blocks.push({ type: 'tool_use', id: e.toolUseId, name: e.name, bytes: 0, dirty: true });
        scheduleLive();
        break;
      case 'tool_use.progress': {
        const block = live?.blocks.find((b) => b.type === 'tool_use' && b.id === e.toolUseId);
        if (block) {
          block.bytes = e.bytes;
          block.dirty = true;
          scheduleLive();
        }
        break;
      }
      case 'message.reset':
        endLive();
        break;
      case 'message.completed':
        endLive();
        appendMessage(e.message);
        scrollDown();
        break;
      case 'approval.requested':
        cards.get(e.approval.toolUseId)?.showApproval(e.approval);
        break;
      case 'approval.resolved': {
        const card = cards.get(e.toolUseId);
        if (card) {
          card.hideApproval();
          if (e.decision === 'allow' || e.decision === 'allow_always') card.setStatus('queued');
        }
        break;
      }
      case 'tool.started': {
        const card = cards.get(e.toolUseId);
        if (card) {
          card.setInput(e.input);
          card.setStatus('running');
        }
        break;
      }
      case 'tool.output':
        cards.get(e.toolUseId)?.appendOutput(e.text);
        scrollDown();
        break;
      case 'tool.completed':
        cards.get(e.toolUseId)?.complete(e.result, e.ms);
        scrollDown();
        break;
      case 'run.retry':
        setStatusLine(t('retrying', e.attempt));
        break;
      case 'run.notice':
        setStatusLine(e.message);
        break;
      case 'compaction.started':
        setStatusLine(t('compacting'));
        break;
      case 'compaction.completed':
        setStatusLine(null);
        break;
      case 'run.completed':
        endLive();
        setStatusLine(null);
        for (const card of cards.values()) {
          if (card.status === 'running' || card.status === 'queued' || card.status === 'approval') {
            card.hideApproval();
            card.setStatus('error', t('interrupted'));
          }
        }
        break;
      default:
        break;
    }
  },

  scrollToEnd: () => scrollDown(true),
};
