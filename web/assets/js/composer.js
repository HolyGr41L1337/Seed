// The input bar: text entry, send/stop, and the slash-command menu.
import { clear, h, icon } from './dom.js';
import { t } from './i18n.js';

const form = document.getElementById('composer');
const input = document.getElementById('input');
const sendButton = document.getElementById('send');
const newButton = document.getElementById('new-chat');
const menu = document.getElementById('command-menu');

/** name → { name, description, args?, run(argString), source } */
const commands = new Map();
let running = false;
let menuItems = [];
let menuIndex = 0;

const handlers = {
  submit: async () => {}, // (text) => void — set by the app
  stop: () => {},
  newChat: () => {},
};

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
}

function refreshButton() {
  clear(sendButton);
  if (running) {
    sendButton.append(icon('stop', 16));
    sendButton.classList.add('stop');
    sendButton.disabled = false;
    sendButton.title = t('stop');
    sendButton.setAttribute('aria-label', t('stop'));
  } else {
    sendButton.append(icon('send'));
    sendButton.classList.remove('stop');
    sendButton.disabled = !input.value.trim();
    sendButton.title = t('send');
    sendButton.setAttribute('aria-label', t('send'));
  }
}

// ---- slash commands -------------------------------------------------------------

function matchingCommands() {
  const value = input.value;
  if (!value.startsWith('/') || /\s/.test(value)) return [];
  const typed = value.slice(1).toLowerCase();
  const all = [...commands.values()];
  const starts = all.filter((c) => c.name.startsWith(typed));
  const contains = all.filter((c) => !c.name.startsWith(typed) && c.name.includes(typed));
  return [...starts, ...contains];
}

function renderMenu() {
  menuItems = matchingCommands();
  if (!menuItems.length) {
    menu.hidden = true;
    return;
  }
  menuIndex = Math.min(menuIndex, menuItems.length - 1);
  clear(menu);
  menuItems.forEach((command, i) => {
    const row = h(
      'div',
      { class: `command${i === menuIndex ? ' active' : ''}`, role: 'option' },
      h('span', { class: 'name' }, `/${command.name}${command.args ? ` ${command.args}` : ''}`),
      h('span', { class: 'desc' }, command.description || ''),
    );
    // mousedown, not click: keep the focus in the input.
    row.addEventListener('mousedown', (event) => {
      event.preventDefault();
      choose(command);
    });
    menu.append(row);
  });
  menu.hidden = false;
  menu.children[menuIndex]?.scrollIntoView({ block: 'nearest' });
}

function choose(command) {
  if (command.args) {
    input.value = `/${command.name} `;
    menu.hidden = true;
    autosize();
    refreshButton();
    input.focus();
  } else {
    input.value = `/${command.name}`;
    submit();
  }
}

async function runCommand(text) {
  const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return false;
  const command = commands.get(match[1].toLowerCase());
  if (!command) {
    // A lone unknown "/word" is most likely a mistyped command; longer text is a normal message.
    if (match[2] === undefined) {
      composer.onUnknownCommand?.(match[1]);
      return true;
    }
    return false;
  }
  setText('');
  await command.run((match[2] || '').trim());
  return true;
}

async function submit() {
  const text = input.value.trim();
  menu.hidden = true;
  if (!text) return;
  if (text.startsWith('/') && (await runCommand(text))) return;
  await handlers.submit(text);
}

function setText(value) {
  input.value = value;
  autosize();
  refreshButton();
  renderMenu();
}

// ---- events ----------------------------------------------------------------------

input.addEventListener('input', () => {
  autosize();
  refreshButton();
  menuIndex = 0;
  renderMenu();
});

input.addEventListener('keydown', (event) => {
  // Never act on Enter while an input method is composing (Chinese, Japanese, ...).
  if (event.isComposing || event.keyCode === 229) return;
  if (!menu.hidden) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      menuIndex = (menuIndex + (event.key === 'ArrowDown' ? 1 : -1) + menuItems.length) % menuItems.length;
      return renderMenu();
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      const typed = input.value.slice(1).toLowerCase();
      const command = menuItems[menuIndex];
      // Enter on an exactly typed command with arguments still to come completes it; otherwise choose.
      if (command && (event.key === 'Tab' || command.name !== typed || !command.args)) {
        event.preventDefault();
        return choose(command);
      }
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      menu.hidden = true;
      return;
    }
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (!running) submit();
    else if (input.value.trim().startsWith('/')) submit();
    else composer.onBusy?.();
  }
});

input.addEventListener('blur', () => setTimeout(() => (menu.hidden = true), 120));

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (running) handlers.stop();
  else submit();
});

newButton.append(icon('plus'));
newButton.title = t('newChat');
newButton.setAttribute('aria-label', t('newChat'));
newButton.addEventListener('click', () => handlers.newChat());

export const composer = {
  input,
  handlers,
  commands,
  onUnknownCommand: null,
  onBusy: null,

  getText: () => input.value,
  setText,
  focus: () => input.focus(),
  insert(text) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    input.selectionStart = input.selectionEnd = start + text.length;
    autosize();
    refreshButton();
    input.focus();
  },
  setPlaceholder(text) {
    input.placeholder = text;
  },
  setRunning(value) {
    running = !!value;
    refreshButton();
  },
  showNewButton(value) {
    newButton.hidden = !value;
  },

  /** Add a slash command. Returns a function that removes it. */
  registerCommand(command, source = 'app') {
    const name = String(command.name || '').replace(/^\//, '').toLowerCase();
    if (!/^[\w-]{1,32}$/.test(name)) throw new Error(`Invalid command name "${command.name}". Use letters, digits, "-" and "_".`);
    if (typeof command.run !== 'function') throw new Error(`Command "/${name}" needs a run(args) function.`);
    const entry = { ...command, name, source };
    commands.set(name, entry);
    return () => {
      if (commands.get(name) === entry) commands.delete(name);
    };
  },
};

refreshButton();
