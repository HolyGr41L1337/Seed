// Context compaction. When a conversation grows past its budget, the model
// writes a summary of everything so far, and later requests start from that
// summary instead of the old messages ("simple compaction": nothing from
// before the summary is replayed, so there is nothing left to go stale).
// The full transcript stays in the conversation file for the user to read.
import { estimateTokens, truncateMiddle } from '../util.js';
import { contextMessages } from './messages.js';

export const COMPACTION_PROMPT = `The conversation above is about to be replaced by a summary that you write now. After this, you will see only your summary, and you must be able to carry on the work from it without losing anything that matters.

Write the summary with these sections:

1. Requests and goals. Everything the user asked for, in order. Keep exact wording where it matters: names, paths, numbers, preferences, constraints.
2. Work done. Files created or changed (full paths) and what changed in each; commands run and the results that matter; decisions made and the reasons.
3. Current state. What works, what is broken, errors met and how they were resolved.
4. In progress and next. What you were doing when this summary was requested and the next steps, precise enough to continue at once.
5. Worth remembering. Facts learned about the project and the environment, and anything the user told you to do or to avoid.

Be specific and complete rather than short. Include code or exact strings where you will need them again. Do not call any tools. Reply with the summary only.`;

/** Token budget above which the conversation is compacted before the next model call. */
export function compactionThreshold(info) {
  if (info?.compactAt) return info.compactAt;
  const window = info?.contextWindow || 128_000;
  return Math.min(Math.floor(window * 0.75), 200_000);
}

function isFreshUserTurn(message) {
  return message?.role === 'user' && !message.content.some((b) => b.type === 'tool_result');
}

/** Plain-text rendering of messages, used when the conversation no longer fits the model at all. */
export function renderTranscript(messages, maxChars) {
  const parts = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'text') parts.push(`${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${b.text}`);
      else if (b.type === 'tool_use') parts.push(`ASSISTANT called ${b.name}: ${truncateMiddle(JSON.stringify(b.input), 600)}`);
      else if (b.type === 'tool_result') parts.push(`TOOL RESULT${b.is_error ? ' (error)' : ''}: ${truncateMiddle(String(b.content), 600)}`);
    }
  }
  return truncateMiddle(parts.join('\n\n'), maxChars);
}

/**
 * Summarize `conv` in place. Returns true when a summary was made.
 * A fresh user message at the end is kept after the summary, so the model
 * still answers the user's exact words.
 */
export async function compactConversation({ conv, provider, model, tools, signal, info }) {
  const all = contextMessages(conv);
  // Index, in conv.messages, of the last message the model sees.
  let lastIndex = conv.messages.length - 1;
  while (lastIndex >= 0 && conv.messages[lastIndex].role === 'notice') lastIndex--;
  const keepLast = isFreshUserTurn(conv.messages[lastIndex]);
  const toSummarize = keepLast ? all.slice(0, -1) : all;
  if (toSummarize.length < 2) return false;

  const ask = { role: 'user', content: [{ type: 'text', text: COMPACTION_PROMPT }] };
  const textFrom = (result) => result.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

  let summary = '';
  try {
    // Same system prompt, tools and history as the conversation itself, so this request
    // reads the provider's prompt cache instead of paying for the whole context again.
    summary = textFrom(await provider.stream({ model, system: conv.system, messages: [...toSummarize, ask], tools, signal }));
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err.kind !== 'context_overflow' && err.kind !== 'bad_request') throw err;
  }
  if (!summary) {
    // The conversation does not fit any more (or the model answered with tool calls):
    // summarize a shortened plain-text transcript instead.
    const budgetChars = Math.floor((info?.contextWindow || 128_000) * 0.5 * 3);
    const transcript = renderTranscript(toSummarize, budgetChars);
    summary = textFrom(
      await provider.stream({
        model,
        system: 'You write precise, complete summaries of working sessions between a user and an AI agent.',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: `<conversation>\n${transcript}\n</conversation>\n\n${COMPACTION_PROMPT}` }],
          },
        ],
        tools: [],
        signal,
      }),
    );
  }
  if (!summary) return false;

  conv.context = {
    summary,
    from: keepLast ? lastIndex : conv.messages.length,
    midRun: !keepLast,
    at: Date.now(),
    tokensBefore: conv.lastContext || estimateTokens(toSummarize),
  };
  conv.lastContext = 0;
  return true;
}
