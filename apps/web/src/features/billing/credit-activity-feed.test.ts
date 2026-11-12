import { describe, expect, test } from 'bun:test';

import { creditActivityKind, shortenLedgerIds } from './credit-activity-feed';

describe('creditActivityKind', () => {
  test('typed debits name their own kind', () => {
    expect(creditActivityKind('compute_debit', null)).toBe('compute');
    expect(creditActivityKind('storage_debit', null)).toBe('storage');
    expect(creditActivityKind('llm_debit', null)).toBe('llm');
    expect(creditActivityKind('token_overage', null)).toBe('llm');
  });

  test('every way credits come in is one kind, refunds included', () => {
    for (const type of ['tier_grant', 'purchase', 'auto_topup', 'admin_grant', 'refund', 'compute_refund', 'llm_reservation_refund']) {
      expect(creditActivityKind(type, null)).toBe('credit');
    }
  });

  test('a generic usage row is classified by the description the API writes', () => {
    expect(creditActivityKind('usage', 'Sandbox compute · 1vCPU/2GB/10GB · 139s')).toBe('compute');
    expect(creditActivityKind('usage', 'Storage · 2.1 GiB-hours')).toBe('storage');
    expect(creditActivityKind('usage', 'Files storage · 2026-11-09 · 2.41 GiB-hours')).toBe('storage');
    expect(creditActivityKind('usage', 'LLM gateway admission hold · deepseek-v4.1-flash')).toBe('llm');
    expect(creditActivityKind('usage', 'deepseek-v4.1-flash · 12 requests')).toBe('llm');
    expect(creditActivityKind('usage', null)).toBe('llm');
  });

  test('expiry, adjustments and unknown types stay neutral', () => {
    expect(creditActivityKind('expired', null)).toBe('other');
    expect(creditActivityKind('adjustment', null)).toBe('other');
    expect(creditActivityKind('admin_debit', 'Reimbursement')).toBe('other');
  });
});

describe('shortenLedgerIds', () => {
  test('cuts every full UUID to its first eight characters', () => {
    expect(
      shortenLedgerIds('Sandbox compute · 276956e5-b9d4-48e9-be62-c0a389b9f183 · 2vCPU/4GB/20GB · 2s'),
    ).toBe('Sandbox compute · 276956e5 · 2vCPU/4GB/20GB · 2s');
    expect(
      shortenLedgerIds('Reimbursement (by admin b4e959ab-c442-4f51-ad57-7b36e7583d87)'),
    ).toBe('Reimbursement (by admin b4e959ab)');
  });

  test('leaves text without a UUID untouched', () => {
    expect(shortenLedgerIds('Monthly credits')).toBe('Monthly credits');
  });
});
