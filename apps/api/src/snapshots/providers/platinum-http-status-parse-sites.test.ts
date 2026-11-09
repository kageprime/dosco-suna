import { describe, expect, test } from 'bun:test';

import {
  type PollErrorClass,
  classifyPlatinumPollError,
  httpStatusFromMessage,
} from './platinum-poll-classify';
import { findTemplateById, isPlatinumAuthFailure, type PlatinumClient } from './platinum-templates';
import { isRetryableUploadError, templateInUseCount } from './platinum-upload';

/**
 * Characterization of every `platinum <method> <path> -> <status>` decision in
 * the unit (KRTX-4468). Before the refactor each of the five sites re-parses
 * with its own regex and four of them only accept the spaced form, so a
 * compact `->404` message is a 404 to the poll classifier and "not a 404" to
 * the template lookup at the same time. `platinumJson` itself never emits a
 * compact message (shared/platinum.ts appends `-> ${res.status} `), so on
 * real inputs this table is behavior-preserving; the compact rows pin exactly
 * which verdicts collapse when every site adopts `httpStatusFromMessage`.
 */
function platinumMessage(status: number, body: string): string {
  return `platinum GET /v1/templates/tpl_x -> ${status} ${body}`;
}

function compact(platinumMessage_: string): string {
  return platinumMessage_.replace('-> ', '->');
}

const M_404 = platinumMessage(404, 'not visible yet');
const M_404_COMPACT = compact(M_404);
const M_409 = platinumMessage(409, 'template_in_use {"in_use":3}');
const M_409_COMPACT = compact(M_409);
const M_401 = platinumMessage(401, 'unauthorized');
const M_401_COMPACT = compact(M_401);
const M_408 = platinumMessage(408, 'idle timeout');
const M_408_COMPACT = compact(M_408);

function findingTemplateById(message: string): Promise<unknown> {
  const client: PlatinumClient = {
    isConfigured: () => true,
    async json<T>(): Promise<T> {
      throw new Error(message);
    },
  };
  return findTemplateById('tpl_x', client);
}

/** The site verdicts, one row per (message, expected, current). */
const ROWS: Array<{
  name: string;
  message: string;
  poll: PollErrorClass;
  findTemplate: 'null' | 'throws';
  authFailure: boolean;
  retryableUpload: boolean;
  inUseCount: number | null;
}> = [
  { name: '-> 404', message: M_404, poll: 'not-visible', findTemplate: 'null', authFailure: false, retryableUpload: false, inUseCount: null },
  // Compact `->404`: only the poll classifier (the canonical regex) reads it.
  // Collapsed onto the canonical parser (KRTX-4468): `->404` now reads as a
  // 404 on every site, like `-> 404` always did.
  { name: '->404', message: M_404_COMPACT, poll: 'not-visible', findTemplate: 'null', authFailure: false, retryableUpload: false, inUseCount: null },
  { name: '-> 409 template_in_use', message: M_409, poll: 'unknown', findTemplate: 'throws', authFailure: false, retryableUpload: false, inUseCount: 3 },
  { name: '->409 template_in_use', message: M_409_COMPACT, poll: 'unknown', findTemplate: 'throws', authFailure: false, retryableUpload: false, inUseCount: 3 },
  { name: '-> 401', message: M_401, poll: 'auth-permanent', findTemplate: 'throws', authFailure: true, retryableUpload: false, inUseCount: null },
  { name: '->401', message: M_401_COMPACT, poll: 'auth-permanent', findTemplate: 'throws', authFailure: true, retryableUpload: false, inUseCount: null },
  { name: '-> 408 idle', message: M_408, poll: 'transient-transport', findTemplate: 'throws', authFailure: false, retryableUpload: true, inUseCount: null },
  { name: '->408 idle', message: M_408_COMPACT, poll: 'transient-transport', findTemplate: 'throws', authFailure: false, retryableUpload: true, inUseCount: null },
];

describe('platinum `-> <status>` decisions (characterization)', () => {
  test.each(ROWS)('$name', async ({ message, poll, findTemplate, authFailure, retryableUpload, inUseCount }) => {
    expect(classifyPlatinumPollError(new Error(message))).toBe(poll);
    expect(httpStatusFromMessage(message)).toBe(Number(/(\d{3}) \S/.exec(message)?.[1]));
    await expect(
      findingTemplateById(message).then((r) => 'null', () => 'throws'),
    ).resolves.toBe(findTemplate);
    expect(isPlatinumAuthFailure(new Error(message))).toBe(authFailure);
    expect(isRetryableUploadError(new Error(message))).toBe(retryableUpload);
    expect(templateInUseCount(message)).toBe(inUseCount);
  });

  test('a message without a status parses to undefined', () => {
    expect(httpStatusFromMessage('platinum GET /v1/x timed out after 5000')).toBeUndefined();
  });

  test('the template lookup rethrows every non-404 error', async () => {
    const client: PlatinumClient = {
      isConfigured: () => true,
      async json<T>(): Promise<T> {
        throw new Error(M_409);
      },
    };
    await expect(() => findTemplateById('tpl_x', client)).toThrow();
  });
});
