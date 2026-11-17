import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  SessionManager,
  buildSshArgs,
  buildSshControlArgs,
} from '../build/SessionManager.js';
import {
  buildTmuxArgs,
  buildTmuxKillArgs,
  buildTmuxProbeArgs,
  resetTmuxProbes,
  tmuxSessionName,
  tmuxEnabled,
  tmuxHistoryLimit,
} from '../build/Tmux.js';
import { fakeSsh, freshLog, readLog, withEnv, settle, until } from './helpers/fake-ssh.mjs';

/** Every remote test gets a private fake ssh, a private argv log and a cold probe cache. */
function harness(extraEnv = {}) {
  const bin = fakeSsh();
  const log = freshLog();
  resetTmuxProbes();
  return {
    bin,
    log,
    env: {
      HELA_RIBOSOME_SSH_BIN: bin,
      HELA_RIBOSOME_SSH_HOSTS: undefined,
      HELA_RIBOSOME_TMUX: undefined,
      FAKE_SSH_LOG: log,
      FAKE_SSH_TMUX: '1',
      FAKE_SSH_DOWN: '',
      FAKE_SSH_MIDWAY: '0',
      ...extraEnv,
    },
    calls: () => readLog(log),
  };
}

const probeCalls = (calls) => calls.filter(c => c.includes('tmux -V'));
const killCalls = (calls) => calls.filter(c => c.includes('tmux kill-session'));

test('PTY-04: argv builders are exact and shell-free', () => {
  assert.deepEqual(buildTmuxArgs('hela_dead', 10000), [
    'tmux', '-u',
    'set-option', '-g', 'history-limit', '10000',
    '\\;',
    'new-session', '-A', '-s', 'hela_dead',
  ]);
  assert.deepEqual(buildTmuxArgs('hela_dead', 500, ['tail', '-f', '/var/log/syslog']), [
    'tmux', '-u',
    'set-option', '-g', 'history-limit', '500',
    '\\;',
    'new-session', '-A', '-s', 'hela_dead',
    '--', 'tail', '-f', '/var/log/syslog',
  ]);
  assert.deepEqual(buildTmuxKillArgs('hela_dead'), ['tmux', 'kill-session', '-t', 'hela_dead']);
  assert.deepEqual(buildTmuxProbeArgs(), ['tmux', '-V']);
  assert.equal(tmuxSessionName('a1b2c3d4'), 'hela_a1b2c3d4');
  assert.equal(tmuxSessionName('../evil:name.x'), 'hela_evilnamex');
  assert.deepEqual(buildSshControlArgs('box', ['tmux', '-V']), [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    'box',
    'tmux', '-V',
  ]);
});

test('PTY-04: tmux env gates', () => {
  withEnv({ HELA_RIBOSOME_TMUX: undefined }, () => assert.equal(tmuxEnabled(), true));
  withEnv({ HELA_RIBOSOME_TMUX: 'off' }, () => assert.equal(tmuxEnabled(), false));
  withEnv({ HELA_RIBOSOME_TMUX: '0' }, () => assert.equal(tmuxEnabled(), false));
  withEnv({ HELA_RIBOSOME_TMUX_HISTORY_LIMIT: '250' }, () => assert.equal(tmuxHistoryLimit(), 250));
  withEnv({ HELA_RIBOSOME_TMUX_HISTORY_LIMIT: 'nonsense' }, () => assert.equal(tmuxHistoryLimit(), 10000));
});

