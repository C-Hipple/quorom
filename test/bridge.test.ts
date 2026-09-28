// Tests for serve.ts and the local bridge, with a stand-in for Claude Code.
import { afterAll, test } from "bun:test";
import { Database } from "bun:sqlite";
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { folderInfo, type FolderInfo } from "../bridge";
import { claudeArgs, createTranslator, errorCode, validModel } from "../harness/claude-code";
import { MAX_TOOL_OUTPUT, toolOutput, type Harness } from "../harness/harness";
import { startServer, type QuorumServer, type ServerOptions } from "../serve";
import { fakeOpenAI, seatAgent } from "./fake-openai";

const FAKE = { command: process.execPath, args: [path.join(import.meta.dir, "fake-claude.ts")] };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quorum-bridge-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "docs"));
  fs.mkdirSync(path.join(dir, ".hidden"));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/feature/login\n");
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Notes\n");
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# How the app is built\nOne file, src/app.js.\n");
  fs.writeFileSync(path.join(dir, "src", "app.js"), "// app\n");
  return fs.realpathSync(dir);
}

async function listen(opts?: ServerOptions): Promise<QuorumServer> {
  return startServer(Object.assign({ claude: FAKE, port: 0 }, opts));
}

interface Request {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  // Hears the body so far as it arrives.
  onData?: (body: string, req: http.ClientRequest) => void;
  // The test closes the request itself, so it ending early isn't a failure.
  allowAbort?: boolean;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  aborted?: boolean;
}

function request(server: QuorumServer, o: Request): Promise<Reply> {
  const port = server.port;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, method: o.method || "GET", path: o.path,
      headers: Object.assign({ Host: "localhost:" + port }, o.headers || {}),
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", c => { body += c; if (o.onData) o.onData(body, req); });
      res.on("end", () => resolve({ status: res.statusCode as number, headers: res.headers, body }));
      res.on("error", e => (o.allowAbort ? resolve({ status: 0, headers: {}, body, aborted: true }) : reject(e)));
    });
    req.on("error", e => (o.allowAbort ? resolve({ status: 0, headers: {}, body: "", aborted: true }) : reject(e)));
    if (o.body !== undefined) req.write(typeof o.body === "string" ? o.body : JSON.stringify(o.body));
    req.end();
  });
}

function events(body: string): { event: string, data: any }[] {
  return body.split("\n\n").filter(Boolean).map(block => {
    const ev = /^event: (.+)$/m.exec(block);
    const data = /^data: (.+)$/m.exec(block);
    return { event: ev ? ev[1] : "message", data: data ? JSON.parse(data[1]) : null };
  });
}

