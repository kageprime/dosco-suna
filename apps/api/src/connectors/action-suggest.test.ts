import { describe, expect, test } from 'bun:test';
import { closestActionPaths } from './action-suggest';

const GMAIL = ['get_profile', 'fetch_emails', 'send_email', 'create_draft', 'list_labels', 'delete_email'];

describe('closestActionPaths', () => {
  test('a vendor tool slug finds the action it names', () => {
    expect(closestActionPaths('GMAIL_GET_PROFILE', GMAIL)).toEqual(['get_profile']);
    expect(closestActionPaths('gmail.get_profile', GMAIL)).toEqual(['get_profile']);
    expect(closestActionPaths('Get-Profile', GMAIL)).toEqual(['get_profile']);
  });

  test('a near miss ranks by edit distance, best first', () => {
    expect(closestActionPaths('GMAIL_FETCH_EMAIL', GMAIL)[0]).toBe('fetch_emails');
    expect(closestActionPaths('send_mail', GMAIL)).toEqual(['send_email']);
  });

  test('nothing close answers an empty list', () => {
    expect(closestActionPaths('GMAIL_RUN_REPORT', GMAIL)).toEqual([]);
    expect(closestActionPaths('', GMAIL)).toEqual([]);
    expect(closestActionPaths('get_profile', [])).toEqual([]);
  });

  test('at most `limit` names', () => {
    expect(closestActionPaths('item', ['items', 'itema', 'itemb', 'itemc'], 2)).toHaveLength(2);
  });
});
