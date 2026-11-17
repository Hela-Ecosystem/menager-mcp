/**
 * PTY-04: remote durability.
 *
 * A bare `ssh -t` PTY dies with its transport, taking the remote work with it. When the
 * host has tmux, the session is attached to `tmux new-session -A -s hela_<sessionId>`
 * instead, so a dropped link leaves the remote process running and `session_spawn`
 * can re-attach to the same window. Hosts without tmux fall back to a plain login
 * shell and the session records that it is not durable.
 *
 * Everything here builds argv. No shell strings are ever assembled locally.
 */

export interface TmuxState {
  /** True only when the remote session is backed by a live tmux window. */
  enabled: boolean;
  name: string;
  /** Why tmux is not in use (probe result, env gate, …). */
  reason?: string;
}

export interface TmuxProbeResult {
  available: boolean;
  cached: boolean;
  reason?: string;
}

const num = (v: string | undefined, dflt: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};

/** `HELA_RIBOSOME_TMUX=off` (also `0`/`false`) forces the plain login-shell transport. */
export function tmuxEnabled(): boolean {
  const raw = (process.env.HELA_RIBOSOME_TMUX ?? '').trim().toLowerCase();
  return raw !== 'off' && raw !== '0' && raw !== 'false';
}

export function tmuxHistoryLimit(): number {
  return num(process.env.HELA_RIBOSOME_TMUX_HISTORY_LIMIT, 10000);
}

export function tmuxProbeTtlMs(): number {
  return num(process.env.HELA_RIBOSOME_TMUX_PROBE_TTL_MS, 5 * 60 * 1000);
}

/** tmux session names may not contain `.` or `:`; the id is 4-byte hex, so this is belt-and-braces. */
export function tmuxSessionName(sessionId: string): string {
  return `hela_${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '')}`;
}

/**
 * `tmux -u set-option -g history-limit <n> \; new-session -A -s <name> [-- cmd...]`
 *
 * The literal `\;` survives the remote shell and reaches tmux as its command separator.
 * `-A` makes the attach idempotent: it creates the session or attaches to the existing one.
 */
export function buildTmuxArgs(name: string, historyLimit: number, remoteCommand: string[] = []): string[] {
  const args = [
    'tmux', '-u',
    'set-option', '-g', 'history-limit', String(Math.max(0, Math.floor(historyLimit))),
    '\\;',
    'new-session', '-A', '-s', name,
  ];
  if (remoteCommand.length > 0) args.push('--', ...remoteCommand);
  return args;
}

/** Remote argv that tears the window down; used by `session_close` and shutdown. */
export function buildTmuxKillArgs(name: string): string[] {
  return ['tmux', 'kill-session', '-t', name];
}

/** Remote argv for the capability probe. No tty, no durability, just an exit code. */
export function buildTmuxProbeArgs(): string[] {
  return ['tmux', '-V'];
}

interface ProbeEntry { available: boolean; at: number; reason?: string }

const probes = new Map<string, ProbeEntry>();

/** One probe per host per TTL; the caller supplies the actual transport call. */
export function probeTmuxCached(
  host: string,
  probe: () => { available: boolean; reason?: string },
  ttlMs: number = tmuxProbeTtlMs(),
): TmuxProbeResult {
  const hit = probes.get(host);
  if (hit && Date.now() - hit.at < ttlMs) {
    return { available: hit.available, cached: true, ...(hit.reason ? { reason: hit.reason } : {}) };
  }
  let result: { available: boolean; reason?: string };
  try {
    result = probe();
  } catch (e: any) {
    result = { available: false, reason: `tmux probe failed: ${e?.message || String(e)}` };
  }
  probes.set(host, { available: result.available, at: Date.now(), reason: result.reason });
  return { available: result.available, cached: false, ...(result.reason ? { reason: result.reason } : {}) };
}

/** Test seam. */
export function resetTmuxProbes(): void {
  probes.clear();
}

/** Inspection seam for tests and diagnostics. */
export function tmuxProbeCacheSize(): number {
  return probes.size;
}
