# menager — idea

**Historical design notes.** Planned interfaces, version examples, and performance goals below are not current release acceptance evidence. See [README](README.md) and [canonical tools](docs/TOOLS.md) for the current package and advertised API.

> **One agent to rule the terminals.**  
> A TypeScript MCP server that turns any CLI — Python, Node, bash, sub-agents — into a controllable, observable, hookable PTY harness.

---

## The problem

AI agents are great at writing code, bad at *driving* it. Every interesting workflow — `python -i`, `npm watch`, `gdb`, `claude-code`, an interactive installer asking `[y/N]` — lives behind a TTY. Plain `exec("bash -c ...")` can't hold a conversation: no persistent shell, no Ctrl+C, no waiting for `Ready`, no memory of what scrolled past.

`tmux` solves persistence for humans. Agents need the same, but programmable: spawn, type, read, wait for a regex, auto-reply, kill the tree, and do it for 10 harnesses in parallel without leaking memory.

**menager** is that control plane.

---

## The idea in one sentence

Give the master agent a `pty` switchboard: spawn any command in its own PTY, keep a bounded dual-stream buffer (raw ANSI + clean text), and let the agent `write` / `read` / `hook` / `wait` / `signal` / `prune` across all of them — all over MCP stdio.

If `spawn` is `fork`, `hook` is `expect`, and `read` is `tail`, menager is `systemd` for agent harnesses.

---

## How it works (30s architecture)

```
master agent ──MCP stdio (JSON-RPC)──> menager
                                    ├─ SessionManager (Map<id, Session>)
                                    │   ├─ Session ──node-pty──> /dev/pts/N ──> child (bash/python/sub-agent)
                                    │   ├─ rawLines[] / cleanLines[]  (FIFO, default 5000 lines)
                                    │   └─ hooks Set<RegExp> + waitPromises
                                    └─ HookEngine (existing-buffer check → future-data wait → autoResponse)
```

* **PTY, not pipe.** `node-pty` (`forkpty(3)`) allocates a real terminal (`TERM=xterm-256color` or `dumb`, configurable `cols`/`rows`). Interactive programs behave as if a human typed.
* **Two buffers, one truth.** Every `onData` chunk updates `rawLines` and `cleanLines = stripAnsi(rawLines[last])` re-stripped whole-line (fixes ANSI split across chunks). Both capped FIFO.
* **Hooks see past and future.** `hook(pattern)` first scans `cleanLines.join('\n')` (already buffered), then watches `latestCleanText`. Optional `triggerPayload` writes *after* registration to avoid deadlock, and `autoResponse` writes on match.

---

## Core primitives

1. **Session** — an isolated PTY with `id` (4-byte hex), optional `name`, `pid`, `command`+`args`, `cwd`/`env` merged per-session, `status` (`running`/`exited`) + `exitCode`, `createdAt`, optional `ttlMs` (auto-delete after exit).
2. **Buffer** — `getLines(tailLines, stripAnsi, offsetLines, grepPattern, clearBuffer)` — `tail` + `grep` + `slice` over the ring. `clearBuffer` flushes both streams.
3. **Hook** — `await hook(/Ready/, timeoutMs, autoResponse?, triggerPayload?)` — resolves with `matchedChunk`, rejects on `Hook timeout ...` or `Session exited`. `Invalid regex` is a typed `{"error":...}`.
4. **Lifecycle** — `signal(SIGINT|TERM|KILL)` via `tree-kill` (kills child tree, parent may survive `TERM` — useful), `close` (SIGKILL + delete), `prune(status=exited|running)` bulk GC, `wait(timeoutMs)` resolves with exit code, `resize(cols,rows)`.

No polling, no `sleep` loops — all async `Promise` + `onData`/`onExit`.

---

## Tool surface (10 tools, current as of v8)

| Tool | What it does | Notable params |
|------|--------------|----------------|
| `session_spawn` | `pty.spawn` new harness | `command, args[], cwd, env{}, maxBufferLines=5000, terminalType, name, cols=80, rows=24, ttlMs` |
| `session_write` | type into `stdin` | `payload, pressEnter=false (→\r), pressKey=Ctrl+C/D/Enter/Tab/Escape/ArrowUp/Down` — chunked `16k/5ms` async |
| `session_read` | ring buffer `tail` | `tailLines=100, stripAnsi=true, offsetLines, grepPattern, clearBuffer` |
| `session_hook` | `expect` a regex | `pattern, timeoutMs=30000, autoResponse, triggerPayload` |
| `session_wait` | block until `exited` | `timeoutMs?` → `exitCode` or `{"error":"Wait timeout..."}` |
| `session_signal` | `kill` | `SIGINT|TERM|KILL` via `tree-kill` |
| `session_resize` | `ioctl` | `cols, rows` |
| `session_info` | `stat` one | → `SessionInfo` |
| `session_list` | `ps` all | → `SessionInfo[]` |
| `session_close` / `session_prune` | GC | `close(id)`, `prune(status=exited)` → `prunedCount` |

All errors unified: `isError: true, content: [{text: JSON.stringify({error: ...})}]`. Each `CallToolRequest` logs `[MCP] Tool: name | Session: id` to `stderr`.

---

## What makes it different

* **vs `bash` tool:** persistent, not one-shot. Memory-bounded, greppable history.
* **vs `tmux`:** API-first, not keystrokes. Regex hooks + auto-reply, `wait` with timeout, `ttlMs` auto-GC, JSON errors for LLMs.
* **vs `expect`:** polyglot and concurrent — 10 hooks in parallel, each PTY dual-buffered for token-efficient `stripAnsi` reads.

---

## Use cases that actually need this

