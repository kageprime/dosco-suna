import { getTemplate, getTemplateFiles, TEMPLATE_IDS } from '@kortix/starter/templates';
import { parse } from 'yaml';

/** One factory as the home shows it. Name, summary and the counts come from the template files. */
export interface LoopView {
  id: string;
  /** The team, as the reader says it. */
  team: string;
  name: string;
  line: string;
  summary: string;
  /** The primary agent's name in the template. */
  agent: string;
  /** Triggers the template switches on, and every trigger it ships. */
  triggersOn: number;
  triggers: number;
  skills: number;
}

/** The words only the page adds: a team and one line. */
const PRESENTATION: Record<string, Pick<LoopView, 'team' | 'line'>> = {
  'software-factory': { team: 'Engineering', line: 'Issues, failing tests and errors in. Verified pull requests out.' },
  marketing: { team: 'Marketing', line: 'Every merge becomes a changelog, a post and a video. Search and ads stay watched.' },
  sales: { team: 'Sales', line: 'Every signup researched, scored and drafted before you wake up.' },
  support: { team: 'Support', line: 'Every ticket answered in draft or routed to engineering.' },
  recruiting: { team: 'Recruiting', line: 'Every applicant scored against the role, with an interview kit.' },
};

/** The order the stack shows the factories in. */
const ORDER = ['software-factory', 'marketing', 'sales', 'support', 'recruiting'];

type Manifest = { agents?: Record<string, unknown>; skills?: Record<string, unknown>; triggers?: Array<{ enabled?: boolean }> };

/** The agent and the counts of one template, read from its YAML. */
function anatomy(id: (typeof TEMPLATE_IDS)[number]): Pick<LoopView, 'agent' | 'triggersOn' | 'triggers' | 'skills'> {
  const files = getTemplateFiles(id, { repoFullName: 'your-org/your-repo', defaultBranch: 'main' });
  const docs = files.filter((f) => /\.ya?ml$/.test(f.path)).map((f) => (parse(f.content) ?? {}) as Manifest);
  const triggers = docs.flatMap((doc) => doc.triggers ?? []);
  return {
    agent: docs.flatMap((doc) => Object.keys(doc.agents ?? {}))[0] ?? id,
    triggersOn: triggers.filter((t) => t.enabled !== false).length,
    triggers: triggers.length,
    skills: docs.flatMap((doc) => Object.keys(doc.skills ?? {})).length,
  };
}

/** Every factory of this build, in stack order. Server-side: it reads the template files. */
export function loopViews(): LoopView[] {
  return ORDER.flatMap((raw): LoopView[] => {
    const id = TEMPLATE_IDS.find((known) => known === raw);
    const words = PRESENTATION[raw];
    if (!id || !words) return [];
    const template = getTemplate(id);
    return [{ id, name: template.name, summary: template.summary, ...words, ...anatomy(id) }];
  });
}

/** The teams with no ready-made template: the same prompt builds them from a description. */
export function catalogViews(): string[] {
  return ['Research', 'Reporting', 'Operations', 'Finance', 'Legal ops', 'Procurement', 'Back office'];
}
