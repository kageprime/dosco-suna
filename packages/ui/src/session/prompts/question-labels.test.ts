import { describe, expect, test } from 'bun:test';
import { confirmRowLabels } from './question-labels';

describe('confirmRowLabels', () => {
  test('distinct headers label their rows in the label column', () => {
    expect(
      confirmRowLabels([
        { header: 'Role', question: 'What is your role?' },
        { header: 'Hand-off', question: 'What should I take off your plate?' },
      ]),
    ).toEqual({ labels: ['Role', 'Hand-off'], stacked: false });
  });

  test('a header that every question shares names no row: each row shows its question, stacked', () => {
    expect(
      confirmRowLabels([
        { header: 'You', question: '**What is your role** at the company?' },
        { header: 'you ', question: '\nWhich work should I take off your plate?\nPick all that fit.' },
      ]),
    ).toEqual({
      labels: ['What is your role at the company?', 'Which work should I take off your plate?'],
      stacked: true,
    });
  });

  test('a missing header falls back to the question; a unique header keeps its own', () => {
    expect(
      confirmRowLabels([
        { header: '', question: 'Ship it?' },
        { header: 'Branch', question: 'Which branch?' },
      ]),
    ).toEqual({ labels: ['Ship it?', 'Branch'], stacked: true });
  });
});
