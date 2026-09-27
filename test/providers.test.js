// In-page tests for running Quorum on its own, with OpenRouter, Hermes Agent and other endpoints.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const assert = require("assert");
const html = fs.readFileSync(process.env.QUORUM_HTML || path.join(__dirname, "..", "dist", "quorum.html"), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const txt = el => el.textContent.replace(/\s+/g, " ").trim();

const TITLES = { A: "Shelf Share", B: "Lend Loop", C: "Tool Commons" };
const builderText = L => `# ${TITLES[L]}\n> Pitch for ${L}.\n\n## The approach\nConcrete.\n\n## What changes\n- One\n\n## How we'd build it\n1. Step\n\n## Testing and rollout\nTests.\n\n## Risks and trade-offs\nSome.\n\n## Why the council should choose this\nIt works.`;
const BALLOTS = { advocate: [["B", "A", "C"], { A: 7, B: 9, C: 4 }], skeptic: [["A", "B", "C"], { A: 8, B: 7, C: 3 }], strategist: [["B", "C", "A"], { A: 5, B: 8, C: 6 }] };
const councilText = id => `## Verdict\nI favor ${BALLOTS[id][0][0]}.\n\n## A: x\nok\n\n## B: y\nok\n\n## C: z\nok\n\n## Worth keeping\nBins.\n\n\`\`\`json\n${JSON.stringify({ ranking: BALLOTS[id][0], scores: BALLOTS[id][1] })}\n\`\`\``;
const chairText = "# The Plan\nSummary.\n\n## The decision\nB won.\n\n## Requirements\n- Met\n\n## Implementation steps\n1. Build";

function who(prompt) {
  const m = /^You are (The \w+|the Chair)/.exec(prompt);
  const name = m ? m[1] : "";
  return { "The Pragmatist": "A", "The Visionary": "B", "The Architect": "C", "The Advocate": "advocate", "The Skeptic": "skeptic", "The Strategist": "strategist", "the Chair": "chair" }[name] || "?";
}
function textFor(id) {
  if (["A", "B", "C"].includes(id)) return builderText(id);
  if (id === "chair") return chairText;
  return councilText(id);
}

// An OpenAI-compatible server: streams SSE, optionally with comments, tool events and <think> traces.
function sseResponse(text, o, signal) {
  const enc = new TextEncoder();
  const frames = [": OPENROUTER PROCESSING\n\n"];
  if (o.tool) frames.push("event: hermes.tool.progress\ndata: {\"tool\":\"read_file\"}\n\n");
  const body = (o.think ? "<think>Let me plan this.</think>\n" : "") + text;
  (body.match(/[\s\S]{1,30}/g) || []).forEach(p => frames.push("data: " + JSON.stringify({ model: o.model, choices: [{ index: 0, delta: { content: p } }] }) + "\n\n"));
  if (o.midError) frames.splice(3, frames.length, "data: " + JSON.stringify({ error: { code: "server_error", message: "Provider disconnected unexpectedly" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] }) + "\n\n");
  else {
    frames.push("data: " + JSON.stringify({ model: o.model, choices: [{ index: 0, delta: { content: "" }, finish_reason: o.finish || "stop" }] }) + "\n\n");
    frames.push("data: " + JSON.stringify({ model: o.model, choices: [{ index: 0, delta: { content: "" }, finish_reason: o.finish || "stop" }], usage: { total_tokens: 10 } }) + "\n\n");
    frames.push("data: [DONE]\n\n");
  }
  let i = 0, timer = null, over = false;
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

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

function makeHarness(opts = {}) {
  const requests = [];
  const downloads = [];
  const behavior = opts.behavior || (() => null);
  const fetchMock = async (url, init = {}) => {
    const req = { url: String(url), method: init.method || "GET", headers: Object.assign({}, init.headers || {}), body: init.body ? JSON.parse(init.body) : null };
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
    beforeParse(w) {
      w.__QUORUM_TEST__ = true;
      Object.keys(opts.storage || {}).forEach(k => w.localStorage.setItem(k, opts.storage[k]));
      w.fetch = fetchMock;
      w.TextDecoder = TextDecoder;
      w.Element.prototype.scrollIntoView = function () {};
      w.URL.createObjectURL = () => "blob:quorum";
      w.URL.revokeObjectURL = () => {};
      w.HTMLAnchorElement.prototype.click = function () { downloads.push(this.getAttribute("download")); };
      w.console.error = (...a) => console.log("[page error]", ...a);
    },
  });
  return { dom, win: dom.window, doc: dom.window.document, requests, downloads };
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
async function convene(h, feature = "Let users export reports as CSV.") {
  await sleep(20);
  h.doc.getElementById("feature").value = feature;
  h.doc.getElementById("convene").click();
}
const chats = h => h.requests.filter(r => r.method === "POST");

(async () => {
  let passed = 0;
  const run = async (name, fn) => {
    try { await fn(); passed++; console.log("ok  ", name); }
    catch (e) { console.log("FAIL", name, "\n   ", e.stack.split("\n").slice(0, 8).join("\n    ")); process.exitCode = 1; }
  };

  await run("on its own, Quorum defaults to OpenRouter and asks for a key", async () => {
    const h = makeHarness();
    const { doc } = h;
    await sleep(40);
    assert.deepStrictEqual(["builders", "council", "chair"].map(r => doc.getElementById("provider-" + r).value + " " + doc.getElementById("model-" + r).value),
      ["openrouter nousresearch/hermes-4-70b", "openrouter nousresearch/hermes-4-405b", "openrouter nousresearch/hermes-4-405b"]);
    assert.ok(doc.getElementById("tier-builders").hidden);
    assert.strictEqual(doc.getElementById("model-builders").getAttribute("list"), "models-openrouter");
    const claudeOpt = doc.querySelector('#provider-builders option[value="claude"]');
    assert.ok(claudeOpt.disabled);
    assert.strictEqual(claudeOpt.textContent, "Claude (inside claude.ai only)");
    assert.ok(doc.getElementById("providers").open, "providers panel opens until something is set up");
    assert.strictEqual(txt(doc.getElementById("providersStatus")), "OpenRouter needs setting up");
    assert.ok(txt(doc.getElementById("help-hermes")).includes("API_SERVER_CORS_ORIGINS=https://example.org"));
    const ids = [...doc.querySelectorAll("#models-openrouter option")].map(o => o.value);
    assert.ok(ids.includes("anthropic/claude-opus-5.5") && ids[0] === "nousresearch/hermes-4-70b", "live model list merged after the presets: " + ids.join(","));
    await convene(h);
    await sleep(20);
    assert.strictEqual(chats(h).length, 0);
    assert.strictEqual(txt(doc.getElementById("agentsNote")), "Add your OpenRouter API key under Providers.");
    assert.strictEqual(doc.activeElement.id, "key-openrouter");
  });

  await run("a full session runs on OpenRouter", async () => {
    const h = makeHarness({ behavior: req => (req.body && who(req.body.messages[0].content) === "A" ? { sse: { think: true } } : null) });
    const { doc, win } = h;
    await sleep(20);
    type(h, "key-openrouter", " sk-or-test ");
    type(h, "model-chair", "anthropic/claude-opus-5.5");
    await convene(h);
    await waitFor(() => win.__quorum.S.phase === "done", 10000, "done");
    await sleep(40);
    const posts = chats(h);
    assert.strictEqual(posts.length, 7);
    posts.forEach(r => {
      assert.strictEqual(r.url, "https://openrouter.ai/api/v1/chat/completions");
      assert.strictEqual(r.headers.Authorization, "Bearer sk-or-test");
      assert.strictEqual(r.headers["X-Title"], "Quorum");
      assert.strictEqual(r.headers["HTTP-Referer"], "https://example.org");
      assert.strictEqual(r.body.stream, true);
    });
    const byId = {};
    posts.forEach(r => { byId[who(r.body.messages[0].content)] = r.body.model; });
    assert.deepStrictEqual(byId, { A: "nousresearch/hermes-4-70b", B: "nousresearch/hermes-4-70b", C: "nousresearch/hermes-4-70b", advocate: "nousresearch/hermes-4-405b", skeptic: "nousresearch/hermes-4-405b", strategist: "nousresearch/hermes-4-405b", chair: "anthropic/claude-opus-5.5" });
    assert.ok(!posts.some(r => r.body.messages[0].content.includes("You may have tools")), "plain models aren't told about tools");
    const S = win.__quorum.S;
    assert.ok(!S.seats.A.text.includes("<think>") && S.seats.A.text.startsWith("# Shelf Share"), "think traces removed");
    assert.strictEqual(txt(doc.getElementById("propTier")), "Agent: hermes-4-70b via OpenRouter");
    assert.strictEqual(doc.getElementById("propTier").title, "OpenRouter: nousresearch/hermes-4-70b");
    assert.strictEqual(txt(doc.getElementById("planTier")), "Agent: claude-opus-5.5 via OpenRouter");
    assert.strictEqual(txt(doc.getElementById("verdict")), "Proposal B, \u201CLend Loop\u201D, wins with 8 of 9 possible points.");
    assert.ok(!doc.getElementById("dlRecord").hidden, "plain downloads work outside Claude");
    doc.getElementById("dlRecord").click();
    await sleep(20);
    assert.deepStrictEqual(h.downloads, ["council-record-the-plan.md"]);
    assert.strictEqual(txt(doc.getElementById("dlRecord")), "Downloaded");
    assert.strictEqual(win.localStorage.getItem("quorum:key:openrouter"), null, "keys aren't stored unless Remember is on");
    assert.strictEqual(txt(doc.getElementById("settingsHint")), "OpenRouter bills your account for each request.");
  });

  await run("a rejected key pauses the session, and fixing it lets it continue", async () => {
    let good = false;
    const h = makeHarness({ behavior: req => (req.method === "POST" && !good ? { response: jsonResponse(401, { error: { code: 401, message: "No auth credentials found" } }) } : null) });
    const { doc, win } = h;
    await sleep(20);
    type(h, "key-openrouter", "sk-or-wrong");
    await convene(h);
    await waitFor(() => win.__quorum.S.phase === "paused", 5000, "paused");
    await sleep(30);
    assert.strictEqual(txt(doc.getElementById("noticeText")), "The Pragmatist, the Visionary and the Architect couldn't finish. OpenRouter rejected the API key. Check it under Providers, then retry.");
    assert.strictEqual(txt(doc.getElementById("propNote")), "OpenRouter rejected the API key.");
    assert.ok(!doc.getElementById("provider-builders").disabled, "settings can change while paused");
    good = true;
    type(h, "key-openrouter", "sk-or-right");
    doc.getElementById("noticeRetry").click();
    await waitFor(() => win.__quorum.S.phase === "done", 10000, "done");
    assert.ok(chats(h).slice(3).every(r => r.headers.Authorization === "Bearer sk-or-right"), "the retry uses the corrected key");
  });

  await run("errors in the middle of a stream keep the partial text and can be retried", async () => {
    let first = true;
    const h = makeHarness({ behavior: req => {
      if (req.method === "POST" && who(req.body.messages[0].content) === "skeptic" && first) { first = false; return { sse: { midError: true } }; }
      return null;
    } });
    const { doc, win } = h;
    await sleep(20);
    type(h, "key-openrouter", "sk-or-test");
    await convene(h);
    await waitFor(() => win.__quorum.S.phase === "paused", 8000, "paused");
    await sleep(30);
    assert.strictEqual(txt(doc.getElementById("noticeText")), "The Skeptic couldn't finish. The connection to OpenRouter dropped. Retry to continue where the council left off.");
    doc.getElementById("noticeRetry").click();
    await waitFor(() => win.__quorum.S.phase === "done", 8000, "done");
  });

  await run("the builders can run on Hermes Agent with its tools", async () => {
    const h = makeHarness({ behavior: req => (/8642/.test(req.url) && req.method === "POST" ? { sse: { tool: true, delay: 5 } } : null) });
    const { doc, win } = h;
    await sleep(20);
    type(h, "provider-builders", "hermes", "change");
    assert.strictEqual(doc.getElementById("model-builders").value, "hermes-agent");
    assert.strictEqual(doc.getElementById("model-builders").getAttribute("list"), "models-hermes");
    type(h, "key-openrouter", "sk-or-test");
    await convene(h);
    await sleep(20);
    assert.strictEqual(txt(doc.getElementById("agentsNote")), "Add the Hermes Agent API key under Providers.");
    type(h, "key-hermes", "local-secret");
    doc.getElementById("check-hermes").click();
    await sleep(20);
    assert.strictEqual(txt(doc.getElementById("status-hermes")), "Connected. It offers \u201Chermes-agent\u201D.");
    await convene(h);
    await waitFor(() => win.__quorum.S.phase === "done", 10000, "done");
    const hermesPosts = chats(h).filter(r => /8642/.test(r.url));
    assert.strictEqual(hermesPosts.length, 3);
    hermesPosts.forEach(r => {
      assert.strictEqual(r.url, "http://127.0.0.1:8642/v1/chat/completions");
      assert.strictEqual(r.headers.Authorization, "Bearer local-secret");
      assert.strictEqual(r.body.model, "hermes-agent");
      assert.ok(r.body.messages[0].content.includes("You may have tools that can read the project's files."));
    });
    assert.ok(chats(h).filter(r => /openrouter/.test(r.url)).every(r => !r.body.messages[0].content.includes("You may have tools")));
    assert.strictEqual(txt(doc.getElementById("propTier")), "Agent: Hermes Agent");
    assert.strictEqual(txt(doc.getElementById("providersStatus")), "OpenRouter is set up and Hermes Agent is set up");
    assert.strictEqual(txt(doc.getElementById("settingsHint")), "OpenRouter bills your account for each request. Hermes Agent may use its tools first, so its seats can take longer.");
  });

  await run("an unreachable Hermes explains how to allow this page", async () => {
    const h = makeHarness({ behavior: req => (/8642/.test(req.url) ? { reject: true } : null) });
    const { doc, win } = h;
    await sleep(20);
    ["builders", "council", "chair"].forEach(r => type(h, "provider-" + r, "hermes", "change"));
    type(h, "key-hermes", "local-secret");
    doc.getElementById("check-hermes").click();
    await sleep(20);
    assert.strictEqual(txt(doc.getElementById("status-hermes")), "Couldn't reach Hermes Agent. Check that hermes gateway is running and that API_SERVER_CORS_ORIGINS includes https://example.org, then retry.");
    await convene(h);
    await waitFor(() => win.__quorum.S.phase === "paused", 5000, "paused");
    await sleep(30);
    assert.strictEqual(txt(doc.getElementById("noticeText")), "The Pragmatist, the Visionary and the Architect couldn't finish. Couldn't reach Hermes Agent. Check that hermes gateway is running and that API_SERVER_CORS_ORIGINS includes https://example.org, then retry.");
  });

  await run("a file page is told to use a local web server for Hermes", async () => {
    const h = makeHarness({ url: "file:///home/me/quorum.html" });
    await sleep(20);
    const help = txt(h.doc.getElementById("help-hermes"));
    assert.ok(help.includes("serve Quorum locally first, for example with python3 -m http.server 8000"), help);
  });

  await run("any OpenAI-compatible endpoint works, and keys are remembered only on request", async () => {
    const h = makeHarness();
    const { doc, win } = h;
    await sleep(20);
    ["builders", "council", "chair"].forEach(r => type(h, "provider-" + r, "custom", "change"));
    await convene(h);
    await sleep(20);
    assert.strictEqual(txt(doc.getElementById("agentsNote")), "Enter a model for the builders.");
    ["builders", "council", "chair"].forEach(r => type(h, "model-" + r, "llama3.1:8b"));
    await convene(h);
    await sleep(20);
    assert.strictEqual(txt(doc.getElementById("agentsNote")), "Add the address of your endpoint under Providers.");
    type(h, "url-custom", "http://localhost:11434/v1/");
    type(h, "key-custom", "ollama");
    doc.getElementById("remember-custom").click();
    await sleep(10);
    assert.strictEqual(win.localStorage.getItem("quorum:key:custom"), "ollama");
    assert.deepStrictEqual(JSON.parse(win.localStorage.getItem("quorum:providers")).urls, { hermes: "", custom: "http://localhost:11434/v1/" });
    await convene(h);
    await waitFor(() => win.__quorum.S.phase === "done", 10000, "done");
    await sleep(30);
    assert.ok(chats(h).every(r => r.url === "http://localhost:11434/v1/chat/completions" && r.body.model === "llama3.1:8b"));
    assert.strictEqual(txt(doc.getElementById("planTier")), "Agent: llama3.1:8b via localhost:11434");
    doc.getElementById("remember-custom").click();
    await sleep(10);
    assert.strictEqual(win.localStorage.getItem("quorum:key:custom"), null, "unticking Remember forgets the key");
    // a new visit restores remembered settings
    const h2 = makeHarness({ storage: {
      "quorum:providers": JSON.stringify({ urls: { hermes: "http://127.0.0.1:9000/v1", custom: "" }, remember: { openrouter: true, hermes: false, custom: false } }),
      "quorum:key:openrouter": "sk-or-saved",
      "quorum:agents": JSON.stringify({ builders: { provider: "hermes", model: "alice" }, council: { provider: "claude", model: "complex" }, chair: { provider: "openrouter", model: "x/y" } }),
    } });
    await sleep(30);
    assert.strictEqual(h2.doc.getElementById("key-openrouter").value, "sk-or-saved");
    assert.ok(h2.doc.getElementById("remember-openrouter").checked);
    assert.strictEqual(h2.doc.getElementById("url-hermes").value, "http://127.0.0.1:9000/v1");
    assert.deepStrictEqual(["builders", "council", "chair"].map(r => h2.doc.getElementById("provider-" + r).value + " " + h2.doc.getElementById("model-" + r).value),
      ["hermes alice", "openrouter nousresearch/hermes-4-405b", "openrouter x/y"]);
    assert.ok(!h2.doc.getElementById("providers").open, "the panel stays closed once something is set up");
  });

  await run("stopping aborts the requests in flight", async () => {
    const h = makeHarness({ behavior: req => (req.method === "POST" ? { sse: { delay: 60 } } : null) });
    const { doc, win } = h;
    await sleep(20);
    type(h, "key-openrouter", "sk-or-test");
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

  console.log(passed + " provider tests passed" + (process.exitCode ? " (with failures)" : ""));
  process.exit(process.exitCode || 0);
})();
