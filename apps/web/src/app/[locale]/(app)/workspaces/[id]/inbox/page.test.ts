import { afterAll, expect, mock, test } from 'bun:test';

let userAgent = 'Browser';
mock.module('next/headers', () => ({
  headers: async () => new Headers({ 'user-agent': userAgent }),
}));
const { default: page } = await import('./page');
afterAll(() => mock.restore());

async function destination(view: string, agent: string) {
  userAgent = agent;
  try {
    await page({
      params: Promise.resolve({ id: 'synthetic-workspace' }),
      searchParams: Promise.resolve({ view, id: 'cr:7', tag: ['a', 'b'] }),
    });
  } catch (error) {
    return (error as { digest: string }).digest;
  }
}

test('old Review bookmarks preserve item and repeated query values', async () => {
  expect(await destination('review', 'Browser')).toBe(
    'NEXT_REDIRECT;replace;/workspaces/synthetic-workspace/review?id=cr%3A7&tag=a&tag=b;307;',
  );
});
test('installed desktop shells keep Review inside the window', async () => {
  expect(await destination('review', 'KortixDesktop')).toBe(
    'NEXT_REDIRECT;replace;/projects/synthetic-workspace/review?id=cr%3A7&tag=a&tag=b;307;',
  );
});
test('notification bookmarks open personal Inbox', async () => {
  expect(await destination('notifications', 'Browser')).toBe('NEXT_REDIRECT;replace;/inbox;307;');
});
