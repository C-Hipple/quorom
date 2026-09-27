// The local half of Quorum, used when serve.ts serves the page. It lets the page choose a project folder on this
// computer, run seats on Claude Code inside it, and save sessions so they can be picked up again.
//
//   GET    /api/local                           whether Claude Code is installed and sessions can be saved, and the
//                                               project given on the command line
//   GET    /api/folder?path=…                   a folder: its subfolders, its Git branch and whether it has a CLAUDE.md
//   POST   /api/claude-code                     { prompt, model, cwd }: runs Claude Code in cwd and streams what it does
//   GET    /api/sessions                        the saved sessions, most recent first
//   POST   /api/sessions                        { title, project, status, agents }: starts saving a new session
//   GET    /api/sessions/:id                    a session and every handoff it has made
//   PATCH  /api/sessions/:id                    { title, status, round, agents, elapsed }, any of them
//   DELETE /api/sessions/:id
//   PUT    /api/sessions/:id/rounds/:round/:node   { kind, data }: the handoff a step made in that round
//   PUT    /api/sessions/:id/rounds/:round/:node/transcripts/:attempt   { data }: one attempt's conversation with its agent
//   GET    /api/sessions/:id/rounds/:round/:node/transcripts            every attempt's conversation at that step
//   GET    /api/sessions/:id/transcripts                                every conversation in the session
//
// Claude Code runs headless with only its tools for reading and searching files. It can't edit, run commands or use
// MCP servers, it ignores the project's own settings and hooks, and anything that would need permission is denied.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATUSES, type NewSession, type SessionPatch, type Sessions, type Status } from "./sessions";

export const TOOLS = "Read,Grep,Glob";
const MAX_BODY = 2 * 1024 * 1024;
// A conversation carries the files and search results its agent read, so it can be far longer than anything else.
const MAX_TRANSCRIPT = 32 * 1024 * 1024;
export const MAX_TOOL_OUTPUT = 200000;
const MAX_DIRS = 500;

export type Env = Record<string, string | undefined>;

// How to run Claude Code: a command and the arguments that come before Quorum's own.
export interface ClaudeCommand {
  command: string;
  args: string[];
}

export interface GitInfo {
  root: string;
  branch: string | null;
  detached: string | null;
}

export interface FolderInfo {
  path: string;
  name: string;
  parent: string | null;
  dirs: { name: string, path: string }[];
  more: number;
  unreadable: boolean;
  git: GitInfo | null;
  claudeMd: boolean;
}

export interface Usage {
  turns?: number;
  costUsd?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

// Claude Code's stream-json messages are read loosely: only the fields the translator checks are relied on.
type Json = Record<string, any>;

export function claudeArgs(model?: string): string[] {
  const args = [
    "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--tools", TOOLS, "--permission-mode", "dontAsk",
    "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence",
  ];
  if (model) args.push("--model", model);
  return args;
}

// Model names and aliases only, so a model can't be read as another flag.
export function validModel(m: unknown): boolean {
  return m === "" || (typeof m === "string" && m.length <= 100 && /^[A-Za-z0-9][\w.:[\]-]*$/.test(m));
}

function findOnPath(name: string, env: Env): string | null {
  const exts = process.platform === "win32" ? String(env.PATHEXT || ".EXE").split(";") : [""];
  for (const dir of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        if (fs.statSync(file).isFile()) return file;
      } catch (_) { /* not here */ }
    }
  }
  return null;
}

