import { describe, expect, test } from 'bun:test';
import { dictationAudioExtension } from './transcribe';
import { dictationPriceUsd } from '../../billing/services/tiers';

const bytes = (...values: Array<number | string>) =>
  new Uint8Array(values.flatMap((v) => (typeof v === 'string' ? [...v].map((c) => c.charCodeAt(0)) : [v])));

describe('dictationAudioExtension', () => {
  test('reads the container from the first bytes, whatever the name says', () => {
    expect(dictationAudioExtension(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f), 'blob')).toBe('webm');
    expect(dictationAudioExtension(bytes('OggS', 0, 2), '')).toBe('ogg');
    expect(dictationAudioExtension(bytes(0, 0, 0, 0x20, 'ftypM4A '), 'recording')).toBe('m4a');
    expect(dictationAudioExtension(bytes('RIFF', 1, 2, 3, 4, 'WAVE'), 'x.bin')).toBe('wav');
    expect(dictationAudioExtension(bytes('fLaC'), '')).toBe('flac');
    expect(dictationAudioExtension(bytes('ID3', 4), '')).toBe('mp3');
    expect(dictationAudioExtension(bytes(0xff, 0xfb, 0x90), '')).toBe('mp3');
  });

  test('falls back to the file name when the bytes are not recognized', () => {
    expect(dictationAudioExtension(bytes(1, 2, 3), 'clip.WEBM')).toBe('webm');
    expect(dictationAudioExtension(bytes(1, 2, 3), 'voice.mp4')).toBe('m4a');
    expect(dictationAudioExtension(bytes(1, 2, 3), 'voice.opus')).toBe('ogg');
  });

  test('refuses text, images and unnamed unknown bytes', () => {
    expect(dictationAudioExtension(bytes('hello'), 'note.txt')).toBeNull();
    expect(dictationAudioExtension(bytes(0x89, 'PNG'), 'image.png')).toBeNull();
    expect(dictationAudioExtension(bytes(1, 2, 3), '')).toBeNull();
    expect(dictationAudioExtension(new Uint8Array(), '')).toBeNull();
  });
});

describe('dictationPriceUsd', () => {
  test('charges 1 credit ($0.01) per minute, per second', () => {
    expect(dictationPriceUsd(60)).toBe(0.01);
    expect(dictationPriceUsd(30)).toBe(0.005);
    expect(dictationPriceUsd(1)).toBeCloseTo(0.01 / 60, 10);
    expect(dictationPriceUsd(600)).toBe(0.1);
  });

  test('charges nothing for no audio or a nonsense duration', () => {
    expect(dictationPriceUsd(0)).toBe(0);
    expect(dictationPriceUsd(-5)).toBe(0);
    expect(dictationPriceUsd(Number.NaN)).toBe(0);
  });
});
