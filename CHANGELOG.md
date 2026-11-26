## [3.2.4] - 2026-11-25

### Fixed
- `opencode_server_spawn` keeps the generated server password private and sets `OPENCODE_PASSWORD` only for opencode commands that attach to that same server URL (`agent_spawn`, `agent_send`, `agent_fork`, session lookup, delete); it is never returned or logged. Startup is checked once after a fixed 1s window and reports `ok:false` with the exit code when the process died. (`menager-mcp#23` ISS-64)
- `opencode_server_spawn` result and description now state that `status: running` means alive after the startup window, not ready to accept connections. (`menager-mcp#23` ISS-64)
- `opencode_import` reports a skipped duplicate session as `ok:false, skipped:true` instead of an empty success, and accepts an optional `cwd` that selects the project the imported session is re-homed to. (`menager-mcp#23` ISS-65)
- `agent_send` follow-up runs get unique names (`name#2`, `name#3`, ...) so a name identifies one tracked run. (`menager-mcp#23` ISS-66)

## [3.2.3] - 2026-11-23

### Fixed
- The hook trigger-echo strip no longer treats a bare newline (the Enter key's own echo or a prompt refresh) as the end of the echo. The command line can arrive in a later chunk, so the strip now waits for the echo or real content; this removes a race that made `menager#21`'s regression flake under CI load.

## [3.2.2] - 2026-11-23

### Fixed
- `session_read` lines mode replays carriage-return semantics, so a shell redrawing its prompt no longer leaves interleaved ghost frames like `<cho MARKER-START; ls …`. The raw (`stripAnsi:false`) path is unchanged. (`menager-mcp#17`)

## [3.2.1] - 2026-11-22

### Fixed
- `opencode_db` is advertised as restricted in its description, matching the ecosystem canonical-boundary check; the wording also points at `hela-genome execute_sql` for memory-database queries.

## [3.2.0] - 2026-11-22

### Changed
- `opencode_status` reads the v2 CLI: agents come back as structured ids/modes rather than a usage block, and the command wrappers match opencode 2.x (`session export/import`, `--server` instead of `--attach`, client-side `models` filtering). `db` and `agent create` report `unsupported on opencode v2` instead of running a command that no longer exists. Session ids accept `ses_<alnum>` as well as UUIDs. (`menager-mcp#20`, `#18`)
- `agent_send` resumes the session it was given. An explicit `sessionId` resolves to that OpenCode session or fails with a hint; only a call without an id continues the latest session, and says `via: "latest"`. Ids are captured from the agent JSON output and persisted. (`menager-mcp#19`)

### Fixed
- The managed-server password no longer reaches `session_read` or `agent_info`: sessions spawned with redaction buffer lines and replace `server password …` with `[redacted server password]`, including across chunk boundaries. `session_write` on an exited session returns `ok:false` with the exit code; `agent_close` reports whether an OpenCode session was actually deleted and why not; `agent_list` merges per tracked directory; `opencode_models` is bounded to 50 rows / 8000 characters. (`menager-mcp#22`)
- `session_hook` waits for output instead of matching the terminal echo of `triggerPayload`, and a marker already in the scrollback no longer satisfies a fresh hook. Both are bounded and preserve cross-chunk matching. (`menager-mcp#21`)

### Fixed
- Keep the advertised MCP server version in sync with package metadata through a single-source version guard.

### Added
- `npm run test:remote` exercises the ssh transport against a real host: spawn, tmux attach, command round-trip through the rendered screen, idempotent reattach with the reconnect marker, remote kill on close, and a transport-failure exit code. Set `HELA_ITEST_HOST` (default `servy`); it requires key-based ssh and tmux on the target and is not part of `npm test`.

# Changelog

All notable changes to this project.

## [3.1.2] - 2026-11-19

### Changed
- npm audit fix clears two moderate advisories; PTY behaviour unchanged.

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
