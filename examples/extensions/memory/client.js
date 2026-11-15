// The UI half of the memory extension: a /memory command that lists the
// saved notes. Shows: calling this extension's own server routes, a dialog.

export function activate(seed) {
  const { h, tr } = seed;

  async function showNotes() {
    const body = h('div');
    const draw = async () => {
      const { notes } = await seed.api.ext.get('/notes');
      body.replaceChildren(
        ...(notes.length
          ? notes.map((n) =>
              h(
                'div',
                { class: 'card', style: { margin: '0 0 8px', padding: '8px 12px' } },
                h(
                  'div',
                  { class: 'row' },
                  h('span', { class: 'grow', style: { whiteSpace: 'normal' } }, n.note),
                  h('button', { class: 'seed-btn small', onclick: async () => (await seed.api.ext.del(`/notes/${n.id}`), draw()) }, tr('删除', 'Delete', { ja: '削除', fr: 'Supprimer', ru: 'Удалить' })),
                ),
              ),
            )
          : [h('p', { class: 'seed-muted' }, tr('还没有记忆。对 AI 说"记住……"试试。', 'Nothing saved yet. Try telling the AI to remember something.', { ja: 'まだ何も記憶していません。AI に「覚えておいて」と頼んでみてください。', fr: "Rien d'enregistré pour l'instant. Demandez à l'IA de retenir quelque chose.", ru: 'Пока ничего не сохранено. Попросите ИИ что-нибудь запомнить.' }))]),
      );
    };
    seed.ui.modal({ title: tr('记忆', 'Memory', { ja: 'メモリ', fr: 'Mémoire', ru: 'Память' }), content: body });
    await draw();
  }

  seed.commands.register({ name: 'memory', description: tr('查看 AI 记住的内容', 'Show what the AI remembers', { ja: 'AI が覚えている内容を表示する', fr: "Afficher ce que l'IA a retenu", ru: 'Показать, что запомнил ИИ' }), run: showNotes });
}
