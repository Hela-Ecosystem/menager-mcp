import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { VERSION } from '../build/version.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_SERVER_PASSWORD = 'aB_cd-' + '0123456789'.repeat(3) + '0123456';

/** Minimal newline-delimited JSON-RPC client for the server's own stdio transport. */
function mcpClient(env = {}, cwd = ROOT) {
  const child = spawn(process.execPath, [path.join(ROOT, 'build', 'index.js')], {
    cwd,
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
    assert.equal(init.result.serverInfo.version, VERSION);

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

test('OpenCode v2 unsupported tools fail explicitly without invoking the CLI', async () => {
  const client = mcpClient({ OPENCODE_BIN: '/nonexistent/opencode' });
  try {
    await client.init();
    for (const [tool, args, reason] of [
      ['opencode_db', {}, /no db command/i],
      ['opencode_db', { query: 'SELECT 1' }, /no db command/i],
      ['agent_create', { description: 'test agent' }, /no agent create command/i],
      ['agent_spawn', { prompt: 'hello', share: true }, /--share/],
      ['opencode_models', { refresh: true }, /--refresh/],
      ['opencode_models', { verbose: true }, /--verbose/],
    ]) {
      const result = await client.call(tool, args);
      assert.equal(result.isError, true, result.text);
      assert.equal(result.json.ok, false, result.text);
      assert.match(result.json.error, /unsupported on opencode v2/i);
      assert.match(result.json.error, reason);
    }
  } finally {
    await client.close();
  }
});

test('OpenCode help and unknown flags become MCP errors with a single diagnostic', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'menager-opencode-help-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'opencode');
  await writeFile(bin, `#!/bin/sh
printf 'DESCRIPTION\\n  Test CLI\\n\\nUSAGE\\n  opencode %s [flags]\\n\\nGLOBAL FLAGS\\n  --help\\n' "$1"
if [ "$1" = models ]; then
  printf 'ERROR\\n  Unrecognized flag: --retired\\n' >&2
  exit 1
fi
`, { mode: 0o700 });
  const client = mcpClient({ OPENCODE_BIN: bin });
  try {
    await client.init();
    for (const [tool, error] of [
      ['opencode_models', 'Unrecognized flag: --retired'],
      ['opencode_stats', 'Usage: opencode stats [flags]'],
    ]) {
      const result = await client.call(tool, {});
      assert.equal(result.isError, true, result.text);
      assert.deepEqual(result.json, { ok: false, error });
    }
  } finally {
    await client.close();
  }
});

async function fakeOpencode(t, script) {
  const dir = await mkdtemp(path.join(tmpdir(), 'menager-opencode-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'opencode');
  await writeFile(bin, `#!/bin/sh\n${script}`, { mode: 0o700 });
  return { bin, dir };
}

const ROUTING_FIRST = 'ses_first12345678';
const ROUTING_SECOND = 'ses_second12345678';

async function routingFixture(t) {
  const { bin, dir } = await fakeOpencode(t, `
case "$1:$2" in
  session:list)
    printf '%s\\n' "$PWD" >> .searches
    printf '[{"id":"${ROUTING_SECOND}","title":"%s","directory":"%s/other"},' "$(cat .title)" "$PWD"
    printf '{"id":"${ROUTING_SECOND}","title":"Named agent","directory":"%s"},' "$PWD"
    printf '{"id":"${ROUTING_FIRST}","title":"%s","directory":"%s"}]\\n' "$(cat .title)" "$PWD"
    exit 0 ;;
  run:*) shift ;;
  *) exit 2 ;;
esac
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
  case "$1" in
    --session) target=$2; shift ;;
    --continue) target=$(cat .latest) ;;
    --format) format=$2; shift ;;
    --title=*) printf '%s\\n' "\${1#--title=}" > .title ;;
    *) exit 2 ;;
  esac
  shift
done
case "$2" in
  first) target=${ROUTING_FIRST}; reply='no codeword' ;;
  second) target=${ROUTING_SECOND}; reply=BLUEBIRD ;;
  unresolved) printf 'no session was created\\n'; exit 0 ;;
  follow-up)
    printf '%s\\n' "$target" >> .deliveries
    if [ "$target" = '${ROUTING_FIRST}' ]; then reply='no codeword'; else reply=BLUEBIRD; fi ;;
  *) exit 2 ;;
esac
printf '%s\\n' "$target" > .latest
if [ "$format" = json ]; then
  printf '{"type":"step_start","sessionID":"%s"}\\n' "$target"
else
  printf '${ROUTING_SECOND}\\n'
fi
printf '%s\\n' "$reply"
`);
  const cwd = path.join(dir, 'project');
  await mkdir(cwd);
  const client = mcpClient({ OPENCODE_BIN: bin }, dir);
  t.after(() => client.close());
  await client.init();
  async function wait(sessionId) {
    const result = await client.call('session_wait', { sessionId, timeoutMs: 5000 });
    assert.equal(result.json?.exitCode, 0, result.text);
  }
  async function start(prompt, options = {}) {
    const result = await client.call('agent_spawn', { cwd, prompt, ...options });
    assert.equal(result.isError, false, result.text);
    await wait(result.json.sessionId);
    return result.json.sessionId;
  }
  return { client, cwd, start, wait };
}

test('agent_send resumes the addressed v2 agent when another agent is newer in the same directory', async (t) => {
  const { client, cwd, start, wait } = await routingFixture(t);
  const first = await start('first');
  await start('second');

  // Resolving must survive clearing the PTY's scrollback before the first send.
  await client.call('session_read', { sessionId: first, clearBuffer: true });
  for (let i = 0; i < 2; i++) {
    const result = await client.call('agent_send', { sessionId: first, message: 'follow-up' });
    assert.equal(result.isError, false, result.text);
    await wait(result.json.next.sessionId);
    const output = await client.call('session_read', { sessionId: result.json.next.sessionId });
    assert.match(output.text, /no codeword/);
    assert.doesNotMatch(output.text, /BLUEBIRD/);
    assert.equal(result.json.via, 'opencode-session');
    assert.equal(result.json.previousSessionId, first);
  }
  assert.equal(await readFile(path.join(cwd, '.deliveries'), 'utf8'), `${ROUTING_FIRST}\n`.repeat(2));
  const info = await client.call('agent_info', { sessionId: first });
  assert.equal(info.json.meta.opencodeSessionId, ROUTING_FIRST);
});

test('agent_send refuses unknown and unresolved addresses without delivering a message', async (t) => {
  const { client, cwd, start } = await routingFixture(t);
  const unresolved = await start('unresolved');
  await start('second');
  for (const sessionId of [unresolved, 'missing-agent', '', null]) {
    const result = await client.call('agent_send', { sessionId, cwd, message: 'follow-up' });
    assert.equal(result.isError, true, result.text);
    assert.equal(result.json.ok, false);
    assert.match(result.json.reason, /session/i);
    assert.match(result.json.hint, sessionId === unresolved ? /PTY output/ : /tracked/i);
    if (sessionId === unresolved) assert.ok(result.json.hint.includes(cwd), result.text);
  }
  assert.equal((await client.call('agent_list', { includeOpencode: false })).json.tracked.length, 2);
  await assert.rejects(readFile(path.join(cwd, '.deliveries')), { code: 'ENOENT' });
});

test('agent_send without a sessionId explicitly resumes the latest session in cwd', async (t) => {
  const { client, cwd, start, wait } = await routingFixture(t);
  await start('first');
  await start('second');
  const result = await client.call('agent_send', { cwd, message: 'follow-up' });
  assert.equal(result.isError, false, result.text);
  assert.equal(result.json.resumed, true);
  assert.equal(result.json.via, 'latest');
  assert.equal(result.json.previousSessionId, undefined);
  await wait(result.json.next.sessionId);
  assert.equal(await readFile(path.join(cwd, '.deliveries'), 'utf8'), `${ROUTING_SECOND}\n`);
});

test('agent_send resolves formatted output by the matching title and directory, then caches it', async (t) => {
  const { client, cwd, start, wait } = await routingFixture(t);
  const first = await start('first', { format: 'default', title: 'Named agent' });
  await start('second');
  for (let i = 0; i < 2; i++) {
    const result = await client.call('agent_send', { sessionId: first, message: 'follow-up' });
    assert.equal(result.isError, false, result.text);
    await wait(result.json.next.sessionId);
  }
  assert.equal(await readFile(path.join(cwd, '.searches'), 'utf8'), `${cwd}\n`);
  assert.equal(await readFile(path.join(cwd, '.deliveries'), 'utf8'), `${ROUTING_FIRST}\n`.repeat(2));
  const info = await client.call('agent_info', { sessionId: first });
  assert.equal(info.json.meta.title, 'Named agent');
  assert.match(await readFile(path.join(cwd, '.title'), 'utf8'), /^Named agent \[menager:[0-9a-f-]+\]\n$/);
});

test('managed OpenCode server passwords are absent from PTY output and previews', async (t) => {
  assert.equal(TEST_SERVER_PASSWORD.length, 43);
  const { bin, dir } = await fakeOpencode(t, `
printf 'server pass'
sleep 0.1
printf '\\033[32mword\\033[0m %s' '${TEST_SERVER_PASSWORD}'
sleep 0.2
printf '\\nserver listening\\n'
exec sleep 30
`);
  const client = mcpClient({ OPENCODE_BIN: bin }, dir);
  try {
    await client.init();
    const server = await client.call('opencode_server_spawn', { mode: 'serve' });
    assert.equal(server.isError, false, server.text);
    const { sessionId } = server.json;
    const ready = await client.call('session_hook', { sessionId, pattern: 'server listening', timeoutMs: 5000 });
    assert.equal(ready.isError, false, ready.text);

    for (const result of [
      await client.call('session_read', { sessionId }),
      await client.call('session_read', { sessionId, stripAnsi: false }),
      await client.call('session_read', { sessionId, mode: 'screen', includeScrollback: true, settleMs: 200 }),
      await client.call('agent_info', { sessionId }),
      ready,
      server,
    ]) {
      assert.equal(result.isError, false);
      assert.doesNotMatch(result.text, /[A-Za-z0-9_-]{43}/);
    }
    assert.match((await client.call('session_read', { sessionId })).text, /server listening/);
  } finally {
    await client.close();
  }
});

test('session_write reports the exit code for a retained exited PTY', async () => {
  const client = mcpClient();
  try {
    await client.init();
    const { json: { sessionId } } = await client.call('session_spawn', { command: 'sh', args: ['-c', 'exit 7'] });
    assert.equal((await client.call('session_wait', { sessionId, timeoutMs: 5000 })).json.exitCode, 7);
    const write = await client.call('session_write', { sessionId, payload: 'echo ghost' });
    assert.equal(write.isError, true);
    assert.deepEqual(write.json, { ok: false, error: 'session exited (code 7)', exitCode: 7 });
  } finally {
    await client.close();
  }
});

test('agent_close reports unresolved ids and deletes resolved ses_ sessions', async (t) => {
  const nativeId = 'ses_AbCd12345678';
  const { bin, dir } = await fakeOpencode(t, `
case "$1:$2" in
  run:*)
    for arg do prompt=$arg; done
    if [ "$prompt" = tracked ]; then printf '%s\\n' '{"type":"step_start","sessionID":"${nativeId}"}'; fi ;;
  session:delete)
    [ "$3" = '${nativeId}' ] && [ -f .native-session ] || exit 1
    rm .native-session ;;
  *) exit 2 ;;
esac
`);
  const project = path.join(dir, 'project');
  await mkdir(project);
  const nativeSession = path.join(project, '.native-session');
  await writeFile(nativeSession, nativeId);
  const client = mcpClient({ OPENCODE_BIN: bin }, dir);
  try {
    await client.init();
    for (const [prompt, deleted, reason] of [
      ['unresolved', false, 'no opencode session id resolved'],
      ['tracked', true, undefined],
      ['tracked', false, 'opencode session delete failed'],
    ]) {
      const run = await client.call('agent_spawn', { prompt, cwd: project, format: 'json' });
      assert.equal(run.isError, false, run.text);
      const { sessionId } = run.json;
      assert.equal((await client.call('session_wait', { sessionId, timeoutMs: 5000 })).json.exitCode, 0);
      if (deleted) {
        const fork = await client.call('agent_fork', { sessionId, message: 'forked' });
        assert.equal(fork.isError, false, fork.text);
        const forkId = fork.json.sessionId;
        assert.equal((await client.call('session_wait', { sessionId: forkId, timeoutMs: 5000 })).json.exitCode, 0);
        const closedFork = await client.call('agent_close', { sessionId: forkId, deleteOpencodeSession: true });
        assert.equal(closedFork.json.opencodeSessionDeleted, false);
        assert.equal(closedFork.json.reason, 'no opencode session id resolved');
        assert.equal(await readFile(nativeSession, 'utf8'), nativeId);
      }
      const close = await client.call('agent_close', { sessionId, deleteOpencodeSession: true });
      assert.equal(close.isError, false, close.text);
      assert.equal(close.json.closed, true);
      assert.equal(close.json.opencodeSessionId, prompt === 'tracked' ? nativeId : null);
      assert.equal(close.json.opencodeSessionDeleted, deleted);
      assert.equal(close.json.reason, reason);
      if (prompt === 'tracked') {
        await assert.rejects(readFile(nativeSession), { code: 'ENOENT' });
      } else {
        assert.equal(await readFile(nativeSession, 'utf8'), nativeId);
      }
    }
  } finally {
    await client.close();
  }
});

test('agent_list queries OpenCode once per distinct tracked directory', async (t) => {
  const { bin, dir } = await fakeOpencode(t, `
case "$1:$2" in
  run:*) exit 0 ;;
  session:list)
    printf '%s\\n' "$PWD" >> "$MENAGER_TEST_QUERIES"
    case "$(basename "$PWD")" in
      alpha) printf '%s\\n' '[{"id":"ses_alpha1234"}]' ;;
      beta) printf '%s\\n' '[{"id":"ses_beta12345"},{"id":"ses_alpha1234"}]' ;;
      *) exit 2 ;;
    esac ;;
  *) exit 2 ;;
esac
`);
  const alpha = path.join(dir, 'alpha');
  const beta = path.join(dir, 'beta');
  await Promise.all([mkdir(alpha), mkdir(beta)]);
  const queries = path.join(dir, 'queries');
  const client = mcpClient({ OPENCODE_BIN: bin, MENAGER_TEST_QUERIES: queries }, dir);
  try {
    await client.init();
    for (const cwd of [alpha, alpha, beta]) {
      const run = await client.call('agent_spawn', { prompt: 'hello', cwd });
      assert.equal(run.isError, false, run.text);
    }
    const listing = await client.call('agent_list', { includeOpencode: false });
    assert.equal(listing.json.tracked.length, 3);
    await assert.rejects(readFile(queries), { code: 'ENOENT' });

    const merged = await client.call('agent_list', { maxCount: 2 });
    assert.equal(merged.isError, false, merged.text);
    assert.equal(merged.json.tracked.length, 3);
    assert.deepEqual(merged.json.opencode?.map(({ id }) => id).sort(), ['ses_alpha1234', 'ses_beta12345']);
    assert.deepEqual((await readFile(queries, 'utf8')).trim().split('\n').sort(), [alpha, beta]);
    assert.equal((await client.call('agent_list', { maxCount: 1 })).json.opencode.length, 1);
  } finally {
    await client.close();
  }
});

test('opencode_models caps complete rows after provider filtering', async (t) => {
  const models = ['first', 'second'].flatMap(provider =>
    Array.from({ length: 75 }, (_, i) => `${provider}/model-${i}`));
  const { bin, dir } = await fakeOpencode(t, `printf '%s\\n' ${models.join(' ')}\n`);
  const client = mcpClient({ OPENCODE_BIN: bin }, dir);
  try {
    await client.init();
    for (const provider of [undefined, 'second']) {
      const result = await client.call('opencode_models', { provider });
      assert.equal(result.isError, false, result.text);
      const expected = provider ? models.filter(model => model.startsWith(`${provider}/`)) : models;
      assert.deepEqual(result.text.trim().split('\n'), expected.slice(0, 50));
    }
  } finally {
    await client.close();
  }
});

test('OpenCode v2 wrappers work against the installed CLI', { timeout: 90000 }, async (t) => {
  const bin = process.env.OPENCODE_BIN || 'opencode';
  const version = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (version.error?.code === 'ENOENT') return t.skip('opencode is absent');
  assert.equal(version.status, 0, version.error?.message || version.stderr);
  if (!/\bv?2\./.test(version.stdout)) return t.skip('requires OpenCode v2');

  async function reservePort() {
    const listener = createServer();
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => listener.listening && new Promise(resolve => listener.close(resolve)));
    return listener;
  }
  const mainListener = await reservePort();
  const probeListener = await reservePort();
  const { port } = mainListener.address();
  const { port: probePort } = probeListener.address();
  const attach = `http://127.0.0.1:${port}`;

  const dir = await mkdtemp(path.join(tmpdir(), 'menager-opencode-live-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const launcher = path.join(dir, 'opencode-isolated');
  await writeFile(launcher, `#!/bin/sh
case "$1" in
  serve)
    if [ "$3" = "$MENAGER_TEST_PROBE_PORT" ]; then unset OPENCODE_SERVER_PASSWORD; fi
    exec "$MENAGER_TEST_OPENCODE" "$@" ;;
  --server|--version) exec "$MENAGER_TEST_OPENCODE" "$@" ;;
  run) exec "$MENAGER_TEST_OPENCODE" --standalone "$@" ;;
  *) exec "$MENAGER_TEST_OPENCODE" --server "$MENAGER_TEST_SERVER_URL" "$@" ;;
esac
`, { mode: 0o700 });
  const client = mcpClient({
    OPENCODE_BIN: launcher,
    MENAGER_TEST_OPENCODE: bin.includes('/') ? path.resolve(bin) : bin,
    MENAGER_TEST_SERVER_URL: attach,
    MENAGER_TEST_PROBE_PORT: String(probePort),
    HOME: dir,
    OPENCODE_HOST_HOME: dir,
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    XDG_DATA_HOME: path.join(dir, 'data'),
    XDG_CACHE_HOME: path.join(dir, 'cache'),
    XDG_STATE_HOME: path.join(dir, 'state'),
    OPENCODE_SERVER_PASSWORD: TEST_SERVER_PASSWORD,
  }, dir);
  try {
    await client.init();
    const call = async (tool, args = {}) => {
      const result = await client.call(tool, args);
      assert.equal(result.isError, false, `${tool}: ${result.text}`);
      return result;
    };

    await new Promise(resolve => probeListener.close(resolve));
    const probe = (await call('opencode_server_spawn', { mode: 'serve', hostname: '127.0.0.1', port: probePort })).json;
    await call('session_hook', { sessionId: probe.sessionId, pattern: 'server password', timeoutMs: 10000 });
    const serverOutput = await call('session_read', { sessionId: probe.sessionId });
    assert.doesNotMatch(serverOutput.text, /[A-Za-z0-9_-]{43}/);
    assert.match(serverOutput.text, /\[redacted server password\]/);
    assert.match(serverOutput.text, /server listening/);
    await call('session_close', { sessionId: probe.sessionId });

    await new Promise(resolve => mainListener.close(resolve));
    const server = (await call('opencode_server_spawn', { mode: 'serve', hostname: '127.0.0.1', port })).json;
    await call('session_hook', { sessionId: server.sessionId, pattern: 'server listening', timeoutMs: 10000 });

    const status = (await call('opencode_status')).json;
    assert.equal(status.available, true);
    assert.equal(status.version, version.stdout.trim());
    assert.ok(JSON.parse(status.agentsOutput).some(agent => agent.id === 'build'));

    const allModels = (await call('opencode_models')).text.trim().split('\n');
    const provider = allModels[0].split('/')[0];
    const filtered = (await call('opencode_models', { provider })).text.trim().split('\n');
    assert.ok(filtered[0].startsWith(`${provider}/`));
    assert.ok(filtered.every(model => model.startsWith(`${provider}/`)));
    assert.equal((await call('opencode_models', { provider: 'menager_missing_provider' })).text, '');

    // An unknown provider exercises session creation and argv parsing with no model request.
    const model = 'menager_missing_provider/missing';
    const run = (await call('agent_spawn', {
      prompt: '--help',
      model,
      attach,
      format: 'json',
    })).json;
    const finished = await call('session_wait', { sessionId: run.sessionId, timeoutMs: 12000 });
    assert.ok(Number.isInteger(finished.json.exitCode), finished.text);
    const output = await call('session_read', { sessionId: run.sessionId });
    assert.match(output.text, /Model unavailable/);

    const listed = (await call('agent_list', { maxCount: 1 })).json.opencode;
    assert.equal(listed.length, 1);
    const { id: sessionId } = listed[0];
    assert.match(sessionId, /^ses_[A-Za-z0-9]+$/);
    assert.equal((await call('agent_info', { sessionId: run.sessionId })).json.resolvedOpencodeSessionId, sessionId);
    const exported = await call('opencode_export', { sessionId });
    assert.equal(exported.json.info.id, sessionId);
    assert.equal(exported.json.messages[0].text, '--help');
    const sanitized = await call('opencode_export', { sessionId, sanitize: true });
    assert.match(sanitized.json.messages[0].text, /redacted/);

    const file = path.join(dir, 'session.json');
    await writeFile(file, exported.text);
    assert.equal((await call('opencode_session_delete', { sessionId })).json.deleted, true);
    assert.deepEqual((await call('agent_list')).json.opencode, []);
    assert.equal((await call('opencode_import', { file })).json.ok, true);
    assert.equal((await call('agent_list')).json.opencode[0].id, sessionId);

    const formatted = (await call('agent_spawn', { prompt: 'Formatted session', title: 'Named agent', model, attach, format: 'default' })).json;
    await call('session_wait', { sessionId: formatted.sessionId, timeoutMs: 12000 });
    const formattedId = (await call('agent_info', { sessionId: formatted.sessionId })).json.resolvedOpencodeSessionId;
    assert.match(formattedId, /^ses_[A-Za-z0-9]+$/);
    assert.notEqual(formattedId, sessionId);
    const followUp = (await call('agent_send', { sessionId: run.sessionId, message: 'Exact follow-up' })).json;
    assert.equal(followUp.via, 'opencode-session');
    await call('session_wait', { sessionId: followUp.next.sessionId, timeoutMs: 12000 });
    const firstHistory = (await call('opencode_export', { sessionId })).json.messages;
    const secondHistory = (await call('opencode_export', { sessionId: formattedId })).json.messages;
    assert.ok(firstHistory.some(message => message.text === 'Exact follow-up'));
    assert.ok(secondHistory.every(message => message.text !== 'Exact follow-up'));

    const fork = (await call('agent_fork', { sessionId: formatted.sessionId, message: 'Fork follow-up' })).json;
    await call('session_wait', { sessionId: fork.sessionId, timeoutMs: 12000 });
    const forkId = (await call('agent_info', { sessionId: fork.sessionId })).json.resolvedOpencodeSessionId;
    assert.match(forkId, /^ses_[A-Za-z0-9]+$/);
    assert.notEqual(forkId, formattedId);

    await call('opencode_stats', { days: 0, topModels: 1, topTools: 1 });
    await call('opencode_mcp_list');
    await call('opencode_auth_list');

    const standalone = (await call('agent_spawn', { prompt: 'Smoke test', title: '--help', model, format: 'json' })).json;
    await call('session_wait', { sessionId: standalone.sessionId, timeoutMs: 12000 });
    assert.match((await call('session_read', { sessionId: standalone.sessionId })).text, /Model unavailable/);
  } finally {
    await client.close();
  }
});

const ATTACH_PASSWORD = 'Zx_9-' + 'abcdefghij'.repeat(3) + 'KLMN';

test('ISS-64: an attached agent receives the spawned server password without it ever being returned', async (t) => {
  const { bin, dir } = await fakeOpencode(t, `
case "$1" in
  serve)
    printf 'server password %s\\n' '${ATTACH_PASSWORD}'
    printf 'listening on http://127.0.0.1:47123\\n'
    exec sleep 30 ;;
  --server)
    if [ "$OPENCODE_PASSWORD" != '${ATTACH_PASSWORD}' ]; then
      printf '{"type":"error","message":"Server at %s requires a password; set OPENCODE_PASSWORD"}\\n' "$2"
      exit 1
    fi
    printf '{"type":"step_start","sessionID":"ses_attach123456"}\\n'
    exit 0 ;;
  *) exit 2 ;;
esac
`);
  const client = mcpClient({ OPENCODE_BIN: bin }, dir);
  t.after(() => client.close());
  await client.init();
  const server = await client.call('opencode_server_spawn', { mode: 'serve', port: 47123 });
  assert.equal(server.isError, false, server.text);
  assert.match(server.json.startupCheck, /alive after the 1000ms startup window, not that the server is ready/);
  const everything = [server.text];

  const attached = await client.call('agent_spawn', { prompt: 'hello', cwd: dir, attach: 'http://127.0.0.1:47123' });
  assert.equal(attached.isError, false, attached.text);
  const { sessionId } = attached.json;
  assert.equal((await client.call('session_wait', { sessionId, timeoutMs: 5000 })).json.exitCode, 0);
  const info = await client.call('agent_info', { sessionId });
  assert.equal(info.json.resolvedOpencodeSessionId, 'ses_attach123456');
  everything.push(attached.text, info.text, (await client.call('session_list', {})).text,
    (await client.call('session_read', { sessionId: server.json.sessionId })).text);

  const followUp = await client.call('agent_send', { sessionId, message: 'again' });
  assert.equal(followUp.isError, false, followUp.text);
  assert.equal((await client.call('session_wait', { sessionId: followUp.json.next.sessionId, timeoutMs: 5000 })).json.exitCode, 0);
  everything.push(followUp.text);

  const other = await client.call('agent_spawn', { prompt: 'hello', cwd: dir, attach: 'http://127.0.0.1:47999' });
  assert.equal((await client.call('session_wait', { sessionId: other.json.sessionId, timeoutMs: 5000 })).json.exitCode, 1);

  for (const text of everything) assert.ok(!text.includes(ATTACH_PASSWORD));
});

test('ISS-64: opencode_server_spawn reports a startup failure instead of status running', async (t) => {
  const { bin, dir } = await fakeOpencode(t, `
printf 'port already in use\\n'
exit 3
`);
  const client = mcpClient({ OPENCODE_BIN: bin }, dir);
  t.after(() => client.close());
  await client.init();
  const server = await client.call('opencode_server_spawn', { mode: 'serve' });
  assert.equal(server.isError, true, server.text);
  assert.equal(server.json.ok, false);
  assert.equal(server.json.status, 'exited');
  assert.equal(server.json.exitCode, 3);
  assert.match(server.json.output, /port already in use/);
});

test('ISS-65: opencode_import fails when the session already exists and honours cwd', async (t) => {
  const { bin, dir } = await fakeOpencode(t, `
printf '%s\\n' "$PWD" >> "$MENAGER_IMPORT_LOG"
case "$(cat "$MENAGER_IMPORT_LOG" | wc -l | tr -d ' ')" in
  3) printf 'Session already exists\\n' >&2; exit 0 ;;
  *) printf 'Imported session ses_imported1234\\n'; exit 0 ;;
esac
`);
  const project = path.join(dir, 'project');
  await mkdir(project);
  const log = path.join(dir, 'imports.log');
  await writeFile(log, '');
  const client = mcpClient({ OPENCODE_BIN: bin, MENAGER_IMPORT_LOG: log }, dir);
  t.after(() => client.close());
  await client.init();

  const imported = await client.call('opencode_import', { file: '/tmp/session.json', cwd: project });
  assert.equal(imported.isError, false, imported.text);
  assert.equal(imported.json.ok, true);
  assert.equal((await readFile(log, 'utf8')).trim(), await (await import('node:fs/promises')).realpath(project));

  const missing = await client.call('opencode_import', { file: '/tmp/session.json', cwd: path.join(dir, 'nope') });
  assert.equal(missing.isError, true);

  await client.call('opencode_import', { file: '/tmp/session.json' });
  const duplicate = await client.call('opencode_import', { file: '/tmp/session.json' });
  assert.equal(duplicate.isError, true, duplicate.text);
  assert.equal(duplicate.json.ok, false);
  assert.equal(duplicate.json.skipped, true);
});

test('ISS-66: follow-up runs get unique names instead of reusing the agent name', async (t) => {
  const { bin, dir } = await fakeOpencode(t, `
printf '{"type":"step_start","sessionID":"ses_followup1234"}\\n'
`);
  const client = mcpClient({ OPENCODE_BIN: bin }, dir);
  t.after(() => client.close());
  await client.init();
  const first = await client.call('agent_spawn', { prompt: 'one', cwd: dir, name: 'v-agent-A' });
  assert.equal(first.json.name, 'v-agent-A');
  assert.equal((await client.call('session_wait', { sessionId: first.json.sessionId, timeoutMs: 5000 })).json.exitCode, 0);
  const second = await client.call('agent_send', { sessionId: first.json.sessionId, message: 'two' });
  assert.equal(second.json.next.name, 'v-agent-A#2');
  assert.equal((await client.call('session_wait', { sessionId: second.json.next.sessionId, timeoutMs: 5000 })).json.exitCode, 0);
  const third = await client.call('agent_send', { sessionId: second.json.next.sessionId, message: 'three' });
  assert.equal(third.json.next.name, 'v-agent-A#3');
  const names = (await client.call('agent_list', { includeOpencode: false })).json.tracked.map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
});
