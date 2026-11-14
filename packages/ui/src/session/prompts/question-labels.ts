import type { QuestionInfo } from '../../internal/session-types';

/** A question's text as one plain line: the first non-empty line, markdown marks removed. */
export function questionPlainLine(question: string): string {
  return (
    question
      .replace(/[*_`#>]/g, '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}

/**
 * The label of each row on the Confirm tab, and whether the rows stack.
 *
 * A header labels its row only when no other question in the call shares it.
 * An agent that gives every question the same header (the stage name, "You")
 * would otherwise label every row "You". A row without a distinct header
 * shows its question text instead, and then the rows stack (label above the
 * answer), because a question does not fit the narrow label column.
 */
export function confirmRowLabels(questions: Pick<QuestionInfo, 'header' | 'question'>[]): {
  labels: string[];
  stacked: boolean;
} {
  const counts = new Map<string, number>();
  for (const q of questions) {
    const header = q.header?.trim().toLowerCase();
    if (header) counts.set(header, (counts.get(header) ?? 0) + 1);
  }
  let stacked = false;
  const labels = questions.map((q) => {
    const header = q.header?.trim() ?? '';
    if (header && counts.get(header.toLowerCase()) === 1) return header;
    stacked = true;
    return questionPlainLine(q.question) || header;
  });
  return { labels, stacked };
}
