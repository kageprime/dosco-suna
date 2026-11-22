/** Additive read access only. Existing session sharing and IAM remain independent. */
export interface TriggerReaders {
  humans: 'members' | 'none';
  agents: string[];
}

export function parseTriggerReaders(value: unknown): { readers: TriggerReaders } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'session_readers must be an object' };
  const fields = Object.entries(value);
  if (fields.some(([key]) => key !== 'humans' && key !== 'agents')) return { error: 'session_readers accepts only humans and agents' };
  const humans = 'humans' in value ? value.humans : 'none';
  const agents = 'agents' in value ? value.agents : [];
  if (humans !== 'none' && humans !== 'members') return { error: 'session_readers.humans must be none or members' };
  if (!Array.isArray(agents) || agents.some((name) => typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(name))) {
    return { error: 'session_readers.agents must be a list of named agents' };
  }
  return { readers: { humans, agents: [...new Set<string>(agents)].sort() } };
}
