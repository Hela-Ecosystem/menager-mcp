## [Unreleased]

### Fixed
- Keep the advertised MCP server version in sync with package metadata through a single-source version guard.

### Added
- `npm run test:remote` exercises the ssh transport against a real host: spawn, tmux attach, command round-trip through the rendered screen, idempotent reattach with the reconnect marker, remote kill on close, and a transport-failure exit code. Set `HELA_ITEST_HOST` (default `servy`); it requires key-based ssh and tmux on the target and is not part of `npm test`.

# Changelog

All notable changes to this project.

## [3.1.0] - 2026-11-18

Remote rendered PTY. No tools were added or removed — the surface stays at 28 canonical tools; everything below is new parameters and new reporting on the existing ones.

### Added
- **PTY-01 rendered screen.** `@xterm/headless` is now a lazy **optional** dependency behind `src/ScreenBuffer.ts`, fed from the same `onData` stream as the raw ring buffer. It answers "what would a human see", which is what full-screen TUIs, progress bars and cursor-addressed output actually need. `HELA_RIBOSOME_SCREEN=off` (also `0`/`false`), or the module simply not being installed, falls back to the existing strip-ansi behaviour. Raw lines are untouched and remain the source for hooks and exact-byte reads.
- **PTY-02 `session_read` modes.** `mode: "lines"` (default, unchanged plain-text output) or `mode: "screen"`, which returns the rendered frame as JSON with `rendered`, `settled`, `cols`, `rows`, `cursor` and `scrollbackLines`. `includeScrollback` (screen only) adds the rows that scrolled off. `settleMs` (screen only) waits for the stream to go quiet and reports `settled: false` when the cap expires rather than pretending the frame is final. An unknown `mode`, or `includeScrollback`/`settleMs` on `mode: "lines"`, is a typed `{"error": ...}`.
- **PTY-04 tmux durability.** SSH sessions probe the host for tmux once per host (cached, `HELA_RIBOSOME_TMUX_PROBE_TTL_MS`, default 5 min) and attach through `tmux -u set-option -g history-limit <n> \; new-session -A -s hela_<sessionId>`, so remote work outlives a dropped link. Hosts without tmux fall back to a plain login shell and record `tmux: {enabled: false, reason}`. `session_spawn({sessionId})` on a tracked session is an idempotent re-attach: the rendered viewport resets, local scrollback is kept, and a `[reconnected at <iso>]` marker is injected. `session_info` reports `tmux {enabled, name}` and `reconnects`. `session_close` kills the remote window unless `persistOnClose`, and server shutdown leaves no remote sessions behind. Everything is argv — no shell strings.
- **PTY-16 environment allowlist.** `HELA_RIBOSOME_ENV_ALLOWLIST` (comma-separated) restricts which variables a spawned session inherits from the server. Unset keeps today's full inheritance. Per-session `env` is explicit intent and always passes, so `HELA_RUN_ID`/`HELA_STEP_ID` linkage still reaches a filtered child.
- **PTY-06 evidence harness.** A hermetic fake `ssh` (`test/helpers/fake-ssh.mjs`) plus failure injection for a transport killed mid-stream, a host without tmux, an unreachable host and an exceeded session quota. An optional real-sshd round-trip runs behind `HELA_RIBOSOME_SSHD_TEST=1` and skips itself when localhost sshd is unreachable. The suite needs no network and no sshd.

### Changed
- `session_close` returns the remote-teardown result (`tmux: {attempted, ok, detail}`) alongside `closed`.
- `session_info`/`session_list` entries also carry `reconnects` and `screen: {enabled, state, cols, rows}`; `persistOnClose` appears on SSH sessions.
- PTY-15: `idea.md`'s "Next" list now matches what is actually shipped.

## [3.0.1] - 2026-11-13

### Fixed
- `opencode_stats` now uses the CLI's boolean `--tools`/`--models` section flags and a single `--limit` row count, instead of passing the counts as flag values and printing help.
- OpenCode subprocesses now use the login home and XDG paths instead of the cell's isolated runtime HOME. This lets `opencode_mcp_list` connect to the existing managed service rather than failing when it tries to bind port 49374 again.

## [3.0.0] - 2026-10-31

### Changed
- **Version reset to 3.0.0** — per-server version metadata baseline reset (Phase 7). All `package.json`, MCP `ServerInfo.version`, and HTTP metadata now report `3.0.0`. This is a metadata/interface baseline reset; for `hela-plastid` it is not an upgrade from the previous `4.2.0` advert.

