import test from 'node:test';
import assert from 'node:assert/strict';
import { createIceServers, getTurnConfiguration, validateTurnConfiguration } from '../turnConfig.js';

test('validates short-lived TURN credentials', () => {
  const config = getTurnConfiguration({
    TURN_URLS: 'turn:turn.example.com:3478,turns:turn.example.com:5349',
    TURN_SECRET: 'test-secret',
    TURN_TTL_SECONDS: '120'
  });
  const status = validateTurnConfiguration(config);
  assert.equal(status.enabled, true);
  assert.deepEqual(status.errors, []);
  const servers = createIceServers(config, 1_700_000_000);
  assert.deepEqual(servers[1].urls, ['turn:turn.example.com:3478', 'turns:turn.example.com:5349']);
  assert.equal(servers[1].username, '1700000120:airdropweb');
  assert.ok(servers[1].credential.length > 20);
});

test('rejects incomplete or invalid TURN settings', () => {
  const missingCredentials = validateTurnConfiguration(getTurnConfiguration({
    TURN_URLS: 'turn:turn.example.com:3478'
  }));
  assert.equal(missingCredentials.enabled, false);
  assert.match(missingCredentials.errors[0], /TURN_SECRET/);

  const invalidUrl = validateTurnConfiguration(getTurnConfiguration({
    TURN_URLS: 'https://not-a-turn-server.example.com',
    TURN_SECRET: 'secret'
  }));
  assert.match(invalidUrl.errors[0], /无效地址/);

  const required = validateTurnConfiguration(getTurnConfiguration({ TURN_REQUIRED: '1' }));
  assert.match(required.errors[0], /TURN_REQUIRED/);
});

test('supports static credentials for development', () => {
  const config = getTurnConfiguration({
    TURN_URLS: 'turn:turn.example.com:3478',
    TURN_USERNAME: 'user',
    TURN_CREDENTIAL: 'password'
  });
  assert.equal(validateTurnConfiguration(config).enabled, true);
  assert.equal(createIceServers(config)[1].username, 'user');
});