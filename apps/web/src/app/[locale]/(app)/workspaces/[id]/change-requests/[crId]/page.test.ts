import { expect, test } from 'bun:test';
const { default: page } = await import('./page');
const W = 'aaaaaaaa-1111-4111-8111-111111111111';
const C = 'bbbbbbbb-2222-4222-8222-222222222222';

async function outcome(ref: string) {
  try {
    return await page({
      params: Promise.resolve({ id: W, crId: ref }),
    });
  } catch (error) {
    return error instanceof Error && 'digest' in error ? error.digest : error;
  }
}

test('the screenshot UUID detail route renders the fragment-preserving compatibility navigation', async () => {
  expect(await outcome(C)).toHaveProperty('props', { workspaceId: W, crRef: C });
});
test('UUID casing canonicalizes before navigation', async () => {
  expect(await outcome(C.toUpperCase())).toHaveProperty('props', { workspaceId: W, crRef: C });
});
test.each(['bad', '0', '2147483648', 'a/b'])('invalid reference %s is not a Review redirect', async (ref) => {
  expect(await outcome(ref)).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
});
test.each(['233', '#233', '%23233'])('numbers %s render the authorized resolver, not cr:number selection', async (ref) => {
  const element = await outcome(ref);
  expect(element).toHaveProperty('props', { workspaceId: W, crRef: '233' });
});
