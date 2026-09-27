const fs = require("fs");
const { JSDOM } = require("jsdom");
const assert = require("assert");
const html = fs.readFileSync(require("path").join(__dirname, "..", "dist", "quorum.html"), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const builderText = (L, title) => `# ${title}\n> A one-line pitch for ${L}.\n\n## The approach\nKeep it simple and **concrete**.\n\n## What it includes\n- A sign-out sheet\n- A shared shelf\n  - Labeled bins\n\n## How we'd make it happen\n1. Week 1: set up\n2. Week 2: launch\n\n## Risks and trade-offs\nSome risk.\n\n## Why the council should choose this\nBecause it works.`;
const TITLES = { A: "Shelf Share", B: "Lend Loop", C: "Tool Commons" };
const councilText = (ranking, scores, withBallot = true) => `## Verdict\nI favor ${ranking[0]}.\n\n## A: ${TITLES.A}\nGood.\n\n## B: ${TITLES.B}\nFine.\n\n## C: ${TITLES.C}\nOk.\n\n## Worth keeping\nThe bins.` +
  (withBallot ? `\n\n\`\`\`json\n{"ranking": ${JSON.stringify(ranking)}, "scores": ${JSON.stringify(scores)}}\n\`\`\`` : "");
const chairText = deciding => `# The Building Tool Library\nA shared library for the building.\n\n## The decision\n${deciding ? "I cast the deciding vote for Proposal " + deciding + ". " : ""}The council chose well.\n\n## Scope\nIn and out.\n\n## How it works\nPieces.\n\n## Milestones\n1. One — a week\n2. Two — a week\n\n## Risks and mitigations\n- Risk: handled\n\n## Open questions\n- Who keeps the keys?`;

function makeHarness(opts = {}) {
  const calls = [];
  const saves = [];
  const plan = opts.plan || {};
  const counts = {};
  function who(prompt) {
    if (prompt.startsWith("You are The Pragmatist")) return "A";
    if (prompt.startsWith("You are The Visionary")) return "B";
    if (prompt.startsWith("You are The Architect")) return "C";
    if (prompt.startsWith("You are The Advocate")) return "advocate";
    if (prompt.startsWith("You are The Skeptic")) return "skeptic";
    if (prompt.startsWith("You are The Strategist")) return "strategist";
    if (prompt.startsWith("You are the Chair")) return "chair";
    return "?";
  }
  const ballots = opts.ballots || {
    advocate: [["B", "A", "C"], { A: 7, B: 9, C: 4 }],
    skeptic: [["A", "B", "C"], { A: 8, B: 7, C: 3 }],
    strategist: [["B", "C", "A"], { A: 5, B: 8, C: 6 }],
  };
  function textFor(id, n) {
    if (["A", "B", "C"].includes(id)) return builderText(id, TITLES[id]);
    if (id === "chair") return chairText(opts.deciding);
    const [r, s] = ballots[id];
    const noBallot = plan[id] === "no_ballot" && n === 1;
    return councilText(r, s, !noBallot);
  }
  const sample = function (prompt, o) {
    const id = who(prompt);
    counts[id] = (counts[id] || 0) + 1;
    const n = counts[id];
    calls.push({ id, tier: o.modelTier, cache: o.cache, len: prompt.length, prompt });
    const signal = o.signal;
    return new Promise((resolve, reject) => {
      const full = textFor(id, n);
      const failure = plan[id] && n === 1 && plan[id] !== "no_ballot" ? plan[id] : null;
      if (plan.all === "not_granted") return setTimeout(() => reject({ code: "not_granted", message: "declined" }), 5);
      const chunks = full.match(/[\s\S]{1,40}/g);
      let i = 0, text = "", done = false;
      const onAbort = () => { if (done) return; done = true; reject({ code: "cancelled", message: "aborted", text }); };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort);
      const step = () => {
        if (done) return;
        if (failure && i === 3) { done = true; return reject({ code: failure, message: "fail", text }); }
        if (i >= chunks.length) { done = true; return resolve({ text, truncated: false, modelTierApplied: (o.modelTier === "complex" && opts.tierApplied) || o.modelTier }); }
        text += chunks[i++];
        try { o.onText({ text, delta: chunks[i - 1] }); } catch (e) { console.error("onText threw", e); }
        setTimeout(step, opts.delay || 2);
      };
      setTimeout(step, opts.thinkDelay || 5);
    });
  };
  const downloads = Object.freeze({ save: req => { saves.push(req); return Promise.resolve({ status: "saved" }); } });
  const dom = new JSDOM(html, {
    url: "https://example.org/quorum",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.__QUORUM_TEST__ = true;
      Object.keys(opts.storage || {}).forEach(k => window.localStorage.setItem(k, opts.storage[k]));
      window.claude = { use: name => Promise.resolve(name === "sample" ? sample : name === "downloads" ? downloads : null) };
      window.Element.prototype.scrollIntoView = function () {};
      window.console.error = (...a) => { console.log("[page error]", ...a); };
    },
  });
  return { dom, win: dom.window, doc: dom.window.document, calls, saves, counts };
}

