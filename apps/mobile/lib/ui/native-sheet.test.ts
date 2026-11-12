import { describe, expect, test } from 'bun:test';

import {
  detentFraction,
  hasNativeComponent,
  nativeSheetHiddenBottom,
  nativeSheetMaxHeight,
  resolveNativeDetents,
  supportsNativeSheet,
} from './native-sheet';

describe('supportsNativeSheet', () => {
  test('iOS with the form sheet compiled in uses the native sheet', () => {
    expect(supportsNativeSheet('ios', true)).toBe(true);
  });

  test('an iOS binary without RNSFormSheetHost (an OTA on an old build) keeps gorhom', () => {
    expect(supportsNativeSheet('ios', false)).toBe(false);
  });

  test('Android always keeps gorhom', () => {
    expect(supportsNativeSheet('android', true)).toBe(false);
  });
});

describe('hasNativeComponent', () => {
  test('asks the registry global for the name', () => {
    const asked: string[] = [];
    const scope = {
      __nativeComponentRegistry__hasComponent: (name: string) => {
        asked.push(name);
        return name === 'RNSFormSheetHost';
      },
    };
    expect(hasNativeComponent('RNSFormSheetHost', scope)).toBe(true);
    expect(hasNativeComponent('RNSMissing', scope)).toBe(false);
    expect(asked).toEqual(['RNSFormSheetHost', 'RNSMissing']);
  });

  test('no registry global (old runtime, bun) reads as missing', () => {
    expect(hasNativeComponent('RNSFormSheetHost', {})).toBe(false);
  });

  test('a throwing registry reads as missing', () => {
    const scope = {
      __nativeComponentRegistry__hasComponent: () => {
        throw new Error('boom');
      },
    };
    expect(hasNativeComponent('RNSFormSheetHost', scope)).toBe(false);
  });
});

describe('nativeSheetMaxHeight', () => {
  test('the window less both safe areas and the top gap', () => {
    expect(nativeSheetMaxHeight(852, 59, 34)).toBe(743);
  });

  test('never negative', () => {
    expect(nativeSheetMaxHeight(10, 59, 34)).toBe(0);
  });
});

describe('detentFraction', () => {
  test('a percentage is its fraction', () => {
    expect(detentFraction('50%', 700)).toBe(0.5);
    expect(detentFraction('92%', 700)).toBe(0.92);
    expect(detentFraction('42.5%', 700)).toBe(0.425);
  });

  test('a point value is its share of the maximum height', () => {
    expect(detentFraction(350, 700)).toBe(0.5);
    expect(detentFraction(260, 743)).toBe(0.35);
  });

  test('100% and anything taller is the full detent', () => {
    expect(detentFraction('100%', 700)).toBe(1);
    expect(detentFraction(900, 700)).toBe(1);
  });

  test('an unreadable or empty value is null', () => {
    expect(detentFraction('auto', 700)).toBeNull();
    expect(detentFraction('0%', 700)).toBeNull();
    expect(detentFraction(0, 700)).toBeNull();
    expect(detentFraction(300, 0)).toBeNull();
  });
});

describe('resolveNativeDetents', () => {
  const maxHeight = 700;

  test('a content-sized sheet (no snap points) fits its content', () => {
    expect(resolveNativeDetents({ snapPoints: undefined, dynamicSizing: true, maxHeight })).toEqual({
      detents: 'fitToContents',
      initialIndex: 0,
    });
  });

  test("a content-sized sheet with only '100%' (the picker) still fits its content", () => {
    expect(resolveNativeDetents({ snapPoints: ['100%'], dynamicSizing: true, maxHeight }).detents).toBe('fitToContents');
  });

  test('a fixed-detent sheet opens at its detent and can reach full screen', () => {
    expect(resolveNativeDetents({ snapPoints: ['92%'], dynamicSizing: false, maxHeight })).toEqual({
      detents: [0.92, 1],
      initialIndex: 0,
    });
  });

  test("a full-screen sheet ('100%', fixed) is one full detent", () => {
    expect(resolveNativeDetents({ snapPoints: ['100%'], dynamicSizing: false, maxHeight })).toEqual({
      detents: [1],
      initialIndex: 0,
    });
  });

  test('a two-stop sheet keeps its order and its index', () => {
    expect(resolveNativeDetents({ snapPoints: ['40%', '100%'], dynamicSizing: false, maxHeight, index: 1 })).toEqual({
      detents: [0.4, 1],
      initialIndex: 1,
    });
    expect(resolveNativeDetents({ snapPoints: ['70%', '95%'], dynamicSizing: false, maxHeight, index: 0 })).toEqual({
      detents: [0.7, 0.95, 1],
      initialIndex: 0,
    });
  });

  test('explicit partial snap points win over dynamic sizing (gorhom merged the content height in)', () => {
    expect(resolveNativeDetents({ snapPoints: ['75%', '95%'], dynamicSizing: true, maxHeight }).detents).toEqual([
      0.75, 0.95, 1,
    ]);
  });

  test('point snap points become fractions (the instances sheet)', () => {
    expect(resolveNativeDetents({ snapPoints: [350], dynamicSizing: true, maxHeight }).detents).toEqual([0.5, 1]);
  });

  test('unsorted input comes out strictly ascending, duplicates merged', () => {
    expect(resolveNativeDetents({ snapPoints: ['80%', '40%', '40%'], dynamicSizing: false, maxHeight, index: 0 })).toEqual({
      detents: [0.4, 0.8, 1],
      initialIndex: 1,
    });
  });

  test('an index past the list opens at the first detent', () => {
    expect(resolveNativeDetents({ snapPoints: ['50%'], dynamicSizing: false, maxHeight, index: 4 }).initialIndex).toBe(0);
  });

  test('a shared value cannot be read: one full detent', () => {
    expect(resolveNativeDetents({ snapPoints: { value: ['50%'] }, dynamicSizing: false, maxHeight })).toEqual({
      detents: [1],
      initialIndex: 0,
    });
  });
});

describe('nativeSheetHiddenBottom', () => {
  // iPhone 17: 874pt window, 62pt top, 34pt bottom → 762pt maximum detent.
  const maxHeight = nativeSheetMaxHeight(874, 62, 34);
  const bottomInset = 34;

  test('a box laid out at the full detent hides (1 − fraction) of the detent height below the screen', () => {
    const boxHeight = maxHeight + bottomInset;
    expect(nativeSheetHiddenBottom({ boxHeight, fraction: 0.85, maxHeight, bottomInset })).toBe(Math.round(0.15 * maxHeight));
  });

  test('UIKit measured a slightly different maximum: the hidden part follows the real box', () => {
    const boxHeight = maxHeight + bottomInset + 6;
    expect(nativeSheetHiddenBottom({ boxHeight, fraction: 0.85, maxHeight, bottomInset })).toBe(
      Math.round(0.15 * (boxHeight - bottomInset)),
    );
  });

  test('a box UIKit already sized to the detent hides nothing', () => {
    const boxHeight = 0.85 * maxHeight + bottomInset;
    expect(nativeSheetHiddenBottom({ boxHeight, fraction: 0.85, maxHeight, bottomInset })).toBe(0);
  });

  test('the full detent hides nothing', () => {
    expect(nativeSheetHiddenBottom({ boxHeight: maxHeight + bottomInset, fraction: 1, maxHeight, bottomInset })).toBe(0);
  });

  test('before the first layout nothing is hidden', () => {
    expect(nativeSheetHiddenBottom({ boxHeight: 0, fraction: 0.5, maxHeight, bottomInset })).toBe(0);
  });
});
