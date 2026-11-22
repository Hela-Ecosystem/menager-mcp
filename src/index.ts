#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool
} from "@modelcontextprotocol/sdk/types.js";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Session, SessionExitedError, SessionManager } from "./SessionManager.js";
import { assertOpencodeSessionId, buildStatsArgs, isOpencodeSessionId, opencodeHostEnv, opencodeUsageError } from "./opencode-cli.js";
import { VERSION } from "./version.js";

const sessionManager = new SessionManager();

const OPENCODE_BIN = (() => {
  const raw = (process.env.OPENCODE_BIN || "opencode").trim();
  if (/^[a-zA-Z0-9._\/-]{1,256}$/.test(raw) && !raw.includes("..")) return raw;
  return "opencode";
})();

// Cells run with an isolated HOME, but OpenCode's managed service uses one
// global port. Give every OpenCode subprocess the login environment so it
// connects to the existing service instead of trying to bind port 49374.
const OPENCODE_ENV = opencodeHostEnv();

const AGENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const MODEL_RE = /^[^/\s]+\/[^/\s]{1,128}$/;
const MAX_PROMPT = 8000;
const MAX_MODELS = 50;
const MAX_MODEL_OUTPUT = 8000;

function assertPrompt(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new Error("prompt/message must be a non-empty string");
  if (v.length > MAX_PROMPT) throw new Error(`prompt exceeds ${MAX_PROMPT} chars`);
  return v;
}

function assertAgent(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !AGENT_RE.test(v)) throw new Error("agent must match [a-zA-Z0-9_-]{1,64}");
  return v;
}

function assertModel(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !MODEL_RE.test(v)) throw new Error("model must be provider/model");
  return v;
}

function assertServerUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^https?:\/\//i.test(value) || !URL.canParse(value)) {
    throw new Error("attach must be an HTTP or HTTPS server URL");
  }
  return value;
}

function buildRunArgs(o: { message: string; session?: string; latest?: boolean; fork?: boolean; model?: string; agent?: string; format?: string; title?: string; attach?: string }): string[] {
  const a = ["run"];
  if (o.attach) a.unshift("--server", o.attach);
  if (o.session) a.push("--session", o.session);
  else if (o.latest) a.push("--continue");
  if (o.fork) {
    if (!o.session) throw new Error("fork requires session");
    a.push("--fork");
  }
  if (o.model) a.push(`--model=${o.model}`);
  if (o.agent) a.push("--agent", o.agent);
  if (o.format === "json") a.push("--format", "json");
  if (o.title) a.push(`--title=${o.title.slice(0, 120)}`);
  a.push("--", o.message);
  return a;
}

