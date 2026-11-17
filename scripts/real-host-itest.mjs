import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';

const HOST = process.env.HELA_ITEST_HOST || 'servy';
const SESSION = 'itest' + Date.now().toString(36).slice(-5);
const remoteHas = (name) => spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', HOST, 'tmux', 'has-session', '-t', name], { encoding: 'utf8' }).status === 0;

const transport = new StdioClientTransport({ command: process.execPath, args: ['build/index.js'], cwd: process.cwd(), stderr: 'pipe' });
const client = new Client({ name: 'real-host-itest', version: '1.0.0' });
await client.connect(transport);

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '';
  if (res.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const step = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

try {
  const spawned = await call('session_spawn', { host: HOST, sessionId: SESSION, cols: 100, rows: 30 });
  step('spawn over ssh', spawned.transport === 'ssh' && spawned.host === HOST, `${spawned.transport} tmux=${JSON.stringify(spawned.tmux)}`);
  step('tmux durability active', spawned.tmux?.enabled === true, spawned.tmux?.name ?? 'no tmux');

  const marker = `HELA_ITEST_${SESSION}`;
  await call('session_write', { sessionId: SESSION, payload: `echo ${marker} $((40+2))`, pressEnter: true });
  let screen = '';
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const read = await call('session_read', { sessionId: SESSION, mode: 'screen', tailLines: 40 });
    screen = read.text ?? read.screen ?? JSON.stringify(read);
    if (screen.includes(`${marker} 42`)) break;
  }
  step('command round-trip', screen.includes(`${marker} 42`), screen.split('\n').filter((l) => l.includes(marker)).slice(-1)[0] ?? 'marker missing');

  step('remote tmux session exists', remoteHas(`hela_${SESSION}`), `hela_${SESSION}`);

  const reattached = await call('session_spawn', { sessionId: SESSION });
  step('reattach is idempotent', reattached.reattached === true, `reconnects=${reattached.reconnects}`);
  let after = { text: '' };
  for (let i = 0; i < 20; i++) {
    after = await call('session_read', { sessionId: SESSION, mode: 'screen', tailLines: 40, settleMs: 250 });
    if ((after.text ?? '').includes('[reconnected at')) break;
    await sleep(200);
  }
  step('reconnect marker injected', (after.text ?? '').includes('[reconnected at'), (after.text ?? '').split('\n').filter((l) => l.includes('reconnected')).slice(-1)[0]);

  const closed = await call('session_close', { sessionId: SESSION });
  step('close kills the remote session', remoteHas(`hela_${SESSION}`) === false, JSON.stringify(closed));

  const bad = await call('session_spawn', { host: 'no-such-host.invalid', sessionId: SESSION + 'x' });
  await sleep(1500);
  const badInfo = await call('session_info', { sessionId: SESSION + 'x' });
  step('unreachable host reports a transport exit', badInfo.exitKind === 'transport', `exitKind=${badInfo.exitKind} code=${badInfo.exitCode}`);
  await call('session_close', { sessionId: SESSION + 'x' }).catch(() => {});
  step('host is recorded on the broken session', bad.host === 'no-such-host.invalid', bad.host);
} catch (error) {
  step('suite', false, error.message);
} finally {
  await client.close().catch(() => {});
  spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', HOST, 'tmux', 'kill-session', '-t', `hela_${SESSION}`], { encoding: 'utf8' });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}
