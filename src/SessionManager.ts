import * as pty from 'node-pty';
import { IPty } from 'node-pty';
import stripAnsi from 'strip-ansi';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { spawnSync } from 'node:child_process';
// @ts-ignore
import killTree from 'tree-kill';
import { ScreenBuffer, ScreenSnapshot, screenEnabled } from './ScreenBuffer.js';
import {
  TmuxState,
  buildTmuxArgs,
  buildTmuxKillArgs,
  buildTmuxProbeArgs,
  probeTmuxCached,
  tmuxEnabled,
  tmuxHistoryLimit,
  tmuxSessionName,
} from './Tmux.js';

export interface AgentMeta {
  kind: 'pty' | 'agent';
  agent?: string;
  model?: string;
  dir?: string;
  title?: string;
  promptPreview?: string;
  opencodeSessionId?: string | null;
  parentSessionId?: string | null;
  /** P0-B4: RunStore linkage — every spawn carries run/step identity when run under a workflow. */
  run_id?: string | null;
  step_id?: string | null;
}

/** P0-B4 quotas: env-overridable, safe defaults so one client can't fork-bomb the host. */
export function ribosomeQuotas(): { maxSessions: number; defaultTtlMs: number; maxTtlMs: number; maxBufferLines: number } {
  const num = (v: string | undefined, dflt: number): number => {
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
  };
  return {
    maxSessions: num(process.env.HELA_RIBOSOME_MAX_SESSIONS, 20),
    defaultTtlMs: num(process.env.HELA_RIBOSOME_DEFAULT_TTL_MS, 30 * 60 * 1000),
    maxTtlMs: num(process.env.HELA_RIBOSOME_MAX_TTL_MS, 4 * 60 * 60 * 1000),
    maxBufferLines: num(process.env.HELA_RIBOSOME_MAX_BUFFER_LINES, 5000),
  };
}

export type SessionTransport = 'local' | 'ssh';
export type SessionExitKind = 'remote' | 'transport';

export interface SessionInfo {
  sessionId: string;
  name?: string;
  pid: number;
  command: string;
  args: string[];
  status: 'running' | 'exited';
  exitCode: number | null;
  createdAt: string;
  ttlMs?: number;
  transport: SessionTransport;
  host?: string;
  /** Only present for ssh sessions: 255 means the transport failed, anything else came from the remote shell. */
  exitKind?: SessionExitKind;
  /** PTY-04: present for ssh sessions only. */
  tmux?: TmuxState;
  /** PTY-04: how many times this session has been re-attached. */
  reconnects: number;
  /** PTY-04: when true, closing the session leaves the remote tmux window alive. */
  persistOnClose?: boolean;
  /** PTY-01: rendered-screen availability. */
  screen: { enabled: boolean; state: string; cols: number; rows: number };
  meta?: AgentMeta;
}

/** PTY-03: hostnames only — no flags, no spaces, no ssh options smuggled through the host argument. */
const SSH_HOST_RE = /^[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?$/;

/** ssh exit code reserved for its own failures (connection, auth, protocol). */
const SSH_TRANSPORT_EXIT_CODE = 255;

export function isValidSshHost(host: unknown): host is string {
  if (typeof host !== 'string') return false;
  if (host.startsWith('-')) return false;
  return SSH_HOST_RE.test(host);
}

/** Exact-match allowlist on the host argument as supplied; unset env means any validated host. */
export function sshHostAllowlist(): string[] | null {
  const raw = process.env.HELA_RIBOSOME_SSH_HOSTS;
  if (raw === undefined) return null;
  const hosts = raw.split(',').map(h => h.trim()).filter(h => h.length > 0);
  return hosts;
}

export function assertSshHost(host: unknown): string {
  if (!isValidSshHost(host)) {
    throw new Error(`invalid ssh host: must match ${SSH_HOST_RE.source} ([user@]hostname, no flags or options)`);
  }
  const allowlist = sshHostAllowlist();
  if (allowlist && !allowlist.includes(host)) {
    throw new Error(`ssh host not allowed: ${host} (HELA_RIBOSOME_SSH_HOSTS)`);
  }
  return host;
}

/** Pure argv builder — never a shell string. */
export function buildSshArgs(host: string, remoteCommand: string[] = []): string[] {
  return [
    '-t',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=10',
    host,
    ...remoteCommand,
  ];
}

/** Non-interactive argv for capability probes and teardown: no tty, no prompts. */
export function buildSshControlArgs(host: string, remoteCommand: string[]): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    host,
    ...remoteCommand,
  ];
}

