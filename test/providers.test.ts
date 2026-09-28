// In-page tests for running Quorum on its own, without Quorum's local server: Hermes Agent, which the page asks
// directly, and the providers whose agents need the server. QUORUM_HTML names another build of the page to test instead
// of dist/quorum.html. Agents on the server are tested in local.test.ts.
import { test } from "bun:test";
import { JSDOM } from "jsdom";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(process.env.QUORUM_HTML || path.join(import.meta.dir, "..", "dist", "quorum.html"), "utf8");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const txt = (el: Element) => (el.textContent || "").replace(/\s+/g, " ").trim();

const TITLES: Record<string, string> = { A: "Shelf Share", B: "Lend Loop", C: "Tool Commons" };
const builderText = (L: string) => `# ${TITLES[L]}\n> Pitch for ${L}.\n\n## The approach\nConcrete.\n\n## What changes\n- One\n\n## How we'd build it\n1. Step\n\n## Testing and rollout\nTests.\n\n## Risks and trade-offs\nSome.\n\n## Why the council should choose this\nIt works.`;
const BALLOTS: Record<string, [string[], Record<string, number>]> = { advocate: [["B", "A", "C"], { A: 7, B: 9, C: 4 }], skeptic: [["A", "B", "C"], { A: 8, B: 7, C: 3 }], strategist: [["B", "C", "A"], { A: 5, B: 8, C: 6 }] };
const councilText = (id: string) => `## Verdict\nI favor ${BALLOTS[id][0][0]}.\n\n## A: x\nok\n\n## B: y\nok\n\n## C: z\nok\n\n## Worth keeping\nBins.\n\n\`\`\`json\n${JSON.stringify({ ranking: BALLOTS[id][0], scores: BALLOTS[id][1] })}\n\`\`\``;
const chairText = "# The Plan\nSummary.\n\n## The decision\nB won.\n\n## Requirements\n- Met\n\n## Implementation steps\n1. Build";

function who(prompt: string): string {
  const m = /^You are (The \w+|the Chair)/.exec(prompt);
  const name = m ? m[1] : "";
  if (prompt.startsWith("Name a session of Quorum")) return "name";
  return ({ "The Pragmatist": "A", "The Visionary": "B", "The Architect": "C", "The Advocate": "advocate", "The Skeptic": "skeptic", "The Strategist": "strategist", "the Chair": "chair" } as Record<string, string>)[name] || "?";
}
function textFor(id: string): string {
  if (id === "name") return "Shared Tool Library for Neighbors, With Bins and a Sign-out Sheet";
  if (["A", "B", "C"].includes(id)) return builderText(id);
  if (id === "chair") return chairText;
  return councilText(id);
}

