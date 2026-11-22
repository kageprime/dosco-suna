import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { clampSpot, readSpot } from './use-call-card-position';

const browser = new Window();
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: browser });

afterEach(() => {
  browser.localStorage.removeItem('kortix-voice-call-card');
});

describe('clampSpot', () => {
  const size = { width: 320, height: 140 };
  const vw = 1280;
  const vh = 800;

  test('a spot inside the viewport stays as it is', () => {
    expect(clampSpot({ left: 100, top: 200 }, size, vw, vh)).toEqual({ left: 100, top: 200 });
  });

  test('a spot off any edge comes back on screen', () => {
    expect(clampSpot({ left: -50, top: 200 }, size, vw, vh)).toEqual({ left: 0, top: 200 });
    expect(clampSpot({ left: 2000, top: 200 }, size, vw, vh)).toEqual({ left: vw - size.width, top: 200 });
    expect(clampSpot({ left: 100, top: -1 }, size, vw, vh)).toEqual({ left: 100, top: 0 });
    expect(clampSpot({ left: 100, top: 5000 }, size, vw, vh)).toEqual({ left: 100, top: vh - size.height });
  });

  test('a viewport smaller than the card pins it at 0, not off screen', () => {
    expect(clampSpot({ left: 40, top: 60 }, size, 200, 100)).toEqual({ left: 0, top: 0 });
  });
});

describe('readSpot', () => {
  test('no save reads as no spot', () => {
    expect(readSpot()).toBeNull();
  });

  test('the saved spot reads back', () => {
    expect(browser.localStorage.setItem('kortix-voice-call-card', JSON.stringify({ left: 12, top: 34 }))).toBeUndefined();
    expect(readSpot()).toEqual({ left: 12, top: 34 });
  });

  test('a broken save reads as no spot, never a crash', () => {
    browser.localStorage.setItem('kortix-voice-call-card', '{not json');
    expect(readSpot()).toBeNull();
    browser.localStorage.setItem('kortix-voice-call-card', JSON.stringify({ left: 'x', top: 1 }));
    expect(readSpot()).toBeNull();
    browser.localStorage.setItem('kortix-voice-call-card', JSON.stringify({ left: NaN, top: 1 }));
    expect(readSpot()).toBeNull();
  });
});

if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
