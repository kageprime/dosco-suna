import { describe, expect, test } from 'bun:test';
import { parseJudgeReply } from './evals.ts';

describe('kortix evals judge reply', () => {
  test('reads one score per criterion, clamped to 0..1, from a reply with prose around the JSON', () => {
    const reply = 'Here you go:\n{"scores": {"accuracy": 0.8, "tone": 1.4}, "reasoning": "Mostly right."}\nThanks';
    expect(parseJudgeReply(reply, ['accuracy', 'tone'])).toEqual({ scores: { accuracy: 0.8, tone: 1 }, reasoning: 'Mostly right.' });
  });
  test('accepts the scores at the top level', () => {
    expect(parseJudgeReply('{"accuracy": 0}', ['accuracy'])).toEqual({ scores: { accuracy: 0 }, reasoning: '' });
  });
  test('a missing criterion, a non-number or no JSON is no reply', () => {
    expect(parseJudgeReply('{"scores": {"accuracy": 1}}', ['accuracy', 'tone'])).toBeNull();
    expect(parseJudgeReply('{"scores": {"accuracy": "high"}}', ['accuracy'])).toBeNull();
    expect(parseJudgeReply('I think it is good.', ['accuracy'])).toBeNull();
  });
});
