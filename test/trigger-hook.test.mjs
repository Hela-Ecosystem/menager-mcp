import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../build/SessionManager.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function freshSession(name) {
  const mgr = new SessionManager();
  const info = mgr.spawn('bash', ['--norc', '--noprofile'], process.cwd(), {}, 10000, 'dumb', name, 120, 40);
  const session = mgr.getSession(info.sessionId);
  return { mgr, session };
}

test('menager#21: the echoed trigger does not satisfy the hook', async () => {
  const { mgr, session } = freshSession('hook-echo');
  try {
    await sleep(400);
    const started = Date.now();
    const matched = session.hook(/DONE-MARK-8817/, 8000, undefined, 'sleep 1; echo DONE-MARK-8817\n');
    const chunk = await matched;
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 700, `resolved on the echo after ${elapsed}ms`);
    assert.match(chunk, /DONE-MARK-8817\r?\n/);
    assert.ok(!/sleep 1; echo DONE-MARK-8817[^\n]*\nDONE-MARK-8817$/.test(chunk.trimEnd()), 'chunk is output, not the echoed command');
  } finally {
    mgr.prune();
  }
});

test('menager#21: a marker already in the scrollback does not satisfy a fresh hook', async () => {
  const { mgr, session } = freshSession('hook-scrollback');
  try {
    await sleep(400);
    await session.write('echo OLD-MARK-9911\n', false);
    await sleep(600);
    await assert.rejects(
      session.hook(/OLD-MARK-9911/, 700, undefined, 'sleep 2; echo NEVER-EMITTED\n'),
      /Hook timeout/,
    );
  } finally {
    mgr.prune();
  }
});

test('menager#21: output produced after the trigger still matches', async () => {
  const { mgr, session } = freshSession('hook-late');
  try {
    await sleep(400);
    const chunk = await session.hook(/LATE-MARK-4411/, 8000, undefined, 'sleep 1; printf "noise\\n"; sleep 0.2; printf "LATE-MARK-4411\\n"\n');
    assert.match(chunk, /LATE-MARK-4411/);
  } finally {
    mgr.prune();
  }
});

test('menager#21: hooks without a trigger still match what is already on screen', async () => {
  const { mgr, session } = freshSession('hook-preexisting');
  try {
    await sleep(400);
    await session.write('echo PRESENT-MARK-2200\n', false);
    await sleep(600);
    assert.match(await session.hook(/PRESENT-MARK-2200/, 1000), /PRESENT-MARK-2200/);
  } finally {
    mgr.prune();
  }
});