// A seat for an agent on the server, on Claude Code unless the body names another provider.
const post = (server: QuorumServer, body: unknown, headers?: Record<string, string>) => request(server, {
  method: "POST", path: "/api/agent", body: body && typeof body === "object" ? Object.assign({ provider: "claude-code" }, body) : body,
  headers: Object.assign({ "Content-Type": "application/json", Origin: "http://localhost:" + server.port }, headers || {}),
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

const project = tmpProject();

test("Claude Code runs read-only, without MCP servers or the project's settings", async () => {
  const args = claudeArgs("opus");
  const flag = (f: string) => args[args.indexOf(f) + 1];
  assert.strictEqual(flag("--tools"), "Read,Grep,Glob");
  assert.strictEqual(flag("--permission-mode"), "dontAsk");
  assert.strictEqual(flag("--setting-sources"), "user");
  assert.strictEqual(flag("--output-format"), "stream-json");
  assert.strictEqual(flag("--model"), "opus");
  assert.ok(args.includes("--strict-mcp-config") && args.includes("--no-session-persistence") && args.includes("-p"));
  assert.ok(!claudeArgs("").includes("--model"), "no model means Claude Code's default");
  assert.ok(validModel("") && validModel("sonnet") && validModel("claude-opus-5-5") && validModel("opus[1m]"));
  assert.ok(!validModel("--dangerously-skip-permissions") && !validModel("-x") && !validModel("a b") && !validModel(3));
});

test("stream-json becomes the page's events", async () => {
  const got: unknown[] = [];
  const tr = createTranslator((event, data) => got.push([event, data]), "/p");
  tr.feed({ type: "system", subtype: "init", model: "claude-opus-5-5", tools: ["Read", "Grep", 3] });
  tr.feed({ type: "stream_event", event: { type: "message_start" } });
  tr.feed({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } });
  tr.feed({ type: "assistant", message: { content: [{ type: "thinking", thinking: "Read the code first.", signature: "s" }] } });
  tr.feed({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } } });
  tr.feed({ type: "assistant", message: { content: [{ type: "text", text: "Hi" }, { type: "text", text: "  " }] } });
  tr.feed({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/p/src/a.js" } }, { type: "tool_use", id: "t2", name: "Grep", input: { pattern: "TODO" } }, { type: "tool_use", id: "t3", name: "Read", input: { file_path: "/elsewhere/b.js" } }] } });
  tr.feed({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "t1", content: "const a = 1;\n" },
    { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "src/a.js:3: TODO" }, { type: "image" }] },
    { type: "tool_result", tool_use_id: "t3", content: "Permission denied", is_error: true },
  ] } });
  tr.feed({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t9", content: "from a subagent" }] }, parent_tool_use_id: "t8" });
  tr.feed({ type: "stream_event", event: { type: "message_start" } }, );
  // Each message says what it used as it streams, so the page can count while the run goes on.
  tr.feed({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 1 } } } });
  tr.feed({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 25 } } });
  tr.feed({
    type: "result", subtype: "success", is_error: false, stop_reason: "max_tokens", result: "# Plan",
    num_turns: 3, total_cost_usd: 0.5, duration_ms: 9000, usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 40 },
  });
  tr.feed({ type: "result", subtype: "success", result: "ignored after the end" });
  assert.deepStrictEqual(got, [
    ["start", { model: "claude-opus-5-5", tools: ["Read", "Grep"] }], ["turn", {}],
    ["block", { type: "thinking", text: "Read the code first." }],
    ["text", { delta: "Hi" }], ["block", { type: "text", text: "Hi" }],
    ["tool", { id: "t1", tool: "Read", detail: "src/a.js", input: { file_path: "/p/src/a.js" } }],
    ["tool", { id: "t2", tool: "Grep", detail: "TODO", input: { pattern: "TODO" } }],
    ["tool", { id: "t3", tool: "Read", detail: "/elsewhere/b.js", input: { file_path: "/elsewhere/b.js" } }],
    ["tool_result", { id: "t1", content: "const a = 1;\n", error: false }],
    ["tool_result", { id: "t2", content: "src/a.js:3: TODO\n[image]", error: false }],
    ["tool_result", { id: "t3", content: "Permission denied", error: true }],
    ["turn", {}],
    ["turn", {}], ["usage", { turns: 1, inputTokens: 100, outputTokens: 1 }], ["usage", { turns: 1, inputTokens: 100, outputTokens: 25 }],
    ["done", { text: "# Plan", truncated: true, model: "claude-opus-5-5", usage: { turns: 3, costUsd: 0.5, durationMs: 9000, inputTokens: 115, outputTokens: 40 } }],
  ]);
  assert.ok(tr.finished());
});

test("a tool's result is kept whole up to a limit", async () => {
  assert.strictEqual(toolOutput("abc"), "abc");
  assert.strictEqual(toolOutput(undefined), "");
  const long = toolOutput("x".repeat(MAX_TOOL_OUTPUT + 5));
  assert.ok(long.startsWith("x".repeat(MAX_TOOL_OUTPUT) + "\n\n[Quorum kept the first " + MAX_TOOL_OUTPUT + " of " + (MAX_TOOL_OUTPUT + 5) + " characters.]"));
});

