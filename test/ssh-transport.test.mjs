import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildSshArgs,
  isValidSshHost,
  assertSshHost,
  sshBinary,
  SessionManager,
} from '../build/SessionManager.js';

const FAKE_SSH = `#!/bin/bash
echo "FAKE_SSH_ARGV:$*"
stty raw -echo 2>/dev/null
exec cat -v
`;

/** Hermetic stand-in for the ssh binary: no network, no sshd. */
function fakeSsh(body = FAKE_SSH) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hela-fake-ssh-'));
  const bin = path.join(dir, 'ssh');
  fs.writeFileSync(bin, body, { mode: 0o755 });
  return bin;
}

function withEnv(patch, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('buildSshArgs is exact and keeps the host ahead of the remote argv', () => {
  assert.deepEqual(buildSshArgs('user@example.internal'), [
    '-t',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=10',
    'user@example.internal',
  ]);
  assert.deepEqual(buildSshArgs('box', ['tail', '-f', '/var/log/syslog']), [
    '-t',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=10',
    'box',
    'tail', '-f', '/var/log/syslog',
  ]);
});

test('host validation rejects flags, options and whitespace', () => {
  for (const host of ['box', 'build-01', 'a.b.c', 'user@host', 'user.name@a-b.example']) {
    assert.equal(isValidSshHost(host), true, host);
  }
  for (const host of [
    '--oProxyCommand=x',
    '-oProxyCommand=x',
    '-t',
    'host with space',
    'a b',
    'host;rm -rf /',
    'host$(id)',
    'user@host -o ProxyCommand=x',
    'ProxyCommand=x',
    '',
    undefined,
    null,
    42,
  ]) {
    assert.equal(isValidSshHost(host), false, String(host));
  }
  assert.throws(() => assertSshHost('--oProxyCommand=x'), /invalid ssh host/);
  assert.throws(() => assertSshHost('a b'), /invalid ssh host/);
});

test('allowlist is exact-match on the host argument and inert when unset', () => {
  withEnv({ HELA_RIBOSOME_SSH_HOSTS: undefined }, () => {
    assert.equal(assertSshHost('anything.example'), 'anything.example');
  });
  withEnv({ HELA_RIBOSOME_SSH_HOSTS: 'build-01, user@build-02' }, () => {
    assert.equal(assertSshHost('build-01'), 'build-01');
    assert.equal(assertSshHost('user@build-02'), 'user@build-02');
    assert.throws(() => assertSshHost('build-02'), /not allowed/);
    assert.throws(() => assertSshHost('build-01.example'), /not allowed/);
  });
  withEnv({ HELA_RIBOSOME_SSH_HOSTS: '' }, () => {
    assert.throws(() => assertSshHost('build-01'), /not allowed/);
  });
});

test('ssh binary override accepts a bare name or an absolute path only', () => {
  withEnv({ HELA_RIBOSOME_SSH_BIN: undefined }, () => assert.equal(sshBinary(), 'ssh'));
  withEnv({ HELA_RIBOSOME_SSH_BIN: '/usr/bin/ssh' }, () => assert.equal(sshBinary(), '/usr/bin/ssh'));
  withEnv({ HELA_RIBOSOME_SSH_BIN: 'ssh -o ProxyCommand=x' }, () => assert.throws(() => sshBinary(), /invalid HELA_RIBOSOME_SSH_BIN/));
});

test('a host spawns the ssh transport with the built argv', async () => {
  const bin = fakeSsh();
  const mgr = new SessionManager();
  try {
    // PTY-04 is covered in remote-pty.test.mjs; here the plain transport is the subject.
    const info = withEnv({ HELA_RIBOSOME_SSH_BIN: bin, HELA_RIBOSOME_SSH_HOSTS: undefined, HELA_RIBOSOME_TMUX: 'off' }, () =>
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'ssh-argv', 80, 24, 60000, undefined, {
        host: 'build-01',
        remoteCommand: ['uptime'],
      }));
    assert.equal(info.transport, 'ssh');
    assert.equal(info.host, 'build-01');
    assert.equal(info.command, bin);
    assert.deepEqual(info.args, buildSshArgs('build-01', ['uptime']));
    assert.equal(info.exitKind, undefined);
    assert.equal(info.tmux.enabled, false, 'tmux is opted out for this case');

    await settle(400);
    const out = mgr.getSession(info.sessionId).getLines(50);
    assert.match(out, /FAKE_SSH_ARGV:-t -o ServerAliveInterval=15/);
    assert.match(out, /build-01 uptime/);
  } finally {
    mgr.prune();
  }
});

