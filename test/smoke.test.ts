// In-page tests for Quorum inside claude.ai: the page in jsdom, with a simulated Claude answering each seat.
import { test } from "bun:test";
import { JSDOM } from "jsdom";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(path.join(import.meta.dir, "..", "dist", "quorum.html"), "utf8");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const builderText = (L: string, title: string) => `# ${title}\n> A one-line pitch for ${L}.\n\n## The approach\nKeep it simple and **concrete**.\n\n## What it includes\n- A sign-out sheet\n- A shared shelf\n  - Labeled bins\n\n## How we'd make it happen\n1. Week 1: set up\n2. Week 2: launch\n\n## Risks and trade-offs\nSome risk.\n\n## Why the council should choose this\nBecause it works.`;
const TITLES: Record<string, string> = { A: "Shelf Share", B: "Lend Loop", C: "Tool Commons" };
const councilText = (ranking: string[], scores: Record<string, number>, withBallot = true) => `## Verdict\nI favor ${ranking[0]}.\n\n## A: ${TITLES.A}\nGood.\n\n## B: ${TITLES.B}\nFine.\n\n## C: ${TITLES.C}\nOk.\n\n## Worth keeping\nThe bins.` +
  (withBallot ? `\n\n\`\`\`json\n{"ranking": ${JSON.stringify(ranking)}, "scores": ${JSON.stringify(scores)}}\n\`\`\`` : "");
const checkText = (verdict: string, findings: string) => `## Verdict\n${verdict}\n\n## Findings\n${findings}\n\n## What the plan gets right\nThe sign-out sheet.`;
const CHECKS: Record<string, string> = {
  scaling: checkText("Fine for one building, not for ten.", "1. **High**: the shared sheet becomes a bottleneck. Move it online.\n2. **Medium**: no cap on loans per person."),
  security: checkText("Ready.", "No findings."),
};
const finalText = "# The Building Tool Library, Reviewed\nA shared library for the building.\n\n## The decision\nB.\n\n## Final review\n- **High**, the sheet: moved online.\n\n## Open questions\n- None.";
const chairText = (deciding?: string) => `# The Building Tool Library\nA shared library for the building.\n\n## The decision\n${deciding ? "I cast the deciding vote for Proposal " + deciding + ". " : ""}The council chose well.\n\n## Scope\nIn and out.\n\n## How it works\nPieces.\n\n## Milestones\n1. One — a week\n2. Two — a week\n\n## Risks and mitigations\n- Risk: handled\n\n## Open questions\n- Who keeps the keys?`;

interface HarnessOptions {
  // How each seat's first answer goes wrong, by seat: an error code, or "no_ballot"; all: "not_granted" declines them all.
  plan?: Record<string, string>;
  ballots?: Record<string, [string[], Record<string, number>]>;
  deciding?: string;
  questions?: boolean;
  storage?: Record<string, string>;
  tierApplied?: string;
  delay?: number;
  thinkDelay?: number;
}

interface Call {
  id: string;
  tier: string;
  cache: boolean;
  len: number;
  prompt: string;
}