test("Claude Code's errors become Quorum's error codes", async () => {
  assert.strictEqual(errorCode(404, "model_not_found", "There's an issue with the selected model"), "bad_model");
  assert.strictEqual(errorCode(401, "", ""), "auth_failed");
  assert.strictEqual(errorCode(0, "", "Invalid API key · Please run /login"), "auth_failed");
  assert.strictEqual(errorCode(0, "billing_error", ""), "no_credits");
  assert.strictEqual(errorCode(429, "", ""), "rate_limited");
  assert.strictEqual(errorCode(0, "", "Claude AI usage limit reached"), "rate_limited");
  assert.strictEqual(errorCode(0, "", "Prompt is too long"), "prompt_too_large");
  assert.strictEqual(errorCode(500, "error_during_execution", "boom"), "upstream_error");
});

test("a folder lists its subfolders, its Git branch and whether it has a CLAUDE.md", async () => {
  const info = folderInfo(project) as FolderInfo;
  assert.strictEqual(info.path, project);
  assert.strictEqual(info.name, path.basename(project));
  assert.strictEqual(info.parent, path.dirname(project));
  assert.deepStrictEqual(info.dirs, [{ name: "docs", path: path.join(project, "docs") }, { name: "src", path: path.join(project, "src") }], "hidden folders are left out");
  assert.deepStrictEqual(info.git, { root: project, branch: "feature/login", detached: null });
  assert.strictEqual(info.claudeMd, true);
  assert.strictEqual(info.agentsMd, true);
  const sub = folderInfo(path.join(project, "src")) as FolderInfo;
  assert.strictEqual(sub.git!.root, project, "a subfolder belongs to the repository above it");
  assert.strictEqual(sub.claudeMd, false);
  assert.strictEqual(sub.agentsMd, false);
  assert.strictEqual(folderInfo(path.join(project, "nope")), null);
  assert.strictEqual(folderInfo(path.join(project, "src", "app.js")), null, "a file isn't a folder");
  assert.strictEqual(folderInfo("~")!.path, os.homedir());
});

const server = await listen({ project });
const port = server.port;
afterAll(async () => {
  await server.stop();
  fs.rmSync(project, { recursive: true, force: true });
});

test("the page learns whether Claude Code is installed, and the project it started with", async () => {
  const r = await request(server, { path: "/api/local" });
  assert.strictEqual(r.status, 200);
  const o = JSON.parse(r.body);
  assert.deepStrictEqual(o.claudeCode, { available: true, version: "9.9.9" });
  assert.strictEqual(o.project, project);
  const f = await request(server, { path: "/api/folder?path=" + encodeURIComponent(project) });
  assert.strictEqual(JSON.parse(f.body).git.branch, "feature/login");
  const missing = await request(server, { path: "/api/folder?path=" + encodeURIComponent(path.join(project, "nope")) });
  assert.strictEqual(missing.status, 404);
  assert.strictEqual(JSON.parse(missing.body).error.code, "project_missing");
});

test("only the page itself can use the bridge", async () => {
  assert.strictEqual((await request(server, { path: "/api/local", headers: { Host: "evil.example:" + port } })).status, 403, "DNS rebinding");
  assert.strictEqual((await request(server, { path: "/api/local", headers: { Origin: "https://evil.example" } })).status, 403, "another site");
  assert.strictEqual((await post(server, { prompt: "x", cwd: project }, { Origin: "http://evil.example" })).status, 403);
  const form = await post(server, "prompt=x", { "Content-Type": "text/plain" });
  assert.strictEqual(form.status, 415, "a simple cross-site form post can't start a run");
  assert.strictEqual((await request(server, { path: "/api/local", headers: { Host: "127.0.0.1:" + port, Origin: "http://127.0.0.1:" + port } })).status, 200);
  const page = await request(server, { path: "/" });
  assert.strictEqual(page.status, 200, "the page is still served");
});