/** Test/harness seam: the ssh binary to exec. Bare name or absolute path only. */
export function sshBinary(): string {
  const bin = process.env.HELA_RIBOSOME_SSH_BIN;
  if (!bin) return 'ssh';
  if (!/^(\/[^\0]*|[A-Za-z0-9._-]+)$/.test(bin)) {
    throw new Error('invalid HELA_RIBOSOME_SSH_BIN: expected a bare binary name or an absolute path');
  }
  return bin;
}

/**
 * PTY-16: `HELA_RIBOSOME_ENV_ALLOWLIST` is a comma-separated list of variable names that
 * may be inherited by spawned sessions. Unset means the whole parent environment is
 * inherited, which is the pre-PTY-16 behaviour.
 */
export function envAllowlist(): string[] | null {
  const raw = process.env.HELA_RIBOSOME_ENV_ALLOWLIST;
  if (raw === undefined) return null;
  return raw.split(',').map(k => k.trim()).filter(k => k.length > 0);
}

/**
 * Builds the child environment. Explicit per-session variables are always honoured —
 * the allowlist filters what is *inherited*, not what the caller deliberately sets.
 */
export function buildChildEnv(overrides: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const allow = envAllowlist();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (allow && !allow.includes(k)) continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) continue;
    env[k] = String(v);
  }
  return env;
}

interface SessionHook {
  pattern: RegExp;
  resolve: (chunk: string) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  autoResponse?: string;
  /** Echo of the trigger still to be discarded; output starts after it. */
  echoPending?: string;
  /** Text observed since the hook was registered (capped), not the scrollback. */
  seen?: string;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Text kept per hook for cross-chunk patterns; bounded so a chatty session cannot grow it. */
const HOOK_SEEN_LIMIT = 64 * 1024;

/** The terminal echoes the first line of a payload as written (without the newline). */
function triggerEcho(payload: string): string | undefined {
  const line = payload.replace(/\r\n/g, '\n').split('\n')[0].trim();
  return line || undefined;
}

/** Grace for the lazy `@xterm/headless` import only; data settling is opt-in via `settleMs`. */
const SCREEN_READY_GRACE_MS = 250;

export interface ScreenReadResult {
  mode: 'screen';
  /** False when the screen is disabled or `@xterm/headless` is absent; `text` is then the strip-ansi fallback. */
  rendered: boolean;
  settled: boolean;
  includeScrollback: boolean;
  reason?: string;
  cols?: number;
  rows?: number;
  cursor?: { x: number; y: number };
  scrollbackLines?: number;
  text: string;
}

export class Session {
  public id: string;
  public ptyProcess: pty.IPty;
  public maxBufferLines: number;
  public status: 'running' | 'exited' = 'running';
  public exitCode: number | null = null;
  public createdAt: string;
  public meta: AgentMeta = { kind: 'pty' };
  public transport: SessionTransport;
  public host?: string;
  public exitKind?: SessionExitKind;
  public tmux?: TmuxState;
  public reconnects = 0;
  public persistOnClose: boolean;