function expandHome(p: string): string {
  const s = String(p || "").trim();
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~" + path.sep)) return path.join(os.homedir(), s.slice(2));
  return s;
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

// The Git repository a folder belongs to, if any, and the branch it's on.
export function gitOf(dir: string): GitInfo | null {
  for (let d = dir, i = 0; i < 64; i++) {
    const dotGit = path.join(d, ".git");
    if (fs.existsSync(dotGit)) {
      let gitDir = dotGit;
      try {
        if (fs.statSync(dotGit).isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
          if (m) gitDir = path.resolve(d, m[1].trim());
        }
        const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return { root: d, branch: ref ? ref[1] : null, detached: ref ? null : head.slice(0, 7) };
      } catch (_) {
        return { root: d, branch: null, detached: null };
      }
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

export function folderInfo(raw: string): FolderInfo | null {
  const p = path.resolve(expandHome(raw) || os.homedir());
  if (!isDir(p)) return null;
  let entries: fs.Dirent[] = [], unreadable = false;
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch (_) { unreadable = true; }
  const dirs = entries
    .filter(e => !e.name.startsWith(".") && (e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(p, e.name)))))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const parent = path.dirname(p);
  return {
    path: p,
    name: path.basename(p) || p,
    parent: parent === p ? null : parent,
    dirs: dirs.slice(0, MAX_DIRS).map(name => ({ name, path: path.join(p, name) })),
    more: Math.max(0, dirs.length - MAX_DIRS),
    unreadable,
    git: gitOf(p),
    claudeMd: ["CLAUDE.md", path.join(".claude", "CLAUDE.md")].some(f => fs.existsSync(path.join(p, f))),
  };
}

// Claude Code's errors as Quorum's error codes.
export function errorCode(status: number, kind: string, message: string): string {
  const s = String(kind || "") + " " + String(message || "");
  if (/model_not_found|unrecognized_model/i.test(s) || (status === 404 && /model/i.test(s))) return "bad_model";
  if (status === 401 || status === 403 || /authentication|not logged in|\/login|invalid api key/i.test(s)) return "auth_failed";
  if (status === 402 || /billing|credit balance/i.test(s)) return "no_credits";
  if (status === 429 || status === 529 || /rate_limit|rate limit|usage limit|overloaded/i.test(s)) return "rate_limited";
  if (status === 413 || /prompt is too long|context window/i.test(s)) return "prompt_too_large";
  return "upstream_error";
}

// What a tool call was about, for the page to show while the agent explores: a file, a folder or a search pattern.
function toolDetail(input: unknown, cwd: string): string {
  const o: Json = input && typeof input === "object" ? input : {};
  const rel = (p: string) => {
    const r = path.relative(cwd, String(p));
    return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : String(p);
  };
  const d = typeof o.file_path === "string" ? rel(o.file_path) : typeof o.pattern === "string" ? o.pattern :
    typeof o.path === "string" ? rel(o.path) : "";
  return d.length > 120 ? d.slice(0, 119) + "…" : d;
}

// What a tool gave back, as the agent read it: its text, and a placeholder for anything else, such as an image.
export function toolOutput(content: unknown): string {
  const s = typeof content === "string" ? content : Array.isArray(content) ?
    content.map((c: Json) => (c && c.type === "text" ? String(c.text || "") : c && c.type ? "[" + c.type + "]" : "")).join("\n") : "";
  return s.length > MAX_TOOL_OUTPUT ? s.slice(0, MAX_TOOL_OUTPUT) + "\n\n[Quorum kept the first " + MAX_TOOL_OUTPUT + " of " + s.length + " characters.]" : s;
}

// How long a run took and what it used, from Claude Code's result: any of turns, costUsd, durationMs, inputTokens
// (including tokens read from and written to the cache) and outputTokens, or null if it said none of them.
function usageOf(m: Json): Usage | null {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const u: Json = m.usage && typeof m.usage === "object" ? m.usage : {};
  const inputs = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].map(k => n(u[k])).filter(v => v !== null);
  const all = { turns: n(m.num_turns), costUsd: n(m.total_cost_usd), durationMs: n(m.duration_ms),
    inputTokens: inputs.length ? inputs.reduce((a, b) => a + b, 0) : null, outputTokens: n(u.output_tokens) };
  const out: Usage = {};
  (Object.keys(all) as (keyof Usage)[]).forEach(k => { const v = all[k]; if (v !== null) out[k] = v; });
  return Object.keys(out).length ? out : null;
}

// Turns Claude Code's stream-json messages into the events the page reads:
//   start       {model, tools}               the session began on this model, with these tools
//   tool        {id, tool, detail, input}    the agent used a tool, such as Read and the file it read
//   tool_result {id, content, error}         what the tool gave back
//   turn        {}                           the agent began a new message, so any text before it was a preamble
//   text        {delta}                      more of the current message
//   block       {type, text}                 a whole block of a message once it's written: "text", or "thinking"
//                                            for the agent's reasoning
//   done        {text, truncated, model, usage?}  the answer, which is the agent's final message
//   error       {code, message, usage?}
export function createTranslator(emit: (event: string, data: Json) => void, cwd: string) {
  let model = "", failure = "", finished = false;
  return {
    feed(m: Json) {
      if (finished || !m || typeof m !== "object" || m.parent_tool_use_id) return;
      if (m.type === "system" && m.subtype === "init") {
        model = typeof m.model === "string" ? m.model : "";
        emit("start", { model, tools: Array.isArray(m.tools) ? m.tools.filter((t: unknown) => typeof t === "string") : [] });
      } else if (m.type === "stream_event" && m.event) {
        const e = m.event;
        if (e.type === "message_start") emit("turn", {});
        else if (e.type === "content_block_delta" && e.delta && e.delta.type === "text_delta" && e.delta.text) emit("text", { delta: e.delta.text });
      } else if (m.type === "assistant" && m.message) {
        if (m.error) failure = String(m.error);
        (m.message.content || []).forEach((c: Json) => {
          if (!c) return;
          if (c.type === "tool_use") {
            emit("tool", { id: String(c.id || ""), tool: String(c.name || ""), detail: toolDetail(c.input, cwd), input: c.input === undefined ? null : c.input });
          } else if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
            emit("block", { type: "text", text: c.text });
          } else if (c.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim()) {
            emit("block", { type: "thinking", text: c.thinking });
          }
        });
      } else if (m.type === "user" && m.message && Array.isArray(m.message.content)) {
        m.message.content.forEach((c: Json) => {
          if (c && c.type === "tool_result") emit("tool_result", { id: String(c.tool_use_id || ""), content: toolOutput(c.content), error: !!c.is_error });
        });
      } else if (m.type === "result") {
        finished = true;
        const usage = usageOf(m), used = usage ? { usage } : {};
        if (m.is_error || m.subtype !== "success") {
          const message = String(m.result || (Array.isArray(m.errors) && m.errors[0]) || m.subtype || "");
          emit("error", Object.assign({ code: errorCode(m.api_error_status, failure || m.subtype, message), message }, used));
        } else {
          emit("done", Object.assign({ text: String(m.result || ""), truncated: m.stop_reason === "max_tokens", model }, used));
        }
      }
    },
    finished: () => finished,
  };
}

