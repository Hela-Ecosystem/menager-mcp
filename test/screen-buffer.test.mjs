import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenBuffer, loadHeadlessTerminal, screenEnabled } from '../build/ScreenBuffer.js';
import { SessionManager } from '../build/SessionManager.js';
import { withEnv, settle, until } from './helpers/fake-ssh.mjs';

test('PTY-01: the optional dependency resolves to a Terminal constructor', async () => {
  const Ctor = await loadHeadlessTerminal();
  assert.equal(typeof Ctor, 'function', '@xterm/headless is installed for this run');
});

test('PTY-01: HELA_RIBOSOME_SCREEN gates the renderer', () => {
  withEnv({ HELA_RIBOSOME_SCREEN: undefined }, () => assert.equal(screenEnabled(), true));
  withEnv({ HELA_RIBOSOME_SCREEN: 'off' }, () => assert.equal(screenEnabled(), false));
  withEnv({ HELA_RIBOSOME_SCREEN: 'OFF' }, () => assert.equal(screenEnabled(), false));
  withEnv({ HELA_RIBOSOME_SCREEN: '0' }, () => assert.equal(screenEnabled(), false));
  withEnv({ HELA_RIBOSOME_SCREEN: 'on' }, () => assert.equal(screenEnabled(), true));
});

test('PTY-01: the rendered screen resolves cursor motion that strip-ansi cannot', async () => {
  const screen = new ScreenBuffer({ cols: 20, rows: 4, scrollback: 50 });
  try {
    screen.write('abc\rXY');
    assert.equal(await screen.settle(20, 1500), true);
    const snap = screen.snapshot();
    assert.ok(snap, 'a snapshot is available');
    // strip-ansi would hand back "abc\rXY"; a terminal shows the overwrite.
    assert.deepEqual(snap.lines, ['XYc']);
    assert.equal(snap.cols, 20);
    assert.equal(snap.rows, 4);
    assert.equal(snap.cursor.y, 0);
  } finally {
    screen.dispose();
  }
});

test('PTY-01: SGR colour and erase-line sequences are rendered, not echoed', async () => {
  const screen = new ScreenBuffer({ cols: 20, rows: 3, scrollback: 10 });
  try {
    screen.write('\x1b[31mred\x1b[0m done\r\n');
    screen.write('scratch\x1b[2K\rfinal\r\n');
    await screen.settle(20, 1500);
    assert.deepEqual(screen.snapshot().lines, ['red done', 'final']);
  } finally {
    screen.dispose();
  }
});

test('PTY-01: snapshot returns the viewport, includeScrollback returns the history', async () => {
  const screen = new ScreenBuffer({ cols: 20, rows: 3, scrollback: 50 });
  try {
    screen.write('l1\r\nl2\r\nl3\r\nl4\r\n');
    await screen.settle(20, 1500);

    const viewport = screen.snapshot();
    assert.equal(viewport.includeScrollback, false);
    assert.ok(viewport.scrollbackLines > 0, 'rows have scrolled off the viewport');
    assert.deepEqual(viewport.lines, ['l3', 'l4'], 'trailing blank rows are trimmed');

    const full = screen.snapshot({ includeScrollback: true });
    assert.equal(full.includeScrollback, true);
    assert.deepEqual(full.lines, ['l1', 'l2', 'l3', 'l4']);
  } finally {
    screen.dispose();
  }
});

test('PTY-01: resize reflows the rendered geometry', async () => {
  const screen = new ScreenBuffer({ cols: 10, rows: 3, scrollback: 20 });
  try {
    screen.write('0123456789ABCDE\r\n');
    await screen.settle(20, 1500);
    assert.deepEqual(screen.snapshot().lines, ['0123456789', 'ABCDE']);

    screen.resize(20, 4);
    await screen.settle(20, 1500);
    const snap = screen.snapshot();
    assert.equal(snap.cols, 20);
    assert.equal(snap.rows, 4);
    assert.deepEqual(snap.lines, ['0123456789ABCDE']);
  } finally {
    screen.dispose();
  }
});

test('PTY-02: settle reports false when the cap expires on a busy stream', async () => {
  const screen = new ScreenBuffer({ cols: 40, rows: 5, scrollback: 20 });
  screen.write('x');
  const timer = setInterval(() => screen.write('x'), 10);
  try {
    assert.equal(await screen.settle(200, 150), false, 'a capped wait must not claim the frame is final');
  } finally {
    clearInterval(timer);
    screen.dispose();
  }
});

