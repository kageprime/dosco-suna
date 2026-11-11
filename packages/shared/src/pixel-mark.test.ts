import { describe, expect, test } from 'bun:test';

import { pixelMarkShape } from './pixel-mark';

// One golden set for every host: web (`@kortix/ui` `pixelMark`) and mobile
// paint these exact paths. A change here redraws every agent on every surface.
describe('pixelMarkShape', () => {
  test('golden 7 × 7 marks', () => {
    const golden = {
      kortix: 'M3 0h1v1h-1zM2 1h3v1h-3zM1 2h5v1h-5zM0 3h3v1h-3zM4 3h3v1h-3zM0 4h7v1h-7zM1 5h2v1h-2zM4 5h2v1h-2zM1 6h2v1h-2zM4 6h2v1h-2z',
      'harness-reflector':
        'M3 0h1v1h-1zM2 1h3v1h-3zM1 2h1v1h-1zM3 2h1v1h-1zM5 2h1v1h-1zM0 3h7v1h-7zM2 4h1v1h-1zM4 4h1v1h-1zM1 5h5v1h-5zM1 6h1v1h-1zM3 6h1v1h-1zM5 6h1v1h-1z',
      scout: 'M1 1h1v1h-1zM3 1h1v1h-1zM5 1h1v1h-1zM1 2h1v1h-1zM3 2h1v1h-1zM5 2h1v1h-1zM1 3h5v1h-5zM0 4h3v1h-3zM4 4h3v1h-3zM2 5h3v1h-3zM2 6h3v1h-3z',
      reviewer: 'M3 0h1v1h-1zM3 1h1v1h-1zM0 2h3v1h-3zM4 2h3v1h-3zM1 3h5v1h-5zM2 4h3v1h-3zM2 5h3v1h-3zM1 6h2v1h-2zM4 6h2v1h-2z',
    };
    for (const [slug, path] of Object.entries(golden)) {
      expect(pixelMarkShape(slug)).toMatchObject({ path, ditherPath: '', width: 7, height: 7 });
    }
  });

  test('golden My Kortix mark: the 12 × 10 Dosco crest, solid and dithered cells', () => {
    expect(pixelMarkShape('mykortix')).toMatchObject({
      path: 'M6 0h2v1h-2zM6 1h2v1h-2zM6 2h1v1h-1zM9 2h2v1h-2zM4 3h1v1h-1zM6 3h1v1h-1zM8 3h2v1h-2zM4 4h5v1h-5zM3 5h1v1h-1zM5 5h3v1h-3zM4 6h4v1h-4zM3 7h2v1h-2zM7 7h2v1h-2zM2 8h2v1h-2zM8 8h2v1h-2zM1 9h1v1h-1zM9 9h2v1h-2z',
      ditherPath: 'M5 2h1v1h-1zM7 2h1v1h-1zM11 2h1v1h-1zM5 3h1v1h-1zM7 3h1v1h-1zM10 3h1v1h-1zM3 4h1v1h-1zM4 5h1v1h-1zM8 6h1v1h-1zM9 7h1v1h-1zM7 8h1v1h-1zM10 8h1v1h-1zM0 9h1v1h-1zM2 9h1v1h-1zM11 9h1v1h-1z',
      width: 12,
      height: 10,
    });
  });
});
