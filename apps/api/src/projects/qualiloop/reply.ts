/**
 * The text QualiLoop gets for one turn: the agent's words, then each card the
 * web chat draws under the turn's tool calls that asks the person to act (a
 * Connect card, a review). QualiLoop reads text only. Without the cards, "click
 * Connect on the card" pointed at nothing, and the simulated person asked turn
 * after turn what to do (39 of 229 conversations on dev). Links stay out: the
 * person sees a button, not a URL.
 */
import { kortixPlatformTool, parseKortixToolResult, toolCallConnectorSignIns } from '@kortix/sdk';
import type { LogMessage } from './spans';

type ToolCall = Extract<LogMessage['blocks'][number], { type: 'tool_call' }>;

const callText = (block: ToolCall) =>
  (block.result?.content ?? []).map((item) => (item.type === 'text' ? item.text : '')).join('');

const sentence = (value: string) => (/[.!?]$/.test(value) ? value : `${value}.`);

/** The cards one call draws, as the person reads them. */
function cardsOf(block: ToolCall): string[] {
  const signIns = toolCallConnectorSignIns({ ...block, input: block.input });
  if (signIns.length > 0) {
    return signIns.map(({ slug, owner }) => {
      const who = owner === 'project' ? 'Everyone in the workspace will use this sign-in.' : 'Only you will use this sign-in.';
      return `[Card in the chat: Connect ${slug}. ${who} Button: Connect]`;
    });
  }
  // The connect card above is the one the chat draws for a sign-in; its tool card is not a second one.
  if (kortixPlatformTool(block.name) === 'kortix_connectors') return [];
  const result = parseKortixToolResult(callText(block), block.name);
  if (!result || result.card.status !== 'needs_you') return [];
  const buttons = (result.card.links ?? []).map((link) => link.label);
  return [
    `[Card in the chat: ${[result.card.title, result.card.subtitle].filter(Boolean).map((part) => sentence(part!)).join(' ')}` +
      `${buttons.length ? ` Button${buttons.length > 1 ? 's' : ''}: ${buttons.join(', ')}` : ''}]`,
  ];
}

/** The reply for a turn's log messages (the user prompt and the agent's messages after it). */
export function turnReply(messages: LogMessage[]): string {
  const agent = messages.filter((m) => m.role === 'assistant');
  const words = agent
    .map((m) => m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''))
    .filter((value) => value.trim());
  const cards = [...new Set(agent.flatMap((m) => m.blocks.flatMap((b) => (b.type === 'tool_call' ? cardsOf(b) : []))))];
  return [...words, ...cards].join('\n\n').trim();
}