test('PTY-01: a disposed screen stops rendering and reports no snapshot', async () => {
  const screen = new ScreenBuffer({ cols: 10, rows: 2 });
  screen.write('hi');
  await screen.settle(20, 1500);
  assert.ok(screen.snapshot());
  screen.dispose();
  assert.equal(screen.state(), 'unavailable');
  assert.equal(screen.write('more'), false);
  assert.equal(screen.snapshot(), null);
});

test('PTY-01: the session feeds the renderer from the same stream as the raw ring buffer', async () => {
  const mgr = new SessionManager();
  try {
    const info = mgr.spawn('bash', ['-c', "printf 'abc\\rXY'; sleep 1"], process.cwd(), {}, 5000, 'xterm-256color', 'screen-feed', 40, 6, 60000);
    const session = mgr.getSession(info.sessionId);
    assert.equal(info.screen.enabled, true);

    await until(() => session.getLines(10).includes('XY'));
    const read = await session.readScreen({ settleMs: 400 });

    assert.equal(read.rendered, true);
    assert.equal(read.mode, 'screen');
    assert.equal(read.text, 'XYc', 'the screen shows the overwrite');
    assert.match(session.getLines(10, false), /abc\rXY/, 'raw bytes are kept untouched for exact-byte reads');
    assert.equal(read.cols, 40);
    assert.equal(read.rows, 6);
  } finally {
    mgr.prune();
  }
});

test('PTY-02: a capped settleMs on a noisy session reports settled:false', async () => {
  const mgr = new SessionManager();
  try {
    const info = mgr.spawn('bash', ['-c', 'while :; do printf x; sleep 0.01; done'], process.cwd(), {}, 5000, 'xterm-256color', 'screen-noisy', 40, 6, 60000);
    const session = mgr.getSession(info.sessionId);
    await until(() => session.getLines(5).includes('x'));
    const read = await session.readScreen({ settleMs: 150 });
    assert.equal(read.rendered, true);
    assert.equal(read.settled, false);
  } finally {
    mgr.prune();
  }
});

test('PTY-01: HELA_RIBOSOME_SCREEN=off falls back to the strip-ansi buffer', async () => {
  const mgr = new SessionManager();
  try {
    const info = withEnv({ HELA_RIBOSOME_SCREEN: 'off' }, () =>
      mgr.spawn('bash', ['-c', "printf 'abc\\rXY'; sleep 1"], process.cwd(), {}, 5000, 'xterm-256color', 'screen-off', 40, 6, 60000));
    const session = mgr.getSession(info.sessionId);
    assert.equal(info.screen.enabled, false);
    assert.equal(info.screen.state, 'disabled');

    await until(() => session.getLines(10).includes('XY'));
    const read = await session.readScreen({});
    assert.equal(read.rendered, false);
    assert.match(read.reason, /HELA_RIBOSOME_SCREEN=off/);
    assert.equal(read.settled, true);
    assert.equal(read.text, session.getLines(100, true), 'the fallback is exactly today\'s behaviour');
  } finally {
    mgr.prune();
  }
});

test('PTY-01: reattach resets the viewport but keeps the local line buffer', async () => {
  const mgr = new SessionManager();
  try {
    const info = mgr.spawn('bash', ['-c', 'echo first-frame; sleep 30'], process.cwd(), {}, 5000, 'xterm-256color', 'screen-reset', 40, 6, 60000, undefined, undefined, { sessionId: 'screenreset' });
    const session = mgr.getSession(info.sessionId);
    assert.equal(info.sessionId, 'screenreset', 'an explicit sessionId is honoured');
    await until(() => session.getLines(10).includes('first-frame'));
    assert.match((await session.readScreen({ settleMs: 300 })).text, /first-frame/);

    const reattached = session.reattach();
    assert.equal(reattached.reconnects, 1);
    assert.equal(reattached.status, 'running');
    assert.equal(reattached.pid, info.pid, 'a live session is re-attached in place, not respawned');

    const after = await session.readScreen({ settleMs: 300 });
    assert.doesNotMatch(after.text, /first-frame/, 'the viewport was cleared');
    assert.match(after.text, /\[reconnected at /, 'the reconnect marker is rendered');
    assert.match(session.getLines(200), /first-frame/, 'local scrollback survives the reattach');
  } finally {
    mgr.prune();
  }
});
