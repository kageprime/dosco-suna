import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SecretTableRow, type SecretRow } from './secrets-view';

const unset: SecretRow = {
  identifier: 'EXAMPLE_API_KEY',
  key: 'EXAMPLE_API_KEY',
  requirement: 'optional',
  configured: false,
  system: false,
  readonly: false,
  purpose: null,
  canRotate: false,
  updatedAt: null,
  strategy: 'runtime',
  consumer: 'sandbox',
  deliveryStatus: 'unavailable',
  egressPolicy: null,
  requiresRotation: false,
  deliveryBlockedReason: null,
  sharedWith: [],
  usable: true,
  undecryptable: false,
  mineUndecryptable: false,
};

function renderRow(row: SecretRow, canManage = true): string {
  const noop = () => {};
  return renderToStaticMarkup(
    <table>
      <tbody>
        <SecretTableRow
          row={row}
          canManage={canManage}
          viewerId={null}
          busy={false}
          deletingMine={false}
          onEdit={noop}
          onDelete={noop}
          onDeleteMine={noop}
        />
      </tbody>
    </table>,
  );
}

describe('SecretTableRow: a secret with no value', () => {
  test('shows a visible Set value button beside Not set', () => {
    const out = renderRow(unset);
    expect(out).toContain('Not set');
    expect(out).toMatch(/<button[^>]*>Set value<\/button>/);
  });

  test('says who can use it is pending a value instead of a blank cell', () => {
    const out = renderRow(unset);
    expect(out).toContain('—');
    expect(out).toContain('Delivered once a value is set');
  });

  test('a viewer who cannot manage secrets gets no Set value button', () => {
    expect(renderRow(unset, false)).not.toMatch(/>Set value<\/button>/);
  });

  test('a set secret shows no Set value button and no dash', () => {
    const out = renderRow({ ...unset, configured: true, deliveryStatus: 'available' });
    expect(out).not.toMatch(/>Set value<\/button>/);
    expect(out).not.toContain('Delivered once a value is set');
  });
});
