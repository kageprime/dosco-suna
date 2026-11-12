import { describe, expect, test } from 'bun:test';
import { classifyUnannotatedToolRisk, inferToolRisk } from './tool-risk';

describe('inferToolRisk', () => {
  test('a read prefix is read, a write prefix is write', () => {
    for (const name of ['get_issue', 'list_issues', 'read_file', 'search_docs', 'fetch_emails', 'find_user', 'query_db', 'describe_table', 'lookup_customer']) {
      expect(inferToolRisk(name)).toBe('read');
    }
    for (const name of ['create_issue', 'update_issue', 'delete_issue', 'send_email', 'post_message', 'remove_label', 'archive_thread', 'set_status', 'add_comment']) {
      expect(inferToolRisk(name)).toBe('write');
    }
  });

  test('case, camelCase, hyphens and a dotted path are read the same way', () => {
    expect(inferToolRisk('GMAIL_FETCH_EMAILS')).toBe('read');
    expect(inferToolRisk('listIssues')).toBe('read');
    expect(inferToolRisk('send-message')).toBe('write');
    expect(inferToolRisk('repos.list_for_user')).toBe('read');
    expect(inferToolRisk('search')).toBe('read');
  });

  test('anything else is unknown, never write', () => {
    for (const name of ['ask_wiki_question', 'run', 'getaway', 'settings', 'listen', '']) {
      expect(inferToolRisk(name)).toBe('unknown');
    }
  });
});

describe('classifyUnannotatedToolRisk', () => {
  test('a read verb with no write word in the name or the description is read', () => {
    expect(
      classifyUnannotatedToolRisk('list_labels', "Retrieves a list of all system and user-created labels for the user's account."),
    ).toBe('read');
    expect(classifyUnannotatedToolRisk('get_users_me', 'Returns profile information for the authenticated user.')).toBe('read');
    expect(classifyUnannotatedToolRisk('fetch_emails', 'Fetches messages, with filtering and pagination.')).toBe('read');
    expect(classifyUnannotatedToolRisk('GMAIL_LIST_LABELS')).toBe('read');
    expect(classifyUnannotatedToolRisk('get_user_posts', 'Retrieves posts and deleted replies of a user.')).toBe('read');
    expect(classifyUnannotatedToolRisk('list_transfers', 'Lists transfers and charges.')).toBe('read');
  });

  test('a write verb as the name is write', () => {
    for (const name of ['send_email', 'create_post', 'batch_modify_messages', 'move_to_trash', 'add_label_to_email']) {
      expect(classifyUnannotatedToolRisk(name, 'Does the thing.')).toBe('write');
    }
  });

  test('a read verb is write when the name or the description also writes', () => {
    expect(classifyUnannotatedToolRisk('get_or_create_label', 'Returns a label.')).toBe('write');
    expect(classifyUnannotatedToolRisk('search_and_replace', 'Finds text.')).toBe('write');
    expect(classifyUnannotatedToolRisk('fetch_message', 'Fetches a message and marks it as read: modifies its labels.')).toBe('write');
    expect(classifyUnannotatedToolRisk('get_draft', 'Sends the draft to its recipients.')).toBe('write');
    expect(classifyUnannotatedToolRisk('list_threads', 'Lists threads. Use it to delete old ones.')).toBe('write');
  });

  test('a name that says nothing is write, never read', () => {
    for (const name of ['ask_wiki_question', 'run', 'getaway', 'settings', 'listen', 'process_order', '']) {
      expect(classifyUnannotatedToolRisk(name, 'Returns data.')).toBe('write');
    }
  });
});