function assertSafePath(v: unknown, what: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${what} must be a non-empty string`);
  if (v.includes("..") || v.length > 1024) throw new Error(`${what} looks unsafe`);
  return v;
}

function assertPort(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("port must be 1-65535");
  return n;
}

class OpencodeUsageError extends Error {}

function opencodeFailure(error: string, hint?: string) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error, ...(hint && { reason: error, hint }) }) }] };
}

function runOpencodeSync(args: string[], cwd?: string, timeoutMs = 15000): { ok: boolean; stdout: string; stderr: string; error?: string } {
  const result = spawnSync(OPENCODE_BIN, args, { cwd: cwd || process.cwd(), timeout: timeoutMs, encoding: "utf-8", shell: false, maxBuffer: 2 * 1024 * 1024, env: OPENCODE_ENV });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const usageError = opencodeUsageError(stdout, stderr);
  if (usageError) throw new OpencodeUsageError(usageError);
  return { ok: result.status === 0, stdout, stderr, error: result.error?.message };
}

function opencodeAttach(session: Session): string | undefined {
  return session.args[0] === "--server" ? session.args[1] : undefined;
}

function resolveAgentSessionId(session: Session): string | null {
  const { kind, opencodeSessionId, opencodeLookupTitle } = session.meta;
  if (kind !== "agent") return null;
  if (isOpencodeSessionId(opencodeSessionId)) return opencodeSessionId;
  if (!opencodeLookupTitle) return null;

  const command = ["session", "list", "--format", "json"];
  const attach = opencodeAttach(session);
  if (attach) command.unshift("--server", attach);
  try {
    const result = runOpencodeSync(command, session.cwd);
    if (!result.ok) return null;
    const rows: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(rows)) return null;
    const ids = new Set<string>();
    for (const row of rows) {
      if (row?.title !== opencodeLookupTitle || !isOpencodeSessionId(row.id)) continue;
      if (typeof row.directory !== "string" || !isAbsolute(row.directory)) continue;
      // OpenCode can record the project root for a run launched in a subdirectory.
      const fromDirectory = relative(row.directory, session.cwd);
      if (!isAbsolute(fromDirectory) && fromDirectory.split(sep)[0] !== "..") ids.add(row.id);
    }
    if (ids.size !== 1) return null;
    const [id] = ids;
    session.meta.opencodeSessionId = id;
    return id;
  } catch {
    return null;
  }
}

function opencodeResolutionHint(session: Session): string {
  const sources = session.meta.opencodeLookupTitle
    ? `opencode session list --format json for title ${JSON.stringify(session.meta.opencodeLookupTitle)}`
    : "PTY output for a JSON event with a valid OpenCode session ID";
  return `Searched ${sources} for tracked session ${session.id} in ${session.cwd}.`;
}

const server = new Server(
  {
    name: "menager-mcp",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const TOOLS: Tool[] = [
  {
    name: "session_spawn",
    description: "Spawns a new child PTY session, or re-attaches to a tracked one when 'sessionId' names an existing session.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        sessionId: { type: "string", description: "Re-use this id. An id already tracked by this server is an idempotent re-attach: the rendered viewport resets, local scrollback is kept, and a '[reconnected at <iso>]' marker is injected. Ignored args on re-attach." },
        persistOnClose: { type: "boolean", description: "SSH + tmux only: leave the remote tmux window running when the session is closed or the server shuts down (default false)." },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        env: { type: "object", additionalProperties: { type: "string" } },
        maxBufferLines: { type: "number" },
        terminalType: { type: "string", description: "Set to 'dumb' to avoid TUI/cursor artifacts, or 'xterm-256color' for standard colors." },
        name: { type: "string", description: "Optional logical name for this session" },
        cols: { type: "number", description: "Terminal columns (default 80)" },
        rows: { type: "number", description: "Terminal rows (default 24)" },
        ttlMs: { type: "number", description: "Optional Time-To-Live in milliseconds. Auto-closes session after it exits." },
        host: { type: "string", description: "Optional [user@]hostname. When set, the session runs the system ssh binary as its transport and 'command' is ignored." },
        remoteCommand: { type: "array", items: { type: "string" }, description: "Argv to run on the remote host (requires 'host'). Omit for an interactive login shell." },
        run_id: { type: "string", description: "P0-B4: RunStore run id to link this session to" },
        step_id: { type: "string", description: "P0-B4: RunStore step id to link this session to" }
      }
    }
  },
  {
    name: "session_resize",
    description: "Resizes the PTY terminal dimensions.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        cols: { type: "number" },
        rows: { type: "number" }
      },
      required: ["sessionId", "cols", "rows"]
    }
  },
  {
    name: "session_wait",
    description: "Blocks and waits for a session to exit, returning its exit code.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        timeoutMs: { type: "number", description: "Optional timeout in milliseconds" }
      },
      required: ["sessionId"]
    }
  },
  {
    name: "session_write",
    description: "Injects keystrokes, commands, or escape sequences into the session's standard input.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        payload: { type: "string" },
        pressEnter: { type: "boolean" },
        pressKey: { type: "string", description: "Optional special key (Ctrl+C, Ctrl+D, Enter, Tab, Escape, ArrowUp, ArrowDown)" }
      },
      required: ["sessionId", "payload"]
    }
  },
  {
    name: "session_read",
    description: "Reads buffered output from the target session: the raw/stripped line buffer ('lines', default) or the rendered terminal screen ('screen').",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        mode: { type: "string", enum: ["lines", "screen"], description: "'lines' (default) returns the ring buffer as text. 'screen' returns the @xterm/headless rendered frame as JSON — what a human would see — which is what TUIs, progress bars and full-screen apps actually need." },
        tailLines: { type: "number" },
        stripAnsi: { type: "boolean" },
        clearBuffer: { type: "boolean" },
        offsetLines: { type: "number", description: "Read lines starting from this index" },
        grepPattern: { type: "string", description: "Filter read lines by regex pattern" },
        includeScrollback: { type: "boolean", description: "screen mode only: include rows that scrolled off the viewport (default false)." },
        settleMs: { type: "number", description: "screen mode only: wait up to this long for the output stream to go quiet before snapshotting. Immediate by default; a snapshot taken at the cap reports settled:false." }
      },
      required: ["sessionId"]
    }
  },
  {
    name: "session_hook",
    description: "Awaits a specific regex pattern on the session stream with optional automated reply.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        pattern: { type: "string" },
        timeoutMs: { type: "number" },
        autoResponse: { type: "string" },
        triggerPayload: { type: "string", description: "Optional payload to write AFTER registering the hook to avoid concurrency deadlocks" }
      },
      required: ["sessionId", "pattern"]
    }
  },
  {
    name: "session_close",
    description: "Kills and removes an interactive PTY session managed by this server, freeing its memory. SSH sessions backed by tmux also get their remote window killed unless persistOnClose is set.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        persistOnClose: { type: "boolean", description: "SSH + tmux only: keep the remote tmux window alive so a later session_spawn({sessionId}) can re-attach to it." }
      },
      required: ["sessionId"]
    }
  },
  {
    name: "session_signal",
    description: "Sends a POSIX signal to the target session process.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        signal: { type: "string", enum: ["SIGINT", "SIGTERM", "SIGKILL"] }
      },
      required: ["sessionId", "signal"]
    }
  },
  {
    name: "session_info",
    description: "Returns metadata and status for a specific session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" }
      },
      required: ["sessionId"]
    }
  },
  {
    name: "session_prune",
    description: "Force deletes sessions (default: only 'exited' sessions).",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["running", "exited"] }
      }
    }
  },
  {
    name: "session_list",
    description: "Lists all active and completed interactive PTY sessions managed by this server.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "agent_spawn",
    description: "Spawn an opencode agent run (opencode run) inside a managed PTY. Native multi-agent orchestration: each agent gets its own sessionId for routing follow-ups via agent_send/agent_fork.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Initial prompt for the agent (max 8000 chars)" },
        agent: { type: "string", description: "opencode agent name (e.g. build, plan)" },
        model: { type: "string", description: "provider/model (e.g. opencode/muse-spark-1.3-free)" },
        cwd: { type: "string", description: "Working directory for the agent run" },
        title: { type: "string", description: "Session title" },
        format: { type: "string", enum: ["default", "json"], description: "OpenCode output format (JSON by default). Formatted output uses a unique suffix in the OpenCode title for routing." },
        share: { type: "boolean", description: "Legacy option. Sharing is unsupported on opencode v2." },
        attach: { type: "string", description: "Connect to a running opencode server URL (--server)" },
        name: { type: "string", description: "Logical name for routing" },
        cols: { type: "number" },
        rows: { type: "number" },
        run_id: { type: "string", description: "P0-B4: RunStore run id to link this agent to" },
        step_id: { type: "string", description: "P0-B4: RunStore step id to link this agent to" }
      },
      required: ["prompt"]
    }
  },
  {
    name: "agent_send",
    description: "Send a follow-up to a tracked agent. Writes into its running PTY or resumes its exact OpenCode session. Omit sessionId to resume the latest session in cwd.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Tracked menager session ID. Omit to resume the latest OpenCode session." },
        cwd: { type: "string", description: "Working directory when sessionId is omitted (defaults to the server's working directory)." },
        message: { type: "string" }
      },
      required: ["message"]
    }
  },
  {
    name: "agent_fork",
    description: "Fork an agent session (opencode run --session <id> --fork) into a new tracked branch session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        message: { type: "string" },
        name: { type: "string" }
      },
      required: ["sessionId", "message"]
    }
  },
  {
    name: "agent_list",
    description: "List menager agent sessions, optionally merged with live opencode session list.",
    inputSchema: {
      type: "object",
      properties: {
        includeOpencode: { type: "boolean", description: "Merge opencode session list (default true)" },
        maxCount: { type: "number", description: "Max merged opencode sessions across tracked directories (default 20, max 50)" }
      },
      required: []
    }
  },
  {
    name: "agent_info",
    description: "Inspect an agent session: metadata, resolved opencode session id, and output preview.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        tailLines: { type: "number", description: "Preview lines (default 20, max 100)" }
      },
      required: ["sessionId"]
    }
  },
  {
    name: "agent_close",
    description: "Close a tracked agent session, optionally also deleting the opencode session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        deleteOpencodeSession: { type: "boolean", description: "Also run opencode session delete" }
      },
      required: ["sessionId"]
    }
  },
  {
    name: "opencode_status",
    description: "Check opencode CLI availability, version, defined agents, and tracked session counts.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "agent_create",
    description: "Legacy tool. Agent creation is unsupported on opencode v2.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory for the agent file (defaults to global or .opencode/agent)" },
        description: { type: "string", description: "What the agent should do" },
        mode: { type: "string", enum: ["all", "primary", "subagent"] },
        permissions: { type: "string", description: "Comma-separated allow list (bash,read,edit,glob,grep,webfetch,task,todowrite,websearch,lsp,skill); omitted = denied" },
        model: { type: "string", description: "provider/model" }
      },
      required: ["description"]
    }
  },
  {
    name: "opencode_models",
    description: `List available models, optionally filtered by provider. Returns up to ${MAX_MODELS} complete rows and ${MAX_MODEL_OUTPUT} characters.`,
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string" },
        refresh: { type: "boolean", description: "Legacy option. Unsupported on opencode v2." },
        verbose: { type: "boolean", description: "Legacy option. Unsupported on opencode v2." }
      },
      required: []
    }
  },
  {
    name: "opencode_stats",
    description: "Token usage and cost statistics (opencode stats).",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Last N days (0 means today)" },
        topTools: { type: "number", description: "Show tool reliability and limit it to N rows" },
        topModels: { type: "number", description: "Show model usage and limit it to N rows" },
        project: { type: "string", description: "Filter by project ID, or use '.' for the current project" }
      },
      required: []
    }
  },
  {
    name: "opencode_export",
    description: "Export opencode session data as JSON (opencode session export <sessionID>).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        sanitize: { type: "boolean", description: "Redact sensitive transcript/file data" }
      },
      required: ["sessionId"]
    }
  },
  {
    name: "opencode_import",
    description: "Import opencode session data from a JSON file (opencode session import <file>).",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Absolute path to a session JSON file" }
      },
      required: ["file"]
    }
  },
  {
    name: "opencode_session_delete",
    description: "Delete an opencode session (opencode session delete <sessionID>). Standalone; agent_close also offers this.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" }
      },
      required: ["sessionId"]
    }
  },
  {
    name: "opencode_mcp_list",
    description: "List configured MCP servers and connection status (opencode mcp list).",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "opencode_auth_list",
    description: "List authenticated providers (opencode auth list). Read-only; names only, no secrets.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "opencode_db",
    description: "Legacy tool, restricted: direct session database inspection is unsupported on opencode v2. Use hela-genome execute_sql for the memory database.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "SQL-ish query string (max 2000 chars)" },
        format: { type: "string", enum: ["json", "tsv"] }
      },
      required: []
    }
  },
  {
    name: "opencode_server_spawn",
    description: "Spawn a long-running opencode server in a managed PTY. Use its URL as the attach input to agent_spawn.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["serve", "web", "acp"], description: "Server flavour" },
        port: { type: "number", description: "Port to listen on" },
        hostname: { type: "string", description: "Hostname to listen on" },
        name: { type: "string", description: "Logical session name" }
      },
      required: ["mode"]
    }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: TOOLS,
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  console.error(`[MCP] Tool: ${name} | Session: ${args?.sessionId || 'N/A'}`);

  try {
    switch (name) {
      case "session_spawn": {
        const { command, args: cmdArgs = [], cwd = process.cwd(), env = {}, maxBufferLines = 5000, terminalType = 'xterm-256color', name, cols, rows, ttlMs, host, remoteCommand, run_id, step_id, sessionId, persistOnClose } = args as any;
        try {
          // PTY-04: a known sessionId is an idempotent re-attach, not a new spawn.
          if (typeof sessionId === 'string' && sessionManager.hasSession(sessionId)) {
            const info = sessionManager.reattach(sessionId);
            return { content: [{ type: "text", text: JSON.stringify({ reattached: true, ...info }, null, 2) }] };
          }
          if (host === undefined && typeof command !== 'string') {
            throw new Error("session_spawn requires 'command' for a local session or 'host' for an ssh session");
          }
          if (host === undefined && remoteCommand !== undefined) {
            throw new Error("remoteCommand requires 'host'");
          }
          const meta = (run_id || step_id) ? { kind: 'pty' as const, run_id: run_id ?? null, step_id: step_id ?? null } : undefined;
          const info = sessionManager.spawn(command, cmdArgs, cwd, env, maxBufferLines, terminalType, name, cols, rows, ttlMs, meta, host === undefined ? undefined : { host, remoteCommand }, {
            sessionId: typeof sessionId === 'string' ? sessionId : undefined,
            persistOnClose: persistOnClose === true,
          });
          return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
        } catch (e: any) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: e.message || String(e) }) }] };
        }
      }
      case "session_resize": {
        const { sessionId, cols, rows } = args as any;
        const session = sessionManager.getSession(sessionId);
        session.resize(cols, rows);
        return { content: [{ type: "text", text: JSON.stringify({ sessionId, cols, rows }, null, 2) }] };
      }
      case "session_wait": {
        const { sessionId, timeoutMs } = args as any;
        const session = sessionManager.getSession(sessionId);
        try {
          const exitCode = await session.wait(timeoutMs);
          return { content: [{ type: "text", text: JSON.stringify({ sessionId, exitCode }, null, 2) }] };
        } catch (e: any) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: e.message || String(e) }) }] };
        }
      }
      case "session_write": {
        const { sessionId, payload, pressEnter = false, pressKey } = args as any;
        const session = sessionManager.getSession(sessionId);
        const bytes = await session.write(payload, pressEnter, pressKey);
        return { content: [{ type: "text", text: JSON.stringify({ sessionId, bytesWritten: bytes }, null, 2) }] };
      }
      case "session_read": {
        const { sessionId, mode = "lines", tailLines = 100, stripAnsi = true, clearBuffer = false, offsetLines, grepPattern, includeScrollback, settleMs } = args as any;
        if (mode !== "lines" && mode !== "screen") {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "mode must be 'lines' or 'screen'" }) }] };
        }
        if (mode === "lines" && includeScrollback !== undefined) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "includeScrollback requires mode 'screen'" }) }] };
        }
        if (mode === "lines" && settleMs !== undefined) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "settleMs requires mode 'screen'" }) }] };
        }
        const session = sessionManager.getSession(sessionId);
        if (mode === "screen") {
          const result = await session.readScreen({ includeScrollback: includeScrollback === true, settleMs, tailLines });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        const data = session.getLines(tailLines, stripAnsi, clearBuffer, offsetLines, grepPattern);
        return { content: [{ type: "text", text: data }] };
      }
      case "session_info": {
        const { sessionId } = args as any;
        const session = sessionManager.getSession(sessionId);
        return { content: [{ type: "text", text: JSON.stringify(session.getInfo(), null, 2) }] };
      }
      case "session_prune": {
        const { status = "exited" } = args as any;
        const count = sessionManager.prune(status);
        return { content: [{ type: "text", text: JSON.stringify({ prunedCount: count }, null, 2) }] };
      }
      case "session_hook": {
        const { sessionId, pattern, timeoutMs = 30000, autoResponse, triggerPayload } = args as any;
        const session = sessionManager.getSession(sessionId);
        let regex: RegExp;
        try {
          regex = new RegExp(pattern);
        } catch (e: any) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: `Invalid regex: ${e.message}` }) }] };
        }
        try {
          const matchedChunk = await session.hook(regex, timeoutMs, autoResponse, triggerPayload);
          return { content: [{ type: "text", text: JSON.stringify({ matched: true, matchedChunk, autoResponded: !!autoResponse }, null, 2) }] };
        } catch (e: any) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: e.message || String(e) }) }] };
        }
      }
      case "session_close": {
        const { sessionId, persistOnClose } = args as any;
        const result = sessionManager.closeSession(sessionId, { persistOnClose: persistOnClose === undefined ? undefined : persistOnClose === true });
        return { content: [{ type: "text", text: JSON.stringify({ ...result, closed: true }, null, 2) }] };
      }
      case "session_signal": {
        const { sessionId, signal } = args as any;
        const session = sessionManager.getSession(sessionId);
        session.signal(signal);
        return { content: [{ type: "text", text: JSON.stringify({ sessionId, signaled: signal }, null, 2) }] };
      }
      case "session_list": {
        const list = sessionManager.listSessions();
        return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
      }
      case "agent_spawn": {
        const { prompt: rawPrompt, agent: rawAgent, model: rawModel, cwd: rawCwd = process.cwd(), title: rawTitle, format, share, attach, name, cols, rows, run_id, step_id } = args as any;
        if (share === true) return opencodeFailure("Sharing is unsupported on opencode v2: run has no --share flag");
        const prompt = assertPrompt(rawPrompt);
        const agent = assertAgent(rawAgent);
        const model = assertModel(rawModel);
        const cwd = resolve(rawCwd);
        const title = typeof rawTitle === "string" ? rawTitle.slice(0, 120) : undefined;
        const fmt = format === "default" ? undefined : "json";
        const suffix = fmt === undefined ? ` [menager:${randomUUID()}]` : undefined;
        const opencodeLookupTitle = suffix ? (title || "Agent").slice(0, 120 - suffix.length) + suffix : undefined;
        const runArgs = buildRunArgs({ message: prompt, model, agent, format: fmt, title: opencodeLookupTitle ?? title, attach: assertServerUrl(attach) });
        const info = sessionManager.spawn(OPENCODE_BIN, runArgs, cwd, OPENCODE_ENV, 5000, "xterm-256color", name, cols, rows, undefined, {
          kind: "agent", agent, model, dir: cwd, title, opencodeLookupTitle,
          promptPreview: prompt.slice(0, 200),
          run_id: typeof run_id === "string" ? run_id : null,
          step_id: typeof step_id === "string" ? step_id : null
        });
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }
      case "agent_send": {
        const { sessionId, message: rawMessage, cwd } = args ?? {};
        const message = assertPrompt(rawMessage);
        if (sessionId === undefined) {
          const dir = cwd === undefined ? process.cwd() : resolve(assertSafePath(cwd, "cwd"));
          const runArgs = buildRunArgs({ message, latest: true, format: "json" });
          const next = sessionManager.spawn(OPENCODE_BIN, runArgs, dir, OPENCODE_ENV, 5000, "xterm-256color", undefined, undefined, undefined, undefined, {
            kind: "agent", dir, promptPreview: message.slice(0, 200)
          });
          return { content: [{ type: "text", text: JSON.stringify({ resumed: true, via: "latest", next }, null, 2) }] };
        }
        if (typeof sessionId !== "string" || !sessionManager.hasSession(sessionId)) {
          return opencodeFailure("Unknown tracked agent session ID", "Searched this menager server's tracked sessions. Use a sessionId returned by agent_spawn or agent_list.");
        }
        const session = sessionManager.getSession(sessionId);
        if (session.status === "running") {
          const bytes = await session.write(message, true);
          return { content: [{ type: "text", text: JSON.stringify({ sessionId, delivered: true, via: "pty-write", bytesWritten: bytes }, null, 2) }] };
        }
        const opencodeId = resolveAgentSessionId(session);
        if (!opencodeId) return opencodeFailure("Could not resolve the addressed OpenCode session ID", opencodeResolutionHint(session));
        const runArgs = buildRunArgs({ message, session: opencodeId, model: session.meta.model, agent: session.meta.agent, attach: opencodeAttach(session) });
        const info = sessionManager.spawn(OPENCODE_BIN, runArgs, session.cwd, OPENCODE_ENV, 5000, "xterm-256color", session.name, undefined, undefined, undefined, {
          kind: "agent", agent: session.meta.agent, model: session.meta.model, dir: session.meta.dir,
          promptPreview: message.slice(0, 200), parentSessionId: sessionId, opencodeSessionId: opencodeId,
          run_id: session.meta.run_id ?? null, step_id: session.meta.step_id ?? null
        });
        return { content: [{ type: "text", text: JSON.stringify({ resumed: true, via: "opencode-session", previousSessionId: sessionId, next: info }, null, 2) }] };
      }
      case "agent_fork": {
        const { sessionId, message: rawMessage, name } = args as any;
        const message = assertPrompt(rawMessage);
        const session = sessionManager.getSession(sessionId);
        const opencodeId = resolveAgentSessionId(session);
        if (!opencodeId) return opencodeFailure("Cannot fork without a resolved OpenCode session ID", opencodeResolutionHint(session));
        const runArgs = buildRunArgs({ message, session: opencodeId, fork: true, model: session.meta.model, agent: session.meta.agent, format: "json", attach: opencodeAttach(session) });
        const info = sessionManager.spawn(OPENCODE_BIN, runArgs, session.cwd, OPENCODE_ENV, 5000, "xterm-256color", typeof name === "string" ? name : undefined, undefined, undefined, undefined, {
          kind: "agent", agent: session.meta.agent, model: session.meta.model, dir: session.meta.dir,
          promptPreview: message.slice(0, 200), parentSessionId: sessionId,
          run_id: session.meta.run_id ?? null, step_id: session.meta.step_id ?? null
        });
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }
      case "agent_list": {
        const { includeOpencode = true, maxCount = 20 } = args ?? {};
        const tracked = sessionManager.listSessions().filter(s => s.meta?.kind === "agent");
        if (!includeOpencode) return { content: [{ type: "text", text: JSON.stringify({ tracked }, null, 2) }] };
        const n = Math.min(Math.max(Math.floor(Number(maxCount)) || 20, 1), 50);
        const directories = new Set(tracked.flatMap(s => s.meta?.dir ? [resolve(s.meta.dir)] : []));
        const sessions = new Map<string, unknown>();
        let opencodeListWarning: string | undefined;
        for (const dir of directories) {
          try {
            const r = runOpencodeSync(["session", "list", "--format", "json", "-n", String(n)], dir);
            if (!r.ok) throw new Error(r.stderr.trim() || r.error || "session list failed");
            const rows: unknown = JSON.parse(r.stdout || "[]");
            if (!Array.isArray(rows)) throw new Error("expected a session list array");
            for (const row of rows) {
              if (typeof row?.id === "string" && !sessions.has(row.id)) sessions.set(row.id, row);
            }
          } catch (error) {
            opencodeListWarning ??= `${dir}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
          }
        }
        const opencode = Array.from(sessions.values()).slice(0, n);
        return { content: [{ type: "text", text: JSON.stringify({ tracked, opencode, opencodeListWarning }, null, 2) }] };
      }
      case "agent_info": {
        const { sessionId, tailLines = 20 } = args as any;
        const session = sessionManager.getSession(sessionId);
        const n = Math.min(Math.max(Number(tailLines) || 20, 1), 100);
        const resolved = resolveAgentSessionId(session);
        return { content: [{ type: "text", text: JSON.stringify({ ...session.getInfo(), resolvedOpencodeSessionId: resolved, preview: session.getLines(n, true) }, null, 2) }] };
      }
      case "agent_close": {
        const { sessionId, deleteOpencodeSession = false } = args as any;
        const session = sessionManager.hasSession(sessionId) ? sessionManager.getSession(sessionId) : undefined;
        const opencodeSessionId = session ? resolveAgentSessionId(session) : null;
        const { closed } = sessionManager.closeSession(sessionId);
        const result = { sessionId, closed, opencodeSessionId };
        if (!deleteOpencodeSession) {
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        let opencodeSessionDeleted = false;
        let reason: string | undefined = "no opencode session id resolved";
        if (session && opencodeSessionId) {
          try {
            const command = ["session", "delete", assertOpencodeSessionId(opencodeSessionId)];
            if (session.args[0] === "--server") command.unshift(...session.args.slice(0, 2));
            const r = runOpencodeSync(command, session.meta.dir);
            opencodeSessionDeleted = r.ok;
            reason = r.ok ? undefined : (r.stderr.trim() || r.error || "opencode session delete failed").slice(0, 300);
          } catch (error) {
            reason = (error instanceof Error ? error.message : String(error)).slice(0, 300);
          }
        }
        return { content: [{ type: "text", text: JSON.stringify({
          ...result,
          opencodeSessionDeleted,
          ...(opencodeSessionId ? { opencodeDeleted: opencodeSessionDeleted } : {}),
          reason,
        }, null, 2) }] };
      }
      case "agent_create":
        return opencodeFailure("Agent creation is unsupported on opencode v2: no agent create command");
      case "opencode_models": {
        const { provider, refresh, verbose } = args ?? {};
        if (provider !== undefined && (typeof provider !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(provider))) {
          throw new Error("invalid provider");
        }
        if (refresh === true) return opencodeFailure("Model refresh is unsupported on opencode v2: models has no --refresh flag");
        if (verbose === true) return opencodeFailure("Verbose model output is unsupported on opencode v2: models has no --verbose flag");
        const r = runOpencodeSync(["models"], undefined, 60000);
        if (!r.ok) {
          return { isError: true, content: [{ type: "text", text: (r.stdout || r.stderr || r.error || "").slice(0, MAX_MODEL_OUTPUT) }] };
        }
        const models = r.stdout.split(/\r?\n/).filter(line => line && (provider === undefined || line.startsWith(`${provider}/`)));
        const output = models.slice(0, MAX_MODELS).join("\n");
        const text = output.length <= MAX_MODEL_OUTPUT
          ? output
          : output.slice(0, Math.max(0, output.lastIndexOf("\n", MAX_MODEL_OUTPUT)));
        return { content: [{ type: "text", text }] };
      }
      case "opencode_stats": {
        const { days, topTools, topModels, project } = args as any;
        const a = buildStatsArgs({
          days,
          topTools,
          topModels,
          project: project !== undefined ? assertSafePath(project, "project") : undefined,
        });
        const r = runOpencodeSync(a, undefined, 30000);
        return { content: [{ type: "text", text: (r.stdout || r.stderr || r.error || "").slice(0, 8000) }], isError: r.ok ? undefined : true };
      }
      case "opencode_export": {
        const { sessionId, sanitize } = args as any;
        const a = ["session", "export", assertOpencodeSessionId(sessionId)];
        if (sanitize === true) a.push("--sanitize");
        const r = runOpencodeSync(a, undefined, 30000);
        return { content: [{ type: "text", text: (r.stdout || r.stderr || r.error || "").slice(0, 20000) }], isError: r.ok ? undefined : true };
      }
      case "opencode_import": {
        const { file } = args as any;
        const f = assertSafePath(file, "file");
        const r = runOpencodeSync(["session", "import", "--", f], undefined, 30000);
        return { content: [{ type: "text", text: JSON.stringify({ ok: r.ok, stdout: r.stdout.slice(0, 4000), stderr: r.stderr.slice(0, 1000) }, null, 2) }], isError: r.ok ? undefined : true };
      }
      case "opencode_session_delete": {
        const sessionId = assertOpencodeSessionId(args?.sessionId);
        const r = runOpencodeSync(["session", "delete", sessionId]);
        return { content: [{ type: "text", text: JSON.stringify({ sessionId, deleted: r.ok, detail: (r.stdout || r.stderr || "").slice(0, 500) }, null, 2) }], isError: r.ok ? undefined : true };
      }
      case "opencode_mcp_list": {
        const r = runOpencodeSync(["mcp", "list"], undefined, 30000);
        return { content: [{ type: "text", text: (r.stdout || r.stderr || r.error || "").slice(0, 8000) }], isError: r.ok ? undefined : true };
      }
      case "opencode_auth_list": {
        const r = runOpencodeSync(["auth", "list"], undefined, 30000);
        return { content: [{ type: "text", text: (r.stdout || r.stderr || r.error || "").slice(0, 4000) }], isError: r.ok ? undefined : true };
      }
      case "opencode_db":
        return opencodeFailure("Database inspection is unsupported on opencode v2: no db command");
      case "opencode_server_spawn": {
        const { mode, port, hostname, name } = args as any;
        if (mode !== "serve" && mode !== "web" && mode !== "acp") throw new Error("mode must be serve|web|acp");
        const a = [mode as string];
        const p = assertPort(port);
        if (p) a.push("--port", String(p));
        if (hostname !== undefined) {
          if (typeof hostname !== "string" || !/^[a-zA-Z0-9.-]{1,253}$/.test(hostname)) throw new Error("invalid hostname");
          a.push("--hostname", hostname);
        }
        const info = sessionManager.spawn(OPENCODE_BIN, a, process.cwd(), OPENCODE_ENV, 5000, "xterm-256color", typeof name === "string" ? name.slice(0, 64) : `opencode-${mode}`, undefined, undefined, undefined, { kind: "pty", promptPreview: `opencode ${a.join(" ")}`.slice(0, 200) }, undefined, { redactServerPassword: true });
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }
      case "opencode_status": {
        const ver = runOpencodeSync(["--version"], undefined, 10000);
        let agentsOutput = "";
        if (ver.ok) {
          const agents = runOpencodeSync(["debug", "agents"], undefined, 10000);
          if (agents.ok) {
            const definitions: { id: string; name: string; mode: string }[] = JSON.parse(agents.stdout);
            // Debug output also contains provider request headers and settings.
            agentsOutput = JSON.stringify(definitions.map(({ id, name, mode }) => ({ id, name, mode })));
          }
        }
        const tracked = sessionManager.listSessions();
        const agentSessions = tracked.filter((s: any) => s.meta?.kind === "agent");
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              bin: OPENCODE_BIN,
              available: ver.ok,
              version: (ver.stdout || ver.stderr || "").trim().slice(0, 100),
              agentsOutput: agentsOutput.slice(0, 2000),
              trackedSessions: tracked.length,
              trackedAgents: agentSessions.length,
              runningAgents: agentSessions.filter((s: any) => s.status === "running").length
            }, null, 2)
          }]
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    if (error instanceof SessionExitedError) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: error.message, exitCode: error.exitCode }) }] };
    }
    if (error instanceof OpencodeUsageError) return opencodeFailure(error.message);
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: error.message || String(error) }) }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("menager MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

async function gracefulShutdown() {
  try {
    const stuck = await sessionManager.shutdown();
    if (stuck.length > 0) {
      console.error(`[MCP] shutdown deadline expired for sessions: ${stuck.join(', ')}`);
    }
  } catch (e: any) {
    console.error(`[MCP] shutdown error: ${e?.message || String(e)}`);
  }
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
