import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager, buildChildEnv, envAllowlist } from '../build/SessionManager.js';
import { withEnv, until } from './helpers/fake-ssh.mjs';

const BASE = { PATH: '/usr/bin', HOME: '/home/agent', AWS_SECRET_ACCESS_KEY: 'shhh', LANG: 'C.UTF-8' };

test('PTY-16: an unset allowlist is inert and inherits everything', () => {
  withEnv({ HELA_RIBOSOME_ENV_ALLOWLIST: undefined }, () => {
    assert.equal(envAllowlist(), null);
    assert.deepEqual(buildChildEnv({}, BASE), BASE);
  });
});

test('PTY-16: the allowlist filters what is inherited', () => {
  withEnv({ HELA_RIBOSOME_ENV_ALLOWLIST: 'PATH, HOME' }, () => {
    assert.deepEqual(envAllowlist(), ['PATH', 'HOME']);
    assert.deepEqual(buildChildEnv({}, BASE), { PATH: '/usr/bin', HOME: '/home/agent' });
  });
});

test('PTY-16: a set-but-empty allowlist inherits nothing', () => {
  withEnv({ HELA_RIBOSOME_ENV_ALLOWLIST: '' }, () => {
    assert.deepEqual(envAllowlist(), []);
    assert.deepEqual(buildChildEnv({}, BASE), {});
  });
});

test('PTY-16: per-session env is explicit intent and always passes', () => {
  withEnv({ HELA_RIBOSOME_ENV_ALLOWLIST: 'PATH' }, () => {
    assert.deepEqual(buildChildEnv({ HELA_RUN_ID: 'r1' }, BASE), { PATH: '/usr/bin', HELA_RUN_ID: 'r1' });
  });
  withEnv({ HELA_RIBOSOME_ENV_ALLOWLIST: 'PATH' }, () => {
    assert.deepEqual(buildChildEnv({ PATH: '/opt/bin' }, BASE), { PATH: '/opt/bin' }, 'an override wins over the inherited value');
  });
});

test('PTY-16: undefined values in the parent environment are dropped', () => {
  assert.deepEqual(buildChildEnv({}, { A: 'a', B: undefined }), { A: 'a' });
});

test('PTY-16: a filtered session cannot see a secret the server holds', async () => {
  const mgr = new SessionManager();
  try {
    const leaked = withEnv({ HELA_RIBOSOME_ENV_ALLOWLIST: undefined, HELA_TEST_SECRET: 'leak-me' }, () =>
      mgr.spawn('bash', ['-c', 'env; sleep 0.2'], process.cwd(), {}, 5000, 'dumb', 'env-open'));
    const leakedSession = mgr.getSession(leaked.sessionId);
    await leakedSession.exited();
    assert.match(leakedSession.getLines(500), /HELA_TEST_SECRET=leak-me/, 'control: today\'s behaviour inherits it');

    const filtered = withEnv({ HELA_RIBOSOME_ENV_ALLOWLIST: 'PATH,HOME', HELA_TEST_SECRET: 'leak-me' }, () =>
      mgr.spawn('bash', ['-c', 'env; sleep 0.2'], process.cwd(), {}, 5000, 'dumb', 'env-filtered'));
    const filteredSession = mgr.getSession(filtered.sessionId);
    await filteredSession.exited();
    const out = filteredSession.getLines(500);
    assert.ok(!out.includes('HELA_TEST_SECRET'), `the secret must not reach the child:\n${out}`);
    assert.match(out, /^PATH=/m, 'the allowlisted variables still arrive');
  } finally {
    mgr.prune();
  }
});

test('PTY-16: RunStore linkage still reaches a filtered child', async () => {
  const mgr = new SessionManager();
  try {
    const info = withEnv({ HELA_RIBOSOME_ENV_ALLOWLIST: 'PATH,HOME' }, () =>
      mgr.spawn('bash', ['-c', 'env; sleep 0.2'], process.cwd(), {}, 5000, 'dumb', 'env-run', 80, 24, 60000, {
        kind: 'pty', run_id: 'run-77', step_id: 'step-9',
      }));
    const session = mgr.getSession(info.sessionId);
    await session.exited();
    const out = session.getLines(500);
    assert.match(out, /HELA_RUN_ID=run-77/);
    assert.match(out, /HELA_STEP_ID=step-9/);
  } finally {
    mgr.prune();
  }
});