test('PTY-04: a tmux-capable host is attached through new-session -A', async () => {
  const h = harness();
  const mgr = new SessionManager();
  try {
    const info = withEnv(h.env, () =>
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'tmux-on', 80, 24, 60000, undefined, { host: 'build-01' }));

    assert.equal(info.transport, 'ssh');
    assert.deepEqual(info.tmux, { enabled: true, name: `hela_${info.sessionId}` });
    assert.deepEqual(info.args, buildSshArgs('build-01', buildTmuxArgs(`hela_${info.sessionId}`, 10000)));
    assert.equal(info.reconnects, 0);
    assert.equal(info.persistOnClose, false);

    await until(() => mgr.getSession(info.sessionId).getLines(50).includes('FAKE_SSH_ARGV'));
    const out = mgr.getSession(info.sessionId).getLines(50);
    assert.match(out, /new-session -A -s hela_/);
    assert.match(out, /history-limit 10000/);
    assert.equal(probeCalls(h.calls()).length, 1, 'exactly one capability probe');
  } finally {
    withEnv(h.env, () => mgr.prune());
  }
});

test('PTY-04: the probe is cached per host', () => {
  const h = harness();
  const mgr = new SessionManager();
  try {
    withEnv(h.env, () => {
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'c1', 80, 24, 60000, undefined, { host: 'build-01' });
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'c2', 80, 24, 60000, undefined, { host: 'build-01' });
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'c3', 80, 24, 60000, undefined, { host: 'build-02' });
    });
    const probes = probeCalls(h.calls());
    assert.equal(probes.length, 2, 'one probe per host, not per session');
    assert.ok(probes.some(p => p.includes('build-01')));
    assert.ok(probes.some(p => p.includes('build-02')));
  } finally {
    withEnv(h.env, () => mgr.prune());
  }
});

test('PTY-04: a cached probe expires with its TTL', () => {
  const h = harness({ HELA_RIBOSOME_TMUX_PROBE_TTL_MS: '1' });
  const mgr = new SessionManager();
  try {
    withEnv(h.env, () => {
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 't1', 80, 24, 60000, undefined, { host: 'build-01' });
      const until = Date.now() + 5;
      while (Date.now() < until) { /* let the 1ms TTL lapse */ }
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 't2', 80, 24, 60000, undefined, { host: 'build-01' });
    });
    assert.equal(probeCalls(h.calls()).length, 2);
  } finally {
    withEnv(h.env, () => mgr.prune());
  }
});

test('PTY-06 failure injection: a host without tmux falls back to a plain login shell', async () => {
  const h = harness({ FAKE_SSH_TMUX: '0' });
  const mgr = new SessionManager();
  try {
    const info = withEnv(h.env, () =>
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'tmux-absent', 80, 24, 60000, undefined, { host: 'build-01' }));

    assert.equal(info.tmux.enabled, false, 'the session is explicitly flagged as not durable');
    assert.match(info.tmux.reason, /tmux unavailable on build-01/);
    assert.deepEqual(info.args, buildSshArgs('build-01'), 'plain login shell, no tmux wrapper');

    await until(() => mgr.getSession(info.sessionId).getLines(50).includes('FAKE_SSH_ARGV'));
    assert.doesNotMatch(mgr.getSession(info.sessionId).getLines(50), /new-session/);
    assert.equal(killCalls(h.calls()).length, 0, 'nothing to kill on a non-tmux session');
  } finally {
    withEnv(h.env, () => mgr.prune());
  }
});

test('PTY-04: HELA_RIBOSOME_TMUX=off skips the probe entirely', () => {
  const h = harness({ HELA_RIBOSOME_TMUX: 'off' });
  const mgr = new SessionManager();
  try {
    const info = withEnv(h.env, () =>
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'tmux-off', 80, 24, 60000, undefined, { host: 'build-01' }));
    assert.equal(info.tmux.enabled, false);
    assert.match(info.tmux.reason, /HELA_RIBOSOME_TMUX=off/);
    assert.deepEqual(info.args, buildSshArgs('build-01'));
    assert.equal(probeCalls(h.calls()).length, 0);
  } finally {
    withEnv(h.env, () => mgr.prune());
  }
});

