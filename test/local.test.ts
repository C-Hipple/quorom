// In-page tests for Quorum served by serve.ts: the page runs in jsdom against the real local server, with a
// stand-in for Claude Code, so a project folder can be chosen and seats run inside it.
import { afterAll, test } from "bun:test";
import { JSDOM } from "jsdom";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, type QuorumServer, type ServerOptions } from "../serve";
import { fakeOpenAI, seatAgent } from "./fake-openai";

const html = fs.readFileSync(path.join(import.meta.dir, "..", "dist", "quorum.html"), "utf8");
const FAKE = { command: process.execPath, args: [path.join(import.meta.dir, "fake-claude.ts")] };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const txt = (el: Element) => (el.textContent || "").replace(/\s+/g, " ").trim();

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quorum-local-"));
  ["src", "docs"].forEach(d => fs.mkdirSync(path.join(dir, d)));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Notes\n");
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# How it's built\nEverything is in src/app.js.\n");
  fs.writeFileSync(path.join(dir, "src", "app.js"), "export function app() {}\nexport const version = 1;\n");
  return fs.realpathSync(dir);
}

// The tests read what a server with a database saved straight from its sessions.
async function listen(opts?: ServerOptions): Promise<QuorumServer & { sessions: any }> {
  return startServer(Object.assign({ claude: FAKE, port: 0 }, opts));
}

// The page, opened from the server. Its requests go to the server through Bun's fetch. win and doc are the page's own
// window and document, which the tests reach into freely.
function open(server: QuorumServer, opts: { hash?: string, questions?: boolean, storage?: Record<string, string> } = {}): { dom: JSDOM, win: any, doc: any } {
  const base = "http://localhost:" + server.port + "/";
  const dom = new JSDOM(html, {
    url: base + (opts.hash || ""),
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w: any) {
      w.__QUORUM_TEST__ = true;
      if (!opts.questions) w.localStorage.setItem("quorum:questions", "off");
      Object.keys(opts.storage || {}).forEach(k => w.localStorage.setItem(k, (opts.storage as Record<string, string>)[k]));
      w.fetch = (url: string, init?: RequestInit) => fetch(new URL(url, base), init);
      w.AbortController = AbortController;
      w.TextDecoder = TextDecoder;
      w.Element.prototype.scrollIntoView = function () {};
      w.console.error = (...a: unknown[]) => console.log("[page error]", ...a);
    },
  });
  return { dom, win: dom.window, doc: dom.window.document };
}

type Page = ReturnType<typeof open>;

async function waitFor(fn: () => unknown, ms = 8000, label = "condition") {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await sleep(10); }
  throw new Error("Timed out waiting for " + label);
}
function type(h: Page, id: string, value: string, ev = "input") {
  const el = h.doc.getElementById(id);
  el.value = value;
  el.dispatchEvent(new h.win.Event(ev, { bubbles: true }));
}
async function ready(h: Page) {
  await waitFor(() => !h.doc.getElementById("project").hidden || /bun start|find Claude Code/.test(txt(h.doc.getElementById("status-claude-code"))), 5000, "the local server");
  await waitFor(() => !/Looking/.test(txt(h.doc.getElementById("projectStatus"))), 5000, "the project lookup");
}
async function convene(h: Page, feature: string) {
  h.doc.getElementById("feature").value = feature;
  h.doc.getElementById("convene").click();
}
const logLines = (file: string): any[] => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

const project = tmpProject();
const logFile = path.join(os.tmpdir(), "quorum-local-" + process.pid + ".log");
const pidFile = path.join(os.tmpdir(), "quorum-local-" + process.pid + ".pids");
const env = Object.assign({}, process.env, { FAKE_LOG: logFile, FAKE_PID_FILE: pidFile });
const server = await listen({ project, env });
afterAll(async () => {
  await server.stop();
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(logFile, { force: true });
  fs.rmSync(pidFile, { force: true });
});

test("served by Quorum's server, the page offers the project folder and puts every seat on Claude Code", async () => {
  const h = open(server);
  const { doc } = h;
  await ready(h);
  assert.ok(!doc.getElementById("project").hidden);
  assert.strictEqual(doc.getElementById("projectPath").value, project, "the folder given to bun start");
  assert.strictEqual(txt(doc.getElementById("projectStatus")), "Found " + path.basename(project) + ", a Git repository on main. It has a CLAUDE.md, which Claude Code reads, and an AGENTS.md, which agents on OpenRouter and other endpoints read.");
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
  assert.strictEqual(txt(doc.getElementById("settingsHint")), "Agents on Claude Code explore the project before they write, so their seats can take a few minutes.");
});

