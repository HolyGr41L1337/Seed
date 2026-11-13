// Memory: two tools for the agent, notes kept in the extension's storage and
// added to the system prompt of new conversations, and an HTTP route that
// this extension's own UI code (client.js) reads.
// Shows: tools.register, storage, prompt.add, http routes.

export async function activate(ctx) {
  const load = async () => (await ctx.storage.get('notes', [])) || [];
  // prompt.add takes text or a function; the function must be synchronous,
  // so keep a copy of the notes in memory.
  let notes = await load();

  ctx.tools.register({
    name: 'remember',
    description:
      'Save a short note that you will see again in future conversations. ' +
      'Call it when the user states a lasting preference or fact (their name, how they like code written, a project convention), ' +
      'or asks you to remember something.',
    parameters: {
      type: 'object',
      properties: { note: { type: 'string', description: 'The note, one sentence, written so it makes sense on its own.' } },
      required: ['note'],
    },
    kind: 'read', // changes nothing outside this extension's own storage, so it never needs approval
    async run({ note }) {
      notes = await load();
      const entry = { id: Date.now().toString(36), note: String(note).trim(), at: new Date().toISOString() };
      notes.push(entry);
      await ctx.storage.set('notes', notes);
      return `Saved note ${entry.id}.`;
    },
  });

  ctx.tools.register({
    name: 'forget',
    description: 'Delete a saved note by its id. Call it when the user asks you to forget something, or when a note is no longer true.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    kind: 'read',
    async run({ id }) {
      notes = await load();
      const before = notes.length;
      notes = notes.filter((n) => n.id !== id);
      await ctx.storage.set('notes', notes);
      return before === notes.length ? `There is no note with id ${id}.` : `Deleted note ${id}.`;
    },
  });

  ctx.prompt.add(() =>
    notes.length
      ? `# Notes you saved in earlier conversations\n${notes.map((n) => `- (${n.id}) ${n.note}`).join('\n')}`
      : '',
  );

  // GET /ext/memory/notes
  ctx.http.get('/notes', async () => ({ notes: await load() }));
  // DELETE /ext/memory/notes/:id
  ctx.http.delete('/notes/:id', async ({ params }) => {
    notes = (await load()).filter((n) => n.id !== params.id);
    await ctx.storage.set('notes', notes);
    return { ok: true };
  });
}
