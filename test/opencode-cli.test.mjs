import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOpencodeSessionId, buildStatsArgs, opencodeHostEnv, opencodeUsageError } from '../build/opencode-cli.js';

test('session IDs accept OpenCode v2 IDs and UUIDs', () => {
  for (const id of [
    'ses_dff6541ebffeZ3KjHphGDsVBvC',
    'ses_AbCd1234',
    `ses_${'A'.repeat(64)}`,
    '550e8400-e29b-41d4-a716-446655440000',
  ]) {
    assert.equal(assertOpencodeSessionId(id), id);
  }
  for (const id of [undefined, 123, 'deadbeef', 'ses_AbCd123', 'ses_abcd-1234',
    `ses_${'A'.repeat(65)}`, 'ses_ABCD1234\n', '--help']) {
    assert.throws(() => assertOpencodeSessionId(id), /invalid sessionId/);
  }
});

test('CLI usage failures report one diagnostic line, even when help is on stdout', () => {
  const help = 'DESCRIPTION\n  List all available models\n\nUSAGE\n  opencode models [flags]\n\nGLOBAL FLAGS\n  --help, -h  Show help information\n';
  assert.equal(opencodeUsageError(help, ''), 'Usage: opencode models [flags]');
  assert.equal(
    opencodeUsageError(help, '\x1b[31mERROR\x1b[0m\n  \x1b[31mUnrecognized flag: --refresh in command opencode models\x1b[0m\n'),
    'Unrecognized flag: --refresh in command opencode models',
  );
  assert.equal(opencodeUsageError(help, 'ERROR\n  Unexpected positional argument: "foo"'), 'Unexpected positional argument: "foo"');
  assert.equal(opencodeUsageError('{"title":"Unrecognized flag: --refresh"}', ''), undefined);
});

test('stats uses boolean section flags and a single row limit', () => {
  assert.deepEqual(buildStatsArgs({ days: 7, topTools: 5 }), [
    'stats', '--days', '7', '--tools', '--limit', '5',
  ]);
  assert.deepEqual(buildStatsArgs({ topModels: 3 }), [
    'stats', '--models', '--limit', '3',
  ]);
  assert.deepEqual(buildStatsArgs({ topTools: 5, topModels: 8 }), [
    'stats', '--tools', '--models', '--limit', '8',
  ]);
});

test('stats accepts today (0 days) and project filters', () => {
  assert.deepEqual(buildStatsArgs({ days: 0, project: '.' }), [
    'stats', '--days', '0', '--project', '.',
  ]);
});

test('stats rejects invalid row counts', () => {
  assert.throws(() => buildStatsArgs({ topTools: 0 }), /topTools must be 1-100/);
  assert.throws(() => buildStatsArgs({ topModels: 101 }), /topModels must be 1-100/);
  assert.throws(() => buildStatsArgs({ days: -1 }), /days must be 0-3650/);
});

test('isolated cell home is mapped back to the login home', () => {
  const env = opencodeHostEnv({
    HOME: '/installation/data/hela-runtime',
    XDG_CONFIG_HOME: '/installation/data/hela-runtime/config',
    PATH: '/usr/bin',
  }, '/home/ubuntu');
  assert.equal(env.HOME, '/home/ubuntu');
  assert.equal(env.XDG_CONFIG_HOME, '/home/ubuntu/.config');
  assert.equal(env.XDG_DATA_HOME, '/home/ubuntu/.local/share');
  assert.equal(env.XDG_CACHE_HOME, '/home/ubuntu/.cache');
  assert.equal(env.XDG_STATE_HOME, '/home/ubuntu/.local/state');
  assert.equal(env.PATH, '/usr/bin');
});

test('normal host environments keep their existing XDG paths', () => {
  const env = opencodeHostEnv({
    HOME: '/home/dev',
    XDG_CONFIG_HOME: '/mnt/config',
    XDG_DATA_HOME: '/mnt/data',
  }, '/home/dev');
  assert.equal(env.HOME, '/home/dev');
  assert.equal(env.XDG_CONFIG_HOME, '/mnt/config');
  assert.equal(env.XDG_DATA_HOME, '/mnt/data');
});

test('explicit host overrides win over passwd defaults', () => {
  const env = opencodeHostEnv({
    HOME: '/installation/data/hela-runtime',
    OPENCODE_HOST_HOME: '/srv/opencode',
    OPENCODE_HOST_CONFIG_HOME: '/srv/opencode/config',
  }, '/home/ubuntu');
  assert.equal(env.HOME, '/srv/opencode');
  assert.equal(env.XDG_CONFIG_HOME, '/srv/opencode/config');
  assert.equal(env.XDG_DATA_HOME, '/srv/opencode/.local/share');
});
