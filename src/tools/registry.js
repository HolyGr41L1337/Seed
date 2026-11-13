// Tool registry. A tool is:
//
//   {
//     name, description,
//     parameters,            // JSON Schema of the input object
//     kind,                  // 'read' | 'write' | 'exec' | 'network' | 'app', or
//                            // (args, ctx) => kind | { kind, paths?, command?, url? }
//     describe?(args, ctx),  // → { title, detail?, preview? } for approval prompts
//     run(args, ctx),        // → string | { content, is_error?, display? }
//   }
//
// ctx = { cwd, signal, emit(text), app, conversation, toolUseId, protectedFiles }
import { editFileTool, listDirTool, readFileTool, writeFileTool } from './files.js';
import { globTool, grepTool } from './search.js';
import { shellTool } from './shell.js';
import { fetchUrlTool } from './web.js';

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export class ToolRegistry {
  constructor() {
    /** @type {Map<string, { tool: object, source: string }>} */
    this.tools = new Map();
  }

  /** Register a tool. Returns a function that removes it again. */
  register(tool, source = 'builtin') {
    if (!tool || !NAME.test(tool.name || '')) {
      throw new Error(`Invalid tool name "${tool?.name}": use 1-64 letters, digits, "_" or "-".`);
    }
    if (typeof tool.run !== 'function') throw new Error(`Tool "${tool.name}" needs a run(args, ctx) function.`);
    if (typeof tool.description !== 'string' || !tool.description.trim()) {
      throw new Error(`Tool "${tool.name}" needs a description: the model decides when to call it from that text.`);
    }
    const existing = this.tools.get(tool.name);
    if (existing && existing.source !== source) {
      throw new Error(`A tool named "${tool.name}" already exists (${existing.source}). Choose another name.`);
    }
    const parameters =
      tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} };
    const entry = { tool: { kind: 'exec', ...tool, parameters }, source };
    this.tools.set(tool.name, entry);
    return () => {
      if (this.tools.get(tool.name) === entry) this.tools.delete(tool.name);
    };
  }

  get(name) {
    return this.tools.get(name)?.tool || null;
  }

  source(name) {
    return this.tools.get(name)?.source || null;
  }

  /**
   * Definitions sent to the model, in a stable order (built-ins as registered,
   * then extension tools by name) so the request prefix stays cacheable.
   */
  definitions() {
    const entries = [...this.tools.values()];
    const builtin = entries.filter((e) => e.source === 'builtin');
    const extra = entries.filter((e) => e.source !== 'builtin').sort((a, b) => a.tool.name.localeCompare(b.tool.name));
    return [...builtin, ...extra].map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }
}

export const updatePlanTool = {
  name: 'update_plan',
  description:
    'Show the user your plan for a task with several steps, and keep it current. ' +
    'Send the whole list every time: mark the step you are working on "in_progress" and finished steps "done". ' +
    'Use it for work with three or more distinct steps; skip it for simple requests.',
  parameters: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: 'Every step of the plan, in order.',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'What this step does, in a few words.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
          },
          required: ['text', 'status'],
        },
      },
    },
    required: ['steps'],
  },
  kind: 'read',
  run(args) {
    const done = args.steps.filter((s) => s.status === 'done').length;
    return { content: `Plan updated (${done}/${args.steps.length} done).`, display: { type: 'plan', steps: args.steps } };
  },
};

export function registerBuiltinTools(registry) {
  for (const tool of [shellTool, readFileTool, writeFileTool, editFileTool, listDirTool, globTool, grepTool, fetchUrlTool, updatePlanTool]) {
    registry.register(tool, 'builtin');
  }
}
