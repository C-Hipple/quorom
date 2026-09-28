// The local half of Quorum, used when serve.ts serves the page. It lets the page choose a project folder on this
// computer, run seats as agents inside it, and save sessions so they can be picked up again.
//
//   GET    /api/local                           whether Claude Code is installed and sessions can be saved, and the
//                                               project given on the command line
//   GET    /api/folder?path=…                   a folder: its subfolders, its Git branch and whether it has a CLAUDE.md
//                                               or an AGENTS.md
//   POST   /api/agent                           { provider, prompt, model, cwd, key?, url? }: runs the seat as an agent
//                                               in cwd, on the harness for its provider, and streams what it does
//   POST   /api/models                          { url, key? }: the models an OpenAI-compatible endpoint offers
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
// Each provider that runs on this computer has a harness (see harness/harness.ts): Claude Code runs `claude -p`, and
// OpenRouter and other OpenAI-compatible endpoints run on Quorum's own agent loop. Every harness can only read and
// search the project's files, and the page reads them all the same way.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Core } from "./src/core";
import { createAgentLoop } from "./harness/agent-loop";
import { createClaudeCode, type ClaudeCommand, type Env } from "./harness/claude-code";
import type { AgentEvent, AgentTask, Harness } from "./harness/harness";
import { STATUSES, type NewSession, type SessionPatch, type Sessions, type Status } from "./sessions";

export type { ClaudeCommand, Env };

const MAX_BODY = 2 * 1024 * 1024;
// A conversation carries the files and search results its agent read, so it can be far longer than anything else.
const MAX_TRANSCRIPT = 32 * 1024 * 1024;
const MAX_DIRS = 500;
export const OPENROUTER_URL = "https://openrouter.ai/api/v1";

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
  agentsMd: boolean;
}

// Request bodies are read loosely: only the fields checked are relied on.
type Json = Record<string, any>;

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
    agentsMd: fs.existsSync(path.join(p, "AGENTS.md")),
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
// o.openrouter   OpenRouter's API address, which tests point elsewhere
// o.harnesses    harnesses to use in place of the usual ones, by provider
export interface BridgeOptions {
  claude?: ClaudeCommand | null;
  project?: string | null;
  sessions?: Sessions | null;
  env?: Env;
  openrouter?: string;
  harnesses?: Partial<Record<Provider, Harness>>;
}

// The providers whose agents run on this computer.
export type Provider = "claude-code" | "openrouter" | "custom";

export type Bridge = ReturnType<typeof createBridge>;

// Streams a harness's events to the page as server-sent events, until the run ends or the page closes the request.
function stream(req: Request, harness: Harness, task: Omit<AgentTask, "signal">): Response {
  const encoder = new TextEncoder();
  const stop = new AbortController();
  let out: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    out.close();
  };
  const emit = (event: AgentEvent, data: Record<string, unknown>) => {
    if (ended) return;
    out.enqueue(encoder.encode("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"));
    if (event === "done" || event === "error") end();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) { out = controller; },
    cancel() { ended = true; stop.abort(); },
  });
  req.signal.addEventListener("abort", () => { ended = true; stop.abort(); });
  harness.run(Object.assign({ signal: stop.signal }, task), emit).then(() => {
    emit("error", { code: "upstream_error", message: "The agent stopped without an answer." });
    // Whatever the run left behind is stopped once the page has its answer.
    stop.abort();
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}

// An http or https address, or null.
function httpUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v.trim());
    return /^https?:$/.test(u.protocol) ? v.trim() : null;
  } catch (_) {
    return null;
  }
}

export function createBridge(o: BridgeOptions) {
  const sessions = o.sessions || null;
  const claudeCode = createClaudeCode({ claude: o.claude, env: o.env });
  const harnesses: Record<Provider, Harness> = Object.assign({
    "claude-code": claudeCode.harness,
    openrouter: createAgentLoop({ headers: { "X-Title": "Quorum" }, body: { usage: { include: true } } }),
    custom: createAgentLoop(),
  }, o.harnesses);

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
      const v = await claudeCode.claudeVersion();
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
    if (route === "/api/agent" && req.method === "POST") {
      const body = await jsonBody(req);
      if (body instanceof Response) return body;
      const provider = body.provider as Provider;
      const harness = typeof provider === "string" && Object.prototype.hasOwnProperty.call(harnesses, provider) ? harnesses[provider] : null;
      if (!harness) return fail(400, "bad_request", "That isn't a provider that runs on this computer.");
      if (typeof body.prompt !== "string" || !body.prompt.trim()) return fail(400, "bad_request", "The request has no prompt.");
      const model = typeof body.model === "string" ? body.model.trim() : "";
      const wrong = harness.checkModel(model);
      if (wrong) return fail(400, "bad_model", wrong);
      if (typeof body.cwd !== "string" || !path.isAbsolute(body.cwd) || !isDir(body.cwd)) {
        return fail(404, "project_missing", "The project folder isn't there.");
      }
      let endpoint;
      if (provider === "claude-code") {
        if (!claudeCode.locate()) return fail(503, "claude_code_missing", "Claude Code isn't installed, or isn't on the PATH.");
      } else if (provider === "openrouter") {
        if (typeof body.key !== "string" || !body.key.trim()) return fail(400, "missing_key", "No OpenRouter API key.");
        endpoint = { url: o.openrouter || OPENROUTER_URL, key: body.key.trim() };
      } else {
        const url = httpUrl(body.url);
        if (!url) return fail(400, "not_found", "No address for the endpoint.");
        endpoint = { url, key: typeof body.key === "string" ? body.key.trim() : "" };
      }
      return stream(req, harness, { prompt: body.prompt, model, cwd: body.cwd, endpoint });
    }
    if (route === "/api/models" && req.method === "POST") {
      const body = await jsonBody(req);
      if (body instanceof Response) return body;
      const url = httpUrl(body.url);
      if (!url) return fail(400, "not_found", "No address for the endpoint.");
      const key = typeof body.key === "string" ? body.key.trim() : "";
      let res: Response, text = "";
      try {
        res = await fetch(url.replace(/\/+$/, "") + "/models", { headers: key ? { Authorization: "Bearer " + key } : {} });
        text = await res.text();
      } catch (e) {
        return fail(502, "unreachable", String((e as Error)?.message || e));
      }
      if (!res.ok) {
        const detail = Core.errorMessageFrom(text);
        return fail(502, Core.httpErrorCode(res.status, detail), detail || "The endpoint answered " + res.status + ".");
      }
      let data;
      try { data = JSON.parse(text); } catch (_) { return fail(502, "bad_request", "The model list wasn't JSON."); }
      const list: Json[] = Array.isArray(data) ? data : Array.isArray(data && data.data) ? data.data : [];
      return sendJSON(200, { models: list.filter(m => m && typeof m.id === "string").map(m => ({ id: m.id, name: typeof m.name === "string" ? m.name : "" })) });
    }
    return fail(404, "not_found", "Not found.");
  }

  return { handle, claudeVersion: claudeCode.claudeVersion, harnesses };
}