test("browsing chooses the project folder", async () => {
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

test("a path that isn't a folder, or no folder at all, stops the council convening", async () => {
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
  assert.strictEqual(txt(doc.getElementById("projectStatus")), "Choose the project folder for the agents to work in.");
  assert.strictEqual(win.__quorum.S.phase, "idle");
  assert.strictEqual(logLines(logFile).length, before, "Claude Code wasn't run");
});

test("a whole session runs on Claude Code inside the project folder", async () => {
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
  const all = logLines(logFile), naming = all.filter(r => /^Name a session/.test(r.prompt)), runs = all.filter(r => !naming.includes(r));
  assert.strictEqual(naming.length, 1, "the Chair's agent named the session");
  assert.strictEqual(naming[0].args[naming[0].args.indexOf("--model") + 1], "opus");
  assert.strictEqual(naming[0].cwd, project);
  assert.strictEqual(runs.length, 7);
  runs.forEach(r => {
    assert.strictEqual(r.cwd, project, "every seat runs inside the project");
    assert.ok(r.prompt.includes("You're running inside the project's folder, " + project + ", with tools that can read and search its files but not change them."), r.prompt.slice(0, 300));
    assert.ok(r.args.includes("--tools") && r.args[r.args.indexOf("--tools") + 1] === "Read,Grep,Glob");
  });
  const model = (r: any) => (r.args.indexOf("--model") >= 0 ? r.args[r.args.indexOf("--model") + 1] : "");
  const seat = (r: any) => (/^You are (The \w+|the Chair)/.exec(r.prompt) || [])[1];
  assert.deepStrictEqual(runs.map(r => seat(r) + ":" + model(r)).sort(), [
    "The Advocate:", "The Architect:sonnet", "The Pragmatist:sonnet", "The Skeptic:", "The Strategist:", "The Visionary:sonnet", "the Chair:opus"]);
  // The rail sums what the agents used by model: each run used 1,200 tokens in, 300 out and $0.0123.
  assert.ok(!doc.getElementById("railUsage").hidden);
  assert.deepStrictEqual([...doc.querySelectorAll("#railUsageList li")].map(txt), [
    "claude-sonnet-fake via Claude Code 3.6k in \u00B7 900 out \u00B7 $0.0369",
    "claude-default-fake via Claude Code 3.6k in \u00B7 900 out \u00B7 $0.0369",
    "claude-opus-fake via Claude Code 1.2k in \u00B7 300 out \u00B7 $0.0123",
    "Total 8.4k in \u00B7 2.1k out \u00B7 $0.0861",
  ]);
  const S = win.__quorum.S;
  assert.ok(S.seats.A.text.includes("Ran in " + project), "the answer came from inside the project");
  assert.ok(!S.seats.A.text.includes("Let me look first."), "the preamble before exploring isn't part of the proposal");
  assert.strictEqual(txt(doc.getElementById("propTier")), "Agent: claude-sonnet-fake via Claude Code");
  assert.strictEqual(doc.getElementById("propTier").title, "Claude Code: claude-sonnet-fake");
  assert.strictEqual(txt(doc.getElementById("planTier")), "Agent: claude-opus-fake via Claude Code");
  assert.strictEqual(txt(doc.getElementById("verdict")), "Proposal A, “Pragmatist Route”, wins with 9 of 9 possible points. Every councilor ranked it first.");
  const planned = S.handoffs.brief.data.project;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(planned)), { path: project, name: path.basename(project) });

  // The Pragmatist's whole conversation: what it was sent, what it thought and said, what it read, and its answer.
  doc.getElementById("propConvo").click();
  await sleep(40);
  assert.strictEqual(txt(doc.getElementById("convoMeta")), "claude-sonnet-fake via Claude Code \u00B7 in " + project + " \u00B7 Finished after 0:0" +
    /Finished after 0:0(\d)/.exec(txt(doc.getElementById("convoMeta")))![1] + " \u00B7 2 turns \u00B7 1,200 tokens in, 300 out \u00B7 $0.0123");
  const turns = [...doc.querySelectorAll("#convoBody > *")];
  assert.deepStrictEqual(turns.map(el => el.className), ["turn is-prompt", "turn is-thinking", "turn is-text", "turn is-tool", "turn is-answer"]);
  assert.strictEqual(turns[0].querySelector("pre").textContent, runs.find(r => seat(r) === "The Pragmatist").prompt, "what Claude Code was given");
  assert.strictEqual(turns[1].querySelector("pre").textContent, "I should read the app first.");
  assert.strictEqual(txt(turns[2].querySelector(".turn-head")), "The Pragmatist wrote");
  assert.strictEqual(txt(turns[2].querySelector(".turn-doc")), "Let me look first.", "what it said before it explored");
  assert.strictEqual(txt(turns[3].querySelector("summary")), "Read " + path.join("src", "app.js") + " \u00B7 2 lines");
  assert.deepStrictEqual([...turns[3].querySelectorAll(".turn-label")].map(txt), ["Input", "What came back"]);
  assert.deepStrictEqual(JSON.parse(turns[3].querySelectorAll("pre")[0].textContent), { file_path: path.join(project, "src", "app.js") });
  assert.strictEqual(turns[3].querySelectorAll("pre")[1].textContent, "export function app() {}\nexport const version = 1;\n", "exactly what it read");
  assert.strictEqual(txt(turns[4].querySelector(".turn-head")), "The Pragmatist\u2019s answer");
  assert.strictEqual(txt(turns[4].querySelector(".turn-doc h1")), "Pragmatist Route");
  doc.getElementById("convoClose").click();
});

