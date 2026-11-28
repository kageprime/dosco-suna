import { expect, test } from 'bun:test';
import { httpUrl } from './review-detail';

test('httpUrl keeps http(s) links and drops script and data URLs', () => {
  expect(httpUrl('https://preview.example.test/a')).toBe('https://preview.example.test/a');
  expect(httpUrl('http://localhost:3000/x')).toBe('http://localhost:3000/x');
  expect(httpUrl('javascript:alert(1)')).toBeUndefined();
  expect(httpUrl(' JavaScript:alert(1)')).toBeUndefined();
  expect(httpUrl('data:text/html,<script>alert(1)</script>')).toBeUndefined();
  expect(httpUrl('/relative/path')).toBeUndefined();
  expect(httpUrl(undefined)).toBeUndefined();
});