test("a seat runs Claude Code inside the project folder and streams what it does", async () => {
  const r = await post(server, { prompt: "Propose something.", model: "sonnet", cwd: project });
  assert.strictEqual(r.status, 200);
  assert.ok(/text\/event-stream/.test(r.headers["content-type"] || ""));
  const evs = events(r.body);
  const answer = evs.slice(8, -2);
  assert.ok(answer.length > 1, "the answer streams in pieces");
  assert.deepStrictEqual(evs.map(e => e.event), ["start", "turn", "block", "text", "block", "tool", "tool_result", "turn"]
    .concat(answer.map(() => "text"), ["block", "done"]));
  assert.deepStrictEqual(evs[0].data, { model: "claude-sonnet-fake", tools: ["Glob", "Grep", "Read"] });
  assert.deepStrictEqual(evs[2].data, { type: "thinking", text: "I should read the app first." });
  assert.deepStrictEqual(evs[4].data, { type: "text", text: "Let me look first." });
  assert.deepStrictEqual(evs[5].data, { id: "t1", tool: "Read", detail: path.join("src", "app.js"), input: { file_path: path.join(project, "src", "app.js") } });
  assert.deepStrictEqual(evs[6].data, { id: "t1", content: "// app\n", error: false }, "what the file held");
  const done = evs[evs.length - 1].data;
  assert.ok(done.text.startsWith("# Fake answer"));
  assert.deepStrictEqual(evs[evs.length - 2].data, { type: "text", text: done.text });
  assert.deepStrictEqual(done.usage, { turns: 2, costUsd: 0.0123, durationMs: 1500, inputTokens: 1200, outputTokens: 300 });
  const ran = JSON.parse(done.text.split("\n\n")[1]);
  assert.strictEqual(ran.cwd, project, "Claude Code runs inside the project");
  assert.strictEqual(ran.prompt, "Propose something.", "the prompt goes in on stdin");
  assert.deepStrictEqual(ran.args, claudeArgs("sonnet"));
  assert.strictEqual(answer.map(e => e.data.delta).join(""), done.text);
});

test("requests Claude Code can't run are turned away before it starts", async () => {
  const noFolder = await post(server, { prompt: "x", cwd: path.join(project, "gone") });
  assert.strictEqual(noFolder.status, 404);
  assert.strictEqual(JSON.parse(noFolder.body).error.code, "project_missing");
  assert.strictEqual((await post(server, { prompt: "x", cwd: "relative/path" })).status, 404);
  const flag = await post(server, { prompt: "x", cwd: project, model: "--dangerously-skip-permissions" });
  assert.strictEqual(flag.status, 400);
  assert.strictEqual(JSON.parse(flag.body).error.code, "bad_model");
  assert.strictEqual((await post(server, { cwd: project })).status, 400);
  assert.strictEqual((await post(server, "{not json")).status, 400);
});

test("Claude Code's failures reach the page as error events", async () => {
  const auth = events((await post(server, { prompt: "FAKE:auth", cwd: project })).body);
  assert.deepStrictEqual(auth[auth.length - 1], { event: "error", data: { code: "auth_failed", message: "Invalid API key · Please run /login" } });
  const crash = events((await post(server, { prompt: "FAKE:crash", cwd: project })).body);
  assert.deepStrictEqual(crash[crash.length - 1], { event: "error", data: { code: "upstream_error", message: "fatal: the fake crashed" } });
});

test("closing the request stops Claude Code", async () => {
  const pidFile = path.join(project, "pid");
  const s2 = await listen({ env: Object.assign({}, process.env, { FAKE_PID_FILE: pidFile }) });
  const p2 = s2.port;
  let pid = 0;
  await request(s2, {
    method: "POST", path: "/api/agent", allowAbort: true,
    body: { provider: "claude-code", prompt: "FAKE:slow", cwd: project },
    headers: { "Content-Type": "application/json", Host: "localhost:" + p2 },
    onData: (body, req) => {
      if (/Starting/.test(body) && !pid) {
        pid = Number(fs.readFileSync(pidFile, "utf8").trim());
        assert.ok(alive(pid));
        req.destroy();
      }
    },
  });
  for (let i = 0; i < 100 && alive(pid); i++) await sleep(20);
  assert.ok(pid && !alive(pid), "the process ended");
  await s2.stop();
});

