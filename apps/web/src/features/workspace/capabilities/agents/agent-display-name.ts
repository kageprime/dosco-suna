import { capitalizeWords, isMetaAgentName, META_AGENT_DISPLAY_NAME } from '@kortix/shared';

/**
 * The name a person reads for an agent. Meta agents show their shared label,
 * the built-in agent's id is `kortix` (backend constant, session rows,
 * manifests — never renamed) but the product surface calls it Xera. Every
 * other agent renders its own name, capitalized the same way as before. Ids,
 * keys, search text, and toasts' values stay raw — only the rendered label
 * maps.
 */
export function displayAgentName(name: string): string {
  if (isMetaAgentName(name)) return META_AGENT_DISPLAY_NAME;
  if (name === 'kortix') return 'Xera';
  return capitalizeWords(name);
}
