import { capitalizeWords } from '@kortix/shared';

/**
 * The name a person reads for an agent. The built-in agent's id is `kortix`
 * (backend constant, session rows, manifests — never renamed), but the
 * product surface calls it Dosco. Every other agent renders its own name,
 * capitalized the same way as before. Ids, keys, search text, and toasts'
 * values stay raw — only the rendered label maps.
 */
export function displayAgentName(name: string): string {
  if (name === 'kortix') return 'Dosco';
  return capitalizeWords(name);
}