test("without Claude Code, the page is told it isn't available", async () => {
  const s3 = await listen({ claude: null, env: { PATH: path.join(project, "empty") } });
  const o = JSON.parse((await request(s3, { path: "/api/local" })).body);
  assert.deepStrictEqual(o.claudeCode, { available: false, version: null });
  assert.strictEqual(o.project, null);
  const r = await request(s3, {
    method: "POST", path: "/api/agent", body: { provider: "claude-code", prompt: "x", cwd: project },
    headers: { "Content-Type": "application/json", Host: "localhost:" + s3.port },
  });
  assert.strictEqual(r.status, 503);
  assert.strictEqual(JSON.parse(r.body).error.code, "claude_code_missing");
  await s3.stop();
});

test("OpenRouter and other endpoints run on Quorum's agent loop inside the project folder", async () => {
  const service = fakeOpenAI(seatAgent);
  const srv = await listen({ project, openrouter: service.url });
  const r = await post(srv, { provider: "openrouter", key: " sk-or-test ", model: "z-ai/glm-5.3", prompt: "You are The Pragmatist. Propose.", cwd: project });
  assert.strictEqual(r.status, 200);
  const evs = events(r.body);
  assert.deepStrictEqual(evs.map(e => e.event).filter(e => e !== "text"), ["start", "turn", "block", "block", "usage", "tool", "tool_result", "turn", "block", "done"]);
  assert.deepStrictEqual(evs[0].data, { model: "z-ai/glm-5.3", tools: ["Read", "Grep", "Glob"] });
  const read = evs.find(e => e.event === "tool_result")!.data;
  assert.deepStrictEqual(read, { id: "call_1_0", content: "     1\t// app", error: false }, "the file, read in the project");
  const done = evs[evs.length - 1].data;
  assert.ok(done.text.startsWith("# Pragmatist Route") && done.text.includes("Ran in " + project), done.text);
  assert.strictEqual(done.model, "z-ai/glm-5.3");
  assert.strictEqual(done.usage.turns, 2);
  const [first] = service.requests;
  assert.strictEqual(first.headers.get("authorization"), "Bearer sk-or-test");
  assert.strictEqual(first.headers.get("x-title"), "Quorum");
  assert.deepStrictEqual(first.body.usage, { include: true });
  assert.ok(first.body.messages[0].content.includes("=== AGENTS.md ===\n# How the app is built\nOne file, src/app.js.\n=== End of AGENTS.md ==="), "the project's AGENTS.md");

  const custom = await post(srv, { provider: "custom", url: service.url, key: "", model: "llama3.1:8b", prompt: "You are the Chair. Plan.", cwd: project });
  assert.ok(events(custom.body).pop()!.data.text.startsWith("# The Plan"));
  const last = service.requests[service.requests.length - 1];
  assert.strictEqual(last.body.model, "llama3.1:8b");
  assert.strictEqual(last.headers.get("authorization"), null, "no key, no Authorization");
  assert.strictEqual(last.body.usage, undefined, "OpenRouter's own fields only go to OpenRouter");

  const turnedAway = async (body: Record<string, unknown>, status: number, code: string) => {
    const x = await post(srv, Object.assign({ prompt: "x", cwd: project, model: "m" }, body));
    assert.strictEqual(x.status, status, JSON.stringify(body));
    assert.strictEqual(JSON.parse(x.body).error.code, code, JSON.stringify(body));
  };
  await turnedAway({ provider: "hermes" }, 400, "bad_request");
  await turnedAway({ provider: "toString" }, 400, "bad_request");
  await turnedAway({ provider: "openrouter", key: "" }, 400, "missing_key");
  await turnedAway({ provider: "openrouter", key: "k", model: "" }, 400, "bad_model");
  await turnedAway({ provider: "custom", url: "file:///etc/passwd" }, 400, "not_found");
  await turnedAway({ provider: "custom", url: service.url, cwd: path.join(project, "gone") }, 404, "project_missing");

  const models = await request(srv, { method: "POST", path: "/api/models", body: { url: service.url }, headers: { "Content-Type": "application/json" } });
  assert.deepStrictEqual(JSON.parse(models.body), { models: [{ id: "glm-test", name: "" }, { id: "other-model", name: "Other" }] });
  const gone = await request(srv, { method: "POST", path: "/api/models", body: { url: "http://127.0.0.1:9/v1" }, headers: { "Content-Type": "application/json" } });
  assert.strictEqual(JSON.parse(gone.body).error.code, "unreachable");
  await srv.stop();
  await service.stop();
});