test('PTY-06 failure injection: an unreachable host reports a transport exit', async () => {
  const h = harness({ FAKE_SSH_DOWN: 'ghost-01' });
  const mgr = new SessionManager();
  try {
    const info = withEnv(h.env, () =>
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'ghost', 80, 24, 60000, undefined, { host: 'ghost-01' }));
    assert.equal(info.tmux.enabled, false, 'an unreachable host cannot be probed, so tmux is off');

    const session = mgr.getSession(info.sessionId);
    await session.exited();
    assert.equal(session.getInfo().exitKind, 'transport');
    assert.match(session.getLines(50), /No route to host/);
  } finally {
    withEnv(h.env, () => mgr.prune());
  }
});

test('PTY-06 failure injection: the transport dying mid-stream keeps the buffer and allows a reattach', async () => {
  const h = harness();
  const mgr = new SessionManager();
  try {
    const info = withEnv(h.env, () =>
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'midstream', 80, 24, 60000, undefined, { host: 'build-01' }, { sessionId: 'midstream1' }));
    const session = mgr.getSession(info.sessionId);
    await until(() => session.getLines(50).includes('FAKE_SSH_ARGV'));
    await session.write('payload-before-drop', true);
    await until(() => session.getLines(50).includes('payload-before-drop'));

    // Hard-kill the local transport: the equivalent of the link going away.
    session.signal('SIGKILL');
    await session.exited();
    assert.equal(session.status, 'exited');
    assert.match(session.getLines(200), /payload-before-drop/, 'buffered evidence survives the drop');

    const reattached = withEnv(h.env, () => mgr.reattach('midstream1'));
    assert.equal(reattached.status, 'running');
    assert.equal(reattached.reconnects, 1);
    assert.notEqual(reattached.pid, info.pid, 'a dead transport is replaced');
    assert.match(session.getLines(200), /\[reconnected at /);
    assert.match(session.getLines(200), /payload-before-drop/, 'scrollback is kept across the reattach');
    assert.deepEqual(reattached.tmux, { enabled: true, name: 'hela_midstream1' }, 'the same tmux window is re-attached');
  } finally {
    withEnv(h.env, () => mgr.prune());
  }
});

test('PTY-04: re-attaching a live session is idempotent', async () => {
  const h = harness();
  const mgr = new SessionManager();
  try {
    const info = withEnv(h.env, () =>
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'idem', 80, 24, 60000, undefined, { host: 'build-01' }, { sessionId: 'idem1' }));
    await until(() => mgr.getSession('idem1').getLines(50).includes('FAKE_SSH_ARGV'));

    const first = mgr.reattach('idem1');
    const second = mgr.reattach('idem1');
    assert.equal(first.pid, info.pid);
    assert.equal(second.pid, info.pid);
    assert.equal(second.reconnects, 2);
    assert.equal(second.status, 'running');
    assert.equal(mgr.listSessions().length, 1, 'no duplicate session is created');

    assert.throws(
      () => withEnv(h.env, () => mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'dupe', 80, 24, 60000, undefined, { host: 'build-01' }, { sessionId: 'idem1' })),
      /already exists/,
    );
  } finally {
    withEnv(h.env, () => mgr.prune());
  }
});

test('PTY-04: session_close kills the remote tmux window, persistOnClose keeps it', async () => {
  const h = harness();
  const mgr = new SessionManager();
  try {
    const killed = withEnv(h.env, () =>
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'close-kill', 80, 24, 60000, undefined, { host: 'build-01' }));
    const kept = withEnv(h.env, () =>
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'close-keep', 80, 24, 60000, undefined, { host: 'build-01' }, { persistOnClose: true }));
    assert.equal(kept.persistOnClose, true);

    const killedResult = withEnv(h.env, () => mgr.closeSession(killed.sessionId));
    assert.equal(killedResult.closed, true);
    assert.equal(killedResult.tmux.attempted, true);
    assert.equal(killedResult.tmux.ok, true);

    const keptResult = withEnv(h.env, () => mgr.closeSession(kept.sessionId));
    assert.equal(keptResult.closed, true);
    assert.equal(keptResult.tmux.attempted, false);
    assert.equal(keptResult.tmux.detail, 'persistOnClose');

    const kills = killCalls(h.calls());
    assert.equal(kills.length, 1);
    assert.match(kills[0], new RegExp(`tmux kill-session -t hela_${killed.sessionId}$`));
    assert.ok(!kills[0].includes(kept.sessionId), 'the persisted window is untouched');
  } finally {
    withEnv(h.env, () => mgr.prune());
  }
});