1. **Sub-agent farm.** Master spawns `sub-agent --task "refactor auth"` in 3 PTYs, hooks `TASK_DONE`, collects `read(grep:"RESULT")`, `prune` when done.
2. **Interactive CLIs.** Drive `python -i`, `gh pr create --fill`, `terraform apply` (hook `Apply complete? [y/N]` → `autoResponse: "y"`), `gdb` (send `Ctrl+C`).
3. **Long watches.** `npm run dev` + `hook(/Compiled/)` → read `tailLines=20`, no log flood (5000-line cap).
4. **Polyglot CI.** Spawn `bash`, `node`, `python3`, `cargo run` side-by-side, `wait` each, `signal` tree-kill on timeout.

---

## Tech stack

| Layer | Choice |
|-------|--------|
| Runtime | Node.js ≥ 20.x, ESM |
| Language | TypeScript 5.x |
| PTY | `node-pty` (C++ `forkpty(3)` bindings) |
| Protocol | `@modelcontextprotocol/sdk` (Stdio, JSON-RPC) |
| Sanitization | `strip-ansi` |
| Validation | `zod` (declared in `package.json`) |

---

## Design principles

* **Async only** — events + promises, never blocking `sleep`.
* **Bounded** — FIFO shift on every `onData`; `prune`/`ttlMs` prevent Map leak.
* **Faithful TTY** — real PTY, not pipe; ANSI preserved raw but clean for LLM.
* **Observable** — `stderr` logging, dual buffers, `list`/`info`.

---

## Reliability & resource discipline

* **Strict asynchrony** — purely event-driven (`onData`/`onExit` + promises); no synchronous sleep or blocking loops.
* **Buffer bounds enforced on every `onData`** — `maxBufferLines` FIFO shift keeps memory flat regardless of output volume.
* **Exited sessions retain metadata + remaining buffers** until explicitly `close`d/`prune`d or auto-reaped by `ttlMs` — nothing is lost mid-flight, nothing leaks forever.
* **Graceful shutdown** — on server `SIGINT`/`SIGTERM`, all active child PTYs receive `SIGTERM` (`tree-kill`), so no orphaned background processes survive the parent.
* **Signal discipline** — `tree-kill` on `signal()`/`close()`/`prune()` so a killed shell doesn't leave `sleep 60 &` grandkids running.

---

## Current state & next ideas

**Shipped (v8):** PTY lifecycle, dual buffers with ANSI re-strip, chunked async `write`, `hook` past+future, `tree-kill` signals, `name`/`cols`/`rows`/`ttlMs`, `prune`/`close`/`resize`/`info`, unified JSON errors, `grep`/`offset` reads, `pressKey` map.

**Shipped since (v3.1.0) — remote rendered PTY, `PTY-01…PTY-16`, no new tools:**
* **SSH transport (PTY-03/05):** `ssh -t` inside the local `node-pty`, `session_spawn({host, remoteCommand})`, validated argv only, `HELA_RIBOSOME_SSH_HOSTS` exact-match allowlist, `HELA_RIBOSOME_SSH_BIN` seam, `exitKind` separating ssh's own 255 from a remote exit, and `SIGINT` translated to a `^C` byte so the interrupt lands where the work is.
* **Rendered screen (PTY-01/02):** `src/ScreenBuffer.ts` over a lazily imported, *optional* `@xterm/headless`, fed from the same `onData` stream as the ring buffer. `session_read mode:"screen"` with `includeScrollback` and `settleMs`; `HELA_RIBOSOME_SCREEN=off` or a missing module falls back to the strip-ansi lines. Raw lines stay the truth for hooks and exact-byte reads.
* **tmux durability (PTY-04):** one cached `tmux -V` probe per host, then `tmux -u set-option -g history-limit <n> \; new-session -A -s hela_<sessionId>`; plain login shell fallback recorded as `tmux.enabled: false` with a reason. `session_spawn({sessionId})` is an idempotent re-attach (viewport reset, local scrollback kept, `[reconnected at <iso>]` injected); `session_close`/shutdown kill the remote window unless `persistOnClose`.
* **Bounded lifecycle (PTY-12/13):** shutdown awaits `SIGTERM`→`SIGKILL` inside a deadline and reports the ids still alive; `ttlMs` is resolved, clamped and reported.
* **Env allowlist (PTY-16):** `HELA_RIBOSOME_ENV_ALLOWLIST` filters what a session inherits; unset is the old behaviour.
* **Evidence harness (PTY-06):** hermetic fake `ssh`, failure injection (transport killed mid-stream, tmux absent, host unreachable, quota exceeded), optional real sshd behind `HELA_RIBOSOME_SSHD_TEST=1`. `npm test` needs no network and no sshd.

**Next:**
* `session_snapshot` → write a session's full scrollback (or rendered frame) to a file instead of through the response.
* Backpressure feedback (`bytesBuffered` vs `bytesWritten` already implicit via chunking).
* Per-session metrics (`uptime`, `hookCount`, bytes in/out) on `session_info`.
* `strip-ansi` ESM pin — the raw/clean dual buffer still carries a v6 CJS dependency the rendered screen does not need.
* Re-attach across server restarts: a tmux window outlives the transport today, but the session id lives only in this process's memory, so a restarted server cannot find it again.

---

## Non-goals

Not a terminal emulator UI, not a process supervisor for production, not a replacement for `systemd`/`docker`. It is a *harness switchboard* for the 10-60s lifetime of an agent turn.

---

*Source: `src/SessionManager.ts` (Session + SessionManager), `src/index.ts` (MCP server, 11 tools inc. prune/info/resize). Build `npm run build` → `build/index.js` (12K).*
