import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * PTY-06 evidence harness: a hermetic stand-in for the ssh binary.
 *
 * It needs no network and no sshd. Behaviour is steered entirely through the
 * environment so a single script can model every failure we care about:
 *
 *   FAKE_SSH_LOG    append every invocation's argv here (one line per call)
 *   FAKE_SSH_TMUX   "1" (default) the host has tmux, "0" it does not
 *   FAKE_SSH_DOWN   comma-separated hosts that are unreachable (ssh exits 255)
 *   FAKE_SSH_MIDWAY "1" makes an interactive transport die after its first output
 */
const FAKE_SSH = [
  '#!/bin/bash',
  'argv="$*"',
  'if [ -n "$FAKE_SSH_LOG" ]; then printf "%s\\n" "$argv" >> "$FAKE_SSH_LOG"; fi',
  'host=""',
  'for a in "$@"; do',
  '  case "$a" in',
  '    -*|ServerAlive*|ConnectTimeout*|BatchMode*) continue ;;',
  '    *) host="$a"; break ;;',
  '  esac',
  'done',
  'IFS="," read -ra down <<< "$FAKE_SSH_DOWN"',
  'for d in "${down[@]}"; do',
  '  if [ -n "$d" ] && [ "$d" = "$host" ]; then',
  '    echo "ssh: connect to host $host port 22: No route to host" >&2',
  '    exit 255',
  '  fi',
  'done',
  'case "$argv" in',
  '  *"tmux -V"*)',
  '    if [ "${FAKE_SSH_TMUX:-1}" = "1" ]; then echo "tmux 3.3a"; exit 0; fi',
  '    echo "bash: line 1: tmux: command not found" >&2',
  '    exit 127',
  '    ;;',
  '  *"tmux kill-session"*)',
  '    exit 0',
  '    ;;',
  'esac',
  'echo "FAKE_SSH_ARGV:$argv"',
  'if [ "${FAKE_SSH_MIDWAY:-0}" = "1" ]; then',
  '  echo "midway-output"',
  '  exit 3',
  'fi',
  'stty raw -echo 2>/dev/null',
  'exec cat -v',
  '',
].join('\n');

export function fakeSsh(body = FAKE_SSH) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hela-fake-ssh-'));
  const bin = path.join(dir, 'ssh');
  fs.writeFileSync(bin, body, { mode: 0o755 });
  return bin;
}

export function freshLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hela-ssh-log-'));
  return path.join(dir, 'argv.log');
}

export function readLog(file) {
  try {
    return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function withEnv(patch, fn) {
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

export const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls a condition without busy-waiting on a fixed sleep. */
export async function until(predicate, timeoutMs = 3000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await settle(stepMs);
  }
}
