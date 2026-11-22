# HeLa Ribosome: canonical tools

Server version **3.2.1**. Generated from the ecosystem schema catalog; regenerate with `npm run docs:generate -- --servers` in the ecosystem checkout.

Only names advertised by `tools/list` are listed here. Older aliases in migration examples are not additional tools. Runtime namespace prefixes are optional and do not change these server-local names.

## `agent_close`

Close a tracked agent session, optionally also deleting the opencode session.

## `agent_create`

Legacy tool. Agent creation is unsupported on opencode v2.

## `agent_fork`

Fork an agent session (opencode run --session <id> --fork) into a new tracked branch session.

## `agent_info`

Inspect an agent session: metadata, resolved opencode session id, and output preview.

## `agent_list`

List menager agent sessions, optionally merged with live opencode session list.

## `agent_send`

Send a follow-up to a tracked agent. Writes into its running PTY or resumes its exact OpenCode session. Omit sessionId to resume the latest session in cwd.

## `agent_spawn`

Spawn an opencode agent run (opencode run) inside a managed PTY. Native multi-agent orchestration: each agent gets its own sessionId for routing follow-ups via agent_send/agent_fork.

## `opencode_auth_list`

List authenticated providers (opencode auth list). Read-only; names only, no secrets.

## `opencode_db`

Legacy tool, restricted: direct session database inspection is unsupported on opencode v2. Use hela-genome execute_sql for the memory database.

## `opencode_export`

Export opencode session data as JSON (opencode session export <sessionID>).

## `opencode_import`

Import opencode session data from a JSON file (opencode session import <file>).

## `opencode_mcp_list`

List configured MCP servers and connection status (opencode mcp list).

## `opencode_models`

List available models, optionally filtered by provider. Returns up to 50 complete rows and 8000 characters.

## `opencode_server_spawn`

Spawn a long-running opencode server in a managed PTY. Use its URL as the attach input to agent_spawn.

## `opencode_session_delete`

Delete an opencode session (opencode session delete <sessionID>). Standalone; agent_close also offers this.

## `opencode_stats`

Token usage and cost statistics (opencode stats).

## `opencode_status`

Check opencode CLI availability, version, defined agents, and tracked session counts.

## `session_close`

Kills and removes an interactive PTY session managed by this server, freeing its memory. SSH sessions backed by tmux also get their remote window killed unless persistOnClose is set.

## `session_hook`

Awaits a specific regex pattern on the session stream with optional automated reply.

## `session_info`

Returns metadata and status for a specific session.

## `session_list`

Lists all active and completed interactive PTY sessions managed by this server.

## `session_prune`

Force deletes sessions (default: only 'exited' sessions).

## `session_read`

Reads buffered output from the target session: the raw/stripped line buffer ('lines', default) or the rendered terminal screen ('screen').

## `session_resize`

Resizes the PTY terminal dimensions.

## `session_signal`

Sends a POSIX signal to the target session process.

## `session_spawn`

Spawns a new child PTY session, or re-attaches to a tracked one when 'sessionId' names an existing session.

## `session_wait`

Blocks and waits for a session to exit, returning its exit code.

## `session_write`

Injects keystrokes, commands, or escape sequences into the session's standard input.