// The page in jsdom inside a simulated claude.ai. win and doc are the page's own window and document, which the tests
// reach into freely.
function makeHarness(opts: HarnessOptions = {}): { dom: JSDOM, win: any, doc: any, calls: Call[], saves: any[], counts: Record<string, number> } {
  const calls: Call[] = [];
  const saves: any[] = [];
  const plan = opts.plan || {};
  const counts: Record<string, number> = {};
  function who(prompt: string): string {
    if (prompt.startsWith("You are The Pragmatist")) return "A";
    if (prompt.startsWith("You are The Visionary")) return "B";
    if (prompt.startsWith("You are The Architect")) return "C";
    if (prompt.startsWith("You are The Advocate")) return "advocate";
    if (prompt.startsWith("You are The Skeptic")) return "skeptic";
    if (prompt.startsWith("You are The Strategist")) return "strategist";
    if (prompt.startsWith("You are The Scaling Reviewer")) return "scaling";
    if (prompt.startsWith("You are The Security Reviewer")) return "security";
    if (/^You are the Chair[^\n]*finishing the plan after its final review/.test(prompt)) return "final";
    if (prompt.startsWith("You are the Chair")) return "chair";
    return "?";
  }
  const ballots = opts.ballots || {
    advocate: [["B", "A", "C"], { A: 7, B: 9, C: 4 }],
    skeptic: [["A", "B", "C"], { A: 8, B: 7, C: 3 }],
    strategist: [["B", "C", "A"], { A: 5, B: 8, C: 6 }],
  };
  function textFor(id: string, n: number): string {
    if (["A", "B", "C"].includes(id)) return builderText(id, TITLES[id]);
    if (id === "chair") return chairText(opts.deciding);
    if (CHECKS[id]) return CHECKS[id];
    if (id === "final") return finalText;
    const [r, s] = ballots[id];
    const noBallot = plan[id] === "no_ballot" && n === 1;
    return councilText(r, s, !noBallot);
  }
  const sample = function (prompt: string, o: any) {
    const id = who(prompt);
    counts[id] = (counts[id] || 0) + 1;
    const n = counts[id];
    calls.push({ id, tier: o.modelTier, cache: o.cache, len: prompt.length, prompt });
    const signal = o.signal;
    return new Promise((resolve, reject) => {
      const full = textFor(id, n);
      const failure = plan[id] && n === 1 && plan[id] !== "no_ballot" ? plan[id] : null;
      if (plan.all === "not_granted") return setTimeout(() => reject({ code: "not_granted", message: "declined" }), 5);
      const chunks = full.match(/[\s\S]{1,40}/g) as string[];
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
  const downloads = Object.freeze({ save: (req: unknown) => { saves.push(req); return Promise.resolve({ status: "saved" }); } });
  const dom = new JSDOM(html, {
    url: "https://example.org/quorum",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window: any) {
      window.__QUORUM_TEST__ = true;
      if (!opts.questions) window.localStorage.setItem("quorum:questions", "off");
      Object.keys(opts.storage || {}).forEach(k => window.localStorage.setItem(k, (opts.storage as Record<string, string>)[k]));
      window.claude = { use: (name: string) => Promise.resolve(name === "sample" ? sample : name === "downloads" ? downloads : null) };
      window.Element.prototype.scrollIntoView = function () {};
      window.console.error = (...a: unknown[]) => { console.log("[page error]", ...a); };
    },
  });
  return { dom, win: dom.window, doc: dom.window.document, calls, saves, counts };
}

type Harness = ReturnType<typeof makeHarness>;

async function waitFor(fn: () => unknown, ms = 5000, label = "condition") {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await sleep(10); }
  throw new Error("Timed out waiting for " + label);
}
const txt = (el: Element) => (el.textContent || "").replace(/\s+/g, " ").trim();

async function convene(h: Harness, feature = "Let users export reports as CSV.") {
  const { doc, win } = h;
  await sleep(20);
  doc.getElementById("feature").value = feature;
  doc.getElementById("convene").click();
}

test("idle state renders", async () => {
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
  assert.strictEqual(doc.querySelector('#provider-builders option[value="claude-code"]').textContent, "Claude Code (outside Claude only)");
  assert.ok(doc.getElementById("project").hidden);
  assert.ok(doc.getElementById("set-openrouter").disabled, "provider settings are off inside Claude");
  assert.strictEqual(txt(doc.getElementById("providersStatus")), "Every agent runs on Claude here");
  assert.ok(doc.querySelector('input[name="length"][value="standard"]').checked);
  assert.ok(doc.getElementById("agentsNote").hidden);
});

test("empty feature shows a field note", async () => {
  const h = makeHarness();
  await sleep(20);
  h.doc.getElementById("feature").value = "   ";
  h.doc.getElementById("convene").click();
  await sleep(20);
  assert.ok(!h.doc.getElementById("featureNote").hidden);
  assert.strictEqual(h.calls.length, 0);
});

test("full session happy path", async () => {
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
    const p = h.calls.find(c => c.id === id)!.prompt;
    assert.ok(p.includes("=== Context: Product requirements ===\n- Export button on every report\n- Respect active filters\n=== End of context: Product requirements ==="), id);
    assert.ok(p.includes("=== Context: Relevant code ===\ndef export(report):\n    return rows\n=== End of context: Relevant code ==="), id);
  });
  assert.ok(!doc.getElementById("motionContext").hidden);
  assert.strictEqual(txt(doc.getElementById("motionContextSummary")), "With 2 pieces of context: Product requirements and Relevant code");
  assert.strictEqual(doc.querySelectorAll("#motionContextBody pre").length, 2);
  assert.ok(block.querySelector(".ctx-text").readOnly === false, "editable again after the session");
  // council prompts are blind and rotated
  const sk = h.calls.find(c => c.id === "skeptic")!.prompt;
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
  const seatCls = (id: string) => doc.querySelector(`[data-seat="${id}"]`).getAttribute("class");
  ["A", "B", "C", "advocate", "skeptic", "strategist", "chair"].forEach(id => assert.ok(seatCls(id).includes("is-done"), id + " " + seatCls(id)));
  assert.strictEqual(doc.querySelector('[data-seat="chair"]').getAttribute("data-letter"), "B");
  assert.strictEqual(doc.querySelector('[data-seat="chair"] .seat-glyph').textContent, "B");
  assert.strictEqual(doc.querySelector('[data-seat="skeptic"] .seat-glyph').textContent, "A");
  assert.strictEqual(doc.querySelector('[data-seat="A"]').getAttribute("tabindex"), "0");
  assert.ok(doc.getElementById("stageReview").hidden, "no final review stage unless it's asked for");
  [...doc.querySelectorAll(".stage-btn")].filter(b => !b.closest("li").hidden).forEach(b => assert.strictEqual(b.getAttribute("data-state"), "done"));
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

test("streaming shows caret and live status", async () => {
  const h = makeHarness({ delay: 120 });
  const { doc, win } = h;
  await convene(h);
  await waitFor(() => win.__quorum.S.seats.A.status === "writing", 3000, "writing");
  await sleep(40);
  assert.ok(doc.querySelector("#propDoc .caret"), "caret while writing");
  assert.ok(txt(doc.querySelector("#tab-A .tab-meta")).endsWith("words so far"));
  assert.ok(doc.querySelector('[data-seat="A"]').getAttribute("class").includes("is-working"));
  assert.ok(/The builders are drafting/.test(txt(doc.getElementById("status"))));
  // The conversation shows the agent writing, as it writes.
  doc.getElementById("propConvo").click();
  await sleep(40);
  assert.strictEqual(txt(doc.querySelector("#convoBody .turn.is-live .turn-head")), "The Pragmatist is writing");
  assert.ok(doc.querySelector("#convoBody .turn.is-live .caret"));
  assert.ok(/^Claude Fast \u00B7 Running$/.test(txt(doc.getElementById("convoMeta"))), txt(doc.getElementById("convoMeta")));
  assert.strictEqual(txt(doc.querySelector("#convoStep option")), "Proposal A \u00B7 The Pragmatist (writing)");
  const prompt = doc.querySelector("#convoBody details.is-prompt");
  prompt.open = false;
  const grew = txt(doc.querySelector("#convoBody .turn.is-live .turn-doc")).length;
  await sleep(300);
  assert.ok(txt(doc.querySelector("#convoBody .turn.is-live .turn-doc")).length > grew, "it keeps up");
  assert.strictEqual(doc.querySelector("#convoBody details.is-prompt"), prompt, "and leaves the rest alone");
  assert.ok(!prompt.open, "a fold the reader closed stays closed");
  doc.getElementById("convoClose").click();
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

test("upstream error pauses and retry continues", async () => {
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

test("steps hand on frozen copies, and a retry builds on them", async () => {
  const h = makeHarness({ plan: { skeptic: "upstream_error" } });
  const { doc, win } = h;
  await convene(h);
  await waitFor(() => win.__quorum.S.phase === "paused", 8000, "paused");
  const S = win.__quorum.S;
  assert.deepStrictEqual(Object.keys(S.handoffs).sort(), ["A", "B", "C", "advocate", "brief", "revision", "strategist"]);
  const A = S.handoffs.A, advocate = S.handoffs.advocate;
  assert.ok(Object.isFrozen(A) && Object.isFrozen(A.data) && Object.isFrozen(advocate.data.ballot.ranking));
  assert.strictEqual(A.data.title, "Shelf Share");
  assert.deepStrictEqual({ ...A.data.agent }, { provider: "claude", model: "quick" });
  assert.throws(() => { A.data.text = "changed"; }, TypeError);
  assert.ok(A.data.text.startsWith("# Shelf Share"), "a handoff can't be changed");
  // Workers read only their handoffs, so what the page holds for a seat can't leak into another's prompt.
  S.seats.A.text = "# Tampered";
  doc.getElementById("resume").click();
  await waitFor(() => S.phase === "done", 8000, "done after retry");
  assert.strictEqual(S.handoffs.A, A, "finished handoffs are kept, not remade");
  assert.strictEqual(S.handoffs.advocate, advocate);
  const retried = h.calls.filter(c => c.id === "skeptic")[1].prompt;
  assert.ok(retried.includes("=== Proposal A ===\n# Shelf Share"));
  assert.ok(!h.calls.some(c => c.prompt.includes("Tampered")));
  assert.strictEqual(S.handoffs.tally.data.winner, "B");
});

test("unreadable ballot pauses with bad_ballot", async () => {
  const h = makeHarness({ plan: { strategist: "no_ballot" } });
  const { doc, win } = h;
  await convene(h);
  await waitFor(() => win.__quorum.S.phase === "paused", 8000, "paused");
  await sleep(30);
  assert.strictEqual(txt(doc.getElementById("noticeText")), "The Strategist couldn't finish. The ballot at the end of the review couldn't be read. Retry to ask for the review again.");
  doc.getElementById("noticeRetry").click();
  await waitFor(() => win.__quorum.S.phase === "done", 8000, "done");
  await sleep(30);
  doc.getElementById("tab-strategist").click();
  await sleep(20);
  doc.getElementById("councilConvo").click();
  await sleep(30);
  assert.deepStrictEqual([...doc.querySelectorAll("#convoBody .convo-attempt")].map(txt), [
    "Attempt 1 of 2 \u00B7 Couldn't finish: The ballot at the end of this review couldn't be read. (The review ends without a readable ballot.)",
    "Attempt 2 of 2"], "the answer that couldn't be read is kept, and so is the retry");
  assert.ok(/ \u00B7 2 attempts$/.test(txt(doc.getElementById("convoMeta"))));
  const answers = [...doc.querySelectorAll("#convoBody .turn.is-answer .turn-doc")].map(txt);
  assert.strictEqual(answers.length, 2);
  assert.ok(!answers[0].includes("ranking") && answers[1].includes("ranking"), "the first had no ballot, the second did");
});

test("declined access blocks the council", async () => {
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

test("refusal needs a reworded request", async () => {
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

test("deadlock goes to the Chair", async () => {
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
  await waitFor(() => win.__quorum.S.handoffs.tally, 8000, "tally");
  await sleep(30);
  assert.strictEqual(txt(doc.getElementById("verdict")), "All three proposals are tied on points, first-place votes and combined scores. The Chair will cast the deciding vote.");
  assert.strictEqual(doc.querySelectorAll("#division .tag.is-tied").length, 3);
  assert.strictEqual(doc.querySelector('.stage-btn[data-stage="vote"]').getAttribute("data-state"), "tied");
  assert.ok(h.calls.find(c => c.id === "chair")!.prompt.includes("I cast the deciding vote for Proposal X."));
  await waitFor(() => win.__quorum.S.phase === "done", 8000, "done");
  await sleep(40);
  assert.strictEqual(win.__quorum.S.handoffs.chair.data.decided, "C");
  assert.strictEqual(txt(doc.getElementById("verdict")), "The council was deadlocked, so the Chair cast the deciding vote for Proposal C, “Tool Commons”.");
  assert.deepStrictEqual([...doc.querySelectorAll("#division tbody tr")].map(r => r.getAttribute("data-letter")), ["C", "A", "B"]);
  assert.strictEqual(txt(doc.querySelector("#tab-C .tab-meta")), "Adopted with 6 points");
  // after a reload, the deciding vote is read from the plan again
  const h2 = makeHarness({ storage: { "quorum:session": win.localStorage.getItem("quorum:session") } });
  await sleep(40);
  assert.strictEqual(h2.win.__quorum.S.handoffs.chair.data.decided, "C");
  assert.strictEqual(txt(h2.doc.getElementById("verdict")), "The council was deadlocked, so the Chair cast the deciding vote for Proposal C, “Tool Commons”.");
});

test("questions and input on the plan go back to the builders, and the council votes again", async () => {
  const h = makeHarness();
  const { doc, win } = h;
  await convene(h);
  await waitFor(() => win.__quorum.S.phase === "done", 8000, "done");
  await sleep(30);
  const S = win.__quorum.S, revise = doc.getElementById("revise");
  assert.ok(!revise.hidden, "the plan takes questions and input");
  assert.ok(doc.getElementById("sec-rounds").hidden);
  doc.getElementById("reviseBtn").click();
  await sleep(20);
  assert.strictEqual(txt(doc.getElementById("reviseNote")), "Write your questions or input first.");
  assert.strictEqual(h.calls.length, 7);
  doc.getElementById("reviseInput").value = "Why a shared shelf?\nWe also need a waitlist.";
  doc.getElementById("reviseBtn").click();
  await sleep(15);
  assert.strictEqual(S.round, 2);
  assert.ok(revise.hidden, "no input while the council is at work");
  assert.strictEqual(doc.getElementById("reviseInput").value, "");
  assert.strictEqual(txt(doc.getElementById("status")), "The builders are revising their proposals with your input.");
  assert.strictEqual(txt(doc.getElementById("motionRoundIntro")), "Round 2 revises the round 1 plan with your input:");
  assert.strictEqual(doc.getElementById("motionRoundQuote").textContent, "Why a shared shelf?\nWe also need a waitlist.");
  assert.ok(/^Round 2 · In session/.test(txt(doc.getElementById("clock"))));
  await waitFor(() => S.phase === "done", 8000, "round 2 done");
  await sleep(30);
  const again = h.calls.slice(7);
  assert.deepStrictEqual(again.map(c => c.id).sort(), ["A", "B", "C", "advocate", "chair", "skeptic", "strategist"], "every seat works again");
  const a2 = again.find(c => c.id === "A")!.prompt;
  assert.ok(a2.includes("This is round 2. In round 1 the council adopted Proposal B, \u201CLend Loop\u201D"));
  assert.ok(a2.includes("Why a shared shelf?\nWe also need a waitlist."));
  assert.ok(a2.includes("=== Your proposal from round 1 ===\n# Shelf Share"), "each builder revises its own proposal");
  assert.ok(a2.includes("=== Plan from round 1 ===\n# The Building Tool Library"));
  assert.ok(again.find(c => c.id === "skeptic")!.prompt.includes("the builders revised their proposals"));
  assert.ok(again.find(c => c.id === "chair")!.prompt.includes("## Your input, answered"));
  assert.strictEqual(S.past.length, 1);
  assert.strictEqual(S.past[0].A.data.title, "Shelf Share", "round 1 is kept");
  assert.strictEqual(txt(doc.getElementById("status")), "The council has adjourned. Proposal B carried, and the revised plan is ready.");
  assert.ok(txt(doc.getElementById("planByline")).startsWith("Round 2. Written by the Chair from Proposal B"));
  assert.ok(!doc.getElementById("sec-rounds").hidden);
  const round1 = doc.querySelectorAll("#roundsList .round");
  assert.strictEqual(round1.length, 1);
  assert.strictEqual(txt(round1[0].querySelector("summary")), "Round 1: The Building Tool LibraryBuilt on Proposal B, \u201CLend Loop\u201D");
  assert.strictEqual(round1[0].querySelector("blockquote").textContent, "Why a shared shelf?\nWe also need a waitlist.");
  const earlier = round1[0].querySelector("[data-convo-round]");
  assert.strictEqual(txt(earlier), "Every agent\u2019s conversation in round 1");
  earlier.click();
  await sleep(30);
  const step = doc.getElementById("convoStep");
  assert.strictEqual(step.value, "1:A");
  assert.deepStrictEqual([...step.querySelectorAll("optgroup")].map(g => g.label + ":" + g.children.length), ["Round 1:7", "Round 2:7"]);
  assert.ok(txt(doc.getElementById("convoMeta")).startsWith("Round 1 \u00B7 Claude Fast"));
  assert.strictEqual(doc.querySelector("#convoBody pre").textContent, h.calls[0].id === "A" ? h.calls[0].prompt : h.calls.slice(0, 7).find(c => c.id === "A")!.prompt);
  step.value = "2:A";
  step.dispatchEvent(new win.Event("change", { bubbles: true }));
  assert.strictEqual(doc.querySelector("#convoBody pre").textContent, again.find(c => c.id === "A")!.prompt, "round 2's own prompt, with the input");
  doc.getElementById("convoClose").click();
  assert.ok(!revise.hidden, "the revised plan takes input too");
  doc.getElementById("dlRecord").click();
  await sleep(20);
  const rec = h.saves[h.saves.length - 1].data;
  assert.ok(rec.includes("## Your input on the round 1 plan\n\n> Why a shared shelf?\n> We also need a waitlist."));
  assert.ok(rec.includes("Round 2."), "the setup line names the round");
  assert.ok(rec.includes("\n---\n\n# Round 1\n\n## The Building Tool Library"), "earlier rounds follow");
  assert.ok(rec.includes("*By the Pragmatist, on Claude Fast*"), "each earlier step keeps its byline");
  assert.strictEqual(win.location.hash, "", "nothing is saved inside claude.ai");
  assert.ok(doc.getElementById("saveState").hidden);
});

test("a final review, if asked for, checks the plan for scaling and security, and the Chair revises it", async () => {
  // Slow enough that the short reviews are still being written when the test looks at them.
  const h = makeHarness({ delay: 30 });
  const { doc, win } = h;
  await sleep(20);
  assert.ok(doc.getElementById("row-review").hidden, "the review agent shows only once the review is asked for");
  doc.getElementById("reviewOn").click();
  await sleep(10);
  assert.ok(!doc.getElementById("row-review").hidden);
  assert.strictEqual(doc.getElementById("tier-review").value, "complex");
  assert.ok(!doc.getElementById("stageReview").hidden);
  assert.strictEqual(txt(doc.querySelector('.stage-btn[data-stage="plan"] .stage-n')), "5");
  assert.ok(txt(doc.getElementById("settingsHint")).includes("The final review adds three requests: two reviews and the Chair's revision."));
  assert.strictEqual(win.localStorage.getItem("quorum:review"), "on");
  const tier = doc.getElementById("tier-review");
  tier.value = "default";
  tier.dispatchEvent(new win.Event("change", { bubbles: true }));
  await convene(h);
  const S = win.__quorum.S;
  await waitFor(() => S.seats.chair.status === "done" && S.seats.scaling.status !== "idle", 8000, "the reviewers to start");
  await sleep(40);
  assert.ok(doc.getElementById("reviewOn").disabled, "the review can't be switched while the council sits");
  assert.ok(/^The reviewers are checking the plan for scaling and security\./.test(txt(doc.getElementById("status"))), txt(doc.getElementById("status")));
  assert.ok(!doc.getElementById("sec-review").hidden);
  assert.ok(txt(doc.getElementById("planDoc")).startsWith("The Building Tool Library"), "the plan shows while it's reviewed");
  assert.strictEqual(txt(doc.getElementById("planNote")), "This is the plan before the final review. The Chair revises it once the reviewers are done.");
  assert.ok(doc.getElementById("planActions").hidden, "it can't be copied until it's final");
  await waitFor(() => S.phase === "done", 8000, "done");
  await sleep(40);
  assert.deepStrictEqual(h.calls.map(c => c.id + ":" + c.tier).sort(), ["A:quick", "B:quick", "C:quick", "advocate:complex", "chair:complex", "final:complex", "scaling:default", "security:default", "skeptic:complex", "strategist:complex"]);
  const scaling = h.calls.find(c => c.id === "scaling")!.prompt;
  assert.ok(scaling.includes("=== The Chair's plan ===\n# The Building Tool Library\nA shared library"));
  const fin = h.calls.find(c => c.id === "final")!.prompt;
  assert.ok(fin.includes("=== Review by the Scaling Reviewer ===\n## Verdict\nFine for one building, not for ten."));
  assert.ok(fin.includes("=== Review by the Security Reviewer ===\n## Verdict\nReady."));
  assert.deepStrictEqual({ ...S.handoffs.scaling.data.findings }, { critical: 0, high: 1, medium: 1, low: 0 });
  assert.strictEqual(txt(doc.querySelector("#tab-scaling .tab-title")), "1 high, 1 medium");
  assert.strictEqual(txt(doc.querySelector("#tab-security .tab-title")), "No findings");
  assert.strictEqual(txt(doc.getElementById("reviewCount")), "Both reviews are in");
  assert.strictEqual(txt(doc.getElementById("reviewByline")), "Review by the Scaling Reviewer");
  assert.strictEqual(txt(doc.getElementById("reviewTier")), "Agent: Claude Balanced");
  doc.getElementById("tab-security").click();
  await sleep(20);
  assert.ok(txt(doc.getElementById("reviewDoc")).startsWith("Verdict Ready."));
  assert.ok(txt(doc.getElementById("planDoc")).startsWith("The Building Tool Library, Reviewed"), "the plan is the Chair's revision");
  assert.strictEqual(txt(doc.getElementById("planByline")), "Written by the Chair from Proposal B, \u201CLend Loop\u201D, and revised after the final review.");
  assert.ok(doc.getElementById("planNote").hidden);
  assert.ok(!doc.getElementById("planDraft").hidden);
  assert.ok(txt(doc.getElementById("planDraftDoc")).startsWith("The Building Tool Library A shared library"), "the plan before the review is kept");
  assert.strictEqual(txt(doc.querySelector("#h-plan .sec-num")), "5");
  assert.strictEqual(txt(doc.getElementById("status")), "The council has adjourned. Proposal B carried, and the plan is ready.");
  [...doc.querySelectorAll(".stage-btn")].filter(b => !b.closest("li").hidden).forEach(b => assert.strictEqual(b.getAttribute("data-state"), "done", b.getAttribute("data-stage")));
  assert.ok(doc.querySelector('[data-seat="chair"]').getAttribute("class").includes("is-done"));
  doc.getElementById("dlPlan").click();
  await sleep(20);
  assert.strictEqual(h.saves[0].filename, "plan-the-building-tool-library-reviewed.md");
  assert.strictEqual(h.saves[0].data, finalText + "\n", "the reviewed plan is the one saved");
  doc.getElementById("dlRecord").click();
  await sleep(20);
  const rec = h.saves[1].data;
  assert.ok(rec.startsWith(finalText));
  assert.ok(rec.includes("Final review on Claude Balanced."));
  assert.ok(rec.includes("### The Scaling Reviewer\n\n*1 high, 1 medium, on Claude Balanced*"));
  assert.ok(rec.includes("### The plan before the final review: The Building Tool Library\n\n*By the Chair, on Claude Frontier*"));
  // A revision round has its own final review, of the revised plan.
  doc.getElementById("reviseInput").value = "What about lost tools?";
  doc.getElementById("reviseBtn").click();
  await waitFor(() => S.round === 2 && S.phase === "done", 8000, "round 2");
  assert.strictEqual(h.calls.length, 20);
  assert.ok(h.calls.slice(10).find(c => c.id === "A")!.prompt.includes("=== Plan from round 1 ===\n# The Building Tool Library, Reviewed"), "the next round revises the reviewed plan");
});

test("tier substitution is noted", async () => {
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

test("each role runs on the model chosen for it", async () => {
  const h = makeHarness({ delay: 20 });
  const { doc, win } = h;
  await sleep(20);
  const pick = (id: string, value: string) => { const el = doc.getElementById(id); el.value = value; el.dispatchEvent(new win.Event("change", { bubbles: true })); };
  pick("tier-builders", "default");
  pick("tier-council", "quick");
  doc.querySelector('input[name="length"][value="brief"]').click();
  await sleep(20);
  assert.deepStrictEqual(JSON.parse(win.localStorage.getItem("quorum:agents")), { builders: { provider: "claude", model: "default" }, council: { provider: "claude", model: "quick" }, chair: { provider: "claude", model: "complex" }, review: { provider: "claude", model: "complex" } });
  assert.strictEqual(win.localStorage.getItem("quorum:length"), "brief");
  await convene(h);
  await sleep(15);
  assert.ok(doc.getElementById("tier-chair").disabled && doc.getElementById("provider-chair").disabled, "agent choices are locked while the council sits");
  await waitFor(() => win.__quorum.S.phase === "done", 8000, "done");
  await sleep(20);
  assert.deepStrictEqual(h.calls.map(c => c.id + ":" + c.tier).sort(), ["A:default", "B:default", "C:default", "advocate:quick", "chair:complex", "skeptic:quick", "strategist:quick"]);
  assert.ok(h.calls.find(c => c.id === "A")!.prompt.includes("about 300 words"));
  assert.ok(h.calls.find(c => c.id === "chair")!.prompt.includes("about 650 words"));
  assert.ok(!doc.getElementById("tier-chair").disabled);
});

test("saved model choices come back on the next visit", async () => {
  const h = makeHarness({ storage: { "quorum:models": JSON.stringify({ builders: "complex", council: "default", chair: "bogus" }), "quorum:length": "detailed" } });
  await sleep(30);
  const { doc } = h;
  assert.strictEqual(doc.getElementById("tier-builders").value, "complex", "older saved tiers carry over");
  assert.strictEqual(doc.getElementById("tier-council").value, "default");
  assert.strictEqual(doc.getElementById("tier-chair").value, "complex", "unknown values fall back to the default");
  assert.ok(doc.querySelector('input[name="length"][value="detailed"]').checked);
});

test("context over the limit blocks convening", async () => {
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

test("examples fill the feature and context, and undo restores the draft", async () => {
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
  assert.deepStrictEqual(saved.map((c: any) => c.title), ["Product requirements", "How it works today"]);
});

test("removing a block moves focus sensibly", async () => {
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

test("saved context comes back on the next visit", async () => {
  const h = makeHarness({ storage: { "quorum:draft": "Saved feature", "quorum:context": JSON.stringify([{ kind: "code", title: "handlers.py", text: "def f():\n    pass" }, { kind: "bogus", title: "", text: "note" }, "junk"]) } });
  await sleep(30);
  const { doc } = h;
  assert.strictEqual(doc.getElementById("feature").value, "Saved feature");
  const titles = [...doc.querySelectorAll("#contextList .ctx-title")].map(i => i.value);
  assert.deepStrictEqual(titles, ["handlers.py", ""]);
  assert.ok(doc.querySelectorAll("#contextList .ctx-text")[0].classList.contains("is-code"));
  assert.strictEqual(txt(doc.getElementById("contextCount")), "21 of 24,000 characters");
});

test("every agent's conversation can be read, from the prompt Quorum sent to the answer", async () => {
  const h = makeHarness();
  const { doc, win } = h;
  await sleep(20);
  assert.ok(doc.getElementById("railConvo").hidden, "nothing to read before the council sits");
  await convene(h);
  await waitFor(() => win.__quorum.S.phase === "done", 8000, "done");
  await sleep(40);
  const link = doc.getElementById("propConvo"), convo = doc.getElementById("convo"), step = doc.getElementById("convoStep");
  assert.ok(!link.hidden);
  assert.strictEqual(link.getAttribute("aria-label"), "Full conversation: Proposal A, The Pragmatist");
  link.focus();
  link.click();
  await sleep(40);
  assert.ok(!convo.hidden);
  assert.strictEqual(doc.activeElement.id, "convoTitle");
  assert.ok(doc.documentElement.classList.contains("is-convo-open"), "the page behind doesn't scroll");
  assert.deepStrictEqual([...step.querySelectorAll("option")].map(o => o.textContent), [
    "Proposal A \u00B7 The Pragmatist", "Proposal B \u00B7 The Visionary", "Proposal C \u00B7 The Architect",
    "Review \u00B7 The Advocate", "Review \u00B7 The Skeptic", "Review \u00B7 The Strategist", "Plan \u00B7 The Chair"]);
  assert.strictEqual(step.querySelectorAll("optgroup").length, 0, "one round needs no grouping");
  assert.strictEqual(step.value, "1:A");
  assert.ok(/^Claude Fast \u00B7 Finished after 0:0\d$/.test(txt(doc.getElementById("convoMeta"))), txt(doc.getElementById("convoMeta")));
  let turns = [...doc.querySelectorAll("#convoBody > *")];
  assert.strictEqual(turns.length, 2);
  const sent = h.calls.find(c => c.id === "A")!.prompt;
  assert.ok(turns[0].open, "the prompt shows");
  assert.strictEqual(txt(turns[0].querySelector("summary")), "Quorum sent the Pragmatist this prompt \u00B7 " + sent.length.toLocaleString("en-US") + " characters");
  assert.strictEqual(turns[0].querySelector("pre").textContent, sent, "exactly what Quorum sent");
  assert.strictEqual(txt(turns[1].querySelector(".turn-head")), "The Pragmatist\u2019s answer");
  assert.strictEqual(txt(turns[1].querySelector(".turn-doc h1")), "Shelf Share");
  assert.ok(doc.getElementById("convoPrev").disabled);
  doc.getElementById("convoNext").click();
  await sleep(30);
  assert.strictEqual(step.value, "1:B");
  assert.strictEqual(doc.querySelector("#convoBody pre").textContent, h.calls.find(c => c.id === "B")!.prompt);
  step.value = "1:chair";
  step.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(30);
  assert.strictEqual(doc.querySelector("#convoBody pre").textContent, h.calls.find(c => c.id === "chair")!.prompt);
  assert.strictEqual(txt(doc.querySelector("#convoBody .turn-head")), "The Chair\u2019s answer");
  assert.ok(doc.getElementById("convoNext").disabled);
  // Focus stays in the viewer, and Escape closes it and goes back to where it was opened.
  doc.getElementById("convoSaveAll").focus();
  doc.getElementById("convoSaveAll").dispatchEvent(new win.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  assert.strictEqual(doc.activeElement.id, "convoClose");
  doc.getElementById("convoClose").dispatchEvent(new win.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
  assert.strictEqual(doc.activeElement.id, "convoSaveAll");
  doc.activeElement.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await sleep(20);
  assert.ok(convo.hidden);
  assert.ok(!doc.documentElement.classList.contains("is-convo-open"));
  assert.strictEqual(doc.activeElement, link);
  // The council's pane opens its councilor's, and the rail opens the latest.
  doc.getElementById("tab-skeptic").click();
  await sleep(20);
  doc.getElementById("councilConvo").click();
  await sleep(30);
  assert.strictEqual(step.value, "1:skeptic");
  assert.ok(doc.querySelector("#convoBody pre").textContent.includes("=== Proposal B ===\n# Lend Loop"), "the councilor read the proposals blind");
  doc.getElementById("convoClose").click();
  assert.ok(!doc.getElementById("railConvo").hidden);
  doc.getElementById("railConvo").click();
  await sleep(30);
  assert.strictEqual(step.value, "1:chair");
  // Every conversation downloads as one file.
  doc.getElementById("convoSaveAll").click();
  await sleep(30);
  const file = h.saves[h.saves.length - 1];
  assert.strictEqual(file.filename, "council-conversations-the-building-tool-library.md");
  assert.ok(file.data.startsWith("# Every agent\u2019s conversation\n\n> Let users export reports as CSV.\n\n"), file.data.slice(0, 120));
  ["Proposal A \u00B7 The Pragmatist", "Review \u00B7 The Skeptic", "Plan \u00B7 The Chair"].forEach(t => assert.ok(file.data.includes("\n## " + t + "\n"), t));
  h.calls.forEach(c => assert.ok(file.data.includes(c.prompt), c.id + "'s prompt"));
  assert.ok(file.data.includes("### The Chair\u2019s answer\n\n#### The Building Tool Library"), "its headings go below the step's");
  turns = doc.querySelectorAll("#convoBody > *");
  assert.strictEqual(turns.length, 2, "nothing drawn twice");
});

test("the last session comes back after a reload", async () => {
  const h = makeHarness();
  const { doc, win } = h;
  await sleep(20);
  doc.querySelector('.add-btn[data-kind="requirements"]').click();
  const ta = doc.querySelector("#contextList .ctx-text");
  ta.value = "- Export button on every report";
  ta.dispatchEvent(new win.Event("input", { bubbles: true }));
  await convene(h);
  await waitFor(() => win.__quorum.S.phase === "done", 8000, "done");
  await sleep(20);
  const saved = win.localStorage.getItem("quorum:session");
  const h2 = makeHarness({ storage: { "quorum:session": saved } });
  await sleep(40);
  const d2 = h2.doc, S = h2.win.__quorum.S;
  assert.strictEqual(S.phase, "done");
  assert.strictEqual(h2.calls.length, 0, "nothing is asked again");
  assert.deepStrictEqual(Object.keys(S.handoffs).sort(), ["A", "B", "C", "advocate", "brief", "chair", "revision", "skeptic", "strategist", "tally"]);
  assert.ok(Object.isFrozen(S.handoffs.advocate.data.ballot));
  assert.ok(d2.getElementById("roster").hidden);
  assert.strictEqual(txt(d2.getElementById("status")), "The council has adjourned. Proposal B carried, and the plan is ready.");
  assert.strictEqual(txt(d2.getElementById("motionQuote")), "Let users export reports as CSV.");
  assert.strictEqual(txt(d2.getElementById("motionContextSummary")), "With one piece of context: Product requirements");
  assert.strictEqual(txt(d2.getElementById("verdict")), "Proposal B, “Lend Loop”, wins with 8 of 9 possible points.");
  assert.strictEqual(txt(d2.querySelector("#tab-advocate .tab-title")), "Ranks B first");
  assert.ok(d2.querySelector("#planDoc h1").textContent.includes("The Building Tool Library"));
  assert.strictEqual(txt(d2.getElementById("propTier")), "Agent: Claude Fast");
  assert.ok(/^Adjourned after 0:0\d$/.test(txt(d2.getElementById("clock"))), txt(d2.getElementById("clock")));
  [...d2.querySelectorAll(".stage-btn")].filter(b => !b.closest("li").hidden).forEach(b => assert.strictEqual(b.getAttribute("data-state"), "done", b.getAttribute("data-stage")));
  d2.getElementById("dlRecord").click();
  await sleep(20);
  assert.ok(h2.saves[0].data.includes("Agents: Builders on Claude Fast, the council on Claude Frontier and the Chair on Claude Frontier. Length: Standard."));
  // What each agent was sent comes back too, rebuilt from the steps before it.
  d2.getElementById("propConvo").click();
  await sleep(30);
  assert.ok(txt(d2.querySelector("#convoBody .convo-note")).startsWith("Rebuilt from the saved session"));
  assert.strictEqual(d2.querySelector("#convoBody pre").textContent, h.calls.find(c => c.id === "A")!.prompt, "the prompt is rebuilt exactly");
  const step = d2.getElementById("convoStep");
  ["skeptic", "chair"].forEach(id => {
    step.value = "1:" + id;
    step.dispatchEvent(new h2.win.Event("change", { bubbles: true }));
    assert.strictEqual(d2.querySelector("#convoBody pre").textContent, h.calls.find(c => c.id === id)!.prompt, id);
  });
  assert.ok(h2.saves[0].data.includes("| B: Lend Loop (adopted) | 1st | 2nd | 1st | 8 |"));
});

test("a saved session is rebuilt only as far as it still reads, and resumes from there", async () => {
  const h = makeHarness();
  await convene(h);
  await waitFor(() => h.win.__quorum.S.phase === "done", 8000, "done");
  await sleep(20);
  const saved = JSON.parse(h.win.localStorage.getItem("quorum:session"));
  saved.seats.advocate.text = "## Verdict\nNo ballot here.";
  const h2 = makeHarness({ storage: { "quorum:session": JSON.stringify(saved) } });
  await sleep(40);
  const { doc } = h2, S = h2.win.__quorum.S;
  assert.strictEqual(S.phase, "stopped");
  assert.deepStrictEqual(Object.keys(S.handoffs).sort(), ["A", "B", "C", "brief", "revision", "skeptic", "strategist"], "the plan needs the count, which needs every ballot");
  assert.strictEqual(S.seats.advocate.status, "stopped");
  assert.strictEqual(S.seats.chair.status, "idle");
  assert.ok(doc.getElementById("sec-vote").hidden && doc.getElementById("sec-plan").hidden);
  assert.strictEqual(txt(doc.getElementById("status")), "Stopped. Resume to continue where the council left off.");
  assert.ok(!doc.getElementById("resume").hidden);
  doc.getElementById("resume").click();
  await waitFor(() => S.phase === "done", 8000, "done after resume");
  assert.deepStrictEqual(h2.calls.map(c => c.id).sort(), ["advocate", "chair"]);
  const h3 = makeHarness({ storage: { "quorum:session": "{not json" } });
  await sleep(30);
  assert.strictEqual(h3.win.__quorum.S.phase, "idle");
  assert.ok(!h3.doc.getElementById("roster").hidden);
});

test("text files come in as named context, and other files are skipped", async () => {
  const h = makeHarness();
  const { doc, win } = h;
  await sleep(20);
  const input = doc.getElementById("fileInput");
  Object.defineProperty(input, "files", { configurable: true, value: [
    new win.File(["def export(report):\r\n    return rows\r\n"], "export.py"),
    new win.File(["# Requirements\n- Export button"], "prd.md"),
    new win.File(["\u0089PNG\u0000\u0000"], "logo.png"),
  ] });
  input.dispatchEvent(new win.Event("change", { bubbles: true }));
  await waitFor(() => !doc.getElementById("contextNote").hidden, 2000, "files read");
  const blocks = [...doc.querySelectorAll("#contextList .ctx")];
  assert.deepStrictEqual(blocks.map(b => b.querySelector(".ctx-title").value), ["export.py", "prd.md"]);
  assert.strictEqual(blocks[0].querySelector(".ctx-text").value, "def export(report):\n    return rows\n");
  assert.ok(blocks[0].querySelector(".ctx-text").classList.contains("is-code"));
  assert.ok(!blocks[1].querySelector(".ctx-text").classList.contains("is-code"));
  assert.strictEqual(doc.activeElement, blocks[0].querySelector(".ctx-text"));
  assert.strictEqual(txt(doc.getElementById("contextNote")), "Skipped logo.png, because only text files up to 200 KB can be added.");
  const drop = new win.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files: [new win.File(["x".repeat(30000)], "dump.sql")] } });
  doc.getElementById("context").dispatchEvent(drop);
  assert.ok(drop.defaultPrevented);
  await waitFor(() => doc.querySelectorAll("#contextList .ctx").length === 3, 2000, "dropped file added");
  await sleep(10);
  assert.strictEqual(txt(doc.getElementById("contextNote")), "The context is now 30,066 characters, more than the 24,000 the council can read at once. Trim it to the parts that matter before you convene.");
  assert.ok(doc.getElementById("contextCount").classList.contains("is-over"));
  await sleep(450);
  assert.deepStrictEqual(JSON.parse(win.localStorage.getItem("quorum:context")).map((c: any) => c.title), ["export.py", "prd.md", "dump.sql"]);
});
