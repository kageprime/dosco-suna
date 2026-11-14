/**
 * Characterization of the two plain prompts in `src/prompts.ts` — `prompt()`
 * and `selectFrom()` — written before KRTX-4814 routes them through the file's
 * existing end-of-input guards (`askOnce`, and the `ended` race `confirm()`
 * already runs), so every TTY behavior below passes before AND after that fix.
 *
 * Pinned here:
 *  - the exact prompt lines and the numbered menu with its default marker;
 *  - default handling for blank input, trimming, answer by option name or by
 *    number, case/whitespace normalization, the re-ask on an unknown value;
 *  - end of input (EOF: `</dev/null`, a pipe that ended, a closed pty):
 *    probed — `rl.question`'s callback NEVER fires when the stream ends while
 *    'close' does, so the bare awaits left the promise pending and the
 *    process exited 0 at the prompt with nothing done. The EOF cases below
 *    pin the fixed contract: `prompt()` rejects with `EndOfInputError`
 *    without a default and takes `defaultValue` with one; `selectFrom()`
 *    takes its default.
 *
 * The EOF cases race a 250 ms guard so a regression fails the test instead
 * of hanging the worker: `settlesWithin` returns null when nothing settles.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';

import { EndOfInputError, prompt, selectFrom } from '../prompts.ts';

const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
const realStdout = Object.getOwnPropertyDescriptor(process, 'stdout');

interface Captured {
  stdin: PassThrough;
  /** Everything written to the fake stdout so far, as raw bytes. */
  text(): string;
}

/** Swap process.stdin and process.stdout for streams we drive and read, with
 *  the TTY flags ensureTTY() requires. */
function attachTty(): Captured {
  const stdin = new PassThrough();
  Object.defineProperty(stdin, 'isTTY', { value: true });
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  const stdout = new PassThrough();
  Object.defineProperty(stdout, 'isTTY', { value: true });
  const chunks: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
  return { stdin, text: () => Buffer.concat(chunks).toString('utf8') };
}

afterEach(() => {
  if (realStdin) Object.defineProperty(process, 'stdin', realStdin);
  if (realStdout) Object.defineProperty(process, 'stdout', realStdout);
});

/** 'settled' once `p` resolves or rejects; null after 250 ms — a prompt whose
 *  promise never settles (the EOF hang) fails the test, not the runner. */
function settlesWithin<T>(p: Promise<T>): Promise<'settled' | null> {
  return Promise.race([
    p.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
  ]);
}

/** Let one piped line reach the question that is outstanding — readline only
 *  consumes input while a question is pending (same as the confirm suite). */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('prompt', () => {
  test('returns the typed answer, trimmed', async () => {
    const { stdin } = attachTty();
    const answer = prompt('region');
    stdin.write('  eu-central-1 \n');
    expect(await answer).toBe('eu-central-1');
  });

  test('blank input takes the default', async () => {
    const { stdin } = attachTty();
    const answer = prompt('region', 'us-east-1');
    stdin.write('\n');
    expect(await answer).toBe('us-east-1');
  });

  test('blank input without a default returns an empty string', async () => {
    const { stdin } = attachTty();
    const answer = prompt('region');
    stdin.write('\n');
    expect(await answer).toBe('');
  });

  test('the prompt line shows the label and the default in parentheses', async () => {
    const { stdin, text } = attachTty();
    const answer = prompt('API subdomain', 'api.example.test');
    stdin.write('\n');
    await answer;
    expect(text()).toContain('API subdomain (api.example.test): ');
  });

  test('the prompt line has no suffix without a default', async () => {
    const { stdin, text } = attachTty();
    const answer = prompt('API subdomain');
    stdin.write('x\n');
    await answer;
    expect(text()).toContain('API subdomain: ');
  });

  test('end of input without a default rejects with EndOfInputError instead of hanging', async () => {
    const { stdin } = attachTty();
    const answer = prompt('region');
    stdin.end();
    expect(await settlesWithin(answer)).toBe('settled');
    const error = await answer.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EndOfInputError);
  });

  test('end of input with a default takes the default instead of hanging', async () => {
    const { stdin } = attachTty();
    const answer = prompt('region', 'us-east-1');
    stdin.end();
    expect(await settlesWithin(answer)).toBe('settled');
    expect(await answer).toBe('us-east-1');
  });

  test('end of input with a whitespace-padded default returns that default untrimmed', async () => {
    const { stdin } = attachTty();
    const answer = prompt('region', '  us-east-1  ');
    stdin.end();
    expect(await settlesWithin(answer)).toBe('settled');
    expect(await answer).toBe('  us-east-1  ');
  });
});

describe('selectFrom', () => {
  test('renders the numbered menu with the default marker, then asks', async () => {
    const { stdin, text } = attachTty();
    const answer = selectFrom('Sandbox provider', ['daytona', 'platinum'] as const, 'platinum');
    stdin.write('\n');
    expect(await answer).toBe('platinum');
    expect(text()).toContain('  Sandbox provider\n    1) daytona\n    2) platinum (default)\n');
    expect(text()).toContain('Enter a number or name [platinum]: ');
  });

  test('accepts the option name, case-insensitive and trimmed', async () => {
    const { stdin } = attachTty();
    const answer = selectFrom('Sandbox provider', ['daytona', 'platinum'] as const, 'platinum');
    stdin.write('  DAYTONA \n');
    expect(await answer).toBe('daytona');
  });

  test('accepts the option number', async () => {
    const { stdin } = attachTty();
    const answer = selectFrom('Sandbox provider', ['daytona', 'platinum'] as const, 'platinum');
    stdin.write('1\n');
    expect(await answer).toBe('daytona');
  });

  test('blank input takes the default', async () => {
    const { stdin } = attachTty();
    const answer = selectFrom('Sandbox provider', ['daytona', 'platinum'] as const, 'platinum');
    stdin.write('\n');
    expect(await answer).toBe('platinum');
  });

  test('re-asks on an unknown value', async () => {
    const { stdin, text } = attachTty();
    const answer = selectFrom('Sandbox provider', ['daytona', 'platinum'] as const, 'platinum');
    stdin.write('nope\n');
    await tick();
    await tick();
    stdin.write('2\n');
    expect(await answer).toBe('platinum');
    expect(text()).toContain('  Pick one of: daytona, platinum\n');
  });

  test('end of input takes the default instead of hanging', async () => {
    const { stdin } = attachTty();
    const answer = selectFrom('Sandbox provider', ['daytona', 'platinum'] as const, 'platinum');
    stdin.end();
    expect(await settlesWithin(answer)).toBe('settled');
    expect(await answer).toBe('platinum');
  });
});