  private reapTimer?: NodeJS.Timeout;
  private rawLines: string[] = [''];
  private cleanLines: string[] = [''];
  private hooks: Set<SessionHook> = new Set();
  private waitPromises: Array<{resolve: (code: number | null) => void, reject: (err: Error) => void, timeout?: NodeJS.Timeout}> = [];
  private screen?: ScreenBuffer;
  private readonly cwd: string;
  private readonly childEnv: Record<string, string>;
  private readonly terminalType: string;
  private cols: number;
  private rows: number;
  private readonly onCleanup?: () => void;

  constructor(
    public command: string,
    public args: string[],
    cwd: string,
    env: Record<string, string>,
    maxBufferLines: number = 5000,
    terminalType: string = 'xterm-256color',
    public name?: string,
    cols: number = 80,
    rows: number = 24,
    public ttlMs?: number,
    onCleanup?: () => void,
    transportOpts: { transport?: SessionTransport; host?: string; tmux?: TmuxState } = {},
    extra: { sessionId?: string; persistOnClose?: boolean } = {}
  ) {
    if (!fs.existsSync(cwd)) {
      throw new Error(`CWD does not exist: ${cwd}`);
    }
    this.transport = transportOpts.transport ?? 'local';
    this.host = transportOpts.host;
    this.tmux = transportOpts.tmux;
    this.persistOnClose = extra.persistOnClose === true;
    this.id = extra.sessionId ?? crypto.randomBytes(4).toString('hex');
    this.maxBufferLines = maxBufferLines;
    this.createdAt = new Date().toISOString();
    this.cwd = cwd;
    this.terminalType = terminalType;
    this.cols = cols;
    this.rows = rows;
    this.onCleanup = onCleanup;
    this.childEnv = buildChildEnv(env);

    if (screenEnabled()) {
      this.screen = new ScreenBuffer({ cols, rows, scrollback: maxBufferLines });
    }

    this.ptyProcess = this.startPty();
  }

  /** Spawns the PTY and wires the data/exit handlers. Used by the constructor and by reattach. */
  private startPty(): IPty {
    const proc = pty.spawn(this.command, this.args, {
      name: this.terminalType,
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: this.childEnv,
    });

    proc.onData((data) => this.handleData(data));
    proc.onExit((event) => {
      // A stale handler from a previous transport must not bury a live reattach.
      if (this.ptyProcess !== proc) return;
      this.status = 'exited';
      this.exitCode = event.exitCode;
      if (this.transport === 'ssh') {
        this.exitKind = event.exitCode === SSH_TRANSPORT_EXIT_CODE ? 'transport' : 'remote';
      }
      this.cleanupHooks(new Error('Session exited'));
      this.waitPromises.forEach(p => {
        if (p.timeout) clearTimeout(p.timeout);
        p.resolve(event.exitCode);
      });
      this.waitPromises = [];
      if (this.ttlMs && this.onCleanup) {
        // The post-exit reaper must not hold the event loop open past shutdown (PTY-12).
        this.reapTimer = setTimeout(this.onCleanup, this.ttlMs);
        this.reapTimer.unref?.();
      }
    });
    return proc;
  }

  private handleData(data: string) {
    this.screen?.write(data);

    const chunks = data.split('\r\n').join('\n').split('\n');

    // Update the last raw line and re-strip it entirely to fix ANSI fragmentation
    this.rawLines[this.rawLines.length - 1] += chunks[0];
    this.cleanLines[this.cleanLines.length - 1] = stripAnsi(this.rawLines[this.rawLines.length - 1]);

    for (let i = 1; i < chunks.length; i++) {
      this.rawLines.push(chunks[i]);
      this.cleanLines.push(stripAnsi(chunks[i]));
    }

    while (this.rawLines.length > this.maxBufferLines) {
      this.rawLines.shift();
      this.cleanLines.shift();
    }

    let latestCleanText = this.cleanLines.slice(-chunks.length).join('\n');

    for (const hook of this.hooks) {
      const chunk = this.stripTriggerEcho(hook, latestCleanText);
      // Accumulate only text observed after registration: matching the whole buffer
      // let an old occurrence of the marker satisfy a fresh hook (menager-mcp#21).
      hook.seen = `${hook.seen ?? ''}\n${chunk}`.slice(-HOOK_SEEN_LIMIT);
      if (hook.pattern.test(hook.seen)) {
        clearTimeout(hook.timeout);
        this.hooks.delete(hook);
        if (hook.autoResponse) {
          this.write(hook.autoResponse, true).catch(() => {});
        }
        hook.resolve(hook.seen);
      }
    }
  }

