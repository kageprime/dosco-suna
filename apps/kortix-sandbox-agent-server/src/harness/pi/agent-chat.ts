/**
 * An agent's chat (flag `channels`): a person messages one agent in its own
 * chat, and each message is a thread whose reply is this session's answer.
 * The API marks such a session with `kortix.agent_chat` in its runtime_context
 * (apps/api `lib/agent-directory.ts`, `startsAgentChat`) from server-side state only; a
 * person cannot set a `kortix.` key. The runtime then adds
 * `AGENT_CHAT_NOTE` to the system prompt.
 */

/** `runtime_context` key: this session is a thread of a person's chat with an agent. */
export const AGENT_CHAT_CONTEXT_KEY = 'kortix.agent_chat'

/** In the system prompt of an agent chat thread: how the reply reads. */
export const AGENT_CHAT_NOTE =
  '## Your reply\n' +
  'A person messages you in their chat with you. Each message is a thread, and your final answer is the reply under it.\n' +
  '- Start with what you did and the result, in two or three plain sentences.\n' +
  '- When the work makes something longer than a short answer (research, a draft, a report, a plan), write it to a file, Markdown unless the person asked for another format, and attach it with `show` so the person can open it. Do not paste it into the reply.\n' +
  '- When you need a decision from the person, ask it with `question`, with the options as short answers.'