function sendJSON(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

function fail(status: number, code: string, message: string): Response {
  return sendJSON(status, { error: { code, message } });
}

const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const NAME = /^[A-Za-z][\w-]{0,31}$/;
const ATTEMPT = /^[\w-]{1,64}$/;

// The fields of a session a request may set, checked; or a string saying what's wrong.
function sessionFields(b: Json, creating: true): NewSession | string;
function sessionFields(b: Json, creating: false): SessionPatch | string;
function sessionFields(b: Json, creating: boolean): NewSession | SessionPatch | string {
  const out: Json = {};
  if (b.title !== undefined || creating) {
    if (typeof b.title !== "string" || !b.title.trim()) return "A session needs a title.";
    out.title = b.title.trim().slice(0, 200);
  }
  if (creating) {
    if (b.project != null && (typeof b.project !== "string" || !path.isAbsolute(b.project))) return "The project must be a full path.";
    out.project = b.project || null;
  }
  if (b.status !== undefined || creating) {
    if (STATUSES.indexOf(b.status as Status) < 0) return "The status must be one of " + STATUSES.join(", ") + ".";
    out.status = b.status;
  }
  if (b.round !== undefined) {
    if (!Number.isInteger(b.round) || b.round < 1 || b.round > 999) return "The round must be a whole number from 1.";
    out.round = b.round;
  }
  if (b.agents !== undefined || creating) {
    if (!isObject(b.agents)) return "The agents must be an object.";
    out.agents = b.agents;
  }
  if (b.elapsed !== undefined) {
    if (!Number.isInteger(b.elapsed) || b.elapsed < 0) return "The elapsed time must be a whole number of milliseconds.";
    out.elapsed = b.elapsed;
  }
  return out as NewSession | SessionPatch;
}

// The request's body as text, or a rejection once it's more than limit bytes.
async function readBody(req: Request, limit: number): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    size += step.value.byteLength;
    if (size > limit) {
      reader.cancel().catch(() => {});
      throw new Error("too large");
    }
    chunks.push(step.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// o.claude       { command, args } to run Claude Code with, or null to look for `claude` on the PATH
// o.project      the folder given on the command line, if any
// o.sessions     the database of sessions from openSessions, or null if sessions can't be saved
// o.env          the environment for Claude Code, process.env by default
export interface BridgeOptions {
  claude?: ClaudeCommand | null;
  project?: string | null;
  sessions?: Sessions | null;
  env?: Env;
}

export type Bridge = ReturnType<typeof createBridge>;

export function createBridge(o: BridgeOptions) {
  const sessions = o.sessions || null;
  const env = o.env || process.env;
  let claude = o.claude || null;
  let version: string | null = null;

  function locate(): ClaudeCommand | null {
    if (claude) return claude;
    const bin = env.QUORUM_CLAUDE_BIN || findOnPath("claude", env);
    if (bin) claude = { command: bin, args: [] };
    return claude;
  }

  function claudeVersion(): Promise<string | null> {
    const c = locate();
    if (!c) return Promise.resolve(null);
    if (version) return Promise.resolve(version);
    return new Promise(resolve => {
      execFile(c.command, c.args.concat(["--version"]), { timeout: 15000, env }, (err, stdout) => {
        const v = err ? null : (String(stdout).trim().split(/\s+/)[0] || "unknown");
        if (v) version = v;
        resolve(v);
      });
    });
  }

  function run(req: Request, body: { prompt: string, model: string, cwd: string }): Response {
    const c = locate();
    if (!c) return fail(503, "claude_code_missing", "Claude Code isn't installed, or isn't on the PATH.");
    const child = spawn(c.command, c.args.concat(claudeArgs(body.model)), { cwd: body.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const encoder = new TextEncoder();
    let out: ReadableStreamDefaultController<Uint8Array>;
    let ended = false, buf = "", stderr = "";
    const send = (event: string, data: Json) => {
      if (!ended) out.enqueue(encoder.encode("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"));
    };
    // Once the page has its answer, or has closed the request to stop the seat, Claude Code is stopped if it's still
    // running.
    const stop = () => {
      ended = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 3000).unref();
    };
    const end = (event: string, data: Json) => {
      if (ended) return;
      send(event, data);
      out.close();
      stop();
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { out = controller; },
      cancel: stop,
    });
    req.signal.addEventListener("abort", stop);
    const tr = createTranslator((event, data) => (event === "done" || event === "error" ? end(event, data) : send(event, data)), body.cwd);
    const feedLine = (line: string) => {
      if (!line.trim()) return;
      let m;
      try { m = JSON.parse(line); } catch (_) { return; }
      tr.feed(m);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        feedLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (s: string) => { stderr = (stderr + s).slice(-4000); });
    child.on("error", (e: NodeJS.ErrnoException) => {
      end("error", e && e.code === "ENOENT" ?
        { code: "claude_code_missing", message: "Claude Code isn't installed, or isn't on the PATH." } :
        { code: "upstream_error", message: String((e && e.message) || e) });
    });
    child.on("close", code => {
      feedLine(buf);
      buf = "";
      const last = stderr.trim().split("\n").pop() || "";
      end("error", { code: errorCode(0, "", stderr), message: last || "Claude Code stopped without an answer (exit code " + code + ")." });
    });
    child.stdin.on("error", () => { /* Claude Code exited before reading the prompt; close reports it */ });
    child.stdin.end(body.prompt);
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
  }

  // Every request that carries a body carries JSON, so another site can't send one with a plain form. Resolves the
  // body, or the response that says what's wrong with it.
  async function jsonBody(req: Request, limit?: number): Promise<Json | Response> {
    if (!/^application\/json\b/i.test(req.headers.get("content-type") || "")) return fail(415, "bad_request", "Send the request as JSON.");
    let body, raw;
    try {
      raw = await readBody(req, limit || MAX_BODY);
    } catch (_) {
      return fail(413, "too_large", "The request was too large.");
    }
    try { body = JSON.parse(raw); } catch (_) { body = undefined; }
    if (!isObject(body)) return fail(400, "bad_request", "The request wasn't a readable JSON object.");
    return body;
  }

  async function handleSessions(req: Request, parts: string[]): Promise<Response> {
    if (!sessions) return fail(503, "sessions_unavailable", "Sessions can't be saved: the server was started without a database.");
    const [id, sub, round, node, part, attempt] = parts;
    const m = req.method;
    if (!id) {
      if (m === "GET") return sendJSON(200, { sessions: sessions.list(50) });
      if (m !== "POST") return fail(405, "bad_request", "Not allowed.");
      const body = await jsonBody(req);
      if (body instanceof Response) return body;
      const f = sessionFields(body, true);
      if (typeof f === "string") return fail(400, "bad_request", f);
      return sendJSON(201, { session: sessions.create(f) });
    }
    if (!sub) {
      if (m === "GET") {
        const got = sessions.get(id);
        return got ? sendJSON(200, got) : fail(404, "session_missing", "There's no saved session with that id.");
      }
      if (m === "DELETE") return sessions.remove(id) ? sendJSON(200, { deleted: id }) : fail(404, "session_missing", "There's no saved session with that id.");
      if (m !== "PATCH") return fail(405, "bad_request", "Not allowed.");
      const body = await jsonBody(req);
      if (body instanceof Response) return body;
      const f = sessionFields(body, false);
      if (typeof f === "string") return fail(400, "bad_request", f);
      const session = sessions.update(id, f);
      return session ? sendJSON(200, { session }) : fail(404, "session_missing", "There's no saved session with that id.");
    }
    if (sub === "transcripts" && parts.length === 2 && m === "GET") {
      const all = sessions.transcripts(id);
      return all ? sendJSON(200, { transcripts: all }) : fail(404, "session_missing", "There's no saved session with that id.");
    }
    if (sub === "rounds" && part === "transcripts" && parts.length >= 5) {
      const r = Number(round);
      if (!Number.isInteger(r) || r < 1 || r > 999 || !NAME.test(node)) return fail(400, "bad_request", "That isn't a round and a step.");
      if (parts.length === 5 && m === "GET") {
        const some = sessions.transcripts(id, r, node);
        return some ? sendJSON(200, { transcripts: some }) : fail(404, "session_missing", "There's no saved session with that id.");
      }
      if (parts.length !== 6 || m !== "PUT") return fail(405, "bad_request", "Not allowed.");
      if (!ATTEMPT.test(attempt)) return fail(400, "bad_request", "That isn't an attempt.");
      const body = await jsonBody(req, MAX_TRANSCRIPT);
      if (body instanceof Response) return body;
      if (!isObject(body.data) || !Array.isArray(body.data.entries)) return fail(400, "bad_request", "A conversation needs its entries.");
      return sessions.putTranscript(id, r, node, attempt, body.data) ?
        sendJSON(200, { saved: { round: r, node, attempt } }) : fail(404, "session_missing", "There's no saved session with that id.");
    }
    if (sub === "rounds" && node && parts.length === 4 && m === "PUT") {
      const r = Number(round);
      if (!Number.isInteger(r) || r < 1 || r > 999 || !NAME.test(node)) return fail(400, "bad_request", "That isn't a round and a step.");
      const body = await jsonBody(req);
      if (body instanceof Response) return body;
      if (typeof body.kind !== "string" || !NAME.test(body.kind) || !("data" in body)) return fail(400, "bad_request", "A handoff needs a kind and data.");
      return sessions.putHandoff(id, r, node, body.kind, body.data) ?
        sendJSON(200, { saved: { round: r, node } }) : fail(404, "session_missing", "There's no saved session with that id.");
    }
    return fail(404, "not_found", "Not found.");
  }

  async function handle(req: Request, url: URL): Promise<Response> {
    const route = url.pathname;
    if (route === "/api/local" && req.method === "GET") {
      const v = await claudeVersion();
      return sendJSON(200, {
        claudeCode: { available: !!v, version: v },
        sessions: sessions ? { file: sessions.file } : null,
        project: o.project || null,
        home: os.homedir(),
      });
    }
    if (route === "/api/sessions" || route.startsWith("/api/sessions/")) {
      return handleSessions(req, route.split("/").slice(3).filter(Boolean).map(decodeURIComponent));
    }
    if (route === "/api/folder" && req.method === "GET") {
      const info = folderInfo(url.searchParams.get("path") || "");
      if (!info) return fail(404, "project_missing", "There's no folder at " + (url.searchParams.get("path") || "that path") + ".");
      return sendJSON(200, info);
    }
    if (route === "/api/claude-code" && req.method === "POST") {
      const body = await jsonBody(req);
      if (body instanceof Response) return body;
      if (typeof body.prompt !== "string" || !body.prompt.trim()) return fail(400, "bad_request", "The request has no prompt.");
      body.model = typeof body.model === "string" ? body.model.trim() : "";
      if (!validModel(body.model)) return fail(400, "bad_model", "That isn't a model name Claude Code accepts.");
      if (typeof body.cwd !== "string" || !path.isAbsolute(body.cwd) || !isDir(body.cwd)) {
        return fail(404, "project_missing", "The project folder isn't there.");
      }
      return run(req, body as { prompt: string, model: string, cwd: string });
    }
    return fail(404, "not_found", "Not found.");
  }

  return { handle, claudeVersion, locate };
}
