import { describe, expect, test } from 'bun:test';
import * as legacy from '../channels/install-store';
import * as slack from '../channels/slack/installs';
import * as email from '../channels/email/installs';
import * as teams from '../channels/teams/installs';
import * as telegram from '../channels/telegram/installs';
import * as discord from '../channels/discord/installs';

describe('channel install compatibility exports', () => {
  test('every direct platform export is still available through the legacy door', () => {
    for (const platform of [slack, email, teams, telegram, discord]) {
      for (const [name, operation] of Object.entries(platform)) {
        expect(Reflect.get(legacy, name)).toBe(operation);
      }
    }
  });

  test.each(['', 'token with spaces', '凭证🔑\nsecond line'])('secret encryption round trips %j and binds to the project', (value) => {
    const encrypted = legacy.encryptChannelSecret('synthetic-project-a', value);
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(legacy.decryptChannelSecret('synthetic-project-a', encrypted)).toBe(value);
    expect(() => legacy.decryptChannelSecret('synthetic-project-b', encrypted)).toThrow();
  });
});