test('spawn rejects a disallowed or malformed host before touching the PTY', () => {
  const mgr = new SessionManager();
  try {
    assert.throws(
      () => mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'bad', 80, 24, 1000, undefined, { host: '--oProxyCommand=x' }),
      /invalid ssh host/,
    );
    withEnv({ HELA_RIBOSOME_SSH_HOSTS: 'build-01' }, () => {
      assert.throws(
        () => mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'bad', 80, 24, 1000, undefined, { host: 'other' }),
        /not allowed/,
      );
    });
    assert.equal(mgr.listSessions().length, 0);
  } finally {
    mgr.prune();
  }
});

test('PTY-05: SIGINT on an ssh session writes ^C instead of killing the transport', async () => {
  const bin = fakeSsh();
  const mgr = new SessionManager();
  try {
    const info = withEnv({ HELA_RIBOSOME_SSH_BIN: bin, HELA_RIBOSOME_TMUX: 'off' }, () =>
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'ssh-sigint', 80, 24, 60000, undefined, { host: 'build-01' }));
    const session = mgr.getSession(info.sessionId);
    await settle(400);

    session.signal('SIGINT');
    await settle(400);

    assert.equal(session.status, 'running', 'ssh transport must survive SIGINT');
    assert.match(session.getLines(50), /\^C/, 'the ^C byte must reach the remote PTY');

    // SIGTERM still tears the local transport down.
    session.signal('SIGTERM');
    await session.exited();
    assert.equal(session.status, 'exited');
  } finally {
    mgr.prune();
  }
});

test('local sessions keep tree-killing on SIGINT', async () => {
  const mgr = new SessionManager();
  try {
    const info = mgr.spawn('cat', [], process.cwd(), {}, 5000, 'dumb', 'local-sigint', 80, 24, 60000);
    const session = mgr.getSession(info.sessionId);
    assert.equal(info.transport, 'local');
    assert.equal(info.host, undefined);
    await settle(200);
    session.signal('SIGINT');
    await session.exited();
    assert.equal(session.status, 'exited');
    assert.equal(session.getInfo().exitKind, undefined, 'local sessions carry no exitKind');
  } finally {
    mgr.prune();
  }
});

test('exitKind labels transport failures (255) apart from remote exits', async () => {
  const mgr = new SessionManager();
  try {
    const transportBin = fakeSsh('#!/bin/bash\nexit 255\n');
    const remoteBin = fakeSsh('#!/bin/bash\nexit 3\n');

    const dead = withEnv({ HELA_RIBOSOME_SSH_BIN: transportBin, HELA_RIBOSOME_TMUX: 'off' }, () =>
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'ssh-255', 80, 24, 60000, undefined, { host: 'build-01' }));
    const deadSession = mgr.getSession(dead.sessionId);
    await deadSession.exited();
    assert.equal(deadSession.getInfo().exitKind, 'transport');

    const failed = withEnv({ HELA_RIBOSOME_SSH_BIN: remoteBin, HELA_RIBOSOME_TMUX: 'off' }, () =>
      mgr.spawn(undefined, [], process.cwd(), {}, 5000, 'dumb', 'ssh-3', 80, 24, 60000, undefined, { host: 'build-01' }));
    const failedSession = mgr.getSession(failed.sessionId);
    await failedSession.exited();
    assert.equal(failedSession.getInfo().exitKind, 'remote');
  } finally {
    mgr.prune();
  }
});
