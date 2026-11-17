/**
 * PTY-01: rendered screen.
 *
 * A thin wrapper over `@xterm/headless` fed from the same `onData` stream as the raw
 * ring buffer. It answers "what would a human see right now" for full-screen TUIs
 * (vim, htop, tmux, progress bars) that `strip-ansi` turns into cursor-movement soup.
 *
 * The dependency is optional and loaded lazily: when it is absent, or when
 * `HELA_RIBOSOME_SCREEN=off`, the buffer reports itself unavailable and callers fall
 * back to the strip-ansi line buffer. The raw lines are always kept for hooks and
 * exact-byte reads.
 */

/** Non-literal on purpose: the optional dependency must not become a build-time one. */
const XTERM_SPECIFIER: string = '@xterm/headless';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_SCROLLBACK = 1000;
/** Bound on data buffered while the emulator is still being imported. */
const MAX_PENDING_CHARS = 1 << 20;

export type ScreenState = 'loading' | 'ready' | 'unavailable';

export interface ScreenSnapshot {
  /** Plain text, one entry per terminal row; trailing blank rows removed. */
  lines: string[];
  cols: number;
  rows: number;
  cursor: { x: number; y: number };
  /** Rows that have scrolled off the viewport and are retained by the emulator. */
  scrollbackLines: number;
  includeScrollback: boolean;
}

/** `HELA_RIBOSOME_SCREEN=off` (also `0`/`false`) restores the pre-PTY-01 behaviour. */
export function screenEnabled(): boolean {
  const raw = (process.env.HELA_RIBOSOME_SCREEN ?? '').trim().toLowerCase();
  return raw !== 'off' && raw !== '0' && raw !== 'false';
}

type TerminalCtor = new (opts: Record<string, unknown>) => any;

let loader: Promise<TerminalCtor | null> | undefined;

/** Imported once per process; a missing module resolves to null instead of throwing. */
export function loadHeadlessTerminal(): Promise<TerminalCtor | null> {
  if (!loader) {
    loader = (async () => {
      try {
        const mod: any = await import(XTERM_SPECIFIER);
        const ctor = mod?.Terminal ?? mod?.default?.Terminal ?? null;
        return typeof ctor === 'function' ? (ctor as TerminalCtor) : null;
      } catch {
        return null;
      }
    })();
  }
  return loader;
}

/** Test seam: forget the cached import so the absent-module path can be exercised. */
export function resetHeadlessTerminalLoader(): void {
  loader = undefined;
}

/** Short, bounded waits only — deliberately not unref'd so an awaited settle cannot stall. */
const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

function clampDimension(value: number | undefined, dflt: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.max(1, Math.floor(n)), 10000);
}

export class ScreenBuffer {
  public cols: number;
  public rows: number;
  public scrollback: number;

  private term: any = null;
  private status: ScreenState = 'loading';
  private pending: string[] = [];
  private pendingChars = 0;
  private inflight = 0;
  private lastWriteAt = 0;
  private disposed = false;
  private readonly readyPromise: Promise<boolean>;

  constructor(opts: { cols?: number; rows?: number; scrollback?: number } = {}) {
    this.cols = clampDimension(opts.cols, DEFAULT_COLS);
    this.rows = clampDimension(opts.rows, DEFAULT_ROWS);
    this.scrollback = clampDimension(opts.scrollback, DEFAULT_SCROLLBACK);

    this.readyPromise = loadHeadlessTerminal().then(Ctor => {
      if (this.disposed) return false;
      if (!Ctor) {
        this.status = 'unavailable';
        this.dropPending();
        return false;
      }
      try {
        this.term = new Ctor({
          cols: this.cols,
          rows: this.rows,
          scrollback: this.scrollback,
          allowProposedApi: true,
        });
      } catch {
        this.status = 'unavailable';
        this.dropPending();
        return false;
      }
      this.status = 'ready';
      const queued = this.pending;
      this.dropPending();
      for (const chunk of queued) this.feed(chunk);
      return true;
    }).catch(() => {
      this.status = 'unavailable';
      this.dropPending();
      return false;
    });
  }

