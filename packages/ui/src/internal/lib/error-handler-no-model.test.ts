/**
 * Session create refused because no model can run (409 `no_model_available`):
 * the person sees the server's sentence and both ways out, never a bare error.
 */
import { beforeEach, expect, mock, test } from 'bun:test';
import { ApiError, configureKortix } from '@kortix/sdk';
import { createTranslator, defaultUiMessages } from '../../i18n';

type Action = { label: string; onClick: () => void };
const errorToast = mock((_message: string, _options?: { actions?: Action[] }) => undefined);
mock.module('../../primitives/toast', () => ({ errorToast, warningToast: mock() }));
mock.module('../../lib/telemetry', () => ({ captureException: mock() }));
const { handleApiError } = await import('./error-handler');
const t = createTranslator({ locale: 'en', messages: defaultUiMessages, namespace: 'hardcodedUi.i18nComplete' });

const MESSAGE = 'No model: upgrade to the Credits plan or add your own provider key.';
const refusal = () => new ApiError(MESSAGE, { status: 409, code: 'no_model_available' });

beforeEach(() => errorToast.mockClear());

test('billing on: the toast names the reason and offers Upgrade plan and Add provider key', () => {
  configureKortix({ backendUrl: 'http://localhost', getToken: async () => null, billingEnabled: true });
  handleApiError(refusal(), undefined, t);
  expect(errorToast).toHaveBeenCalledTimes(1);
  expect(errorToast.mock.calls[0]?.[0]).toBe(MESSAGE);
  expect(errorToast.mock.calls[0]?.[1]?.actions?.map((a) => a.label)).toEqual(['Upgrade plan', 'Add provider key']);
});

test('billing off: only Add provider key, since there is no plan to buy', () => {
  configureKortix({ backendUrl: 'http://localhost', getToken: async () => null, billingEnabled: false });
  handleApiError(refusal(), undefined, t);
  expect(errorToast.mock.calls[0]?.[1]?.actions?.map((a) => a.label)).toEqual(['Add provider key']);
});
