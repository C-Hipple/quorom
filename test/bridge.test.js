// Tests for serve.js and the local bridge, with a stand-in for Claude Code.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");
const { createServer } = require("../serve");
const { createTranslator, errorCode, claudeArgs, validModel, folderInfo } = require("../bridge");

const FAKE = { command: process.execPath, args: [path.join(__dirname, "fake-claude.js")] };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quorum-bridge-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "docs"));
  fs.mkdirSync(path.join(dir, ".hidden"));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/feature/login\n");
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Notes\n");
  fs.writeFileSync(path.join(dir, "src", "app.js"), "// app\n");
  return fs.realpathSync(dir);
}

function listen(opts) {
  const server = createServer(Object.assign({ claude: FAKE }, opts));
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function request(server, o) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, method: o.method || "GET", path: o.path,
      headers: Object.assign({ Host: "localhost:" + port }, o.headers || {}),
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", c => { body += c; if (o.onData) o.onData(body, req); });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on("error", e => (o.allowAbort ? resolve({ aborted: true }) : reject(e)));
    });
    req.on("error", e => (o.allowAbort ? resolve({ aborted: true }) : reject(e)));
    if (o.body !== undefined) req.write(typeof o.body === "string" ? o.body : JSON.stringify(o.body));
    req.end();
  });
}

function events(body) {
  return body.split("\n\n").filter(Boolean).map(block => {
    const ev = /^event: (.+)$/m.exec(block);
    const data = /^data: (.+)$/m.exec(block);
    return { event: ev ? ev[1] : "message", data: data ? JSON.parse(data[1]) : null };
  });
}

const post = (server, body, headers) => request(server, {
  method: "POST", path: "/api/claude-code", body,
  headers: Object.assign({ "Content-Type": "application/json", Origin: "http://localhost:" + server.address().port }, headers || {}),
});

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