  private dropPending(): void {
    this.pending = [];
    this.pendingChars = 0;
  }

  private feed(chunk: string): void {
    this.inflight += 1;
    try {
      this.term.write(chunk, () => { this.inflight -= 1; });
    } catch {
      this.inflight -= 1;
    }
  }

  public state(): ScreenState {
    return this.status;
  }

  /** Feeds the emulator. Returns false when no screen is being rendered. */
  public write(data: string): boolean {
    if (this.disposed || this.status === 'unavailable' || !data) return false;
    this.lastWriteAt = Date.now();
    if (this.status === 'ready') {
      this.feed(data);
      return true;
    }
    this.pending.push(data);
    this.pendingChars += data.length;
    while (this.pendingChars > MAX_PENDING_CHARS && this.pending.length > 1) {
      this.pendingChars -= this.pending.shift()!.length;
    }
    return true;
  }

  public resize(cols: number, rows: number): void {
    this.cols = clampDimension(cols, this.cols);
    this.rows = clampDimension(rows, this.rows);
    if (this.status === 'ready') {
      try { this.term.resize(this.cols, this.rows); } catch { /* emulator refused the geometry */ }
    }
  }

  /**
   * PTY-04 reattach: clear what the previous transport painted without touching the
   * emulator's scrollback or the session's raw lines.
   */
  public resetViewport(): void {
    this.write('\x1b[2J\x1b[H');
  }

  /** Resolves true once the emulator exists, false if it never will. */
  public ready(timeoutMs: number = 1500): Promise<boolean> {
    if (this.status === 'ready') return Promise.resolve(true);
    if (this.status === 'unavailable') return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(this.status === 'ready'), Math.max(0, timeoutMs));
      const done = (value: boolean) => { clearTimeout(timer); resolve(value); };
      this.readyPromise.then(done, () => done(false));
    });
  }

  /**
   * Waits for the stream to go quiet: no bytes for `quietMs` and nothing left to parse.
   * Returns false when `maxMs` expired first, so a caller can report `settled: false`
   * rather than pretend the frame is final.
   */
  public async settle(quietMs: number = 200, maxMs: number = 1500): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, maxMs);
    if (!(await this.ready(Math.max(0, deadline - Date.now())))) return false;
    const quiet = Math.max(0, quietMs);
    for (;;) {
      const idleFor = Date.now() - this.lastWriteAt;
      if (this.inflight === 0 && idleFor >= quiet) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await sleep(Math.min(25, remaining));
    }
  }

  /** The rendered frame, or null when no screen is available. */
  public snapshot(opts: { includeScrollback?: boolean } = {}): ScreenSnapshot | null {
    if (this.status !== 'ready') return null;
    const includeScrollback = opts.includeScrollback === true;
    let buf: any;
    try {
      buf = this.term.buffer.active;
    } catch {
      return null;
    }
    const total: number = Number(buf.length) || 0;
    const baseY: number = Number(buf.baseY) || 0;
    const start = includeScrollback ? 0 : baseY;
    const end = includeScrollback ? total : Math.min(total, baseY + this.rows);
    const lines: string[] = [];
    for (let i = start; i < end; i += 1) {
      const line = buf.getLine(i);
      lines.push(line ? String(line.translateToString(true)) : '');
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    return {
      lines,
      cols: this.cols,
      rows: this.rows,
      cursor: { x: Number(buf.cursorX) || 0, y: Number(buf.cursorY) || 0 },
      scrollbackLines: baseY,
      includeScrollback,
    };
  }

  public dispose(): void {
    this.disposed = true;
    this.dropPending();
    const term = this.term;
    this.term = null;
    this.status = 'unavailable';
    try { term?.dispose?.(); } catch { /* already torn down */ }
  }
}
