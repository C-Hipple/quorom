// The local half of Quorum, used when serve.js serves the page. It lets the page choose a project folder on this
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
//
// Claude Code runs headless with only its tools for reading and searching files. It can't edit, run commands or use
// MCP servers, it ignores the project's own settings and hooks, and anything that would need permission is denied.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { STATUSES } = require("./sessions");

const TOOLS = "Read,Grep,Glob";
const MAX_BODY = 2 * 1024 * 1024;
const MAX_DIRS = 500;

function claudeArgs(model) {
  const args = [
    "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--tools", TOOLS, "--permission-mode", "dontAsk",
    "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence",
  ];
  if (model) args.push("--model", model);
  return args;
}

// Model names and aliases only, so a model can't be read as another flag.
function validModel(m) {
  return m === "" || (typeof m === "string" && m.length <= 100 && /^[A-Za-z0-9][\w.:[\]-]*$/.test(m));
}

function findOnPath(name, env) {
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

function expandHome(p) {
  const s = String(p || "").trim();
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~" + path.sep)) return path.join(os.homedir(), s.slice(2));
  return s;
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

// The Git repository a folder belongs to, if any, and the branch it's on.
function gitOf(dir) {
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

function folderInfo(raw) {
  const p = path.resolve(expandHome(raw) || os.homedir());
  if (!isDir(p)) return null;
  let entries = [], unreadable = false;
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
function errorCode(status, kind, message) {
  const s = String(kind || "") + " " + String(message || "");
  if (/model_not_found|unrecognized_model/i.test(s) || (status === 404 && /model/i.test(s))) return "bad_model";
  if (status === 401 || status === 403 || /authentication|not logged in|\/login|invalid api key/i.test(s)) return "auth_failed";
  if (status === 402 || /billing|credit balance/i.test(s)) return "no_credits";
  if (status === 429 || status === 529 || /rate_limit|rate limit|usage limit|overloaded/i.test(s)) return "rate_limited";
  if (status === 413 || /prompt is too long|context window/i.test(s)) return "prompt_too_large";
  return "upstream_error";
}

// What a tool call was about, for the page to show while the agent explores: a file, a folder or a search pattern.
function toolDetail(input, cwd) {
  const o = input && typeof input === "object" ? input : {};
  const rel = p => {
    const r = path.relative(cwd, String(p));
    return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : String(p);
  };
  const d = typeof o.file_path === "string" ? rel(o.file_path) : typeof o.pattern === "string" ? o.pattern :
    typeof o.path === "string" ? rel(o.path) : "";
  return d.length > 120 ? d.slice(0, 119) + "…" : d;
}

// Turns Claude Code's stream-json messages into the events the page reads:
//   start {model}                     the session began on this model
//   tool  {tool, detail}              the agent used a tool, such as Read and the file it read
//   turn  {}                          the agent began a new message, so any text before it was a preamble
//   text  {delta}                     more of the current message
//   done  {text, truncated, model}    the answer, which is the agent's final message
//   error {code, message}
function createTranslator(emit, cwd) {
  let model = "", failure = "", finished = false;
  return {
    feed(m) {
      if (finished || !m || typeof m !== "object" || m.parent_tool_use_id) return;
      if (m.type === "system" && m.subtype === "init") {
        model = typeof m.model === "string" ? m.model : "";
        emit("start", { model });
      } else if (m.type === "stream_event" && m.event) {
        const e = m.event;
        if (e.type === "message_start") emit("turn", {});
        else if (e.type === "content_block_delta" && e.delta && e.delta.type === "text_delta" && e.delta.text) emit("text", { delta: e.delta.text });
      } else if (m.type === "assistant" && m.message) {
        if (m.error) failure = String(m.error);
        (m.message.content || []).forEach(c => {
          if (c && c.type === "tool_use") emit("tool", { tool: String(c.name || ""), detail: toolDetail(c.input, cwd) });
        });
      } else if (m.type === "result") {
        finished = true;
        if (m.is_error || m.subtype !== "success") {
          const message = String(m.result || (Array.isArray(m.errors) && m.errors[0]) || m.subtype || "");
          emit("error", { code: errorCode(m.api_error_status, failure || m.subtype, message), message });
        } else {
          emit("done", { text: String(m.result || ""), truncated: m.stop_reason === "max_tokens", model });
        }
      }
    },
    finished: () => finished,
  };
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function fail(res, status, code, message) {
  sendJSON(res, status, { error: { code, message } });
}

const isObject = v => !!v && typeof v === "object" && !Array.isArray(v);
const NAME = /^[A-Za-z][\w-]{0,31}$/;

// The fields of a session a request may set, checked; or a string saying what's wrong.
function sessionFields(b, creating) {
  const out = {};
  if (b.title !== undefined || creating) {
    if (typeof b.title !== "string" || !b.title.trim()) return "A session needs a title.";
    out.title = b.title.trim().slice(0, 200);
  }
  if (creating) {
    if (b.project != null && (typeof b.project !== "string" || !path.isAbsolute(b.project))) return "The project must be a full path.";
    out.project = b.project || null;
  }
  if (b.status !== undefined || creating) {
    if (STATUSES.indexOf(b.status) < 0) return "The status must be one of " + STATUSES.join(", ") + ".";
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
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// o.claude       { command, args } to run Claude Code with, or null to look for `claude` on the PATH
// o.project      the folder given on the command line, if any
// o.sessions     the database of sessions from openSessions, or null if sessions can't be saved
// o.env          the environment for Claude Code, process.env by default
function createBridge(o) {
  const sessions = o.sessions || null;
  const env = o.env || process.env;
  let claude = o.claude || null;
  let version = null;

  function locate() {
    if (claude) return claude;
    const bin = env.QUORUM_CLAUDE_BIN || findOnPath("claude", env);
    if (bin) claude = { command: bin, args: [] };
    return claude;
  }

  function claudeVersion() {
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

  function run(req, res, body) {
    const c = locate();
    if (!c) return fail(res, 503, "claude_code_missing", "Claude Code isn't installed, or isn't on the PATH.");
    const child = spawn(c.command, c.args.concat(claudeArgs(body.model)), { cwd: body.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    let ended = false, buf = "", stderr = "";
    const send = (event, data) => {
      if (!ended) res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
    };
    const end = (event, data) => {
      if (ended) return;
      send(event, data);
      ended = true;
      res.end();
    };
    const tr = createTranslator((event, data) => (event === "done" || event === "error" ? end(event, data) : send(event, data)), body.cwd);
    const feedLine = line => {
      if (!line.trim()) return;
      let m;
      try { m = JSON.parse(line); } catch (_) { return; }
      tr.feed(m);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        feedLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", s => { stderr = (stderr + s).slice(-4000); });
    child.on("error", e => {
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
    // Stopping the seat in the page closes the request, which stops Claude Code.
    res.on("close", () => {
      ended = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 3000).unref();
    });
    child.stdin.on("error", () => { /* Claude Code exited before reading the prompt; close reports it */ });
    child.stdin.end(body.prompt);
  }

  // Every request that carries a body carries JSON, so another site can't send one with a plain form.
  async function jsonBody(req, res) {
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) {
      fail(res, 415, "bad_request", "Send the request as JSON.");
      return null;
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (_) { body = undefined; }
    if (!isObject(body)) {
      fail(res, 400, "bad_request", "The request wasn't a readable JSON object.");
      return null;
    }
    return body;
  }

  async function handleSessions(req, res, parts) {
    if (!sessions) return fail(res, 503, "sessions_unavailable", "Sessions can't be saved: this Node.js has no SQLite. Use Node.js 22.13 or later.");
    const [id, sub, round, node] = parts;
    const m = req.method;
    if (!id) {
      if (m === "GET") return sendJSON(res, 200, { sessions: sessions.list(50) });
      if (m !== "POST") return fail(res, 405, "bad_request", "Not allowed.");
      const body = await jsonBody(req, res);
      if (!body) return;
      const f = sessionFields(body, true);
      if (typeof f === "string") return fail(res, 400, "bad_request", f);
      return sendJSON(res, 201, { session: sessions.create(f) });
    }
    if (!sub) {
      if (m === "GET") {
        const got = sessions.get(id);
        return got ? sendJSON(res, 200, got) : fail(res, 404, "session_missing", "There's no saved session with that id.");
      }
      if (m === "DELETE") return sessions.remove(id) ? sendJSON(res, 200, { deleted: id }) : fail(res, 404, "session_missing", "There's no saved session with that id.");
      if (m !== "PATCH") return fail(res, 405, "bad_request", "Not allowed.");
      const body = await jsonBody(req, res);
      if (!body) return;
      const f = sessionFields(body, false);
      if (typeof f === "string") return fail(res, 400, "bad_request", f);
      const session = sessions.update(id, f);
      return session ? sendJSON(res, 200, { session }) : fail(res, 404, "session_missing", "There's no saved session with that id.");
    }
    if (sub === "rounds" && node && parts.length === 4 && m === "PUT") {
      const r = Number(round);
      if (!Number.isInteger(r) || r < 1 || r > 999 || !NAME.test(node)) return fail(res, 400, "bad_request", "That isn't a round and a step.");
      const body = await jsonBody(req, res);
      if (!body) return;
      if (typeof body.kind !== "string" || !NAME.test(body.kind) || !("data" in body)) return fail(res, 400, "bad_request", "A handoff needs a kind and data.");
      return sessions.putHandoff(id, r, node, body.kind, body.data) ?
        sendJSON(res, 200, { saved: { round: r, node } }) : fail(res, 404, "session_missing", "There's no saved session with that id.");
    }
    return fail(res, 404, "not_found", "Not found.");
  }

  async function handle(req, res, url) {
    const route = url.pathname;
    if (route === "/api/local" && req.method === "GET") {
      const v = await claudeVersion();
      return sendJSON(res, 200, {
        claudeCode: { available: !!v, version: v },
        sessions: sessions ? { file: sessions.file } : null,
        project: o.project || null,
        home: os.homedir(),
      });
    }
    if (route === "/api/sessions" || route.startsWith("/api/sessions/")) {
      return handleSessions(req, res, route.split("/").slice(3).filter(Boolean).map(decodeURIComponent));
    }
    if (route === "/api/folder" && req.method === "GET") {
      const info = folderInfo(url.searchParams.get("path") || "");
      if (!info) return fail(res, 404, "project_missing", "There's no folder at " + (url.searchParams.get("path") || "that path") + ".");
      return sendJSON(res, 200, info);
    }
    if (route === "/api/claude-code" && req.method === "POST") {
      const body = await jsonBody(req, res);
      if (!body) return;
      if (typeof body.prompt !== "string" || !body.prompt.trim()) return fail(res, 400, "bad_request", "The request has no prompt.");
      body.model = typeof body.model === "string" ? body.model.trim() : "";
      if (!validModel(body.model)) return fail(res, 400, "bad_model", "That isn't a model name Claude Code accepts.");
      if (typeof body.cwd !== "string" || !path.isAbsolute(body.cwd) || !isDir(body.cwd)) {
        return fail(res, 404, "project_missing", "The project folder isn't there.");
      }
      return run(req, res, body);
    }
    return fail(res, 404, "not_found", "Not found.");
  }

  return { handle, claudeVersion, locate };
}

module.exports = { createBridge, createTranslator, claudeArgs, errorCode, folderInfo, validModel, gitOf, TOOLS };
