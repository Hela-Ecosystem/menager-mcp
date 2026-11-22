/**
 * PTY fixture for menager-mcp#17: a tiny line editor whose prompt repaints with
 * a carriage return, the way the reporter's custom prompt does.
 *
 * It stays in raw mode, echoes typed characters itself, repaints the whole line
 * every few keystrokes, and once emits a stale fragment (`<cho ...`) like the
 * redraw that produced the ghost text in the issue. On Enter it paints the
 * final frame, restores the terminal, and runs the accepted command with the
 * PTY as stdio so the real output lands in the same buffer.
 */
import { spawnSync } from 'node:child_process';

const PROMPT = 'menager> ';
const STALE_AT = 24;

process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdout.write(PROMPT);

let buffer = '';
let accepted = false;

function accept() {
  if (accepted) return;
  accepted = true;
  // Leave raw mode before printing the final newline so the PTY translates it
  // the way an ordinary command would.
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write(`\r${PROMPT}${buffer}\n`);
  const result = spawnSync('bash', ['-c', buffer], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

process.stdin.on('data', chunk => {
  for (const ch of chunk) {
    if (ch === '\r' || ch === '\n') return accept();
    buffer += ch;
    process.stdout.write(ch);
    if (buffer.length === STALE_AT) {
      // A partial repaint: the prompt prefix lost its first characters, so the
      // line now holds the stale `<cho ...` fragment from the issue.
      process.stdout.write(`\r<cho ${buffer}`);
    } else if (buffer.length % 8 === 0) {
      process.stdout.write(`\r${PROMPT}${buffer}`);
    }
  }
});