test("a second server can't share a port with the first", async () => {
  const first = await listen();
  assert.throws(() => startServer({ port: first.port }), (e: NodeJS.ErrnoException) => e.code === "EADDRINUSE");
  const r = await request(first, { path: "/api/local" });
  assert.strictEqual(r.status, 200, "the first is unaffected");
  await first.stop();
});

test("a harness can be swapped for another without the page knowing", async () => {
  const asked: string[] = [];
  const stub: Harness = {
    checkModel: () => undefined,
    async run(task, emit) {
      asked.push(task.model + " in " + task.cwd + " with " + (task.endpoint && task.endpoint.key));
      emit("start", { model: "stub", tools: [] });
      emit("done", { text: "# Stubbed", truncated: false, model: "stub" });
      emit("text", { delta: "after the end" });
    },
  };
  const srv = await listen({ project, harnesses: { openrouter: stub } });
  const evs = events((await post(srv, { provider: "openrouter", key: "k", model: "anything", prompt: "x", cwd: project })).body);
  assert.deepStrictEqual(evs.map(e => e.event), ["start", "done"], "nothing is sent after the end");
  assert.deepStrictEqual(asked, ["anything in " + project + " with k"]);
  await srv.stop();
});

const dbFile = path.join(project, "data", "quorum.db");
const api = (srv: QuorumServer, method: string, route: string, body?: unknown, headers?: Record<string, string>) => request(srv, {
  method, path: "/api/" + route, body,
  headers: Object.assign(body !== undefined ? { "Content-Type": "application/json" } : {}, headers || {}),
}).then(r => ({ status: r.status, body: r.body ? JSON.parse(r.body) : null as any }));
const agents = { builders: { provider: "claude-code", model: "sonnet" }, council: { provider: "claude-code", model: "" }, chair: { provider: "claude-code", model: "opus" } };

