import { describe, expect, test } from 'bun:test';

import { config } from '../../config';
import {
  FEATURE_FLAGS_ENV_NAME,
  featureFlagsEnvValue,
} from './feature-flag-env';

describe('featureFlagsEnvValue', () => {
  test('lists the enabled flags, sorted, comma-separated', () => {
    const value = featureFlagsEnvValue({ experimental: { voice_call: true } }).split(',');
    expect(value).toContain('voice_call');
    expect([...value].sort()).toEqual(value);
  });
  test('a flag that is off is absent', () => {
    expect(featureFlagsEnvValue({ experimental: { voice_call: false } }).split(',')).not.toContain('voice_call');
  });
  test('genui is always listed, also over a stored flag-era `genui: false`, so an older image keeps the skill', () => {
    expect(featureFlagsEnvValue({ experimental: { genui: false } }).split(',')).toContain('genui');
    expect(featureFlagsEnvValue(null).split(',')).toContain('genui');
  });
  test('artifacts is listed exactly where Drive flags are, over a stored flag-era `artifacts: false`; artifact_comments never', () => {
    const value = featureFlagsEnvValue({ experimental: { artifacts: false, artifact_comments: true } }).split(',');
    expect(value.includes('artifacts')).toBe(value.includes('drives'));
    expect(value).not.toContain('artifact_comments');
  });
  test('goal_mode is listed wherever a Drive can hold a goal, with the goals flag off: a chat binds its own goal', () => {
    const settings = config as { PLATINUM_API_KEY?: string };
    const before = settings.PLATINUM_API_KEY;
    try {
      settings.PLATINUM_API_KEY = '';
      expect(featureFlagsEnvValue({ experimental: { goals: false } }).split(',')).not.toContain('goal_mode');
      settings.PLATINUM_API_KEY = 'test-key';
      const value = featureFlagsEnvValue({ experimental: { goals: false } }).split(',');
      expect(value).toContain('goal_mode');
      expect(value).not.toContain('goals');
    } finally {
      settings.PLATINUM_API_KEY = before;
    }
  });
  test('env name is the one kortixd and the CLI read', () => {
    expect(FEATURE_FLAGS_ENV_NAME).toBe('KORTIX_FEATURE_FLAGS');
  });
});

