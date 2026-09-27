// In-page tests for Quorum served by serve.js: the page runs in jsdom against the real local server, with a
// stand-in for Claude Code, so a project folder can be chosen and seats run inside it.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { JSDOM } = require("jsdom");
const assert = require("assert");
const { createServer } = require("../serve");

const html = fs.readFileSync(path.join(__dirname, "..", "dist", "quorum.html"), "utf8");
const FAKE = { command: process.execPath, args: [path.join(__dirname, "fake-claude.js")] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const txt = el => el.textContent.replace(/\s+/g, " ").trim();

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quorum-local-"));
  ["src", "docs"].forEach(d => fs.mkdirSync(path.join(dir, d)));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Notes\n");
  return fs.realpathSync(dir);
}

function listen(opts) {
  const server = createServer(Object.assign({ claude: FAKE }, opts));
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// The page, opened from the server. Its requests go to the server through Node's fetch.
function open(server, opts = {}) {
  const base = "http://localhost:" + server.address().port + "/";
  const dom = new JSDOM(html, {
    url: base + (opts.hash || ""),
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
      w.__QUORUM_TEST__ = true;
      if (!opts.questions) w.localStorage.setItem("quorum:questions", "off");
      Object.keys(opts.storage || {}).forEach(k => w.localStorage.setItem(k, opts.storage[k]));
      w.fetch = (url, init) => fetch(new URL(url, base), init);
      w.AbortController = AbortController;
      w.TextDecoder = TextDecoder;
      w.Element.prototype.scrollIntoView = function () {};
      w.console.error = (...a) => console.log("[page error]", ...a);
    },
  });
  return { dom, win: dom.window, doc: dom.window.document };
}