async function waitFor(fn, ms = 5000, label = "condition") {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await sleep(10); }
  throw new Error("Timed out waiting for " + label);
}
const txt = el => el.textContent.replace(/\s+/g, " ").trim();

async function convene(h, feature = "Let users export reports as CSV.") {
  const { doc, win } = h;
  await sleep(20);
  doc.getElementById("feature").value = feature;
  doc.getElementById("convene").click();
}

(async () => {
  let passed = 0;
  const run = async (name, fn) => { try { await fn(); passed++; console.log("ok  ", name); } catch (e) { console.log("FAIL", name, "\n   ", e.stack.split("\n").slice(0, 12).join("\n    ")); process.exitCode = 1; } };

  await run("idle state renders", async () => {
    const h = makeHarness();
    await sleep(30);
    const { doc } = h;
    assert.strictEqual(txt(doc.getElementById("convene")), "Convene the council");
    assert.ok(!doc.getElementById("roster").hidden);
    assert.ok(doc.getElementById("sec-proposals").hidden);
    assert.strictEqual(txt(doc.getElementById("status")), "The chamber is empty. Put a feature before the council to begin.");
    assert.strictEqual(txt(doc.getElementById("settingsHint")), "Frontier is Claude's most capable model and thinks longest, so its seats can take a few minutes.");
    assert.deepStrictEqual(["builders", "council", "chair"].map(r => doc.getElementById("provider-" + r).value + ":" + doc.getElementById("tier-" + r).value), ["claude:quick", "claude:complex", "claude:complex"]);
    assert.ok(doc.getElementById("model-builders").hidden, "Claude uses the tier picker, not a model field");
    const opt = doc.querySelector('#provider-builders option[value="openrouter"]');
    assert.ok(opt.disabled);
    assert.strictEqual(opt.textContent, "OpenRouter (outside Claude only)");
    assert.ok(doc.getElementById("set-openrouter").disabled, "provider settings are off inside Claude");
    assert.strictEqual(txt(doc.getElementById("providersStatus")), "Every agent runs on Claude here");
    assert.ok(doc.querySelector('input[name="length"][value="standard"]').checked);
    assert.ok(doc.getElementById("agentsNote").hidden);
  });

  await run("empty feature shows a field note", async () => {
    const h = makeHarness();
    await sleep(20);
    h.doc.getElementById("feature").value = "   ";
    h.doc.getElementById("convene").click();
    await sleep(20);
    assert.ok(!h.doc.getElementById("featureNote").hidden);
    assert.strictEqual(h.calls.length, 0);
  });

  await run("full session happy path", async () => {
    const h = makeHarness();
    const { doc, win } = h;
    await sleep(20);
    doc.querySelector('.add-btn[data-kind="requirements"]').click();
    const block = doc.querySelector("#contextList .ctx");
    assert.strictEqual(block.querySelector(".ctx-title").value, "Product requirements");
    assert.strictEqual(doc.activeElement, block.querySelector(".ctx-text"), "new context block takes focus");
    const ta = block.querySelector(".ctx-text");
    ta.value = "- Export button on every report\n- Respect active filters";
    ta.dispatchEvent(new win.Event("input", { bubbles: true }));
    doc.querySelector('.add-btn[data-kind="code"]').click();
    const code = doc.querySelectorAll("#contextList .ctx")[1].querySelector(".ctx-text");
    assert.ok(code.classList.contains("is-code"));
    code.value = "def export(report):\n    return rows";
    code.dispatchEvent(new win.Event("input", { bubbles: true }));
    await sleep(10);
    assert.strictEqual(txt(doc.getElementById("contextCount")), "91 of 24,000 characters");
    assert.strictEqual(txt(block.querySelector(".ctx-size")), "56 characters");
    await convene(h);
    await sleep(5);
    assert.strictEqual(txt(doc.getElementById("convene")), "Stop");
    assert.ok(!doc.getElementById("sec-proposals").hidden);
    assert.strictEqual(txt(doc.getElementById("motionQuote")), "Let users export reports as CSV.");
    await waitFor(() => win.__quorum.S.phase === "done", 8000, "done");
    await sleep(60);
    const S = win.__quorum.S;
    assert.strictEqual(h.calls.length, 7);
    assert.ok(h.calls.every(c => c.cache === false));
    assert.deepStrictEqual(h.calls.map(c => c.id + ":" + c.tier).sort(), ["A:quick", "B:quick", "C:quick", "advocate:complex", "chair:complex", "skeptic:complex", "strategist:complex"]);
    assert.strictEqual(txt(doc.getElementById("propTier")), "Agent: Claude Fast");
    assert.strictEqual(txt(doc.getElementById("planTier")), "Agent: Claude Frontier");
    assert.ok(doc.getElementById("tierNote").hidden);
    // every seat sees the context
    ["A", "skeptic", "chair"].forEach(id => {
      const p = h.calls.find(c => c.id === id).prompt;
      assert.ok(p.includes("=== Context: Product requirements ===\n- Export button on every report\n- Respect active filters\n=== End of context: Product requirements ==="), id);
      assert.ok(p.includes("=== Context: Relevant code ===\ndef export(report):\n    return rows\n=== End of context: Relevant code ==="), id);
    });
    assert.ok(!doc.getElementById("motionContext").hidden);
    assert.strictEqual(txt(doc.getElementById("motionContextSummary")), "With 2 pieces of context: Product requirements and Relevant code");
    assert.strictEqual(doc.querySelectorAll("#motionContextBody pre").length, 2);
    assert.ok(block.querySelector(".ctx-text").readOnly === false, "editable again after the session");
    // council prompts are blind and rotated
    const sk = h.calls.find(c => c.id === "skeptic").prompt;
    assert.ok(sk.indexOf("=== Proposal B ===") < sk.indexOf("=== Proposal A ==="));
    assert.ok(!/Pragmatist|Visionary|Architect/.test(sk));
    // proposals tabs
    assert.strictEqual(txt(doc.querySelector("#tab-A .tab-title")), "Shelf Share");
    assert.strictEqual(txt(doc.querySelector("#tab-B .tab-meta")), "Adopted with 8 points");
    assert.ok(doc.querySelector("#propDoc h1") && doc.querySelector("#propDoc blockquote"));
    assert.ok(doc.querySelector("#propDoc ul ul"), "nested list rendered");
    assert.ok(!doc.querySelector("#propDoc .caret"), "no caret after done");
    // council
    assert.strictEqual(txt(doc.querySelector("#tab-advocate .tab-title")), "Ranks B first");
    assert.strictEqual(doc.getElementById("tab-advocate").getAttribute("data-letter"), "B");
    assert.ok(!txt(doc.getElementById("councilDoc")).includes("ranking"), "ballot JSON hidden");
    assert.strictEqual(doc.querySelectorAll("#ballot .ballot-row").length, 3);
    assert.ok(doc.querySelector('#ballot .ballot-row[data-letter="B"] .rank.r1'));
    // vote
    const rows = [...doc.querySelectorAll("#division tbody tr")].map(r => r.getAttribute("data-letter"));
    assert.deepStrictEqual(rows, ["B", "A", "C"]);
    assert.ok(doc.querySelector('#division tr[data-letter="B"] .tag'));
    assert.strictEqual(txt(doc.getElementById("verdict")), "Proposal B, “Lend Loop”, wins with 8 of 9 possible points.");
    await sleep(60);
    assert.strictEqual(doc.querySelector('#division tr[data-letter="B"] .bar-fill').style.width, "89%");
    // plan
    assert.strictEqual(txt(doc.getElementById("planByline")), "Written by the Chair from Proposal B, “Lend Loop”.");
    assert.ok(doc.querySelector("#planDoc h1").textContent.includes("The Building Tool Library"));
    assert.ok(!doc.getElementById("planActions").hidden);
    assert.ok(!doc.getElementById("dlPlan").hidden && !doc.getElementById("dlRecord").hidden);
    assert.strictEqual(doc.getElementById("plan").getAttribute("data-letter"), "B");
    // rail + seats
    assert.strictEqual(txt(doc.getElementById("status")), "The council has adjourned. Proposal B carried, and the plan is ready.");
    assert.ok(/^Adjourned after 0:0\d$/.test(txt(doc.getElementById("clock"))), txt(doc.getElementById("clock")));
    const seatCls = id => doc.querySelector(`[data-seat="${id}"]`).getAttribute("class");
    ["A", "B", "C", "advocate", "skeptic", "strategist", "chair"].forEach(id => assert.ok(seatCls(id).includes("is-done"), id + " " + seatCls(id)));
    assert.strictEqual(doc.querySelector('[data-seat="chair"]').getAttribute("data-letter"), "B");
    assert.strictEqual(doc.querySelector('[data-seat="chair"] .seat-glyph').textContent, "B");
    assert.strictEqual(doc.querySelector('[data-seat="skeptic"] .seat-glyph').textContent, "A");
    assert.strictEqual(doc.querySelector('[data-seat="A"]').getAttribute("tabindex"), "0");
    [...doc.querySelectorAll(".stage-btn")].forEach(b => assert.strictEqual(b.getAttribute("data-state"), "done"));
    assert.strictEqual(txt(doc.getElementById("convene")), "Convene again");
    assert.ok(doc.getElementById("resume").hidden);
    // downloads
    doc.getElementById("dlRecord").click();
    await sleep(20);
    assert.strictEqual(h.saves.length, 1);
    assert.strictEqual(h.saves[0].filename, "council-record-the-building-tool-library.md");
    assert.ok(h.saves[0].data.includes("# How the council decided"));
    assert.ok(h.saves[0].data.includes("| B: Lend Loop (adopted) | 1st | 2nd | 1st | 8 |"));
    assert.ok(h.saves[0].data.includes("Agents: Builders on Claude Fast, the council on Claude Frontier and the Chair on Claude Frontier. Length: Standard."));
    assert.ok(h.saves[0].data.includes("*By the Pragmatist, on Claude Fast*"));
    assert.ok(h.saves[0].data.includes("*Reviewed blind, on Claude Frontier*"));
    assert.ok(h.saves[0].data.includes("## The context\n\n### Product requirements\n\n```text\n- Export button on every report"));
    doc.getElementById("dlPlan").click();
    await sleep(20);
    assert.strictEqual(h.saves[1].filename, "plan-the-building-tool-library.md");
    assert.ok(txt(doc.getElementById("dlPlan")) === "Saved");
    // tab switching by keyboard
    const tabA = doc.getElementById("tab-A");
    tabA.focus();
    tabA.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await sleep(10);
    assert.strictEqual(doc.getElementById("tab-B").getAttribute("aria-selected"), "true");
    assert.strictEqual(doc.activeElement.id, "tab-B");
    assert.strictEqual(doc.getElementById("propPane").getAttribute("aria-labelledby"), "tab-B");
    assert.ok(txt(doc.getElementById("propDoc")).startsWith("Lend Loop"));
    // seat click jumps to council tab
    doc.querySelector('[data-seat="strategist"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await sleep(10);
    assert.strictEqual(doc.getElementById("tab-strategist").getAttribute("aria-selected"), "true");
    // no inline style attributes other than CSSOM-set ones
    assert.ok(!html.includes('style="'));
  });

  await run("streaming shows caret and live status", async () => {
    const h = makeHarness({ delay: 120 });
    const { doc, win } = h;
    await convene(h);
    await waitFor(() => win.__quorum.S.seats.A.status === "writing", 3000, "writing");
    await sleep(40);
    assert.ok(doc.querySelector("#propDoc .caret"), "caret while writing");
    assert.ok(txt(doc.querySelector("#tab-A .tab-meta")).endsWith("words so far"));
    assert.ok(doc.querySelector('[data-seat="A"]').getAttribute("class").includes("is-working"));
    assert.ok(/The builders are drafting/.test(txt(doc.getElementById("status"))));
    // stop mid-way
    await sleep(450);
    assert.strictEqual(win.__quorum.S.phase, "running");
    doc.getElementById("convene").focus();
    doc.getElementById("convene").click();
    await sleep(20);
    const S = win.__quorum.S;
    assert.strictEqual(S.phase, "stopped");
    assert.ok(["A", "B", "C"].every(L => S.seats[L].status === "stopped" || S.seats[L].status === "done"));
    assert.strictEqual(txt(doc.getElementById("status")), "Stopped. Resume to continue where the council left off.");
    assert.ok(!doc.getElementById("resume").hidden);
    assert.strictEqual(doc.activeElement.id, "resume");
    assert.ok(/^Stopped at /.test(txt(doc.getElementById("clock"))));
    assert.ok(!doc.getElementById("propNote").hidden);
    const before = h.calls.length;
    doc.getElementById("resume").click();
    await waitFor(() => S.phase === "done", 15000, "done after resume");
    assert.ok(h.calls.length >= before + 5);
  });

  await run("upstream error pauses and retry continues", async () => {
    const h = makeHarness({ plan: { skeptic: "upstream_error" } });
    const { doc, win } = h;
    await convene(h);
    await waitFor(() => win.__quorum.S.phase === "paused", 8000, "paused");
    await sleep(40);
    const S = win.__quorum.S;
    assert.strictEqual(S.seats.skeptic.status, "error");
    assert.strictEqual(S.seats.advocate.status, "done");
    assert.ok(!doc.getElementById("notice").hidden);
    assert.strictEqual(txt(doc.getElementById("noticeText")), "The Skeptic couldn't finish. The connection to Claude dropped. Retry to continue where the council left off.");
    assert.ok(!doc.getElementById("noticeRetry").hidden);
    assert.strictEqual(txt(doc.getElementById("resume")), "Retry");
    assert.strictEqual(txt(doc.getElementById("status")), "Paused. The Skeptic couldn't finish.");
    assert.strictEqual(doc.querySelector('[data-seat="skeptic"] .seat-glyph').textContent, "!");
    assert.ok(doc.querySelector('.stage-btn[data-stage="council"]').getAttribute("data-state") === "paused");
    // dismiss keeps the Retry button in the controls
    doc.getElementById("noticeDismiss").click();
    await sleep(20);
    assert.ok(doc.getElementById("notice").hidden);
    assert.ok(!doc.getElementById("resume").hidden);
    const advCalls = h.calls.filter(c => c.id === "advocate").length;
    doc.getElementById("resume").click();
    await waitFor(() => S.phase === "done", 8000, "done after retry");
    assert.strictEqual(h.calls.filter(c => c.id === "advocate").length, advCalls, "finished councilors are not asked again");
    assert.strictEqual(h.calls.filter(c => c.id === "skeptic").length, 2);
    assert.strictEqual(h.calls.length, 8);
  });

  await run("unreadable ballot pauses with bad_ballot", async () => {
    const h = makeHarness({ plan: { strategist: "no_ballot" } });
    const { doc, win } = h;
    await convene(h);
    await waitFor(() => win.__quorum.S.phase === "paused", 8000, "paused");
    await sleep(30);
    assert.strictEqual(txt(doc.getElementById("noticeText")), "The Strategist couldn't finish. The ballot at the end of the review couldn't be read. Retry to ask for the review again.");
    doc.getElementById("noticeRetry").click();
    await waitFor(() => win.__quorum.S.phase === "done", 8000, "done");
  });

  await run("declined access blocks the council", async () => {
    const h = makeHarness({ plan: { all: "not_granted" } });
    const { doc, win } = h;
    await convene(h);
    await waitFor(() => win.__quorum.S.phase === "blocked", 5000, "blocked");
    await sleep(30);
    assert.strictEqual(txt(doc.getElementById("noticeText")), "Claude access was declined for this page. Reload the page to be asked again.");
    assert.ok(doc.getElementById("noticeRetry").hidden);
    assert.ok(doc.getElementById("resume").hidden);
    const calls = h.calls.length;
    doc.getElementById("convene").click();
    await sleep(900);
    doc.getElementById("convene").click();
    await sleep(30);
    assert.strictEqual(h.calls.length, calls, "no new requests once access is declined");
    assert.strictEqual(txt(doc.getElementById("agentsNote")), "Claude access was declined for this page. Reload the page to be asked again.");
  });

  await run("refusal needs a reworded request", async () => {
    const h = makeHarness({ plan: { B: "refused" } });
    const { doc, win } = h;
    await convene(h);
    await waitFor(() => win.__quorum.S.phase === "paused", 5000, "paused");
    await sleep(30);
    assert.strictEqual(txt(doc.getElementById("noticeText")), "The Visionary couldn't finish. Claude declined to work on this request as written. Reword it, then convene again.");
    assert.ok(doc.getElementById("noticeRetry").hidden);
    assert.ok(doc.getElementById("resume").hidden);
    assert.strictEqual(win.__quorum.S.seats.B.text, "", "refused text withdrawn");
    assert.ok(!doc.getElementById("convene").disabled);
  });

  await run("deadlock goes to the Chair", async () => {
    const h = makeHarness({
      deciding: "C",
      ballots: {
        advocate: [["A", "B", "C"], { A: 8, B: 6, C: 4 }],
        skeptic: [["B", "C", "A"], { A: 4, B: 8, C: 6 }],
        strategist: [["C", "A", "B"], { A: 6, B: 4, C: 8 }],
      },
      delay: 15,
    });
    const { doc, win } = h;
    await convene(h);
    await waitFor(() => win.__quorum.S.tally, 8000, "tally");
    await sleep(30);
    assert.strictEqual(txt(doc.getElementById("verdict")), "All three proposals are tied on points, first-place votes and combined scores. The Chair will cast the deciding vote.");
    assert.strictEqual(doc.querySelectorAll("#division .tag.is-tied").length, 3);
    assert.strictEqual(doc.querySelector('.stage-btn[data-stage="vote"]').getAttribute("data-state"), "tied");
    assert.ok(h.calls.find(c => c.id === "chair").prompt.includes("I cast the deciding vote for Proposal X."));
    await waitFor(() => win.__quorum.S.phase === "done", 8000, "done");
    await sleep(40);
    assert.strictEqual(win.__quorum.S.decided, "C");
    assert.strictEqual(txt(doc.getElementById("verdict")), "The council was deadlocked, so the Chair cast the deciding vote for Proposal C, “Tool Commons”.");
    assert.deepStrictEqual([...doc.querySelectorAll("#division tbody tr")].map(r => r.getAttribute("data-letter")), ["C", "A", "B"]);
    assert.strictEqual(txt(doc.querySelector("#tab-C .tab-meta")), "Adopted with 6 points");
  });

  await run("tier substitution is noted", async () => {
    const h = makeHarness({ tierApplied: "default" });
    const { doc, win } = h;
    await convene(h);
    await waitFor(() => win.__quorum.S.phase === "done", 8000, "done");
    await sleep(30);
    assert.strictEqual(txt(doc.getElementById("tierNote")), "Frontier isn't available on your plan, so the council and the Chair answered on Balanced.");
    const chip = doc.getElementById("planTier");
    assert.ok(chip.classList.contains("is-sub"));
    assert.strictEqual(txt(chip), "Agent: Claude Balanced, because Frontier isn't available on your plan");
    assert.strictEqual(txt(doc.getElementById("propTier")), "Agent: Claude Fast");
  });

  await run("each role runs on the model chosen for it", async () => {
    const h = makeHarness({ delay: 20 });
    const { doc, win } = h;
    await sleep(20);
    const pick = (id, value) => { const el = doc.getElementById(id); el.value = value; el.dispatchEvent(new win.Event("change", { bubbles: true })); };
    pick("tier-builders", "default");
    pick("tier-council", "quick");
    doc.querySelector('input[name="length"][value="brief"]').click();
    await sleep(20);
    assert.deepStrictEqual(JSON.parse(win.localStorage.getItem("quorum:agents")), { builders: { provider: "claude", model: "default" }, council: { provider: "claude", model: "quick" }, chair: { provider: "claude", model: "complex" } });
    assert.strictEqual(win.localStorage.getItem("quorum:length"), "brief");
    await convene(h);
    await sleep(15);
    assert.ok(doc.getElementById("tier-chair").disabled && doc.getElementById("provider-chair").disabled, "agent choices are locked while the council sits");
    await waitFor(() => win.__quorum.S.phase === "done", 8000, "done");
    await sleep(20);
    assert.deepStrictEqual(h.calls.map(c => c.id + ":" + c.tier).sort(), ["A:default", "B:default", "C:default", "advocate:quick", "chair:complex", "skeptic:quick", "strategist:quick"]);
    assert.ok(h.calls.find(c => c.id === "A").prompt.includes("about 300 words"));
    assert.ok(h.calls.find(c => c.id === "chair").prompt.includes("about 650 words"));
    assert.ok(!doc.getElementById("tier-chair").disabled);
  });

  await run("saved model choices come back on the next visit", async () => {
    const h = makeHarness({ storage: { "quorum:models": JSON.stringify({ builders: "complex", council: "default", chair: "bogus" }), "quorum:length": "detailed" } });
    await sleep(30);
    const { doc } = h;
    assert.strictEqual(doc.getElementById("tier-builders").value, "complex", "older saved tiers carry over");
    assert.strictEqual(doc.getElementById("tier-council").value, "default");
    assert.strictEqual(doc.getElementById("tier-chair").value, "complex", "unknown values fall back to the default");
    assert.ok(doc.querySelector('input[name="length"][value="detailed"]').checked);
  });

  await run("context over the limit blocks convening", async () => {
    const h = makeHarness();
    const { doc, win } = h;
    await sleep(20);
    doc.querySelector('.add-btn[data-kind="today"]').click();
    const ta = doc.querySelector("#contextList .ctx-text");
    ta.value = "x".repeat(24001);
    ta.dispatchEvent(new win.Event("input", { bubbles: true }));
    await sleep(10);
    assert.ok(doc.getElementById("contextCount").classList.contains("is-over"));
    await convene(h);
    await sleep(20);
    assert.strictEqual(h.calls.length, 0);
    assert.strictEqual(txt(doc.getElementById("contextNote")), "The context is 24,001 characters, more than the 24,000 the council can read at once. Trim it or remove a piece, then convene.");
    assert.strictEqual(doc.activeElement, ta);
    ta.value = "x".repeat(100);
    ta.dispatchEvent(new win.Event("input", { bubbles: true }));
    await sleep(10);
    assert.ok(doc.getElementById("contextNote").hidden);
  });

  await run("examples fill the feature and context, and undo restores the draft", async () => {
    const h = makeHarness();
    const { doc, win } = h;
    await sleep(20);
    doc.getElementById("feature").value = "My own feature";
    doc.querySelector('.add-btn[data-kind="constraints"]').click();
    const mine = doc.querySelector("#contextList .ctx-text");
    mine.value = "Ship by Friday";
    mine.dispatchEvent(new win.Event("input", { bubbles: true }));
    doc.querySelector('.example[data-example="1"]').click();
    await sleep(10);
    assert.strictEqual(doc.getElementById("feature").value, "Let users export any report on the Reports page as a CSV file.");
    assert.deepStrictEqual([...doc.querySelectorAll("#contextList .ctx-title")].map(i => i.value), ["Product requirements", "How it works today"]);
    assert.ok(!doc.getElementById("exampleNote").hidden);
    doc.getElementById("undoExample").click();
    await sleep(10);
    assert.strictEqual(doc.getElementById("feature").value, "My own feature");
    assert.deepStrictEqual([...doc.querySelectorAll("#contextList .ctx-text")].map(i => i.value), ["Ship by Friday"]);
    assert.ok(doc.getElementById("exampleNote").hidden);
    // an empty form takes an example without offering undo
    doc.querySelector("#contextList .ctx-remove").click();
    doc.getElementById("feature").value = "";
    doc.querySelector('.example[data-example="0"]').click();
    await sleep(10);
    assert.ok(doc.getElementById("exampleNote").hidden);
    assert.strictEqual(doc.querySelectorAll("#contextList .ctx").length, 2);
    await sleep(450);
    const saved = JSON.parse(win.localStorage.getItem("quorum:context"));
    assert.deepStrictEqual(saved.map(c => c.title), ["Product requirements", "How it works today"]);
  });

  await run("removing a block moves focus sensibly", async () => {
    const h = makeHarness();
    const { doc } = h;
    await sleep(20);
    doc.querySelector('.add-btn[data-kind="requirements"]').click();
    doc.querySelector('.add-btn[data-kind="other"]').click();
    const blocks = doc.querySelectorAll("#contextList .ctx");
    assert.strictEqual(doc.activeElement, blocks[1].querySelector(".ctx-title"), "an unnamed block focuses its name first");
    assert.strictEqual(blocks[1].querySelector(".ctx-remove").getAttribute("aria-label"), "Remove this context");
    blocks[0].querySelector(".ctx-remove").click();
    assert.strictEqual(doc.querySelectorAll("#contextList .ctx").length, 1);
    assert.strictEqual(doc.activeElement, blocks[1].querySelector(".ctx-text"));
    blocks[1].querySelector(".ctx-remove").click();
    assert.strictEqual(doc.activeElement, doc.querySelector(".add-btn"));
    assert.strictEqual(txt(doc.getElementById("contextCount")), "");
  });

  await run("saved context comes back on the next visit", async () => {
    const h = makeHarness({ storage: { "quorum:draft": "Saved feature", "quorum:context": JSON.stringify([{ kind: "code", title: "handlers.py", text: "def f():\n    pass" }, { kind: "bogus", title: "", text: "note" }, "junk"]) } });
    await sleep(30);
    const { doc } = h;
    assert.strictEqual(doc.getElementById("feature").value, "Saved feature");
    const titles = [...doc.querySelectorAll("#contextList .ctx-title")].map(i => i.value);
    assert.deepStrictEqual(titles, ["handlers.py", ""]);
    assert.ok(doc.querySelectorAll("#contextList .ctx-text")[0].classList.contains("is-code"));
    assert.strictEqual(txt(doc.getElementById("contextCount")), "21 of 24,000 characters");
  });

  console.log(passed + " smoke tests passed" + (process.exitCode ? " (with failures)" : ""));
  process.exit(process.exitCode || 0);
})();
