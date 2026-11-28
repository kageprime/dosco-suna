import { describe, expect, test } from 'bun:test';

import { linkedChangeRequestIds, MAX_LINKED_CHANGE_REQUESTS } from './change-request-links';

describe('linkedChangeRequestIds', () => {
  test('reads the change request of a Review link, the colon plain or encoded', () => {
    const text =
      'Ready in [change request #11](https://app.example/workspaces/w1/inbox?view=review&id=cr%3Abf9c09c2-e6f5-410a-8ef8-e353b1792786).' +
      ' See also /workspaces/w1/review?id=cr:cr_synthetic_2.';
    expect(linkedChangeRequestIds(text)).toEqual(['bf9c09c2-e6f5-410a-8ef8-e353b1792786', 'cr_synthetic_2']);
  });

  test('each change request once, in first-seen order', () => {
    const text = '/review?id=cr:a then /inbox?view=review&id=cr%3Ab then /review?id=cr:a';
    expect(linkedChangeRequestIds(text)).toEqual(['a', 'b']);
  });

  test(`at most ${MAX_LINKED_CHANGE_REQUESTS}`, () => {
    const text = ['a', 'b', 'c', 'd'].map((id) => `/review?id=cr:${id}`).join(' ');
    expect(linkedChangeRequestIds(text)).toEqual(['a', 'b', 'c']);
  });

  test('other Review items and plain text are not change requests', () => {
    expect(linkedChangeRequestIds('/inbox?view=review&id=call:exec_1 and cr:loose')).toEqual([]);
    expect(linkedChangeRequestIds('')).toEqual([]);
    expect(linkedChangeRequestIds(null)).toEqual([]);
  });
});