async function waitFor(fn, ms = 8000, label = "condition") {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await sleep(10); }
  throw new Error("Timed out waiting for " + label);
}
function type(h, id, value, ev = "input") {
  const el = h.doc.getElementById(id);
  el.value = value;
  el.dispatchEvent(new h.win.Event(ev, { bubbles: true }));
}
async function ready(h) {
  await waitFor(() => !h.doc.getElementById("project").hidden || /npm start|find Claude Code/.test(txt(h.doc.getElementById("status-claude-code"))), 5000, "the local server");
  await waitFor(() => !/Looking/.test(txt(h.doc.getElementById("projectStatus"))), 5000, "the project lookup");
}
async function convene(h, feature) {
  h.doc.getElementById("feature").value = feature;
  h.doc.getElementById("convene").click();
}
const logLines = file => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);
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
  const logFile = path.join(os.tmpdir(), "quorum-local-" + process.pid + ".log");
  const pidFile = path.join(os.tmpdir(), "quorum-local-" + process.pid + ".pids");
  const env = Object.assign({}, process.env, { FAKE_LOG: logFile, FAKE_PID_FILE: pidFile });
  const server = await listen({ project, env });

  await run("served by Quorum's server, the page offers the project folder and puts every seat on Claude Code", async () => {
    const h = open(server);
    const { doc } = h;
    await ready(h);
    assert.ok(!doc.getElementById("project").hidden);
    assert.strictEqual(doc.getElementById("projectPath").value, project, "the folder given to npm start");
    assert.strictEqual(txt(doc.getElementById("projectStatus")), "Found " + path.basename(project) + ", a Git repository on main. It has a CLAUDE.md, which Claude Code reads.");
    assert.deepStrictEqual(["builders", "council", "chair"].map(r => doc.getElementById("provider-" + r).value + ":" + doc.getElementById("model-" + r).value),
      ["claude-code:", "claude-code:", "claude-code:"]);
    assert.strictEqual(doc.getElementById("model-builders").placeholder, "Claude Code's default model");
    assert.deepStrictEqual([...doc.querySelectorAll("#models-claude-code option")].map(o => o.value), ["opus", "sonnet", "haiku", "fable"]);
    const opt = doc.querySelector('#provider-builders option[value="claude-code"]');
    assert.ok(!opt.disabled);
    assert.strictEqual(opt.textContent, "Claude Code");
    assert.strictEqual(txt(doc.getElementById("status-claude-code")), "Claude Code 9.9.9 is installed.");
    assert.strictEqual(txt(doc.getElementById("providersStatus")), "Claude Code is set up");
    assert.ok(!doc.getElementById("providers").open, "nothing else needs setting up");
    assert.strictEqual(txt(doc.getElementById("settingsHint")), "Claude Code explores the project before it writes, so its seats can take a few minutes.");
  });

  await run("browsing chooses the project folder", async () => {
    const h = open(server);
    const { doc, win } = h;
    await ready(h);
    doc.getElementById("projectBrowse").click();
    await waitFor(() => doc.querySelectorAll("#projectDirs button").length === 3, 3000, "the listing");
    assert.strictEqual(doc.getElementById("projectBrowse").getAttribute("aria-expanded"), "true");
    assert.strictEqual(txt(doc.getElementById("projectWhere")), project);
    assert.deepStrictEqual([...doc.querySelectorAll("#projectDirs button")].map(txt), ["↑ Parent folder", "docs/", "src/"]);
    doc.querySelector('#projectDirs button[data-path$="src"]').click();
    await waitFor(() => doc.getElementById("projectPath").value === path.join(project, "src") && /Found src/.test(txt(doc.getElementById("projectStatus"))), 3000, "src chosen");
    assert.strictEqual(txt(doc.getElementById("projectStatus")), "Found src, in a Git repository on main.");
    assert.strictEqual(win.localStorage.getItem("quorum:project"), path.join(project, "src"), "remembered for next time");
    await waitFor(() => doc.activeElement && doc.activeElement.classList.contains("project-dir"), 2000, "focus in the listing");
    assert.deepStrictEqual([...doc.querySelectorAll("#projectDirs li")].map(txt), ["↑ Parent folder", "No folders inside."]);
    doc.querySelector("#projectDirs .is-up").click();
    await waitFor(() => doc.getElementById("projectPath").value === project, 3000, "back up");
    doc.getElementById("projectBrowse").click();
    assert.ok(doc.getElementById("projectBrowser").hidden);
  });

  await run("a path that isn't a folder, or no folder at all, stops the council convening", async () => {
    const h = open(server);
    const { doc, win } = h;
    await ready(h);
    const before = logLines(logFile).length;
    type(h, "projectPath", path.join(project, "nope"));
    await convene(h, "Add CSV export.");
    await waitFor(() => /no folder/.test(txt(doc.getElementById("projectStatus"))), 3000, "the lookup");
    assert.strictEqual(txt(doc.getElementById("projectStatus")), "There's no folder at " + path.join(project, "nope") + ".");
    assert.strictEqual(doc.getElementById("projectPath").getAttribute("aria-invalid"), "true");
    assert.strictEqual(doc.activeElement.id, "projectPath");
    assert.strictEqual(win.__quorum.S.phase, "idle");
    type(h, "projectPath", "");
    await convene(h, "Add CSV export.");
    await sleep(50);
    assert.strictEqual(txt(doc.getElementById("projectStatus")), "Choose the project folder for Claude Code to work in.");
    assert.strictEqual(win.__quorum.S.phase, "idle");
    assert.strictEqual(logLines(logFile).length, before, "Claude Code wasn't run");
  });

  await run("a whole session runs on Claude Code inside the project folder", async () => {
    fs.rmSync(logFile, { force: true });
    const h = open(server, { storage: { "quorum:agents": JSON.stringify({ builders: { provider: "claude-code", model: "sonnet" }, council: { provider: "claude-code", model: "" }, chair: { provider: "claude-code", model: "opus" } }) } });
    const { doc, win } = h;
    await ready(h);
    await convene(h, "Add CSV export. FAKE:pause");
    await waitFor(() => /is reading/.test(txt(doc.getElementById("propDoc"))), 5000, "exploring");
    assert.strictEqual(txt(doc.getElementById("propDoc")), "The Pragmatist is reading " + path.join("src", "app.js") + ".");
    assert.strictEqual(txt(doc.getElementById("status")), "The builders are exploring the project and drafting their proposals.");
    assert.strictEqual(txt(doc.getElementById("motionProject")), "In the project " + project);
    await waitFor(() => win.__quorum.S.phase === "done", 20000, "done");
    await sleep(40);
    const runs = logLines(logFile);
    assert.strictEqual(runs.length, 7);
    runs.forEach(r => {
      assert.strictEqual(r.cwd, project, "every seat runs inside the project");
      assert.ok(r.prompt.includes("You're running inside the project's folder, " + project + ", with tools that can read and search its files but not change them."), r.prompt.slice(0, 300));
      assert.ok(r.args.includes("--tools") && r.args[r.args.indexOf("--tools") + 1] === "Read,Grep,Glob");
    });
    const model = r => (r.args.indexOf("--model") >= 0 ? r.args[r.args.indexOf("--model") + 1] : "");
    const seat = r => (/^You are (The \w+|the Chair)/.exec(r.prompt) || [])[1];
    assert.deepStrictEqual(runs.map(r => seat(r) + ":" + model(r)).sort(), [
      "The Advocate:", "The Architect:sonnet", "The Pragmatist:sonnet", "The Skeptic:", "The Strategist:", "The Visionary:sonnet", "the Chair:opus"]);
    const S = win.__quorum.S;
    assert.ok(S.seats.A.text.includes("Ran in " + project), "the answer came from inside the project");
    assert.ok(!S.seats.A.text.includes("Let me look first."), "the preamble before exploring isn't part of the proposal");
    assert.strictEqual(txt(doc.getElementById("propTier")), "Agent: claude-sonnet-fake via Claude Code");
    assert.strictEqual(doc.getElementById("propTier").title, "Claude Code: claude-sonnet-fake");
    assert.strictEqual(txt(doc.getElementById("planTier")), "Agent: claude-opus-fake via Claude Code");
    assert.strictEqual(txt(doc.getElementById("verdict")), "Proposal A, “Pragmatist Route”, wins with 9 of 9 possible points. Every councilor ranked it first.");
    const planned = S.handoffs.brief.data.project;
    assert.deepStrictEqual(JSON.parse(JSON.stringify(planned)), { path: project, name: path.basename(project) });
  });

  await run("Claude Code's problems pause the session with advice for Claude Code", async () => {
    const h = open(server);
    const { doc, win } = h;
    await ready(h);
    await convene(h, "Add CSV export. FAKE:auth");
    await waitFor(() => win.__quorum.S.phase === "paused", 8000, "paused");
    await sleep(30);
    assert.strictEqual(txt(doc.getElementById("noticeText")), "The Pragmatist, the Visionary and the Architect couldn't finish. Claude Code isn't signed in. Run claude in a terminal and sign in, then retry.");
    assert.strictEqual(txt(doc.getElementById("propNote")), "Claude Code isn't signed in.");
  });

  await run("stopping the session stops Claude Code", async () => {
    fs.rmSync(pidFile, { force: true });
    const h = open(server);
    const { doc, win } = h;
    await ready(h);
    await convene(h, "Add CSV export. FAKE:slow");
    await waitFor(() => logLines(logFile).length && fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim().split("\n").length === 3, 8000, "three builders running");
    const pids = fs.readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
    assert.ok(pids.every(alive));
    await sleep(450);
    doc.getElementById("railStop").click();
    await waitFor(() => !pids.some(alive), 8000, "the processes to end");
    assert.strictEqual(win.__quorum.S.phase, "stopped");
  });

  await run("without Claude Code installed, it's offered but switched off", async () => {
    const bare = await listen({ claude: null, env: { PATH: path.join(project, "empty") } });
    const h = open(bare);
    const { doc } = h;
    await ready(h);
    const opt = doc.querySelector('#provider-builders option[value="claude-code"]');
    assert.ok(opt.disabled);
    assert.strictEqual(opt.textContent, "Claude Code (not installed)");
    assert.strictEqual(doc.getElementById("provider-builders").value, "openrouter", "the usual defaults");
    assert.strictEqual(txt(doc.getElementById("status-claude-code")), "Quorum's server couldn't find Claude Code. Install it, or restart the server with QUORUM_CLAUDE_BIN set to its path.");
    assert.ok(!doc.getElementById("project").hidden, "the project folder can still be chosen");
    bare.close();
  });

  const dbFile = path.join(project, ".quorum", "quorum.db");
  const seatOf = r => (/^You are (The \w+ Reviewer|The \w+|the Chair)/.exec(r.prompt) || [])[1];
  const nodes = got => got.handoffs.map(x => x.round + ":" + x.node).sort();
  const ROUND = r => ["A", "B", "C", "advocate", "brief", "chair", "revision", "skeptic", "strategist", "tally"].map(n => r + ":" + n);

  await run("a session is saved as it runs, and the address names it", async () => {
    const srv = await listen({ project, env, db: dbFile });
    const h = open(srv);
    const { doc, win } = h;
    await ready(h);
    await waitFor(() => txt(doc.getElementById("sessionsStatus")) === "None yet", 3000, "the list");
    assert.ok(!doc.getElementById("sessions").hidden);
    assert.strictEqual(txt(doc.getElementById("sessionsIntro")), "Each session is saved in " + dbFile + " as it runs, so you can come back to it after closing this page or stopping the server.");
    await convene(h, "Add CSV export.");
    await waitFor(() => win.__quorum.S.sessionId, 3000, "the session to be saved");
    const id = win.__quorum.S.sessionId;
    assert.strictEqual(win.location.hash, "#session=" + id);
    assert.strictEqual(srv.sessions.get(id).session.status, "running");
    await waitFor(() => win.__quorum.S.phase === "done", 20000, "done");
    await win.__quorum.saved();
    await sleep(30);
    assert.strictEqual(txt(doc.getElementById("saveState")), "Saved");
    const got = srv.sessions.get(id);
    assert.strictEqual(got.session.status, "done");
    assert.strictEqual(got.session.title, "The Plan", "named after its plan");
    assert.strictEqual(got.session.project, project);
    assert.deepStrictEqual(nodes(got), ROUND(1), "every step's handoff is saved");
    assert.strictEqual(got.handoffs.find(x => x.node === "A").data.text, win.__quorum.S.handoffs.A.data.text);
    assert.ok(got.session.elapsed > 0);
    assert.deepStrictEqual([...doc.querySelectorAll("#sessionList .session-open")].map(txt), ["The Plan"]);
    assert.ok(/Plan ready · .* · Open now$/.test(txt(doc.querySelector("#sessionList .session-meta"))), txt(doc.querySelector("#sessionList .session-meta")));
    srv.close();
  });

  await run("stopping the app mid-session and coming back carries on where it got to", async () => {
    fs.rmSync(logFile, { force: true });
    const srv = await listen({ project, env, db: dbFile });
    const h = open(srv);
    await ready(h);
    await convene(h, "Add CSV export. FAKE:pause");
    const S = h.win.__quorum.S;
    await waitFor(() => ["A", "B", "C"].every(L => S.handoffs[L]) && ["advocate", "skeptic", "strategist"].some(c => S.seats[c].status !== "idle"), 10000, "the council to start");
    await h.win.__quorum.saved();
    const id = S.sessionId;
    // The server stops in the middle of the council's review. The old page is left behind, as a closed tab would be;
    // what it makes of its requests failing doesn't matter. (Closing a jsdom window with an animation frame pending
    // crashes jsdom, so it isn't closed.)
    h.win.console.error = () => {};
    srv.closeAllConnections();
    srv.close();
    await sleep(100);

    const srv2 = await listen({ project, env, db: dbFile });
    const h2 = open(srv2);
    const { doc, win } = h2;
    await ready(h2);
    await waitFor(() => doc.querySelectorAll("#sessionList .session-item").length === 2, 3000, "the list");
    assert.ok(doc.getElementById("sessions").open, "unfinished sessions are offered");
    assert.strictEqual(txt(doc.getElementById("sessionsStatus")), "2 sessions, 1 unfinished");
    const before = logLines(logFile).length;
    doc.querySelector('#sessionList [data-open="' + id + '"]').click();
    await waitFor(() => win.__quorum.S.sessionId === id, 3000, "the session to open");
    const S2 = win.__quorum.S;
    assert.strictEqual(win.location.hash, "#session=" + id);
    assert.strictEqual(S2.phase, "stopped");
    assert.deepStrictEqual(["A", "B", "C"].map(L => S2.seats[L].status), ["done", "done", "done"]);
    assert.deepStrictEqual(["advocate", "skeptic", "strategist", "chair"].map(c => S2.seats[c].status), ["stopped", "stopped", "stopped", "idle"]);
    assert.ok(S2.seats.A.text.includes("Ran in " + project), "the proposals are back");
    assert.strictEqual(doc.getElementById("feature").value, "Add CSV export. FAKE:pause", "and so is what it was about");
    assert.strictEqual(doc.getElementById("projectPath").value, project);
    assert.strictEqual(txt(doc.getElementById("status")), "Stopped. Resume to continue where the council left off.");
    assert.ok(!doc.getElementById("resume").hidden);
    doc.getElementById("resume").click();
    await waitFor(() => S2.phase === "done", 20000, "done");
    assert.deepStrictEqual(logLines(logFile).slice(before).map(seatOf).sort(), ["The Advocate", "The Skeptic", "The Strategist", "the Chair"], "only the unfinished steps run again");
    await win.__quorum.saved();
    const got = srv2.sessions.get(id);
    assert.strictEqual(got.session.status, "done");
    assert.deepStrictEqual(nodes(got), ROUND(1));
    srv2.close();
  });

  await run("input on the plan starts a new round, saved with the session", async () => {
    fs.rmSync(logFile, { force: true });
    const srv = await listen({ project, env, db: dbFile });
    const h = open(srv);
    const { doc, win } = h;
    await ready(h);
    await convene(h, "Add CSV export.");
    const S = win.__quorum.S;
    await waitFor(() => S.phase === "done", 20000, "done");
    const id = S.sessionId;
    doc.getElementById("reviseInput").value = "Why not stream the file? Admins must see who exported what.";
    doc.getElementById("reviseBtn").click();
    await waitFor(() => S.round === 2 && S.phase === "done", 20000, "round 2");
    await win.__quorum.saved();
    const runs = logLines(logFile);
    assert.strictEqual(runs.length, 14);
    runs.slice(7).forEach(r => {
      assert.strictEqual(r.cwd, project, "revisions run inside the project too");
      assert.ok(r.prompt.includes("Why not stream the file? Admins must see who exported what."));
    });
    const got = srv.sessions.get(id);
    assert.strictEqual(got.session.round, 2);
    assert.deepStrictEqual(nodes(got), ROUND(1).concat(ROUND(2)).sort());
    const rev = got.handoffs.find(x => x.round === 2 && x.node === "revision").data;
    assert.strictEqual(rev.input, "Why not stream the file? Admins must see who exported what.");
    assert.strictEqual(rev.previous.plan, got.handoffs.find(x => x.round === 1 && x.node === "chair").data.text);

    // Opened again from its address, the session is in round 2, with round 1 behind it.
    const h2 = open(srv, { hash: "#session=" + id });
    await waitFor(() => h2.win.__quorum.S.sessionId === id, 5000, "the session to open");
    const S2 = h2.win.__quorum.S;
    assert.strictEqual(S2.round, 2);
    assert.strictEqual(S2.phase, "done");
    assert.strictEqual(S2.past.length, 1);
    assert.strictEqual(S2.past[0].chair.data.text, got.handoffs.find(x => x.round === 1 && x.node === "chair").data.text);
    await sleep(30);
    assert.strictEqual(h2.doc.getElementById("motionRoundQuote").textContent, "Why not stream the file? Admins must see who exported what.");
    assert.strictEqual(h2.doc.querySelectorAll("#roundsList .round").length, 1);
    assert.ok(!h2.doc.getElementById("revise").hidden, "and ready for more input");
    assert.ok(/^Round 2 · Adjourned after/.test(txt(h2.doc.getElementById("clock"))));
    srv.close();
  });

  await run("saved sessions can be deleted from the list", async () => {
    const srv = await listen({ project, env, db: dbFile });
    const h = open(srv);
    const { doc } = h;
    await ready(h);
    await waitFor(() => doc.querySelectorAll("#sessionList .session-item").length === 3, 3000, "the list");
    assert.strictEqual(txt(doc.getElementById("sessionsStatus")), "3 sessions");
    assert.ok(!doc.getElementById("sessions").open, "nothing unfinished, so the list stays closed");
    const del = doc.querySelector("#sessionList .session-delete");
    const id = del.getAttribute("data-delete");
    del.click();
    await sleep(20);
    const again = doc.querySelector('#sessionList [data-delete="' + id + '"]');
    assert.strictEqual(txt(again), "Delete for good");
    assert.strictEqual(srv.sessions.list().length, 3, "nothing is deleted yet");
    again.click();
    await waitFor(() => doc.querySelectorAll("#sessionList .session-item").length === 2, 3000, "the deletion");
    assert.strictEqual(srv.sessions.get(id), null);
    srv.close();
  });

  await run("a final review runs inside the project too, and is saved with the session", async () => {
    fs.rmSync(logFile, { force: true });
    const srv = await listen({ project, env, db: dbFile });
    const h = open(srv);
    const { doc, win } = h;
    await ready(h);
    doc.getElementById("reviewOn").click();
    await convene(h, "Add CSV export.");
    const S = win.__quorum.S;
    await waitFor(() => S.phase === "done", 20000, "done");
    await win.__quorum.saved();
    const runs = logLines(logFile);
    assert.deepStrictEqual(runs.map(seatOf).slice(-3).sort(), ["The Scaling Reviewer", "The Security Reviewer", "the Chair"]);
    runs.forEach(r => assert.strictEqual(r.cwd, project));
    const check = runs.find(r => seatOf(r) === "The Security Reviewer").prompt;
    assert.ok(check.includes("You're running inside the project's folder, " + project + ", with tools that can read and search its files but not change them. Read the code the plan changes"));
    assert.strictEqual(S.handoffs.security.data.findings.high, 1);
    assert.ok(S.handoffs.final.data.text.startsWith("# The Plan, Reviewed"));
    const got = srv.sessions.get(S.sessionId);
    assert.strictEqual(got.session.title, "The Plan, Reviewed", "named after the reviewed plan");
    assert.deepStrictEqual(nodes(got), ROUND(1).concat(["1:final", "1:scaling", "1:security"]).sort());
    assert.strictEqual(got.handoffs.find(x => x.node === "brief").data.review, true);

    // Opened again, it still has its final review.
    const h2 = open(srv, { hash: "#session=" + S.sessionId });
    await waitFor(() => h2.win.__quorum.S.sessionId === S.sessionId, 5000, "the session to open");
    await sleep(40);
    const d2 = h2.doc;
    assert.strictEqual(h2.win.__quorum.S.phase, "done");
    assert.ok(d2.getElementById("reviewOn").checked);
    assert.ok(!d2.getElementById("sec-review").hidden);
    assert.strictEqual(txt(d2.querySelector("#tab-security .tab-title")), "1 high");
    assert.ok(txt(d2.getElementById("planDoc")).startsWith("The Plan, Reviewed"));
    assert.ok(!d2.getElementById("planDraft").hidden);
    srv.close();
  });

  server.close();
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(logFile, { force: true });
  fs.rmSync(pidFile, { force: true });
  console.log(passed + " local server tests passed" + (process.exitCode ? " (with failures)" : ""));
  process.exit(process.exitCode || 0);
})();
