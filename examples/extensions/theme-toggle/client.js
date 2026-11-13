// Theme toggle: a button inside the input bar plus a /theme command.
// Shows: the composer-actions slot, a command with an argument, storage, cleanup.

export async function activate(seed) {
  const { h, tr } = seed;
  const root = document.documentElement;
  const systemDark = () => matchMedia('(prefers-color-scheme: dark)').matches;

  let theme = await seed.storage.get('theme', 'auto'); // 'auto' | 'light' | 'dark'

  const button = h('button', { type: 'button', class: 'icon-button', id: 'theme-toggle', title: tr('切换主题', 'Switch theme') });

  function apply() {
    if (theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = theme;
    const dark = theme === 'dark' || (theme === 'auto' && systemDark());
    button.textContent = dark ? '☀' : '☾';
  }

  async function set(next) {
    theme = next;
    apply();
    await seed.storage.set('theme', theme);
  }

  button.addEventListener('click', () => set(root.dataset.theme === 'dark' || (!root.dataset.theme && systemDark()) ? 'light' : 'dark'));
  seed.ui.mount('composer-actions', button);

  seed.commands.register({
    name: 'theme',
    args: '[light|dark|auto]',
    description: tr('切换浅色 / 深色主题', 'Switch between light and dark'),
    run: (arg) => {
      if (!['light', 'dark', 'auto'].includes(arg)) return seed.ui.toast(tr('用法：/theme light | dark | auto', 'Usage: /theme light | dark | auto'));
      return set(arg);
    },
  });

  apply();
  // Returned function runs when the extension is reloaded or disabled.
  return () => {
    delete root.dataset.theme;
  };
}
