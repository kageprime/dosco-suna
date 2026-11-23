import { DEMO } from './factory-content';

/** One factory's clip: a signal arrives, the agent works, the result waits for a person. */
export interface Scene {
  /** `real`: every line happened (the demo run). `example`: the steps the factory runs, with example inputs. */
  kind: 'real' | 'example';
  signal: { source: string; title: string };
  steps: Array<{ text: string; done?: boolean }>;
  ship: { kind: string; title: string; status: string };
}

const real = DEMO.worker.slice(0, 4);

export const SCENES: Record<string, Scene> = {
  'software-factory': {
    kind: 'real',
    signal: { source: `GitHub issue #${DEMO.tickets[0]!.number}`, title: DEMO.tickets[0]!.title },
    steps: real.map((line) => ({ text: line.kind === 'cmd' ? `$ ${line.text}` : line.text, done: line.kind === 'ok' })),
    ship: { kind: `Pull request #${DEMO.pr.number}`, title: DEMO.pr.title, status: 'Waiting for you to merge' },
  },
  marketing: {
    kind: 'example',
    signal: { source: 'Pull request merged', title: 'Return 400 on malformed JSON' },
    steps: [
      { text: 'load the brand skill' },
      { text: 'write the changelog entry' },
      { text: 'record the change in a browser' },
      { text: 'render a captioned video', done: true },
    ],
    ship: { kind: 'Pull request', title: 'Changelog entry, post and video', status: 'Waiting for you to publish' },
  },
  sales: {
    kind: 'example',
    signal: { source: 'New signup', title: 'jane@example.com · Example Inc' },
    steps: [
      { text: 'research the company' },
      { text: 'score it against your ICP' },
      { text: 'draft the outreach' },
      { text: 'update the CRM', done: true },
    ],
    ship: { kind: 'Draft', title: 'Lead brief and outreach to Example Inc', status: 'Waiting for you to send' },
  },
  support: {
    kind: 'example',
    signal: { source: 'In-app feedback', title: 'CSV export fails on large tables' },
    steps: [
      { text: 'triage: bug, high priority' },
      { text: 'search the docs and the code' },
      { text: 'draft the answer' },
      { text: 'file the bug for engineering', done: true },
    ],
    ship: { kind: 'Draft', title: 'Reply to the customer, bug ticket linked', status: 'Waiting for you to send' },
  },
  recruiting: {
    kind: 'example',
    signal: { source: 'New application', title: 'Senior Backend Engineer' },
    steps: [
      { text: 'read the CV and the links' },
      { text: 'score against the role' },
      { text: 'build the interview kit' },
      { text: 'draft the candidate update', done: true },
    ],
    ship: { kind: 'Scorecard', title: 'Scorecard and interview kit', status: 'Waiting for your decision' },
  },
};
