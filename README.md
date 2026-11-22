# Menager MCP Server

<!-- hela:version:start -->
**MCP server:** `hela-ribosome` · **Version:** `3.2.1` · **Canonical tools:** 28. [Current tool reference](docs/TOOLS.md).
<!-- hela:version:end -->


> **Part of the [HeLa MCP Ecosystem](https://github.com/Hela-Ecosystem/hela-mcp-ecosystem)** — This server is **HeLa Ribosome (`hela-ribosome`)** — the *PTY Harness* component of the HeLa cellular architecture. See the [ecosystem docs](https://github.com/Hela-Ecosystem/hela-mcp-ecosystem) for profiles, workflows, and multi-client setup.

[![GPL-3.0-or-later License](https://img.shields.io/badge/License-GPL--3.0--or--later-green.svg)](https://www.gnu.org/licenses/gpl-3.0.html)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue.svg)](https://www.typescriptlang.org/)

![Menager Terminal Orchestration](assets/menager-illustrations/01-terminal-orchestration.jpg)

`menager` is a TypeScript-based Model Context Protocol (MCP) server designed for inter-session terminal orchestration. It enables an AI agent session (or human operator) to act as a master control plane capable of spawning, monitoring, driving, and hooking into child terminal harnesses (CLI tools, secondary AI agents, interactive shells, or polyglot runtimes) via standard POSIX pseudo-terminals (`pty`).

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
  - [Starting the Server](#starting-the-server)
- [Available Tools](#available-tools)
  - [Generic PTY](#generic-pty)
  - [OpenCode Native Orchestration](#opencode-native-orchestration)
- [Configuring with AI Assistants](#configuring-with-ai-assistants)

## Features

- **Polyglot Harness Multiplexing:** Drive interactive processes written in any language via standard POSIX pseudo-terminals.
- **Simulated Human Typing:** Inject text, control sequences (`SIGINT`, EOF, Ctrl+C), and raw keystrokes seamlessly into child `stdin`.
- **Predictable Event Interception:** Provide non-blocking regex hooks with timeout guarantees and optional immediate auto-responses.
- **Memory-Bounded Observability:** Maintain dedicated circular buffers per session (default 5,000 lines) with real-time ANSI-stripping for token-efficient LLM context consumption.
- **Rendered Screen Reads:** Optionally render each session through a headless terminal emulator, so a full-screen TUI, a redrawing progress bar, or any cursor-addressed output can be read as the frame a human would see instead of a stream of escape sequences.
- **Durable Remote Sessions:** Run a session over SSH and, where the host has tmux, keep the remote work alive across a dropped link — then re-attach to the same window by session id.
- **Strict Asynchrony & Resource Discipline:** Event handling remains purely event-driven using Node.js event emitters and promises; buffer bounds are strictly enforced to prevent memory leaks.

## Installation

### Manual Installation
```bash
# Clone the repository
git clone <your-repo-url>
cd menager

# Install dependencies (requires build-essential/g++ for node-pty native bindings)
npm install

# The rendered screen (session_read mode: "screen") uses @xterm/headless, declared as an
# optional dependency and imported lazily. Installing with --omit=optional is supported:
# screen reads then report rendered:false and fall back to the strip-ansi line buffer.

# Build the project
npm run build
```

## Usage

### Starting the Server

The server runs via Stdio transport, intended to be executed directly by MCP clients.

```bash
# Start the server (standard mode)
npm start

# Or run the built file directly
node build/index.js
```

## Available Tools

### Generic PTY

### `session_spawn`
Spawns a new child PTY session, locally or over SSH — or re-attaches to a tracked one.
- **`command`** *(string)*: Target binary or executable (e.g., `bash`, `python3`). **Required for local sessions**, ignored when `host` is set.
- **`sessionId`** *(string)*: Use this id instead of a generated one. If the id is **already tracked by this server**, the call is an idempotent **re-attach** and every other argument is ignored (see below).
- **`persistOnClose`** *(boolean)*: SSH + tmux only. Leave the remote tmux window running when the session is closed or the server shuts down (default `false`).
- **`args`** *(string[])*: Command line arguments.
- **`cwd`** *(string)*: Working directory path.
- **`env`** *(object)*: Additional environment variables.
- **`maxBufferLines`** *(number)*: Rolling line limit for memory buffers (default 5000).
- **`terminalType`** *(string)*: Terminal emulation type (`"dumb"` or `"xterm-256color"`, default `"xterm-256color"`).
- **`name`** *(string)*: Optional logical name/label for the session.
- **`cols`** *(number)*: Terminal columns (default 80).
- **`rows`** *(number)*: Terminal rows (default 24).
- **`host`** *(string)*: `[user@]hostname`. Switches the session to the **SSH transport** (see below).
- **`remoteCommand`** *(string[])*: Argv to run on the remote host. Requires `host`; omit it for an interactive login shell.

#### SSH transport

With `host` set, the session runs the system `ssh` binary inside the same local PTY, so `~/.ssh/config`, `ProxyJump`, agent forwarding, and hardware keys all apply unchanged. The argv is built, never concatenated into a shell string:

```
ssh -t -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10 <host> [remoteCommand...]
```

- `host` must match `^[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?$` and may not begin with `-`. Anything else — spaces, `=`, `--oProxyCommand=…` — is rejected before the PTY is created. Tool input can never add `-o` options.
- `HELA_RIBOSOME_SSH_HOSTS` is an optional comma-separated **exact-match** allowlist on the `host` argument as supplied (`build-01` does not match `user@build-01`). Unset means any validated host is allowed; set-but-empty allows none.
- `session_info` reports `transport: "ssh"` and `host`. On exit it also reports `exitKind`: `"transport"` for ssh's own failure code 255 (connection, auth, protocol), `"remote"` for anything the remote shell returned. Local sessions report `transport: "local"` and no `exitKind`.

#### Remote durability (tmux)

A bare SSH PTY dies with its transport and takes the remote work with it. When the host has tmux, the remote side is wrapped instead — once per host, the server probes `tmux -V` over a non-interactive SSH call and caches the answer:

```
ssh -t … <host> tmux -u set-option -g history-limit <n> \; new-session -A -s hela_<sessionId>
```

- `-A` makes the attach idempotent: it creates the window or joins the existing one. A dropped link leaves the remote process running inside tmux.
- Hosts **without** tmux fall back to a plain login shell, and `session_info` records it: `tmux: { "enabled": false, "name": "hela_…", "reason": "tmux unavailable on <host>: …" }`. Such a session is not durable.
- **Re-attach** with `session_spawn({ sessionId })` on a tracked id. A live session is re-attached in place (same pid); a dead transport is replaced with a fresh one running the same argv, which lands back in the same tmux window. Either way the rendered viewport is reset, the local line buffer (scrollback) is kept, and a `[reconnected at <iso>]` marker is injected into the stream. `session_info` reports `reconnects`.
- `session_close` sends `tmux kill-session -t hela_<sessionId>` unless `persistOnClose` was set, and server shutdown does the same for every live session — so neither leaves a remote session behind.
- `HELA_RIBOSOME_TMUX=off` skips the probe and the wrapper entirely; `HELA_RIBOSOME_TMUX_HISTORY_LIMIT` (default `10000`) sets the remote scrollback.

All of this is argv. No remote command is ever assembled as a shell string locally.

### `session_wait`
Blocks and waits for a session to exit gracefully, returning its final exit code.
- **`sessionId`** *(string)*: Target session ID. **Required.**
- **`timeoutMs`** *(number)*: Optional timeout in milliseconds.

### `session_write`
Injects keystrokes, commands, or escape sequences into the session's standard input.
An exited session returns `ok: false` with its `exitCode`.
- **`sessionId`** *(string)*: Target session ID. **Required.**
- **`payload`** *(string)*: String or control character sequence. **Required.**
- **`pressEnter`** *(boolean)*: Append a carriage return (`\r`, what a terminal's Enter key sends) to the payload (default **false** - *Breaking Change in v4*).
- **`pressKey`** *(string)*: Special key injection (`Ctrl+C`, `Ctrl+D`, `Enter`, `Tab`, `Escape`, `ArrowUp`, `ArrowDown`).

### `session_read`
Reads buffered output from the target session: the line buffer, or the rendered screen.
- **`sessionId`** *(string)*: Target session ID. **Required.**
- **`mode`** *(string)*: `"lines"` (default) or `"screen"`. An unknown value is a typed `{"error": …}`.
- **`tailLines`** *(number)*: Number of trailing lines to retrieve (default 100).
- **`stripAnsi`** *(boolean)*: Return sanitized text without ANSI codes, replaying carriage-return overwrites so a line reflects its final rendered state rather than every redraw fragment (default true). *(lines mode)*
- **`clearBuffer`** *(boolean)*: Flush internal buffers after read (default false). *(lines mode)*
- **`offsetLines`** *(number)*: Read lines starting from this absolute index offset (replaces tailLines). *(lines mode)*
- **`grepPattern`** *(string)*: Pre-filter buffer lines via Regex string matching. *(lines mode)*
- **`includeScrollback`** *(boolean)*: Include rows that have scrolled off the viewport (default false). **Screen mode only** — passing it with `mode: "lines"` is a typed error.
- **`settleMs`** *(number)*: Wait up to this long for the output stream to go quiet before snapshotting. **Screen mode only.** Immediate by default.

#### Rendered screen (`mode: "screen"`)

`mode: "lines"` is unchanged and returns plain text. `mode: "screen"` feeds the same `onData` stream through a headless terminal emulator (`@xterm/headless`, an optional dependency imported lazily) and returns JSON:

```json
{
  "mode": "screen",
  "rendered": true,
  "settled": true,
  "includeScrollback": false,
  "cols": 80, "rows": 24,
  "cursor": { "x": 5, "y": 3 },
  "scrollbackLines": 142,
  "text": "…one line per terminal row, trailing blank rows trimmed…"
}
```

- Use it for anything that *paints*: `htop`, `vim`, an installer's progress bar, a redrawing spinner. `abc\rXY` is `"abc\rXY"` to `strip-ansi` and `XYc` on a screen.
- `settled: false` means the cap expired while output was still arriving — the frame is a mid-flight snapshot, not a final one.
- `rendered: false` means no screen was available (`HELA_RIBOSOME_SCREEN=off`, or the optional dependency is not installed). `reason` says which, and `text` is then exactly the strip-ansi line buffer, so the call never fails over this.
- The raw buffer is always kept: hooks and exact-byte reads (`stripAnsi: false`) are unaffected by the renderer.

### `session_hook`
Awaits a specific regex pattern on the session stream with optional automated reply.
- **`sessionId`** *(string)*: Target session ID. **Required.**
- **`pattern`** *(string)*: Regular expression string to observe. **Required.**
- **`timeoutMs`** *(number)*: Milliseconds before timing out (default 30000).
- **`autoResponse`** *(string)*: Optional string to immediately write on match.
- **`triggerPayload`** *(string)*: Write payload *after* hook registers (prevents concurrency deadlock).

### `session_resize`
Resizes the target PTY terminal dimensions.
- **`sessionId`** *(string)*: Target session ID. **Required.**
- **`cols`** *(number)*: Terminal columns. **Required.**
- **`rows`** *(number)*: Terminal rows. **Required.**

### `session_signal`
Sends a POSIX signal to the target session (with recursive process-tree termination).
- **`sessionId`** *(string)*: Target session ID. **Required.**
- **`signal`** *(string)*: Signal to deliver (`SIGINT`, `SIGTERM`, `SIGKILL`). **Required.**

On an **SSH session**, `SIGINT` is translated: the server writes `\x03` into the PTY so the *remote* line discipline raises the interrupt. Killing the local `ssh` client would deliver nothing to the remote process. `SIGTERM` and `SIGKILL` still tear down the local transport only — ⚠️ **a remote process can survive `SIGTERM` on the SSH transport**. With tmux it deliberately does: the window stays, and `session_spawn({sessionId})` re-attaches to it. Use `session_close` to end the remote session for good. Local sessions are unchanged: every signal goes to the process tree.

### `session_close`
Force kills the interactive PTY session's process tree and deletes memory buffers immediately. On an SSH session backed by tmux it also kills the remote window, and reports that as `tmux: {attempted, ok, detail}`.
- **`sessionId`** *(string)*: Target session ID. **Required.**
- **`persistOnClose`** *(boolean)*: Keep the remote tmux window alive so a later `session_spawn({sessionId})` can re-attach to it. Overrides what was set at spawn time.

### `session_prune`
Force deletes sessions to free memory.
- **`status`** *(string)*: Only delete sessions with this status (`"running"` or `"exited"`). Defaults to `"exited"`.

### `session_info`
Returns a single session's live metadata and metrics: `sessionId`, `name`, `pid`, `command`, `args`, `status`, `exitCode`, `createdAt`, `ttlMs` (the resolved and clamped TTL), `transport`, `host`/`exitKind`/`tmux {enabled, name, reason}`/`persistOnClose` (SSH only), `reconnects`, `screen {enabled, state, cols, rows}`, and `meta`.
- **`sessionId`** *(string)*: Target session ID. **Required.**

### `session_list`
Lists all active and completed interactive PTY sessions managed by the server. No parameters required.

### OpenCode Native Orchestration

The wrappers target OpenCode v2. Each spawned agent runs in its own PTY session with `meta.kind: "agent"` tracking (`agent`, `model`, `dir`, resolved OpenCode session ID). [CLI docs](https://opencode.ai/docs/cli/)

| Tool | Maps to | Purpose |
| :--- | :--- | :--- |
| `agent_spawn` | `opencode [--server <url>] run --format json "<prompt>"` | Spawn an agent in a managed PTY. Pass the server URL as `attach`. To get formatted output, set `format: "default"`. Menager adds a unique suffix to the OpenCode title for formatted runs. |
| `agent_send` | PTY write, `opencode run --session <id> "<msg>"`, or `opencode run --continue "<msg>"` | An explicit `sessionId` targets that agent and returns an error if its native ID cannot be resolved. Omit the ID to resume the latest session in `cwd` with `via: "latest"`. |
| `agent_fork` | `opencode run --session <id> --fork "<msg>"` | Branch a session into a new tracked session. |
| `agent_list` | menager tracking + `opencode session list --format json` | Query each tracked working directory once and merge unique native sessions. `maxCount` caps the merged list (default 20, maximum 50). |
| `agent_info` | session metadata + resolved opencode id + output preview | Inspect one agent. |
| `agent_close` | close PTY, optionally `opencode session delete <id>` | Reports `opencodeSessionDeleted` when deletion is requested and a `reason` if it fails or the ID is unresolved. |
| `opencode_status` | `opencode --version` + `opencode debug agents` | CLI availability, version, agent IDs, names, and modes, and tracked counts. |
| `agent_create` | Unsupported on OpenCode v2 | Returns `ok: false` because the CLI has no agent creation command. |
| `opencode_models` | `opencode models` | Filters by `provider` when supplied, then returns up to 50 complete model lines and 8,000 characters. |
| `opencode_stats` | `opencode stats [--days N] [--tools] [--models] [--project ID] [--limit N]` | Usage/cost observability. |
| `opencode_export` / `opencode_import` | `opencode session export <id>` / `opencode session import <file>` | Export or import session JSON. |
| `opencode_session_delete` | `opencode session delete <id>` | Standalone native delete. |
| `opencode_mcp_list` | `opencode mcp list` | MCP connection health. |
| `opencode_auth_list` | `opencode auth list` | Provider auth names (read-only, no secrets). |
| `opencode_db` | Unsupported on OpenCode v2 | Returns `ok: false` because the CLI has no database inspection command. |
| `opencode_server_spawn` | `opencode serve [--port --hostname]` in a managed PTY | Starts a server whose URL can be passed to `agent_spawn` as `attach`. Password lines are redacted before PTY output is buffered. |

The legacy `share`, `refresh`, and `verbose` inputs return `ok: false` when enabled because OpenCode v2 removed their CLI flags.

Deliberately excluded: `tui` (interactive), `auth login/logout` (interactive secrets), `upgrade`/`uninstall` (host-destructive), `github`/`plugin`/`pr` (repo admin — run directly).

Set a custom binary via `OPENCODE_BIN` env (default `opencode`). Prompts are capped at 8000 chars; `agent`/`model` values are strictly validated (`agent` alphanumerics, `model` as `provider/model`); all subprocesses spawn with `shell: false` (no shell injection).

## HeLa session quotas & run linkage (P0-B4, all opt-in overrides)

| Variable | Default | Meaning |
|----------|---------|---------|
| `HELA_RIBOSOME_MAX_SESSIONS` | `20` | Max live sessions; `spawn` throws `session quota exceeded` past it |
| `HELA_RIBOSOME_DEFAULT_TTL_MS` | `1800000` (30m) | Idle TTL for new sessions |
| `HELA_RIBOSOME_MAX_TTL_MS` | `14400000` (4h) | TTL is clamped to this ceiling |
| `HELA_RIBOSOME_MAX_BUFFER_LINES` | `5000` | Session output buffer cap |
| `HELA_RIBOSOME_SSH_HOSTS` | *(unset)* | Comma-separated exact-match allowlist for `session_spawn({host})`; unset allows any validated host |
| `HELA_RIBOSOME_SSH_BIN` | `ssh` | SSH binary for the remote transport (bare name or absolute path); for pinning a path or a test harness |
| `HELA_RIBOSOME_SCREEN` | *(unset = on)* | `off`/`0`/`false` disables the rendered screen; `session_read mode:"screen"` then falls back to the strip-ansi buffer |
| `HELA_RIBOSOME_TMUX` | *(unset = on)* | `off`/`0`/`false` skips the tmux probe and wrapper for SSH sessions |
| `HELA_RIBOSOME_TMUX_HISTORY_LIMIT` | `10000` | Remote tmux scrollback (`history-limit`) for attached sessions |
| `HELA_RIBOSOME_TMUX_PROBE_TTL_MS` | `300000` (5m) | How long a per-host tmux capability probe is cached |
| `HELA_RIBOSOME_TMUX_KILL_TIMEOUT_MS` | `5000` | Timeout for the `tmux kill-session` teardown call |
| `HELA_RIBOSOME_ENV_ALLOWLIST` | *(unset)* | Comma-separated names of variables a spawned session may **inherit** from the server. Unset inherits everything (today's behaviour); set-but-empty inherits nothing. Per-session `env` is explicit intent and always passes |
| `HELA_RIBOSOME_SSHD_TEST` | *(unset)* | Test-only: `1` enables the optional real-sshd round-trip in the suite, which skips itself when localhost sshd is unreachable |

⚠️ `HELA_RIBOSOME_ENV_ALLOWLIST` is a blunt instrument: a child that needs `PATH`, `HOME` or `TERM` will not find them unless you list them.

Server shutdown (`SIGINT`/`SIGTERM`) now **awaits** PTY termination: every live session gets `SIGTERM`, then `SIGKILL`, within a ~2 s bounded deadline before the process exits. Sessions still alive at the deadline are logged by id. SSH sessions backed by tmux have their remote window killed first (unless `persistOnClose`), so shutdown leaves nothing running on the remote host.

`session_spawn`/`agent_spawn` accept optional `run_id`/`step_id` linking the session to a Mitosis RunStore run; the ids are also inherited from `HELA_RUN_ID`/`HELA_STEP_ID` env and propagated to child processes. `linkRun` attaches a run id to an existing session.

## Configuring with AI Assistants

### Configuring with Roo Code or Cline

1. Open the MCP settings file (usually `cline_mcp_settings.json` or `config.json`).
2. Add the following configuration for standard stdio mode:

```json
{
  "mcpServers": {
    "menager-mcp": {
      "command": "node",
      "args": ["/path/to/menager-mcp/build/index.js"],
      "env": {}
    }
  }
}
```

### Configuring with Claude Desktop

1. Open `claude_desktop_config.json`.
2. Add the following configuration:

```json
{
  "mcpServers": {
    "menager-mcp": {
      "command": "node",
      "args": ["/path/to/menager-mcp/build/index.js"],
      "env": {}
    }
  }
}
```
