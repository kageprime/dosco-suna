import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { SCRIPTS } from '../playground/scripts';

const playgroundRoot = join(import.meta.dir, '..', 'playground');

test('every run-all script exists, so no run reports a phantom failure', () => {
  expect(SCRIPTS.filter((script) => !existsSync(join(playgroundRoot, script)))).toEqual([]);
});