// An OpenAI-compatible server: streams SSE, optionally with comments, tool events and <think> traces.
// o: { model, tool, reasoning, think, midError, finish, delay }
function sseResponse(text: string, o: Record<string, any>, signal?: AbortSignal | null): Response {
  const enc = new TextEncoder();
  const frames = [": OPENROUTER PROCESSING\n\n"];
  if (o.tool) frames.push("event: hermes.tool.progress\ndata: {\"tool\":\"read_file\"}\n\n");
  if (o.reasoning) ["Weigh the ", "options."].forEach(r => frames.push("data: " + JSON.stringify({ model: o.model, choices: [{ index: 0, delta: { content: "", reasoning: r } }] }) + "\n\n"));
  const body = (o.think ? "<think>Let me plan this.</think>\n" : "") + text;
  (body.match(/[\s\S]{1,30}/g) || []).forEach(p => frames.push("data: " + JSON.stringify({ model: o.model, choices: [{ index: 0, delta: { content: p } }] }) + "\n\n"));
  if (o.midError) frames.splice(3, frames.length, "data: " + JSON.stringify({ error: { code: "server_error", message: "Provider disconnected unexpectedly" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] }) + "\n\n");
  else {
    frames.push("data: " + JSON.stringify({ model: o.model, choices: [{ index: 0, delta: { content: "" }, finish_reason: o.finish || "stop" }] }) + "\n\n");
    frames.push("data: " + JSON.stringify({ model: o.model, choices: [{ index: 0, delta: { content: "" }, finish_reason: o.finish || "stop" }], usage: { total_tokens: 10 } }) + "\n\n");
    frames.push("data: [DONE]\n\n");
  }
  let i = 0, timer: ReturnType<typeof setTimeout> | undefined, over = false;
  const stream = new ReadableStream({
    start(c) {
      if (signal) signal.addEventListener("abort", () => { over = true; clearTimeout(timer); try { c.error(Object.assign(new Error("aborted"), { name: "AbortError" })); } catch (_) {} });
      const push = () => {
        if (over) return;
        try {
          if (i >= frames.length) { over = true; c.close(); return; }
          // split frames across chunks to exercise buffering
          const f = frames[i++];
          const cut = Math.floor(f.length / 2);
          c.enqueue(enc.encode(f.slice(0, cut)));
          c.enqueue(enc.encode(f.slice(cut)));
        } catch (_) { over = true; return; }
        timer = setTimeout(push, o.delay || 1);
      };
      push();
    },
    cancel() { over = true; clearTimeout(timer); },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function jsonResponse(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

interface HarnessOptions {
  url?: string;
  questions?: boolean;
  storage?: Record<string, string>;
  // How the fake services answer a request: { reject }, { response }, { sse } options, or null for the usual answer.
  behavior?: (req: Sent, requests: Sent[]) => any;
}

// The page in jsdom, with fetch answered by fake services. win and doc are the page's own window and document, which
// the tests reach into freely.
function makeHarness(opts: HarnessOptions = {}): { dom: JSDOM, win: any, doc: any, requests: Sent[], downloads: string[] } {
  const requests: Sent[] = [];
  const downloads: string[] = [];
  const behavior = opts.behavior || (() => null);
  const fetchMock = async (url: string, init: RequestInit = {}) => {
    const req: Sent = { url: String(url), method: init.method || "GET", headers: Object.assign({}, init.headers as Record<string, string> | undefined), body: init.body ? JSON.parse(init.body as string) : null };
    requests.push(req);
    const special = behavior(req, requests);
    if (special && special.reject) throw new TypeError("Failed to fetch");
    if (special && special.response) return special.response;
    if (req.method === "GET" && /\/models$/.test(req.url)) {
      if (/openrouter\.ai/.test(req.url)) return jsonResponse(200, { data: [{ id: "anthropic/claude-opus-5.5", name: "Anthropic: Claude Opus" }, { id: "nousresearch/hermes-4-70b", name: "Nous: Hermes 4 70B" }] });
      return jsonResponse(200, { object: "list", data: [{ id: "hermes-agent", object: "model" }] });
    }
    const prompt = req.body.messages[0].content;
    const id = who(prompt);
    return sseResponse(textFor(id), Object.assign({ model: req.body.model }, (special && special.sse) || {}), init.signal);
  };
  const dom = new JSDOM(html, {
    url: opts.url || "https://example.org/quorum/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w: any) {
      w.__QUORUM_TEST__ = true;
      // A page opened from a file has no storage, and asking for it throws.
      let storage = null;
      try { storage = w.localStorage; } catch (_) { storage = null; }
      if (!opts.questions && storage) storage.setItem("quorum:questions", "off");
      Object.keys(opts.storage || {}).forEach(k => w.localStorage.setItem(k, (opts.storage as Record<string, string>)[k]));
      w.fetch = fetchMock;
      w.TextDecoder = TextDecoder;
      w.Element.prototype.scrollIntoView = function () {};
      w.URL.createObjectURL = () => "blob:quorum";
      w.URL.revokeObjectURL = () => {};
      w.HTMLAnchorElement.prototype.click = function (this: Element) { downloads.push(this.getAttribute("download") as string); };
      w.console.error = (...a: unknown[]) => console.log("[page error]", ...a);
    },
  });
  return { dom, win: dom.window, doc: dom.window.document, requests, downloads };
}

async function waitFor(fn: () => unknown, ms = 8000, label = "condition") {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await sleep(10); }
  throw new Error("Timed out waiting for " + label);
}
type Harness = ReturnType<typeof makeHarness>;

function type(h: Harness, id: string, value: string, ev = "input") {
  const el = h.doc.getElementById(id);
  el.value = value;
  el.dispatchEvent(new h.win.Event(ev, { bubbles: true }));
}
async function convene(h: Harness, feature = "Let users export reports as CSV.") {
  await sleep(20);
  h.doc.getElementById("feature").value = feature;
  h.doc.getElementById("convene").click();
}
const chats = (h: Harness) => h.requests.filter(r => r.method === "POST");

const ROLE_IDS = ["builders", "council", "chair"];
// Puts every role on Hermes Agent, with its key.
function onHermes(h: Harness) {
  ROLE_IDS.forEach(r => type(h, "provider-" + r, "hermes", "change"));
  type(h, "key-hermes", "local-secret");
}

test("on its own, Quorum defaults to OpenRouter, whose agents need Quorum's server", async () => {
  const h = makeHarness();
  const { doc } = h;
  await sleep(40);
  assert.deepStrictEqual(ROLE_IDS.map(r => doc.getElementById("provider-" + r).value + " " + doc.getElementById("model-" + r).value),
    ["openrouter z-ai/glm-5.3", "openrouter z-ai/glm-5.3", "openrouter z-ai/glm-5.3"]);
  assert.ok(doc.getElementById("tier-builders").hidden);
  assert.strictEqual(doc.getElementById("model-builders").getAttribute("list"), "models-openrouter");
  const option = (p: string) => doc.querySelector('#provider-builders option[value="' + p + '"]');
  assert.ok(option("claude").disabled);
  assert.strictEqual(option("claude").textContent, "Claude (inside claude.ai only)");
  ["claude-code", "openrouter", "custom"].forEach(p => assert.ok(option(p).disabled, p + " needs Quorum's local server"));
  assert.deepStrictEqual(["claude-code", "openrouter", "custom"].map(p => option(p).textContent),
    ["Claude Code (needs bun start)", "OpenRouter (needs bun start)", "Other endpoint (needs bun start)"]);
  assert.ok(!option("hermes").disabled, "Hermes Agent is asked directly");
  assert.ok(doc.getElementById("project").hidden, "no project folder without the local server");
  assert.ok(doc.getElementById("providers").open, "providers panel opens until something is set up");
  assert.strictEqual(txt(doc.getElementById("providersStatus")), "OpenRouter needs setting up");
  assert.ok(txt(doc.getElementById("help-hermes")).includes("API_SERVER_CORS_ORIGINS=https://example.org"));
  const ids = [...doc.querySelectorAll("#models-openrouter option")].map((o: any) => o.value);
  assert.ok(ids.includes("anthropic/claude-opus-5.5") && ids[0] === "z-ai/glm-5.3", "live model list merged after the presets: " + ids.join(","));
  // The agents are summed up beside Convene, and set in Settings, at the foot of the rail.
  assert.strictEqual(txt(doc.getElementById("agentsSummary")), "Builders on glm-5.3 via OpenRouter, the council on glm-5.3 via OpenRouter and the Chair on glm-5.3 via OpenRouter.");
  assert.ok(doc.getElementById("settingsDrawer").hidden);
  assert.ok(!doc.getElementById("settingsBadge").hidden, "Settings says a provider needs setting up");
  assert.ok(doc.getElementById("openHistory").hidden, "no History without Quorum's server");
  doc.getElementById("changeAgents").click();
  await sleep(10);
  assert.ok(!doc.getElementById("settingsDrawer").hidden);
  assert.strictEqual(doc.activeElement.id, "settingsTitle");
  type(h, "key-openrouter", "sk-or-test");
  assert.ok(doc.getElementById("settingsBadge").hidden, "set up now");
  doc.querySelector("#settingsDrawer .drawer-scrim").click();
  assert.ok(doc.getElementById("settingsDrawer").hidden, "the scrim closes it");
  assert.strictEqual(doc.activeElement.id, "changeAgents");
  await convene(h);
  await sleep(20);
  assert.strictEqual(chats(h).length, 0);
  assert.strictEqual(txt(doc.getElementById("agentsNote")), "OpenRouter runs through Quorum's local server. Start it with bun start and open Quorum at the address it prints, or choose another provider for the builders.");
  assert.ok(!doc.getElementById("settingsDrawer").hidden, "Settings opens on what needs changing");
  assert.strictEqual(doc.activeElement.id, "provider-builders");
  assert.strictEqual(txt(doc.getElementById("settingsNote")), txt(doc.getElementById("agentsNote")));
  doc.querySelector("#settingsDrawer [data-close]").click();
  type(h, "provider-builders", "custom", "change");
  await convene(h);
  await sleep(20);
  assert.strictEqual(txt(doc.getElementById("agentsNote")), "Your endpoint runs through Quorum's local server. Start it with bun start and open Quorum at the address it prints, or choose another provider for the builders.");
});

test("the whole council can run on Hermes Agent with its tools", async () => {
  const h = makeHarness({ behavior: req => (/8642/.test(req.url) && req.method === "POST" ? { sse: { tool: true, delay: 5 } } : null) });
  const { doc, win } = h;
  await sleep(20);
  ROLE_IDS.forEach(r => type(h, "provider-" + r, "hermes", "change"));
  assert.strictEqual(doc.getElementById("model-builders").value, "hermes-agent");
  assert.strictEqual(doc.getElementById("model-builders").getAttribute("list"), "models-hermes");
  await convene(h);
  await sleep(20);
  assert.strictEqual(txt(doc.getElementById("agentsNote")), "Add the Hermes Agent API key under Providers.");
  type(h, "key-hermes", "local-secret");
  doc.getElementById("check-hermes").click();
  await sleep(20);
  assert.strictEqual(txt(doc.getElementById("status-hermes")), "Connected. It offers “hermes-agent”.");
  await convene(h);
  await waitFor(() => win.__quorum.S.phase === "done", 10000, "done");
  const all = chats(h), posts = all.filter(r => who(r.body.messages[0].content) !== "name");
  assert.strictEqual(all.length, 8, "seven steps, and the Chair's agent naming the session");
  assert.strictEqual(txt(doc.getElementById("sessionName")), "Shared Tool Library for Neighbors, With Bins and a Sign-out Sheet");
  posts.forEach(r => {
    assert.strictEqual(r.url, "http://127.0.0.1:8642/v1/chat/completions");
    assert.strictEqual(r.headers.Authorization, "Bearer local-secret");
    assert.strictEqual(r.body.model, "hermes-agent");
    assert.strictEqual(r.body.stream, true);
    assert.ok(r.body.messages[0].content.includes("You may have tools that can read the project's files."));
  });
  assert.strictEqual(txt(doc.getElementById("propTier")), "Agent: Hermes Agent");
  assert.strictEqual(txt(doc.getElementById("verdict")), "Proposal B, “Lend Loop”, wins with 8 of 9 possible points.");
  assert.ok(!doc.getElementById("dlRecord").hidden, "plain downloads work outside Claude");
  doc.getElementById("dlRecord").click();
  await sleep(20);
  assert.deepStrictEqual(h.downloads, ["council-record-the-plan.md"]);
  assert.strictEqual(win.localStorage.getItem("quorum:key:hermes"), null, "keys aren't stored unless Remember is on");
  doc.getElementById("propConvo").click();
  await sleep(30);
  const event = doc.querySelector("#convoBody details.is-tool");
  assert.strictEqual(txt(event.querySelector("summary")), "hermes.tool.progress", "what Hermes Agent reported while it worked");
  assert.strictEqual(event.querySelector("pre").textContent, '{"tool":"read_file"}');
  doc.getElementById("convoClose").click();
  assert.strictEqual(txt(doc.getElementById("providersStatus")), "Hermes Agent is set up");
  assert.strictEqual(txt(doc.getElementById("settingsHint")), "Hermes Agent may use its tools first, so its seats can take longer.");
});

test("reasoning, inline or apart from the answer, goes into the conversation", async () => {
  const h = makeHarness({ behavior: req => {
    const id = req.body && who(req.body.messages[0].content);
    return id === "A" ? { sse: { think: true } } : id === "B" ? { sse: { reasoning: true } } : null;
  } });
  const { doc, win } = h;
  await sleep(20);
  onHermes(h);
  await convene(h);
  await waitFor(() => win.__quorum.S.phase === "done", 10000, "done");
  await sleep(40);
  const S = win.__quorum.S;
  assert.ok(!S.seats.A.text.includes("<think>") && S.seats.A.text.startsWith("# Shelf Share"), "think traces removed");
  doc.getElementById("propConvo").click();
  await sleep(30);
  const thought = () => doc.querySelector("#convoBody details.is-thinking");
  assert.strictEqual(txt(thought().querySelector("summary")), "The Pragmatist thought · 4 words");
  assert.strictEqual(thought().querySelector("pre").textContent, "Let me plan this.");
  assert.ok(!thought().open, "reasoning starts folded");
  assert.ok(txt(doc.querySelector("#convoBody .turn.is-answer .turn-doc")).startsWith("Shelf Share"), "the answer without its reasoning");
  assert.strictEqual(doc.querySelector("#convoBody pre").textContent, chats(h).find(r => who(r.body.messages[0].content) === "A")!.body.messages[0].content);
  doc.getElementById("convoNext").click();
  await sleep(30);
  assert.strictEqual(thought().querySelector("pre").textContent, "Weigh the options.");
  doc.getElementById("convoSaveAll").click();
  await sleep(20);
  assert.deepStrictEqual(h.downloads, ["council-conversations-the-plan.md"]);
});

test("a rejected key pauses the session, and fixing it lets it continue", async () => {
  let good = false;
  const h = makeHarness({ behavior: req => (req.method === "POST" && !good ? { response: jsonResponse(401, { error: { code: 401, message: "Invalid API key" } }) } : null) });
  const { doc, win } = h;
  await sleep(20);
  onHermes(h);
  await convene(h);
  await waitFor(() => win.__quorum.S.phase === "paused", 5000, "paused");
  await sleep(30);
  assert.strictEqual(txt(doc.getElementById("noticeText")), "The Pragmatist, the Visionary and the Architect couldn't finish. Hermes Agent rejected the API key. Check it under Providers, then retry.");
  assert.strictEqual(txt(doc.getElementById("propNote")), "Hermes Agent rejected the API key.");
  assert.ok(!doc.getElementById("provider-builders").disabled, "settings can change while paused");
  good = true;
  type(h, "key-hermes", "right-secret");
  doc.getElementById("noticeRetry").click();
  await waitFor(() => win.__quorum.S.phase === "done", 10000, "done");
  // The naming and the three builders failed on the wrong key; on the retry, all of them ask again with the right one.
  assert.ok(chats(h).slice(4).every(r => r.headers.Authorization === "Bearer right-secret"), "the retry uses the corrected key");
  assert.strictEqual(txt(doc.getElementById("sessionName")), "Shared Tool Library for Neighbors, With Bins and a Sign-out Sheet", "a session that wasn't named is named when it resumes");
});

test("errors in the middle of a stream keep the partial text and can be retried", async () => {
  let first = true;
  const h = makeHarness({ behavior: req => {
    if (req.method === "POST" && who(req.body.messages[0].content) === "skeptic" && first) { first = false; return { sse: { midError: true } }; }
    return null;
  } });
  const { doc, win } = h;
  await sleep(20);
  onHermes(h);
  await convene(h);
  await waitFor(() => win.__quorum.S.phase === "paused", 8000, "paused");
  await sleep(30);
  assert.strictEqual(txt(doc.getElementById("noticeText")), "The Skeptic couldn't finish. The connection to Hermes Agent dropped. Retry to continue where the council left off.");
  doc.getElementById("noticeRetry").click();
  await waitFor(() => win.__quorum.S.phase === "done", 8000, "done");
  await sleep(30);
  doc.getElementById("tab-skeptic").click();
  await sleep(20);
  doc.getElementById("councilConvo").click();
  await sleep(30);
  assert.deepStrictEqual([...doc.querySelectorAll("#convoBody .convo-attempt")].map(txt), [
    "Attempt 1 of 2 · Couldn't finish: The connection to Hermes Agent dropped before this was finished. (Provider disconnected unexpectedly)",
    "Attempt 2 of 2"]);
  assert.deepStrictEqual([...doc.querySelectorAll("#convoBody .turn-head")].map(txt), ["The Skeptic had written this when it stopped", "The Skeptic’s answer"]);
});

test("an unreachable Hermes explains how to allow this page", async () => {
  const h = makeHarness({ behavior: req => (/8642/.test(req.url) ? { reject: true } : null) });
  const { doc, win } = h;
  await sleep(20);
  onHermes(h);
  doc.getElementById("check-hermes").click();
  await sleep(20);
  assert.strictEqual(txt(doc.getElementById("status-hermes")), "Couldn't reach Hermes Agent. Check that hermes gateway is running and that API_SERVER_CORS_ORIGINS includes https://example.org, then retry.");
  await convene(h);
  await waitFor(() => win.__quorum.S.phase === "paused", 5000, "paused");
  await sleep(30);
  assert.strictEqual(txt(doc.getElementById("noticeText")), "The Pragmatist, the Visionary and the Architect couldn't finish. Couldn't reach Hermes Agent. Check that hermes gateway is running and that API_SERVER_CORS_ORIGINS includes https://example.org, then retry.");
});

test("a file page is told to use a local web server for Hermes", async () => {
  const h = makeHarness({ url: "file:///home/me/quorum.html" });
  await sleep(20);
  const help = txt(h.doc.getElementById("help-hermes"));
  assert.ok(help.includes("serve Quorum locally first, for example with python3 -m http.server 8000"), help);
});

test("keys are remembered only on request, and settings come back on the next visit", async () => {
  const h = makeHarness();
  const { doc, win } = h;
  await sleep(20);
  type(h, "url-custom", "http://localhost:11434/v1/");
  type(h, "key-custom", "ollama");
  assert.strictEqual(win.localStorage.getItem("quorum:key:custom"), null);
  doc.getElementById("remember-custom").click();
  await sleep(10);
  assert.strictEqual(win.localStorage.getItem("quorum:key:custom"), "ollama");
  assert.deepStrictEqual(JSON.parse(win.localStorage.getItem("quorum:providers")).urls, { hermes: "", custom: "http://localhost:11434/v1/" });
  doc.getElementById("remember-custom").click();
  await sleep(10);
  assert.strictEqual(win.localStorage.getItem("quorum:key:custom"), null, "unticking Remember forgets the key");
  const h2 = makeHarness({ storage: {
    "quorum:providers": JSON.stringify({ urls: { hermes: "http://127.0.0.1:9000/v1", custom: "" }, remember: { openrouter: true, hermes: false, custom: false } }),
    "quorum:key:openrouter": "sk-or-saved",
    "quorum:agents": JSON.stringify({ builders: { provider: "hermes", model: "alice" }, council: { provider: "claude", model: "complex" }, chair: { provider: "openrouter", model: "x/y" } }),
  } });
  await sleep(30);
  assert.strictEqual(h2.doc.getElementById("key-openrouter").value, "sk-or-saved");
  assert.ok(h2.doc.getElementById("remember-openrouter").checked);
  assert.strictEqual(h2.doc.getElementById("url-hermes").value, "http://127.0.0.1:9000/v1");
  assert.deepStrictEqual(ROLE_IDS.map(r => h2.doc.getElementById("provider-" + r).value + " " + h2.doc.getElementById("model-" + r).value),
    ["hermes alice", "openrouter z-ai/glm-5.3", "openrouter x/y"]);
  assert.ok(!h2.doc.getElementById("providers").open, "the panel stays closed once something is set up");
});

test("stopping aborts the requests in flight", async () => {
  const h = makeHarness({ behavior: req => (req.method === "POST" ? { sse: { delay: 60 } } : null) });
  const { doc, win } = h;
  await sleep(20);
  onHermes(h);
  await convene(h);
  await waitFor(() => win.__quorum.S.seats.A.status === "writing", 5000, "writing");
  await sleep(450);
  doc.getElementById("railStop").click();
  await sleep(80);
  const S = win.__quorum.S;
  assert.strictEqual(S.phase, "stopped");
  assert.ok(["A", "B", "C"].every(L => S.seats[L].status === "stopped" || S.seats[L].status === "done"));
  doc.getElementById("resume").click();
  await waitFor(() => S.phase === "done", 20000, "done");
});