  private cleanupHooks(err: Error) {
    for (const hook of this.hooks) {
      clearTimeout(hook.timeout);
      hook.reject(err);
    }
    this.hooks.clear();
  }

  public async write(payload: string, pressEnter: boolean = false, pressKey?: string): Promise<number> {
    let finalPayload = payload;
    if (pressKey) {
      const keys: Record<string, string> = {
        'Ctrl+C': '\x03',
        'Ctrl+D': '\x04',
        'Enter': '\r',
        'Tab': '\t',
        'Escape': '\x1b',
        'ArrowUp': '\x1b[A',
        'ArrowDown': '\x1b[B'
      };
      if (keys[pressKey]) {
        finalPayload += keys[pressKey];
      }
    }
    if (pressEnter) finalPayload += '\r';

    const chunkSize = 16384;
    for (let i = 0; i < finalPayload.length; i += chunkSize) {
      this.ptyProcess.write(finalPayload.slice(i, i + chunkSize));
      if (i + chunkSize < finalPayload.length) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    return finalPayload.length;
  }

  public getLines(tailLines: number = 100, stripAnsi: boolean = true, clearBuffer: boolean = false, offsetLines?: number, grepPattern?: string): string {
    let lines = stripAnsi ? this.cleanLines : this.rawLines;
    if (grepPattern) {
      try {
        const regex = new RegExp(grepPattern);
        lines = lines.filter(l => regex.test(l));
      } catch (e) {
        // ignore invalid grep
      }
    }

    if (offsetLines !== undefined) {
      lines = lines.slice(offsetLines, offsetLines + tailLines);
    } else {
      lines = lines.slice(-tailLines);
    }

    if (clearBuffer) {
      this.rawLines = [''];
      this.cleanLines = [''];
    }
    return lines.join('\n');
  }

  /** PTY-01 availability, for `session_info` and the screen-read fallback. */
  public screenState(): string {
    if (!this.screen) return 'disabled';
    return this.screen.state();
  }

  public screenSnapshot(includeScrollback = false): ScreenSnapshot | null {
    return this.screen?.snapshot({ includeScrollback }) ?? null;
  }

  /**
   * PTY-02 `mode: 'screen'`. Immediate by default; a positive `settleMs` waits for the
   * stream to go quiet and reports `settled: false` if the cap expired first.
   */
  public async readScreen(opts: { includeScrollback?: boolean; settleMs?: number; tailLines?: number } = {}): Promise<ScreenReadResult> {
    const includeScrollback = opts.includeScrollback === true;
    const tailLines = opts.tailLines ?? 100;
    const settleMs = Number.isFinite(Number(opts.settleMs)) ? Math.max(0, Math.floor(Number(opts.settleMs))) : 0;

    const fallback = (reason: string): ScreenReadResult => ({
      mode: 'screen',
      rendered: false,
      settled: true,
      includeScrollback,
      reason,
      text: this.getLines(tailLines, true),
    });

    if (!this.screen) return fallback('rendered screen disabled (HELA_RIBOSOME_SCREEN=off)');

    let settled = true;
    if (settleMs > 0) {
      settled = await this.screen.settle(200, settleMs);
    } else if (!(await this.screen.ready(SCREEN_READY_GRACE_MS))) {
      return fallback('@xterm/headless is not installed (optional dependency)');
    }

    const snap = this.screen.snapshot({ includeScrollback });
    if (!snap) return fallback('@xterm/headless is not installed (optional dependency)');

    return {
      mode: 'screen',
      rendered: true,
      settled,
      includeScrollback,
      cols: snap.cols,
      rows: snap.rows,
      cursor: snap.cursor,
      scrollbackLines: snap.scrollbackLines,
      text: snap.lines.join('\n'),
    };
  }

  public hook(pattern: RegExp, timeoutMs: number, autoResponse?: string, triggerPayload?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const existingData = this.cleanLines.join('\n');
      // With a trigger, the marker must come from what the payload produces — not from
      // text already on screen, which may hold an earlier run's marker.
      if (!triggerPayload && pattern.test(existingData)) {
        if (autoResponse) {
          this.write(autoResponse, true);
        }
        const match = existingData.match(pattern);
        return resolve(match ? match[0] : "Matched in buffer");
      }

      let hookObj: SessionHook | undefined;

      const timeout = setTimeout(() => {
        if (hookObj) {
          this.hooks.delete(hookObj);
        }
        reject(new Error(`Hook timeout after ${timeoutMs}ms for pattern: ${pattern}`));
      }, timeoutMs);

      hookObj = {
        pattern,
        resolve,
        reject,
        timeout,
        autoResponse,
        echoPending: triggerPayload ? triggerEcho(triggerPayload) : undefined,
        seen: ''
      };

      this.hooks.add(hookObj);

      if (triggerPayload) {
        this.write(triggerPayload, true);
      }
    });
  }

