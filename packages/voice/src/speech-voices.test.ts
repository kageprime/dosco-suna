import { afterAll, expect, test } from 'bun:test';

// The voice catalog (GET /voices, src/speech.ts inworldVoices): no source at boot is not a catalog.
// The relay calls inworldVoices() at start (src/server.ts); a source (VOICE_MODELS_URL) configured
// later must still be fetched, so a voice asked for by description matches the catalog.
const saved: Record<string, string | undefined> = {};
for (const k of [
  'VOICE_MODELS_URL',
  'VOICE_MODELS_TOKEN',
  'INWORLD_API_KEY',
  'INWORLD_MODEL',
  'KORTIX_WORKSPACE',
]) {
  saved[k] = process.env[k];
  delete process.env[k];
}

let hits = 0;
const catalog = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch() {
    hits++;
    return Response.json({ data: [{ id: 'Dennis', description: 'deep calm male narrator' }] });
  },
});

test('a voice source configured after boot is still used: the empty no-source catalog is never kept', async () => {
  const { inworldVoice, inworldVoices } = await import('./speech');
  // No source yet: the relay calls it at start, before a source exists.
  expect(await inworldVoices()).toEqual([]);
  expect(inworldVoice('deep calm male')).toBe('');
  // A source appears (a config apply at runtime). The next call fetches it through the models base.
  process.env.VOICE_MODELS_URL = `http://127.0.0.1:${catalog.port}`;
  const voices = await inworldVoices();
  expect(voices.map((v) => ({ id: v.id, about: v.about.trim() }))).toEqual([
    { id: 'Dennis', about: 'dennis deep calm male narrator' },
  ]);
  expect(hits).toBe(1);
  // The description match works against the fetched catalog.
  expect(inworldVoice('deep calm male')).toBe('Dennis');
  // With a source, the catalog is fetched once, not per call.
  expect(await inworldVoices()).toEqual(voices);
  expect(hits).toBe(1);
});

afterAll(() => {
  catalog.stop(true);
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
