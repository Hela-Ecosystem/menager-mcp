import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal newline-delimited JSON-RPC client for the server's own stdio transport. */
function mcpClient(env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'build', 'index.js')], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const pendingById = new Map();
  let buffer = '';

  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolver = pendingById.get(msg.id);
      if (resolver) {
        pendingById.delete(msg.id);
        resolver(msg);
      }
    }
  });
  child.stderr.resume();

  let nextId = 1;
  const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);

  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pendingById.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 15000);
    pendingById.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    send({ jsonrpc: '2.0', id, method, params });
  });

  return {
    child,
    request,
    notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
    async init() {
      const res = await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'menager-test', version: '1.0.0' },
      });
      this.notify('notifications/initialized', {});
      return res;
    },
    async call(name, args) {
      const res = await request('tools/call', { name, arguments: args });
      const text = res.result?.content?.[0]?.text ?? '';
      let json;
      try { json = JSON.parse(text); } catch { json = undefined; }
      return { isError: res.result?.isError === true, text, json };
    },
    async close() {
      child.stdin.end();
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
    },
  };
}

test('the advertised tool surface and version are unchanged by PTY-01/02/04', async () => {
  const client = mcpClient();
  try {
    const init = await client.init();
    assert.equal(init.result.serverInfo.name, 'menager-mcp');
    assert.equal(init.result.serverInfo.version, '3.1.0');

    const list = await client.request('tools/list', {});
    const names = list.result.tools.map((t) => t.name).sort();
    assert.equal(names.length, 28, `no tools added or removed:\n${names.join('\n')}`);
    assert.ok(names.includes('session_read'));

    const read = list.result.tools.find((t) => t.name === 'session_read');
    assert.deepEqual(read.inputSchema.properties.mode.enum, ['lines', 'screen']);
    assert.ok(read.inputSchema.properties.includeScrollback);
    assert.ok(read.inputSchema.properties.settleMs);

    const spawnTool = list.result.tools.find((t) => t.name === 'session_spawn');
    assert.ok(spawnTool.inputSchema.properties.sessionId);
    assert.ok(spawnTool.inputSchema.properties.persistOnClose);
  } finally {
    await client.close();
  }
});

test('PTY-02: session_read defaults to lines and rejects an invalid mode', async () => {
  const client = mcpClient();
  try {
    await client.init();
    const spawned = await client.call('session_spawn', {
      command: 'bash',
      args: ['-c', "printf 'abc\\rXY\\n'; sleep 5"],
      terminalType: 'xterm-256color',
      cols: 40,
      rows: 6,
      name: 'tool-read',
    });
    assert.equal(spawned.isError, false, spawned.text);
    const sessionId = spawned.json.sessionId;

    const bad = await client.call('session_read', { sessionId, mode: 'rendered' });
    assert.equal(bad.isError, true);
    assert.match(bad.json.error, /mode must be 'lines' or 'screen'/);

    const misuse = await client.call('session_read', { sessionId, includeScrollback: true });
    assert.equal(misuse.isError, true);
    assert.match(misuse.json.error, /includeScrollback requires mode 'screen'/);

    const settleMisuse = await client.call('session_read', { sessionId, mode: 'lines', settleMs: 100 });
    assert.equal(settleMisuse.isError, true);
    assert.match(settleMisuse.json.error, /settleMs requires mode 'screen'/);

    const lines = await client.call('session_read', { sessionId, settleMs: undefined });
    assert.equal(lines.isError, false);
    assert.equal(lines.json, undefined, 'lines mode still returns plain text');

    const screen = await client.call('session_read', { sessionId, mode: 'screen', settleMs: 500 });
    assert.equal(screen.isError, false, screen.text);
    assert.equal(screen.json.mode, 'screen');
    assert.equal(screen.json.rendered, true);
    assert.equal(screen.json.settled, true);
    assert.equal(screen.json.includeScrollback, false);
    assert.equal(screen.json.cols, 40);
    assert.match(screen.json.text, /^XYc$/m, 'the rendered frame resolves the carriage return');

    const withScrollback = await client.call('session_read', { sessionId, mode: 'screen', includeScrollback: true });
    assert.equal(withScrollback.json.includeScrollback, true);

    const closed = await client.call('session_close', { sessionId });
    assert.equal(closed.json.closed, true);
  } finally {
    await client.close();
  }
});

test('PTY-02: HELA_RIBOSOME_SCREEN=off makes screen mode fall back over the wire', async () => {
  const client = mcpClient({ HELA_RIBOSOME_SCREEN: 'off' });
  try {
    await client.init();
    const spawned = await client.call('session_spawn', {
      command: 'bash',
      args: ['-c', "printf 'abc\\rXY\\n'; sleep 5"],
      name: 'tool-read-off',
    });
    const sessionId = spawned.json.sessionId;
    assert.equal(spawned.json.screen.enabled, false);

    const screen = await client.call('session_read', { sessionId, mode: 'screen', settleMs: 300 });
    assert.equal(screen.json.rendered, false);
    assert.match(screen.json.reason, /HELA_RIBOSOME_SCREEN=off/);
    await client.call('session_close', { sessionId });
  } finally {
    await client.close();
  }
});

test('PTY-04: session_spawn with a known sessionId re-attaches instead of spawning', async () => {
  const client = mcpClient();
  try {
    await client.init();
    const first = await client.call('session_spawn', {
      command: 'bash',
      args: ['-c', 'echo marker-one; sleep 30'],
      sessionId: 'toolreattach',
      name: 'tool-reattach',
    });
    assert.equal(first.json.sessionId, 'toolreattach');
    assert.equal(first.json.reconnects, 0);

    const again = await client.call('session_spawn', { sessionId: 'toolreattach' });
    assert.equal(again.json.reattached, true);
    assert.equal(again.json.reconnects, 1);
    assert.equal(again.json.pid, first.json.pid);

    const list = await client.call('session_list', {});
    assert.equal(list.json.length, 1, 'no duplicate session');

    const info = await client.call('session_info', { sessionId: 'toolreattach' });
    assert.equal(info.json.reconnects, 1);
    assert.equal(info.json.transport, 'local');
    assert.equal(info.json.tmux, undefined, 'local sessions carry no tmux state');

    await client.call('session_close', { sessionId: 'toolreattach' });
  } finally {
    await client.close();
  }
});