  /**
   * Terminals echo what is written to them, so the first lines after a trigger contain
   * the command itself. Drop that echo before the marker is looked for; a payload whose
   * echo never arrives (non-echoing PTY) still matches from the next chunk.
   */
  private stripTriggerEcho(hook: SessionHook, chunk: string): string {
    const echo = hook.echoPending;
    if (!echo) return chunk;
    const at = chunk.indexOf(echo);
    if (at !== -1) {
      hook.echoPending = undefined;
      return chunk.slice(0, at) + chunk.slice(at + echo.length);
    }
    if (!chunk.includes('\n')) return chunk;
    hook.echoPending = undefined;
    const head = echo.slice(0, 12);
    if (head && chunk.startsWith(head)) {
      const newline = chunk.indexOf('\n');
      return chunk.slice(newline + 1);
    }
    return chunk;
  }

  public signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL') {
    // PTY-05: killing the local ssh client sends nothing to the remote process group.
    // Writing ^C lets the remote line discipline raise SIGINT where the work actually runs.
    if (this.transport === 'ssh' && signal === 'SIGINT') {
      this.ptyProcess.write('\x03');
      return;
    }
    try {
      killTree(this.ptyProcess.pid, signal, (err: any) => {
        if (err) this.ptyProcess.kill(signal);
      });
    } catch (e) {
      this.ptyProcess.kill(signal);
    }
  }

  public resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.ptyProcess.resize(cols, rows);
    this.screen?.resize(cols, rows);
  }

  /**
   * PTY-04: idempotent re-attach. A running session is left alone apart from the
   * reconnect marker; an exited one gets a fresh transport with the same argv. The
   * rendered viewport is reset, the local line buffer (scrollback) is kept.
   */
  public reattach(): SessionInfo {
    if (this.status === 'exited') {
      if (this.reapTimer) {
        clearTimeout(this.reapTimer);
        this.reapTimer = undefined;
      }
      this.status = 'running';
      this.exitCode = null;
      this.exitKind = undefined;
      this.ptyProcess = this.startPty();
    }
    this.reconnects += 1;
    this.screen?.resetViewport();
    this.handleData(`[reconnected at ${new Date().toISOString()}]\r\n`);
    return this.getInfo();
  }

  public wait(timeoutMs?: number): Promise<number | null> {
    if (this.status === 'exited') {
      return Promise.resolve(this.exitCode);
    }
    return new Promise((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      if (timeoutMs) {
        timeout = setTimeout(() => {
          this.waitPromises = this.waitPromises.filter(p => p.resolve !== resolve);
          reject(new Error(`Wait timeout after ${timeoutMs}ms for session ${this.id}`));
        }, timeoutMs);
      }
      this.waitPromises.push({ resolve, reject, timeout });
    });
  }

  /** Drop timers owned by this session; the caller is dropping the session itself. */
  public dispose() {
    if (this.reapTimer) {
      clearTimeout(this.reapTimer);
      this.reapTimer = undefined;
    }
    this.cleanupHooks(new Error('Session disposed'));
    this.screen?.dispose();
    this.screen = undefined;
  }

  /** Resolves once the PTY has exited, or immediately if it already has. */
  public exited(): Promise<number | null> {
    if (this.status === 'exited') return Promise.resolve(this.exitCode);
    return new Promise(resolve => {
      this.waitPromises.push({ resolve, reject: () => resolve(this.exitCode) });
    });
  }

  /**
   * PTY-12: ask the process to stop, await its exit up to deadlineMs, then force it
   * and await once more within the same budget. Resolves true when the PTY is gone.
   */
  public async terminate(deadlineMs: number = 2000): Promise<boolean> {
    if (this.status === 'exited') return true;
    const half = Math.max(1, Math.floor(deadlineMs / 2));
    const race = (ms: number): Promise<boolean> => new Promise(resolve => {
      const timer = setTimeout(() => resolve(this.status === 'exited'), ms);
      this.exited().then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    try { this.signal('SIGTERM'); } catch (e) { /* already gone */ }
    if (await race(half)) return true;
    try { this.signal('SIGKILL'); } catch (e) { /* already gone */ }
    return race(deadlineMs - half);
  }

  public resolveOpencodeSessionId(): string | null {
    const text = this.cleanLines.join('\n');
    const near = text.match(/session[^0-9a-f]{0,24}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (near) return near[1];
    const any = text.match(UUID_RE);
    return any ? any[0] : null;
  }

  public getInfo(): SessionInfo {
    return {
      sessionId: this.id,
      name: this.name,
      pid: this.ptyProcess.pid,
      command: this.command,
      args: this.args,
      status: this.status,
      exitCode: this.exitCode,
      createdAt: this.createdAt,
      ttlMs: this.ttlMs,
      transport: this.transport,
      ...(this.host ? { host: this.host } : {}),
      ...(this.exitKind ? { exitKind: this.exitKind } : {}),
      ...(this.tmux ? { tmux: this.tmux } : {}),
      reconnects: this.reconnects,
      ...(this.transport === 'ssh' ? { persistOnClose: this.persistOnClose } : {}),
      screen: { enabled: !!this.screen, state: this.screenState(), cols: this.cols, rows: this.rows },
      meta: this.meta
    };
  }
}

export interface SpawnOptions {
  /** PTY-04: re-use this id. `SessionManager.spawn` rejects an id that is already live. */
  sessionId?: string;
  /** PTY-04: leave the remote tmux window running when the session is closed. */
  persistOnClose?: boolean;
}

export interface RemoteOptions {
  host?: string;
  remoteCommand?: string[];
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function tmuxKillTimeoutMs(): number {
  const n = Number(process.env.HELA_RIBOSOME_TMUX_KILL_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5000;
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();

  /** PTY-04: one tmux capability probe per host, cached with a TTL. */
  public probeHostTmux(host: string): { available: boolean; cached: boolean; reason?: string } {
    return probeTmuxCached(host, () => {
      const r = spawnSync(sshBinary(), buildSshControlArgs(host, buildTmuxProbeArgs()), {
        timeout: 10000,
        encoding: 'utf-8',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (r.error) return { available: false, reason: `tmux probe failed: ${r.error.message}` };
      if (r.status === 0) return { available: true };
      const detail = String(r.stderr || r.stdout || '').trim().split('\n')[0] || `exit ${r.status}`;
      return { available: false, reason: `tmux unavailable on ${host}: ${detail.slice(0, 160)}` };
    });
  }

  public spawn(
    command: string,
    args: string[] = [],
    cwd: string = process.cwd(),
    env: Record<string, string> = {},
    maxBufferLines: number = 5000,
    terminalType: string = 'xterm-256color',
    name?: string,
    cols?: number,
    rows?: number,
    ttlMs?: number,
    meta?: AgentMeta,
    remote?: RemoteOptions,
    opts: SpawnOptions = {}
  ): SessionInfo {
    const q = ribosomeQuotas();
    if (opts.sessionId !== undefined) {
      if (!SESSION_ID_RE.test(opts.sessionId)) {
        throw new Error(`invalid sessionId: must match ${SESSION_ID_RE.source}`);
      }
      if (this.sessions.has(opts.sessionId)) {
        throw new Error(`session ${opts.sessionId} already exists (use session_spawn({sessionId}) to re-attach)`);
      }
    }
    // PTY-03: an explicit host turns this into an ssh transport; argv only, never a shell string.
    let transport: SessionTransport = 'local';
    let host: string | undefined;
    let execCommand = command;
    let execArgs = args;
    let tmux: TmuxState | undefined;
    const sessionId = opts.sessionId ?? crypto.randomBytes(4).toString('hex');
    if (remote?.host !== undefined) {
      host = assertSshHost(remote.host);
      const remoteCommand = remote.remoteCommand ?? [];
      if (!Array.isArray(remoteCommand) || remoteCommand.some(a => typeof a !== 'string')) {
        throw new Error('remoteCommand must be an array of strings');
      }
      transport = 'ssh';
      execCommand = sshBinary();
      // PTY-04: wrap the remote side in tmux when the host has it, so the work outlives the link.
      const tmuxName = tmuxSessionName(sessionId);
      if (!tmuxEnabled()) {
        tmux = { enabled: false, name: tmuxName, reason: 'tmux disabled (HELA_RIBOSOME_TMUX=off)' };
        execArgs = buildSshArgs(host, remoteCommand);
      } else {
        const probe = this.probeHostTmux(host);
        if (probe.available) {
          tmux = { enabled: true, name: tmuxName };
          execArgs = buildSshArgs(host, buildTmuxArgs(tmuxName, tmuxHistoryLimit(), remoteCommand));
        } else {
          // Fallback: a plain login shell, flagged as not durable.
          tmux = { enabled: false, name: tmuxName, reason: probe.reason ?? `tmux unavailable on ${host}` };
          execArgs = buildSshArgs(host, remoteCommand);
        }
      }
    }
    if (this.sessions.size >= q.maxSessions) {
      throw new Error(`session quota exceeded: ${this.sessions.size}/${q.maxSessions} active (HELA_RIBOSOME_MAX_SESSIONS)`);
    }
    const clampedBuffer = Math.min(Math.max(100, Math.floor(maxBufferLines) || 5000), q.maxBufferLines);
    // TTL: default when unset so idle sessions can't linger forever; clamped to max.
    const ttl = ttlMs === undefined ? q.defaultTtlMs : Math.min(Math.max(0, Math.floor(ttlMs)), q.maxTtlMs);
    // Propagate RunStore identity into the child env when linked.
    const childEnv = { ...env };
    if (meta?.run_id && !childEnv.HELA_RUN_ID) childEnv.HELA_RUN_ID = String(meta.run_id);
    if (meta?.step_id && !childEnv.HELA_STEP_ID) childEnv.HELA_STEP_ID = String(meta.step_id);
    const session = new Session(execCommand, execArgs, cwd, childEnv, clampedBuffer, terminalType, name, cols, rows, ttl, () => {
      this.sessions.delete(session.id);
    }, { transport, host, tmux }, { sessionId, persistOnClose: opts.persistOnClose });
    if (meta) session.meta = { ...session.meta, ...meta };
    this.sessions.set(session.id, session);
    return session.getInfo();
  }

  /** PTY-04: idempotent re-attach of a tracked session by id. */
  public reattach(id: string): SessionInfo {
    return this.getSession(id).reattach();
  }

  /** Attach (or re-attach) RunStore identity to an existing session. */
  public linkRun(id: string, run_id: string, step_id?: string): SessionInfo {
    return this.setMeta(id, { run_id, ...(step_id ? { step_id } : {}) });
  }

  public setMeta(id: string, patch: Partial<AgentMeta>): SessionInfo {
    const session = this.getSession(id);
    session.meta = { ...session.meta, ...patch };
    return session.getInfo();
  }

  public prune(status?: 'running' | 'exited'): number {
    let count = 0;
    for (const [id, session] of this.sessions.entries()) {
      if (!status || session.status === status) {
        if (session.status === 'running') {
          session.signal('SIGKILL');
        }
        session.dispose();
        this.sessions.delete(id);
        count++;
      }
    }
    return count;
  }

  public getSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }
    return session;
  }

  public hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  /**
   * PTY-04: tear the remote tmux window down so a closed session leaves nothing behind.
   * `persistOnClose` opts out; a non-tmux session has nothing to kill.
   */
  public killRemoteTmux(session: Session, force = false): { attempted: boolean; ok?: boolean; detail?: string } {
    if (session.transport !== 'ssh' || !session.host || !session.tmux?.enabled) return { attempted: false };
    if (session.persistOnClose && !force) return { attempted: false, detail: 'persistOnClose' };
    try {
      const r = spawnSync(sshBinary(), buildSshControlArgs(session.host, buildTmuxKillArgs(session.tmux.name)), {
        timeout: tmuxKillTimeoutMs(),
        encoding: 'utf-8',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (r.error) return { attempted: true, ok: false, detail: r.error.message.slice(0, 200) };
      return {
        attempted: true,
        ok: r.status === 0,
        detail: String(r.stderr || r.stdout || '').trim().slice(0, 200) || undefined,
      };
    } catch (e: any) {
      return { attempted: true, ok: false, detail: String(e?.message || e).slice(0, 200) };
    }
  }

  public closeSession(id: string, opts: { persistOnClose?: boolean } = {}): { sessionId: string; closed: boolean; tmux?: { attempted: boolean; ok?: boolean; detail?: string } } {
    const session = this.sessions.get(id);
    if (!session) return { sessionId: id, closed: false };
    if (opts.persistOnClose !== undefined) session.persistOnClose = opts.persistOnClose === true;
    const tmux = this.killRemoteTmux(session);
    if (session.status === 'running') {
      try { session.signal('SIGKILL'); } catch (e) {}
    }
    session.dispose();
    this.sessions.delete(id);
    return { sessionId: id, closed: true, ...(tmux.attempted || tmux.detail ? { tmux } : {}) };
  }

  public listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => s.getInfo());
  }

  /**
   * PTY-12: terminate every live session and await the PTYs within a bounded deadline
   * instead of firing SIGTERM and exiting immediately. PTY-04: remote tmux windows are
   * killed first, so shutdown leaves no remote sessions behind unless `persistOnClose`
   * was requested. Resolves to the ids that were still alive when the deadline expired.
   */
  public async shutdown(deadlineMs: number = 2000): Promise<string[]> {
    const pending = Array.from(this.sessions.values()).filter(s => s.status === 'running');
    for (const session of pending) {
      this.killRemoteTmux(session);
    }
    const results = await Promise.all(
      pending.map(async session => ({ id: session.id, done: await session.terminate(deadlineMs) }))
    );
    return results.filter(r => !r.done).map(r => r.id);
  }
}