test("sessions are saved as they run, and read back", async () => {
  const db = await listen({ db: dbFile });
  assert.deepStrictEqual(JSON.parse((await request(db, { path: "/api/local" })).body).sessions, { file: dbFile });
  assert.deepStrictEqual((await api(db, "GET", "sessions")).body, { sessions: [] });
  const made = await api(db, "POST", "sessions", { title: "Add CSV export", project, status: "running", agents });
  assert.strictEqual(made.status, 201);
  const id = made.body.session.id;
  assert.ok(/^[0-9a-f-]{36}$/.test(id));
  assert.deepStrictEqual({ ...made.body.session, id: "", created_at: "", updated_at: "" },
    { id: "", title: "Add CSV export", project, status: "running", round: 1, agents, elapsed: 0, created_at: "", updated_at: "" });
  const brief = { feature: "Add CSV export", context: [], length: "standard", project: { path: project, name: "p" } };
  assert.strictEqual((await api(db, "PUT", "sessions/" + id + "/rounds/1/brief", { kind: "brief", data: brief })).status, 200);
  assert.strictEqual((await api(db, "PUT", "sessions/" + id + "/rounds/1/revision", { kind: "revision", data: null })).status, 200);
  await api(db, "PUT", "sessions/" + id + "/rounds/1/A", { kind: "proposal", data: { text: "# A", title: "A" } });
  await api(db, "PUT", "sessions/" + id + "/rounds/1/A", { kind: "proposal", data: { text: "# A again", title: "A" } });
  const patched = await api(db, "PATCH", "sessions/" + id, { status: "stopped", elapsed: 4200, round: 2 });
  assert.strictEqual(patched.body.session.status, "stopped");
  assert.strictEqual(patched.body.session.elapsed, 4200);
  await api(db, "PUT", "sessions/" + id + "/rounds/2/revision", { kind: "revision", data: { round: 2, input: "Why?" } });
  const got = (await api(db, "GET", "sessions/" + id)).body;
  assert.strictEqual(got.session.round, 2);
  assert.deepStrictEqual(got.handoffs.map((h: any) => h.round + ":" + h.node), ["1:brief", "1:revision", "1:A", "2:revision"]);
  assert.deepStrictEqual(got.handoffs[0].data, brief);
  assert.strictEqual(got.handoffs[1].data, null);
  assert.strictEqual(got.handoffs[2].data.text, "# A again", "a step saved twice keeps its last handoff");
  const other = (await api(db, "POST", "sessions", { title: "Second", project: null, status: "running", agents })).body.session;
  assert.deepStrictEqual((await api(db, "GET", "sessions")).body.sessions.map((x: any) => x.title), ["Second", "Add CSV export"], "most recent first");
  assert.strictEqual((await api(db, "DELETE", "sessions/" + other.id)).status, 200);
  assert.deepStrictEqual((await api(db, "GET", "sessions")).body.sessions.map((x: any) => x.id), [id]);
  await db.stop();
});

test("a saved session is still there after the server stops", async () => {
  const again = await listen({ db: dbFile });
  const list = (await api(again, "GET", "sessions")).body.sessions;
  assert.strictEqual(list.length, 1);
  const got = (await api(again, "GET", "sessions/" + list[0].id)).body;
  assert.strictEqual(got.session.status, "stopped");
  assert.strictEqual(got.handoffs.length, 4);
  await again.stop();
});