test('PTY-04: shutdown leaves no remote sessions behind', async () => {
  const h = harness();
  const mgr = new SessionManager();
  try {
    const a = withEnv(h.env, () =>
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'sd-a', 80, 24, 60000, undefined, { host: 'build-01' }));
    const b = withEnv(h.env, () =>
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'sd-b', 80, 24, 60000, undefined, { host: 'build-02' }));
    const persisted = withEnv(h.env, () =>
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'sd-keep', 80, 24, 60000, undefined, { host: 'build-02' }, { persistOnClose: true }));

    const stuck = await withEnv(h.env, () => mgr.shutdown(2000));
    assert.deepEqual(stuck, [], 'no transport outlives the deadline');

    const kills = killCalls(h.calls());
    assert.equal(kills.length, 2, 'every non-persisted tmux window is killed');
    assert.ok(kills.some(k => k.includes(`hela_${a.sessionId}`)));
    assert.ok(kills.some(k => k.includes(`hela_${b.sessionId}`)));
    assert.ok(!kills.some(k => k.includes(`hela_${persisted.sessionId}`)));
  } finally {
    withEnv(h.env, () => mgr.prune());
  }
});

test('PTY-06 failure injection: the session quota is enforced before any transport is built', () => {
  const h = harness({ HELA_RIBOSOME_MAX_SESSIONS: '1' });
  const mgr = new SessionManager();
  try {
    withEnv(h.env, () => {
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'q1', 80, 24, 60000, undefined, { host: 'build-01' });
      assert.throws(
        () => mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'q2', 80, 24, 60000, undefined, { host: 'build-01' }),
        /session quota exceeded: 1\/1/,
      );
      assert.throws(() => mgr.spawn('cat', [], process.cwd(), {}, 5000, 'dumb', 'q3'), /session quota exceeded/);
    });
    assert.equal(mgr.listSessions().length, 1);
  } finally {
    withEnv(h.env, () => mgr.prune());
  }
});

test('PTY-06: optional localhost sshd round-trip', async (t) => {
  if (process.env.HELA_RIBOSOME_SSHD_TEST !== '1') {
    return t.skip('set HELA_RIBOSOME_SSHD_TEST=1 to exercise a real sshd');
  }
  const reach = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'localhost', 'true'], {
    encoding: 'utf-8',
    timeout: 10000,
  });
  if (reach.status !== 0) {
    return t.skip(`localhost sshd unreachable: ${(reach.stderr || reach.error?.message || '').trim().slice(0, 120)}`);
  }

  const mgr = new SessionManager();
  try {
    resetTmuxProbes();
    const info = withEnv({ HELA_RIBOSOME_SSH_BIN: undefined, HELA_RIBOSOME_SSH_HOSTS: undefined }, () =>
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'real-sshd', 80, 24, 60000, undefined, {
        host: 'localhost',
        remoteCommand: ['echo', 'HELA_REMOTE_OK'],
      }));
    const session = mgr.getSession(info.sessionId);
    assert.equal(info.transport, 'ssh');
    assert.equal(typeof info.tmux.enabled, 'boolean');
    const saw = await until(() => session.getLines(100).includes('HELA_REMOTE_OK'), 15000);
    assert.ok(saw, `remote output never arrived: ${session.getLines(50)}`);
  } finally {
    mgr.prune();
    await settle(50);
  }
});
