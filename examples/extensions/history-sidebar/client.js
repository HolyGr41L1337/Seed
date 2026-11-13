// History sidebar: lists conversations in the left slot.
// Shows: mounting UI in a slot, calling the REST API, reacting to live events,
// following app state, a slash command, and per-extension storage.

export async function activate(seed) {
  const { h, icon, tr } = seed;
  let conversations = [];
  let open = (await seed.storage.get('open', true)) !== false;

  const list = h('div', { class: 'seed-list' });
  const panel = h(
    'div',
    { class: 'seed-panel history-sidebar', id: 'history-sidebar' },
    h(
      'div',
      { class: 'seed-panel-head' },
      h('span', tr('对话', 'Conversations')),
      h('button', { class: 'icon-button', title: tr('新对话', 'New conversation'), onclick: () => seed.chat.new() }, icon('plus', 16)),
    ),
    list,
  );

  function render() {
    const current = seed.state.get().conversationId;
    list.replaceChildren(
      ...conversations.map((c) =>
        h(
          'a',
          { class: `seed-item${c.id === current ? ' active' : ''}`, href: `#/c/${c.id}`, title: c.title },
          h('span', { class: 'grow' }, c.title || tr('（无标题）', '(untitled)')),
          c.running ? h('span', { class: 'spinner' }) : null,
          h(
            'button',
            {
              class: 'icon-button history-delete',
              title: tr('删除', 'Delete'),
              onclick: async (event) => {
                event.preventDefault();
                if (await seed.ui.confirm(tr(`删除"${c.title || c.id}"？`, `Delete "${c.title || c.id}"?`), { danger: true })) {
                  await seed.api.del(`/api/conversations/${c.id}`);
                }
              },
            },
            icon('trash', 14),
          ),
        ),
      ),
    );
    if (!conversations.length) list.append(h('div', { class: 'seed-muted', style: { padding: '8px 10px', fontSize: '13px' } }, tr('还没有对话', 'No conversations yet')));
  }

  async function refresh() {
    conversations = (await seed.api.get('/api/conversations?limit=200')).conversations;
    render();
  }

  // Everything registered through `seed` is removed automatically on reload.
  let unmount = null;
  function show(value) {
    open = value;
    if (open && !unmount) unmount = seed.ui.mount('left', panel, { width: 260 });
    if (!open && unmount) {
      unmount();
      unmount = null;
    }
  }

  for (const type of ['conversation.created', 'conversation.updated', 'conversation.deleted', 'run.started', 'run.completed']) {
    seed.events.on(type, refresh);
  }
  seed.state.subscribe(render); // keeps the active item highlighted

  seed.commands.register({
    name: 'history',
    description: tr('显示或隐藏历史对话侧边栏', 'Show or hide the conversation sidebar'),
    run: async () => {
      show(!open);
      await seed.storage.set('open', open);
    },
  });

  show(open);
  await refresh();
}
