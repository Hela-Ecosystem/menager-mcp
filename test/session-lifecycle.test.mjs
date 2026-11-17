import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../build/SessionManager.js';

test('PTY-13: session info reports the resolved ttlMs', () => {
  const mgr = new SessionManager();
  try {
    const explicit = mgr.spawn('cat', [], process.cwd(), {}, 5000, 'dumb', 'ttl-explicit', 80, 24, 120000);
    assert.equal(explicit.ttlMs, 120000);
    assert.equal(mgr.getSession(explicit.sessionId).getInfo().ttlMs, 120000);

    const defaulted = mgr.spawn('cat', [], process.cwd(), {}, 5000, 'dumb', 'ttl-default');
    assert.equal(typeof defaulted.ttlMs, 'number');
    assert.ok(defaulted.ttlMs > 0, 'an unset ttl falls back to the quota default');

    assert.ok(mgr.listSessions().every(s => typeof s.ttlMs === 'number'));
  } finally {
    mgr.prune();
  }
});

test('PTY-13: the max-ttl clamp is what gets reported', () => {
  const saved = process.env.HELA_RIBOSOME_MAX_TTL_MS;
  process.env.HELA_RIBOSOME_MAX_TTL_MS = '5000';
  const mgr = new SessionManager();
  try {
    const info = mgr.spawn('cat', [], process.cwd(), {}, 5000, 'dumb', 'ttl-clamped', 80, 24, 999999999);
    assert.equal(info.ttlMs, 5000);
  } finally {
    mgr.prune();
    if (saved === undefined) delete process.env.HELA_RIBOSOME_MAX_TTL_MS;
    else process.env.HELA_RIBOSOME_MAX_TTL_MS = saved;
  }
});

test('PTY-12: shutdown awaits PTY termination and resolves well inside the deadline', async () => {
  const mgr = new SessionManager();
  try {
    const a = mgr.spawn('cat', [], process.cwd(), {}, 5000, 'dumb', 'shutdown-a');
    const b = mgr.spawn('cat', [], process.cwd(), {}, 5000, 'dumb', 'shutdown-b');
    const sessions = [mgr.getSession(a.sessionId), mgr.getSession(b.sessionId)];

    const started = Date.now();
    const stuck = await mgr.shutdown(2000);
    const elapsed = Date.now() - started;

    assert.deepEqual(stuck, [], 'no session should outlive the deadline');
    assert.ok(elapsed < 2000, `shutdown returned after the PTYs exited (${elapsed}ms)`);
    for (const s of sessions) {
      assert.equal(s.status, 'exited');
      assert.notEqual(s.exitCode, null);
    }
  } finally {
    mgr.prune();
  }
});

test('PTY-12: shutdown escalates to SIGKILL for a process that ignores SIGTERM', async () => {
  const mgr = new SessionManager();
  try {
    mgr.spawn('bash', ['-c', 'trap "" TERM; while :; do sleep 0.1; done'], process.cwd(), {}, 5000, 'dumb', 'stubborn');
    const stuck = await mgr.shutdown(2000);
    assert.deepEqual(stuck, [], 'SIGKILL must land within the deadline');
    assert.ok(mgr.listSessions().every(s => s.status === 'exited'));
  } finally {
    mgr.prune();
  }
});

test('PTY-12: shutdown on an empty manager resolves immediately', async () => {
  const mgr = new SessionManager();
  assert.deepEqual(await mgr.shutdown(2000), []);
});