test("Claude Code's problems pause the session with advice for Claude Code", async () => {
  const h = open(server);
  const { doc, win } = h;
  await ready(h);
  await convene(h, "Add CSV export. FAKE:auth");
  await waitFor(() => win.__quorum.S.phase === "paused", 8000, "paused");
  await sleep(30);
  assert.strictEqual(txt(doc.getElementById("noticeText")), "The Pragmatist, the Visionary and the Architect couldn't finish. Claude Code isn't signed in. Run claude in a terminal and sign in, then retry.");
  assert.strictEqual(txt(doc.getElementById("propNote")), "Claude Code isn't signed in.");
});

test("stopping the session stops Claude Code", async () => {
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

test("without Claude Code installed, it's offered but switched off", async () => {
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
  await bare.stop();
});

// Puts every role on a provider, with a model if it's given.
function every(h: Page, provider: string, model?: string) {
  ["builders", "council", "chair"].forEach(r => {
    type(h, "provider-" + r, provider, "change");
    if (model !== undefined) type(h, "model-" + r, model);
  });
}

test("a whole session runs on OpenRouter, each seat an agent inside the project folder", async () => {
  const service = fakeOpenAI(seatAgent);
  const srv = await listen({ project, env, openrouter: service.url });
  const h = open(srv);
  const { doc, win } = h;
  await ready(h);
  every(h, "openrouter");
  assert.deepStrictEqual(["builders", "council", "chair"].map(r => doc.getElementById("model-" + r).value), ["z-ai/glm-5.3", "z-ai/glm-5.3", "z-ai/glm-5.3"]);
  await convene(h, "Add CSV export.");
  await sleep(20);
  assert.strictEqual(txt(doc.getElementById("agentsNote")), "Add your OpenRouter API key under Providers.");
  type(h, "key-openrouter", "sk-or-test");
  assert.strictEqual(txt(doc.getElementById("settingsHint")), "Agents on OpenRouter explore the project before they write, so their seats can take a few minutes. OpenRouter bills your account for each request, and an agent makes several as it explores.");
  assert.ok(doc.getElementById("railUsage").hidden, "nothing used yet");
  await convene(h, "Add CSV export.");
  // What an agent has used shows while it's still working, after its first turn.
  await waitFor(() => !doc.getElementById("railUsage").hidden && win.__quorum.S.phase === "running", 8000, "tokens while the agents work");
  await waitFor(() => win.__quorum.S.phase === "done", 20000, "done");
  await sleep(40);
  // Seven seats each made two requests and the Chair's agent one to name the session, each 100 tokens in and 20 out.
  assert.deepStrictEqual([...doc.querySelectorAll("#railUsageList li")].map(txt), ["glm-5.3 via OpenRouter 1.5k in \u00B7 300 out \u00B7 $0.0150"]);
  await sleep(40);
  const S = win.__quorum.S;
  assert.ok(["A", "B", "C", "advocate", "chair"].every(id => S.handoffs[id].data.text.includes("Ran in " + project)), "every seat worked in the project");
  assert.strictEqual(service.requests.length, 15, "each seat read a file, then answered, and the Chair's agent named the session");
  service.requests.filter(r => !/^Name a session/.test(r.body.messages[1].content)).forEach(r => {
    assert.strictEqual(r.headers.get("authorization"), "Bearer sk-or-test");
    assert.strictEqual(r.body.model, "z-ai/glm-5.3");
    assert.ok(r.body.messages[0].content.includes("=== AGENTS.md ===\n# How it's built\nEverything is in src/app.js.\n=== End of AGENTS.md ==="));
    assert.ok(r.body.messages[1].content.includes("You're running inside the project's folder, " + project + ", with tools that can read and search its files but not change them."));
  });
  assert.strictEqual(txt(doc.getElementById("propTier")), "Agent: glm-5.3 via OpenRouter");
  doc.getElementById("propConvo").click();
  await waitFor(() => doc.querySelector("#convoBody .turn.is-answer"), 3000, "the conversation");
  assert.ok(/^glm-5\.3 via OpenRouter \u00B7 in /.test(txt(doc.getElementById("convoMeta"))), txt(doc.getElementById("convoMeta")));
  assert.strictEqual(txt(doc.querySelector("#convoBody details.is-thinking pre")), "I should read the app first.");
  assert.strictEqual(txt(doc.querySelector("#convoBody .turn.is-tool summary")), "Read " + path.join("src", "app.js") + " \u00B7 2 lines");
  assert.ok(txt(doc.querySelector("#convoBody .turn.is-answer")).includes("Ran in " + project));
  await srv.stop();
  await service.stop();
});

test("a model that can't use tools, or a rejected key, pauses the session with advice", async () => {
  const service = fakeOpenAI(req => {
    if (req.body.model !== "z-ai/glm-5.3") return { status: 404, error: { error: { code: 404, message: "No endpoints found that support tool use." } } };
    if (req.headers.get("authorization") !== "Bearer sk-or-right") return { status: 401, error: { error: { code: 401, message: "No auth credentials found" } } };
    return seatAgent(req);
  });
  const srv = await listen({ project, env, openrouter: service.url });
  const h = open(srv);
  const { doc, win } = h;
  await ready(h);
  every(h, "openrouter", "nousresearch/hermes-4-405b");
  type(h, "key-openrouter", "sk-or-wrong");
  await convene(h, "Add CSV export.");
  await waitFor(() => win.__quorum.S.phase === "paused", 8000, "paused");
  await sleep(30);
  assert.strictEqual(txt(doc.getElementById("noticeText")), "The Pragmatist, the Visionary and the Architect couldn't finish. The model can't use tools on OpenRouter, and every seat there works as an agent. Choose a model that supports tool calling under Agents, then retry.");
  every(h, "openrouter", "z-ai/glm-5.3");
  doc.getElementById("noticeRetry").click();
  await waitFor(() => win.__quorum.S.phase === "paused" && /rejected/.test(txt(doc.getElementById("noticeText"))), 8000, "paused again");
  assert.strictEqual(txt(doc.getElementById("noticeText")), "The Pragmatist, the Visionary and the Architect couldn't finish. OpenRouter rejected the API key. Check it under Providers, then retry.");
  assert.strictEqual(txt(doc.getElementById("propNote")), "OpenRouter rejected the API key.");
  type(h, "key-openrouter", "sk-or-right");
  doc.getElementById("noticeRetry").click();
  await waitFor(() => win.__quorum.S.phase === "done", 20000, "done");
  await srv.stop();
  await service.stop();
});

test("any OpenAI-compatible endpoint works through Quorum's server", async () => {
  const service = fakeOpenAI(seatAgent);
  const srv = await listen({ project, env });
  const h = open(srv);
  const { doc, win } = h;
  await ready(h);
  every(h, "custom");
  await convene(h, "Add CSV export.");
  await sleep(20);
  assert.strictEqual(txt(doc.getElementById("agentsNote")), "Enter a model for the builders.");
  every(h, "custom", "llama3.1:8b");
  await convene(h, "Add CSV export.");
  await sleep(20);
  assert.strictEqual(txt(doc.getElementById("agentsNote")), "Add the address of your endpoint under Providers.");
  type(h, "url-custom", service.url + "/");
  type(h, "key-custom", "ollama");
  doc.getElementById("check-custom").click();
  await waitFor(() => /Connected/.test(txt(doc.getElementById("status-custom"))), 3000, "the check");
  assert.strictEqual(txt(doc.getElementById("status-custom")), "Connected. It offers \u201Cglm-test\u201D and \u201Cother-model\u201D.");
  await convene(h, "Add CSV export.");
  await waitFor(() => win.__quorum.S.phase === "done", 20000, "done");
  assert.ok(service.requests.every(r => r.path === "/v1/chat/completions" && r.body.model === "llama3.1:8b" && r.headers.get("authorization") === "Bearer ollama"));
  assert.strictEqual(txt(doc.getElementById("planTier")), "Agent: llama3.1:8b via 127.0.0.1:" + new URL(service.url).port);
  await srv.stop();
  await service.stop();
});

test("stopping a session on OpenRouter closes its agents' requests", async () => {
  const service = fakeOpenAI(() => ({ text: "Starting", hang: true, wait: 20 }));
  const srv = await listen({ project, env, openrouter: service.url });
  const h = open(srv);
  const { doc, win } = h;
  await ready(h);
  every(h, "openrouter");
  type(h, "key-openrouter", "sk-or-test");
  await convene(h, "Add CSV export.");
  await waitFor(() => service.requests.length === 4 && win.__quorum.S.seats.A.status === "writing", 8000, "three builders writing, and the session being named");
  await sleep(450);
  doc.getElementById("railStop").click();
  await waitFor(() => service.aborted === 4, 5000, "the requests to close");
  assert.strictEqual(win.__quorum.S.phase, "stopped");
  await srv.stop();
  await service.stop();
});

const dbFile = path.join(project, ".quorum", "quorum.db");
const S = (win: any) => win.__quorum.S;
const seatOf = (r: { prompt: string }) => (/^You are (The \w+ Reviewer|The \w+|the Chair)/.exec(r.prompt) || [])[1];
const nodes = (got: any) => got.handoffs.map((x: any) => x.round + ":" + x.node).sort();
const ROUND = (r: number) => ["A", "B", "C", "advocate", "brief", "chair", "revision", "skeptic", "strategist", "tally"].map(n => r + ":" + n);

test("a session is saved as it runs, and the address names it", async () => {
  const srv = await listen({ project, env, db: dbFile });
  const h = open(srv);
  const { doc, win } = h;
  await ready(h);
  await waitFor(() => txt(doc.getElementById("sessionsStatus")) === "None yet", 3000, "the list");
  assert.ok(!doc.getElementById("openHistory").hidden, "History is offered at the foot of the rail");
  assert.ok(doc.getElementById("historyDrawer").hidden);
  doc.getElementById("openHistory").click();
  await sleep(20);
  assert.ok(!doc.getElementById("historyDrawer").hidden);
  assert.strictEqual(doc.activeElement.id, "historyTitle");
  assert.strictEqual(doc.getElementById("openHistory").getAttribute("aria-expanded"), "true");
  doc.getElementById("historyDrawer").dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.ok(doc.getElementById("historyDrawer").hidden, "Escape closes it");
  assert.strictEqual(doc.activeElement.id, "openHistory", "and focus goes back");
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
  assert.strictEqual(got.session.title, "Session on Add CSV export", "named by the Chair's agent");
  assert.strictEqual(got.session.project, project);
  assert.deepStrictEqual(nodes(got), ROUND(1), "every step's handoff is saved");
  assert.strictEqual(got.handoffs.find((x: any) => x.node === "A").data.text, win.__quorum.S.handoffs.A.data.text);
  assert.ok(got.session.elapsed > 0);
  assert.deepStrictEqual([...doc.querySelectorAll("#sessionList .session-open")].map(txt), ["Session on Add CSV export"]);
  assert.ok(/Plan ready · .* · Open now$/.test(txt(doc.querySelector("#sessionList .session-meta"))), txt(doc.querySelector("#sessionList .session-meta")));

  // Every step's conversation is saved with the session, and a page that opens it again can read them.
  const convos = srv.sessions.transcripts(id);
  assert.deepStrictEqual(convos.map((x: any) => x.round + ":" + x.node).sort(), ROUND(1).filter(n => !/brief|revision|tally/.test(n)));
  convos.forEach((x: any) => {
    assert.strictEqual(x.data.status, "done", x.node);
    assert.deepStrictEqual(x.data.entries.map((e: any) => e.type), ["prompt", "thinking", "text", "tool", "text"], x.node);
    assert.ok(x.data.entries[3].result.includes("export const version = 1;"), x.node);
    assert.strictEqual(x.data.entries[4].text, S(win).handoffs[x.node].data.text, "the answer is the one handed on");
    assert.strictEqual(x.data.sid, undefined, "the page's own bookkeeping isn't saved");
  });
  const h2 = open(srv, { hash: "#session=" + id });
  await waitFor(() => S(h2.win).sessionId === id, 5000, "the session to open");
  await sleep(30);
  h2.doc.getElementById("tab-skeptic").click();
  await sleep(20);
  h2.doc.getElementById("councilConvo").click();
  await waitFor(() => h2.doc.querySelector("#convoBody .turn.is-tool"), 3000, "the conversation to load");
  assert.strictEqual(h2.doc.getElementById("convoStep").value, "1:skeptic");
  assert.ok(!h2.doc.querySelector("#convoBody .convo-note"), "the saved conversation, not a rebuilt one");
  assert.strictEqual(txt(h2.doc.querySelector("#convoBody .turn.is-tool summary")), "Read " + path.join("src", "app.js") + " \u00B7 2 lines");
  assert.ok(txt(h2.doc.getElementById("convoMeta")).startsWith("claude-default-fake via Claude Code \u00B7 in " + project));
  await srv.stop();
});

test("stopping the app mid-session and coming back carries on where it got to", async () => {
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
  await srv.stop();
  await sleep(100);

  const srv2 = await listen({ project, env, db: dbFile });
  const h2 = open(srv2);
  const { doc, win } = h2;
  await ready(h2);
  await waitFor(() => doc.querySelectorAll("#sessionList .session-item").length === 2, 3000, "the list");
  assert.strictEqual(txt(doc.getElementById("historyBadge")), "1 unfinished session", "History counts the unfinished session");
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
  await srv2.stop();
});

test("input on the plan starts a new round, saved with the session", async () => {
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
  const runs = logLines(logFile).filter(r => !/^Name a session/.test(r.prompt));
  assert.strictEqual(runs.length, 14, "the session is named once, not again in round 2");
  assert.strictEqual(logLines(logFile).length, 15);
  runs.slice(7).forEach(r => {
    assert.strictEqual(r.cwd, project, "revisions run inside the project too");
    assert.ok(r.prompt.includes("Why not stream the file? Admins must see who exported what."));
  });
  const got = srv.sessions.get(id);
  assert.strictEqual(got.session.round, 2);
  assert.deepStrictEqual(nodes(got), ROUND(1).concat(ROUND(2)).sort());
  const rev = got.handoffs.find((x: any) => x.round === 2 && x.node === "revision").data;
  assert.strictEqual(rev.input, "Why not stream the file? Admins must see who exported what.");
  assert.strictEqual(rev.previous.plan, got.handoffs.find((x: any) => x.round === 1 && x.node === "chair").data.text);

  // Opened again from its address, the session is in round 2, with round 1 behind it.
  const h2 = open(srv, { hash: "#session=" + id });
  await waitFor(() => h2.win.__quorum.S.sessionId === id, 5000, "the session to open");
  const S2 = h2.win.__quorum.S;
  assert.strictEqual(S2.round, 2);
  assert.strictEqual(S2.phase, "done");
  assert.strictEqual(S2.past.length, 1);
  assert.strictEqual(S2.past[0].chair.data.text, got.handoffs.find((x: any) => x.round === 1 && x.node === "chair").data.text);
  await sleep(30);
  assert.strictEqual(h2.doc.getElementById("motionRoundQuote").textContent, "Why not stream the file? Admins must see who exported what.");
  assert.strictEqual(h2.doc.querySelectorAll("#roundsList .round").length, 1);
  assert.ok(!h2.doc.getElementById("revise").hidden, "and ready for more input");
  assert.ok(/^Round 2 · Adjourned after/.test(txt(h2.doc.getElementById("clock"))));
  await srv.stop();
});

test("saved sessions can be deleted from the list", async () => {
  const srv = await listen({ project, env, db: dbFile });
  const h = open(srv);
  const { doc } = h;
  await ready(h);
  await waitFor(() => doc.querySelectorAll("#sessionList .session-item").length === 3, 3000, "the list");
  assert.strictEqual(txt(doc.getElementById("sessionsStatus")), "3 sessions");
  assert.ok(doc.getElementById("historyBadge").hidden, "nothing unfinished to count");
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
  await srv.stop();
});

test("a final review runs inside the project too, and is saved with the session", async () => {
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
  assert.strictEqual(got.session.title, "Session on Add CSV export", "named by the Chair's agent");
  assert.deepStrictEqual(nodes(got), ROUND(1).concat(["1:final", "1:scaling", "1:security"]).sort());
  assert.strictEqual(got.handoffs.find((x: any) => x.node === "brief").data.review, true);

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
  await srv.stop();
});