(async () => {
  let passed = 0;
  const run = async (name, fn) => {
    try { await fn(); passed++; console.log("ok  ", name); }
    catch (e) { console.log("FAIL", name, "\n   ", e.stack.split("\n").slice(0, 8).join("\n    ")); process.exitCode = 1; }
  };
  const project = tmpProject();

  await run("Claude Code runs read-only, without MCP servers or the project's settings", async () => {
    const args = claudeArgs("opus");
    const flag = f => args[args.indexOf(f) + 1];
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

  await run("stream-json becomes the page's events", async () => {
    const got = [];
    const tr = createTranslator((event, data) => got.push([event, data]), "/p");
    tr.feed({ type: "system", subtype: "init", model: "claude-opus-5-5" });
    tr.feed({ type: "stream_event", event: { type: "message_start" } });
    tr.feed({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } });
    tr.feed({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } } });
    tr.feed({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/p/src/a.js" } }, { type: "tool_use", name: "Grep", input: { pattern: "TODO" } }, { type: "tool_use", name: "Read", input: { file_path: "/elsewhere/b.js" } }] } });
    tr.feed({ type: "stream_event", event: { type: "message_start" } }, );
    tr.feed({ type: "result", subtype: "success", is_error: false, stop_reason: "max_tokens", result: "# Plan" });
    tr.feed({ type: "result", subtype: "success", result: "ignored after the end" });
    assert.deepStrictEqual(got, [
      ["start", { model: "claude-opus-5-5" }], ["turn", {}], ["text", { delta: "Hi" }],
      ["tool", { tool: "Read", detail: "src/a.js" }], ["tool", { tool: "Grep", detail: "TODO" }], ["tool", { tool: "Read", detail: "/elsewhere/b.js" }],
      ["turn", {}], ["done", { text: "# Plan", truncated: true, model: "claude-opus-5-5" }],
    ]);
    assert.ok(tr.finished());
  });

  await run("Claude Code's errors become Quorum's error codes", async () => {
    assert.strictEqual(errorCode(404, "model_not_found", "There's an issue with the selected model"), "bad_model");
    assert.strictEqual(errorCode(401, "", ""), "auth_failed");
    assert.strictEqual(errorCode(0, "", "Invalid API key · Please run /login"), "auth_failed");
    assert.strictEqual(errorCode(0, "billing_error", ""), "no_credits");
    assert.strictEqual(errorCode(429, "", ""), "rate_limited");
    assert.strictEqual(errorCode(0, "", "Claude AI usage limit reached"), "rate_limited");
    assert.strictEqual(errorCode(0, "", "Prompt is too long"), "prompt_too_large");
    assert.strictEqual(errorCode(500, "error_during_execution", "boom"), "upstream_error");
  });

  await run("a folder lists its subfolders, its Git branch and whether it has a CLAUDE.md", async () => {
    const info = folderInfo(project);
    assert.strictEqual(info.path, project);
    assert.strictEqual(info.name, path.basename(project));
    assert.strictEqual(info.parent, path.dirname(project));
    assert.deepStrictEqual(info.dirs, [{ name: "docs", path: path.join(project, "docs") }, { name: "src", path: path.join(project, "src") }], "hidden folders are left out");
    assert.deepStrictEqual(info.git, { root: project, branch: "feature/login", detached: null });
    assert.strictEqual(info.claudeMd, true);
    const sub = folderInfo(path.join(project, "src"));
    assert.strictEqual(sub.git.root, project, "a subfolder belongs to the repository above it");
    assert.strictEqual(sub.claudeMd, false);
    assert.strictEqual(folderInfo(path.join(project, "nope")), null);
    assert.strictEqual(folderInfo(path.join(project, "src", "app.js")), null, "a file isn't a folder");
    assert.strictEqual(folderInfo("~").path, os.homedir());
  });

  const server = await listen({ project });
  const port = server.address().port;

  await run("the page learns whether Claude Code is installed, and the project it started with", async () => {
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

  await run("only the page itself can use the bridge", async () => {
    assert.strictEqual((await request(server, { path: "/api/local", headers: { Host: "evil.example:" + port } })).status, 403, "DNS rebinding");
    assert.strictEqual((await request(server, { path: "/api/local", headers: { Origin: "https://evil.example" } })).status, 403, "another site");
    assert.strictEqual((await post(server, { prompt: "x", cwd: project }, { Origin: "http://evil.example" })).status, 403);
    const form = await post(server, "prompt=x", { "Content-Type": "text/plain" });
    assert.strictEqual(form.status, 415, "a simple cross-site form post can't start a run");
    assert.strictEqual((await request(server, { path: "/api/local", headers: { Host: "127.0.0.1:" + port, Origin: "http://127.0.0.1:" + port } })).status, 200);
    const page = await request(server, { path: "/" });
    assert.strictEqual(page.status, 200, "the page is still served");
  });

  await run("a seat runs Claude Code inside the project folder and streams what it does", async () => {
    const r = await post(server, { prompt: "Propose something.", model: "sonnet", cwd: project });
    assert.strictEqual(r.status, 200);
    assert.ok(/text\/event-stream/.test(r.headers["content-type"]));
    const evs = events(r.body);
    assert.deepStrictEqual(evs.map(e => e.event), ["start", "turn", "text", "tool", "turn"].concat(evs.slice(5, -1).map(() => "text"), ["done"]));
    assert.deepStrictEqual(evs[0].data, { model: "claude-sonnet-fake" });
    assert.deepStrictEqual(evs[3].data, { tool: "Read", detail: path.join("src", "app.js") });
    const done = evs[evs.length - 1].data;
    assert.ok(done.text.startsWith("# Fake answer"));
    const ran = JSON.parse(done.text.split("\n\n")[1]);
    assert.strictEqual(ran.cwd, project, "Claude Code runs inside the project");
    assert.strictEqual(ran.prompt, "Propose something.", "the prompt goes in on stdin");
    assert.deepStrictEqual(ran.args, claudeArgs("sonnet"));
    assert.strictEqual(evs.slice(5, -1).map(e => e.data.delta).join(""), done.text);
  });

  await run("requests Claude Code can't run are turned away before it starts", async () => {
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

  await run("Claude Code's failures reach the page as error events", async () => {
    const auth = events((await post(server, { prompt: "FAKE:auth", cwd: project })).body);
    assert.deepStrictEqual(auth[auth.length - 1], { event: "error", data: { code: "auth_failed", message: "Invalid API key · Please run /login" } });
    const crash = events((await post(server, { prompt: "FAKE:crash", cwd: project })).body);
    assert.deepStrictEqual(crash[crash.length - 1], { event: "error", data: { code: "upstream_error", message: "fatal: the fake crashed" } });
  });

  await run("closing the request stops Claude Code", async () => {
    const pidFile = path.join(project, "pid");
    const s2 = await listen({ env: Object.assign({}, process.env, { FAKE_PID_FILE: pidFile }) });
    const p2 = s2.address().port;
    let pid = 0;
    await request(s2, {
      method: "POST", path: "/api/claude-code", allowAbort: true,
      body: { prompt: "FAKE:slow", cwd: project },
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
    s2.close();
  });

  await run("without Claude Code, the page is told it isn't available", async () => {
    const s3 = await listen({ claude: null, env: { PATH: path.join(project, "empty") } });
    const o = JSON.parse((await request(s3, { path: "/api/local" })).body);
    assert.deepStrictEqual(o.claudeCode, { available: false, version: null });
    assert.strictEqual(o.project, null);
    const r = await request(s3, {
      method: "POST", path: "/api/claude-code", body: { prompt: "x", cwd: project },
      headers: { "Content-Type": "application/json", Host: "localhost:" + s3.address().port },
    });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(JSON.parse(r.body).error.code, "claude_code_missing");
    s3.close();
  });

  const dbFile = path.join(project, "data", "quorum.db");
  const api = (srv, method, route, body, headers) => request(srv, {
    method, path: "/api/" + route, body,
    headers: Object.assign(body !== undefined ? { "Content-Type": "application/json" } : {}, headers || {}),
  }).then(r => ({ status: r.status, body: r.body ? JSON.parse(r.body) : null }));
  const agents = { builders: { provider: "claude-code", model: "sonnet" }, council: { provider: "claude-code", model: "" }, chair: { provider: "claude-code", model: "opus" } };

  await run("sessions are saved as they run, and read back", async () => {
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
    assert.deepStrictEqual(got.handoffs.map(h => h.round + ":" + h.node), ["1:brief", "1:revision", "1:A", "2:revision"]);
    assert.deepStrictEqual(got.handoffs[0].data, brief);
    assert.strictEqual(got.handoffs[1].data, null);
    assert.strictEqual(got.handoffs[2].data.text, "# A again", "a step saved twice keeps its last handoff");
    const other = (await api(db, "POST", "sessions", { title: "Second", project: null, status: "running", agents })).body.session;
    assert.deepStrictEqual((await api(db, "GET", "sessions")).body.sessions.map(x => x.title), ["Second", "Add CSV export"], "most recent first");
    assert.strictEqual((await api(db, "DELETE", "sessions/" + other.id)).status, 200);
    assert.deepStrictEqual((await api(db, "GET", "sessions")).body.sessions.map(x => x.id), [id]);
    db.close();
  });

  await run("a saved session is still there after the server stops", async () => {
    const again = await listen({ db: dbFile });
    const list = (await api(again, "GET", "sessions")).body.sessions;
    assert.strictEqual(list.length, 1);
    const got = (await api(again, "GET", "sessions/" + list[0].id)).body;
    assert.strictEqual(got.session.status, "stopped");
    assert.strictEqual(got.handoffs.length, 4);
    again.close();
  });

  await run("session requests are checked", async () => {
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
    db.close();
  });

  await run("without a database, sessions aren't offered", async () => {
    assert.strictEqual(JSON.parse((await request(server, { path: "/api/local" })).body).sessions, null);
    const r = await api(server, "GET", "sessions");
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.body.error.code, "sessions_unavailable");
  });

  server.close();
  fs.rmSync(project, { recursive: true, force: true });
  console.log(passed + " bridge tests passed" + (process.exitCode ? " (with failures)" : ""));
  process.exit(process.exitCode || 0);
})();