test("session requests are checked", async () => {
  const db = await listen({ db: dbFile });
  const id = (await api(db, "GET", "sessions")).body.sessions[0].id;
  assert.strictEqual((await api(db, "POST", "sessions", { title: "x", status: "sleeping", agents })).status, 400);
  assert.strictEqual((await api(db, "POST", "sessions", { title: "x", status: "running", agents, project: "relative" })).status, 400);
  assert.strictEqual((await api(db, "POST", "sessions", { title: " ", status: "running", agents })).status, 400);
  assert.strictEqual((await api(db, "PATCH", "sessions/" + id, { round: 0 })).status, 400);
  assert.strictEqual((await api(db, "PUT", "sessions/" + id + "/rounds/1/..", { kind: "x", data: 1 })).status, 404);
  assert.strictEqual((await api(db, "PUT", "sessions/" + id + "/rounds/x/A", { kind: "proposal", data: 1 })).status, 400);
  assert.strictEqual((await api(db, "PUT", "sessions/" + id + "/rounds/1/A", { kind: "proposal" })).status, 400, "no data");
  assert.strictEqual((await api(db, "PUT", "sessions/nope/rounds/1/A", { kind: "proposal", data: 1 })).body.error.code, "session_missing");
  assert.strictEqual((await api(db, "GET", "sessions/nope")).status, 404);
  const form = await request(db, { method: "POST", path: "/api/sessions", body: "title=x", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  assert.strictEqual(form.status, 415, "a cross-site form can't write to the database");
  const cross = await request(db, { method: "DELETE", path: "/api/sessions/" + id, headers: { Origin: "https://evil.example" } });
  assert.strictEqual(cross.status, 403);
  assert.strictEqual((await api(db, "GET", "sessions")).body.sessions.length, 1);
  await db.stop();
});

test("each step's conversation with its agent is saved, attempt by attempt", async () => {
  const db = await listen({ db: dbFile });
  const id = (await api(db, "POST", "sessions", { title: "Talk", project, status: "running", agents })).body.session.id;
  const convo = (text: string, status: string) => ({ v: 1, round: 1, node: "A", status, entries: [{ type: "prompt", text: "Propose." }, { type: "text", text, final: status === "done" }] });
  const put = (round: number | string, node: string, attempt: string, body: unknown) => api(db, "PUT", "sessions/" + id + "/rounds/" + round + "/" + node + "/transcripts/" + attempt, body);
  assert.strictEqual((await put(1, "A", "first", { data: convo("Half", "running") })).status, 200);
  assert.strictEqual((await put(1, "A", "first", { data: convo("Half a proposal", "error") })).status, 200, "saved again as it grows");
  assert.strictEqual((await put(1, "A", "second", { data: convo("# A", "done") })).status, 200);
  assert.strictEqual((await put(2, "A", "third", { data: convo("# A2", "done") })).status, 200);
  await put(1, "skeptic", "s1", { data: convo("Review", "done") });
  const atA = (await api(db, "GET", "sessions/" + id + "/rounds/1/A/transcripts")).body.transcripts;
  assert.deepStrictEqual(atA.map((x: any) => x.attempt + ":" + x.data.entries[1].text), ["first:Half a proposal", "second:# A"], "every attempt, oldest first");
  const all = (await api(db, "GET", "sessions/" + id + "/transcripts")).body.transcripts;
  assert.deepStrictEqual(all.map((x: any) => x.round + ":" + x.node + ":" + x.attempt), ["1:A:first", "1:A:second", "1:skeptic:s1", "2:A:third"]);
  assert.deepStrictEqual((await api(db, "GET", "sessions/" + id + "/rounds/1/B/transcripts")).body.transcripts, []);

  const big = "x".repeat(3 * 1024 * 1024);
  assert.strictEqual((await put(1, "B", "big", { data: { entries: [{ type: "tool", result: big }] } })).status, 200, "a conversation can be longer than other requests");
  assert.strictEqual((await put(1, "A", "bad.attempt", { data: convo("x", "done") })).status, 400);
  assert.strictEqual((await put(1, "A", "x", { data: { entries: "no" } })).status, 400);
  assert.strictEqual((await put(1, "A", "x", {})).status, 400);
  assert.strictEqual((await put("x", "A", "x", { data: convo("x", "done") })).status, 400);
  assert.strictEqual((await api(db, "PUT", "sessions/nope/rounds/1/A/transcripts/x", { data: convo("x", "done") })).body.error.code, "session_missing");
  assert.strictEqual((await api(db, "GET", "sessions/nope/transcripts")).status, 404);
  assert.strictEqual((await api(db, "DELETE", "sessions/" + id + "/rounds/1/A/transcripts")).status, 405);
  const cross = await request(db, { method: "PUT", path: "/api/sessions/" + id + "/rounds/1/A/transcripts/x", body: JSON.stringify({ data: convo("x", "done") }), headers: { "Content-Type": "application/json", Origin: "https://evil.example" } });
  assert.strictEqual(cross.status, 403);

  assert.strictEqual((await api(db, "DELETE", "sessions/" + id)).status, 200);
  assert.strictEqual(db.sessions!.transcripts(id), null);
  const check = new Database(dbFile);
  const left = (check.query("SELECT COUNT(*) AS n FROM transcripts WHERE session_id = ?").get(id) as { n: number }).n;
  check.close();
  assert.strictEqual(left, 0, "deleting a session deletes its conversations");
  await db.stop();
});

test("without a database, sessions aren't offered", async () => {
  assert.strictEqual(JSON.parse((await request(server, { path: "/api/local" })).body).sessions, null);
  const r = await api(server, "GET", "sessions");
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.body.error.code, "sessions_unavailable");
});

