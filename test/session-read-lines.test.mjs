import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { SessionManager, applyCarriageReturns } from '../build/SessionManager.js';
import { until } from './helpers/fake-ssh.mjs';

const FIXTURE = fileURLToPath(new URL('./helpers/cr-redraw-pty.mjs', import.meta.url));
const COMMAND = 'echo MARKER-START; ls /definitely-not-here; echo exit=0';

test('menager#17: carriage returns replay as terminal overwrites', () => {
  assert.equal(applyCarriageReturns('abc\rXY'), 'XYc');
  assert.equal(applyCarriageReturns('prompt> old\rprompt> new!'), 'prompt> new!');
  assert.equal(applyCarriageReturns('plain output'), 'plain output');
});

test('menager#17: session_read lines resolves prompt redraws instead of exposing ghost fragments', async () => {
  const mgr = new SessionManager();
  try {
    const info = mgr.spawn(process.execPath, [FIXTURE], process.cwd(), {}, 5000, 'dumb', 'cr-redraw', 120, 40, 60000);
    const session = mgr.getSession(info.sessionId);
    assert.equal(await until(() => session.getLines(5).includes('menager>'), 3000), true, 'the fixture prompt is ready');

    await session.write(COMMAND, true);
    assert.equal(await until(() => session.status === 'exited', 8000), true, 'the fixture command completes');

    const text = session.getLines(200, true);
    assert.match(text, /MARKER-START/, 'real command output is present');
    assert.match(text, /No such file or directory/, 'the real error line is present');
    assert.doesNotMatch(text, /<cho MARKER-START/, 'overwritten redraw fragments must not leak into lines mode');
    for (const line of text.split('\n')) {
      assert.ok(
        (line.match(/MARKER-START/g) ?? []).length <= 1,
        `one rendered copy per line, got: ${JSON.stringify(line)}`,
      );
    }
    assert.doesNotMatch(text, /\r/, 'carriage returns are resolved, not returned as text');
  } finally {
    mgr.prune();
  }
});
