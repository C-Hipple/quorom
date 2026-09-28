// Tests for src/core.ts: Markdown, ballots, the count, prompts, the session graph and the written record.
import { test as t } from "bun:test";
import assert from "node:assert";
import { Core, type Ballot, type Brief, type RecordView, type SessionView, type Transcript } from "../src/core";
import { Graph, type GraphDef, type Handoffs, type Task } from "../src/graph";

const J = (v: unknown) => JSON.parse(JSON.stringify(v));
// Compares as JSON. A third argument says what's being checked, for the reader.
const deq = (a: unknown, b: unknown, _about?: string) => assert.deepStrictEqual(J(a), J(b));
// The steps as the tests call them, whatever their kind, with only the inputs each one reads.
const STEPS: Record<string, any> = Core.STEPS;

// ---------- Markdown ----------
const md = Core.renderMarkdown;
t("heading+para", () => assert.strictEqual(md("# Title\n\nHello **bold** and *it* `c<d>`"), "<h1>Title</h1>\n<p>Hello <strong>bold</strong> and <em>it</em> <code>c&lt;d&gt;</code></p>"));
t("escape html", () => assert.ok(!md("<script>alert(1)</script>").includes("<script>")));
t("escape in heading", () => assert.strictEqual(md("## A <b>x</b>"), "<h2>A &lt;b&gt;x&lt;/b&gt;</h2>"));
t("blockquote pitch", () => assert.strictEqual(md("> One sentence pitch."), "<blockquote><p>One sentence pitch.</p></blockquote>"));
t("ul", () => assert.strictEqual(md("- a\n- b"), "<ul><li>a</li><li>b</li></ul>"));
t("ol start", () => assert.strictEqual(md("3. x\n4. y"), '<ol start="3"><li>x</li><li>y</li></ol>'));
t("nested", () => assert.strictEqual(md("- a\n  - a1\n  - a2\n- b"), "<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>"));
t("nested ul in ol", () => assert.strictEqual(md("1. one\n   - sub\n2. two"), "<ol><li>one<ul><li>sub</li></ul></li><li>two</li></ol>"));
t("loose list", () => assert.strictEqual(md("- a\n\n- b\n\nPara"), "<ul><li>a</li><li>b</li></ul>\n<p>Para</p>"));
t("list then heading", () => assert.strictEqual(md("- a\n## H"), "<ul><li>a</li></ul>\n<h2>H</h2>"));
t("lazy continuation", () => assert.strictEqual(md("- a\ncontinued"), "<ul><li>a<br>continued</li></ul>"));
t("mixed list kinds", () => assert.strictEqual(md("- a\n1. b"), "<ul><li>a</li></ul>\n<ol><li>b</li></ol>"));
t("code fence", () => assert.strictEqual(md("```js\nconst a = '<x>';\n```"), "<pre><code>const a = &#39;&lt;x&gt;&#39;;</code></pre>"));
t("unterminated fence", () => assert.strictEqual(md("```\nabc"), "<pre><code>abc</code></pre>"));
t("hr", () => assert.strictEqual(md("a\n\n---\n\nb"), "<p>a</p>\n<hr>\n<p>b</p>"));
t("table", () => {
  const h = md("| Name | Cost |\n|---|--:|\n| Drill | $5 |\n| Ladder | **$0** |");
  assert.ok(h.startsWith('<div class="table-wrap"><table><thead><tr><th>Name</th><th class="al-r">Cost</th></tr></thead><tbody>'), h);
  assert.ok(h.includes('<td class="al-r"><strong>$0</strong></td>'), h);
});
t("table after para", () => assert.ok(md("Intro\n| a | b |\n|---|---|\n| 1 | 2 |").includes('<p>Intro</p>\n<div class="table-wrap">')));
t("link", () => assert.strictEqual(md("[site](https://ex.com/a_b_c?x=1&y=2)"), '<p><a href="https://ex.com/a_b_c?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">site</a></p>'));
t("no js link", () => assert.ok(!md("[x](javascript:alert(1))").includes("<a ")));
t("snake_case untouched", () => assert.strictEqual(md("use snake_case_names here"), "<p>use snake_case_names here</p>"));
t("underscore italic", () => assert.strictEqual(md("an _emph_ word"), "<p>an <em>emph</em> word</p>"));
t("math star", () => assert.strictEqual(md("2 * 3 * 4"), "<p>2 * 3 * 4</p>"));
t("bold italic", () => assert.strictEqual(md("***both***"), "<p><strong><em>both</em></strong></p>"));
t("italic inside bold", () => assert.strictEqual(md("**a *b* c**"), "<p><strong>a <em>b</em> c</strong></p>"));
t("strike", () => assert.strictEqual(md("~~no~~"), "<p><del>no</del></p>"));
t("soft breaks", () => assert.strictEqual(md("**Effort:** 2 weeks\n**Cost:** $0"), "<p><strong>Effort:</strong> 2 weeks<br><strong>Cost:</strong> $0</p>"));
t("code in link text", () => assert.strictEqual(md("[`x`](https://a.b)"), '<p><a href="https://a.b" target="_blank" rel="noopener noreferrer"><code>x</code></a></p>'));
t("nul stripped", () => assert.ok(!md("a\u00000\u0000b").includes("undefined")));
t("streaming partial bold", () => assert.strictEqual(md("Some **bol"), "<p>Some **bol</p>"));
t("empty", () => assert.strictEqual(md(""), ""));
t("heading hashes trailing", () => assert.strictEqual(md("## Title ##"), "<h2>Title</h2>"));
t("hashtag not heading", () => assert.strictEqual(md("#hashtag"), "<p>#hashtag</p>"));
t("quote multi para", () => assert.strictEqual(md("> a\n>\n> b"), "<blockquote><p>a</p>\n<p>b</p></blockquote>"));
t("indented continuation after blank", () => assert.strictEqual(md("- a\n\n  more\n- b"), "<ul><li>a<br>more</li><li>b</li></ul>"));

// ---------- Titles, slugs ----------
t("titleOf", () => assert.strictEqual(Core.titleOf("# **Shelf Share**\n> pitch"), "Shelf Share"));
t("titleOf none", () => assert.strictEqual(Core.titleOf("## Only h2"), ""));
t("titleOf later", () => assert.strictEqual(Core.titleOf("\n\n# Late Title #\n"), "Late Title"));
t("slug", () => assert.strictEqual(Core.slug("Café Crème: The Plan!"), "cafe-creme-the-plan"));
t("slug empty", () => assert.strictEqual(Core.slug("!!!"), "plan"));
t("namesList", () => assert.strictEqual(Core.namesList(["The Visionary", "The Skeptic", "The Chair"]), "The Visionary, the Skeptic and the Chair"));

// ---------- Ballots ----------
const review = "## Verdict\nB is best.\n\n## A: X\nok\n\n## Worth keeping\nThe sign-out sheet.\n\n```json\n{\"ranking\": [\"B\", \"A\", \"C\"], \"scores\": {\"A\": 7, \"B\": 9, \"C\": 4}}\n```";
const F = (body: string) => "```json\n" + body + "\n```";
t("extract fenced", () => deq(Core.extractBallot(review), { ranking: ["B", "A", "C"], scores: { A: 7, B: 9, C: 4 } }));
t("extract raw", () => deq(Core.extractBallot('Text\n{"ranking":["C","B","A"],"scores":{"A":3,"B":5,"C":8}}')!.ranking, ["C", "B", "A"]));
t("extract after other fence", () => deq(Core.extractBallot("```\ncode\n```\ntext\n" + F('{"ranking":["A","C","B"],"scores":{"A":9,"B":2,"C":5}}'))!.ranking, ["A", "C", "B"]));
t("extract unterminated", () => deq(Core.extractBallot('x\n```json\n{"ranking": ["A","B","C"], "scores": {"A":1,"B":2,"C":3}}')!.ranking, ["A", "B", "C"]));
t("extract smart quotes + trailing comma", () => deq(Core.extractBallot(F("{\u201Cranking\u201D: [\u201CB\u201D, \u201CC\u201D, \u201CA\u201D,], \u201Cscores\u201D: {\u201CA\u201D: 2, \u201CB\u201D: 8, \u201CC\u201D: 6}}"))!.ranking, ["B", "C", "A"]));
t("proposal names in ranking", () => deq(Core.extractBallot(F('{"ranking": ["Proposal C", "Proposal A", "Proposal B"], "scores": {"Proposal A": 6, "Proposal B": 4, "Proposal C": 8.6}}')), { ranking: ["C", "A", "B"], scores: { A: 6, B: 4, C: 9 } }));
t("two-letter ranking filled", () => deq(Core.extractBallot(F('{"ranking": ["b", "a"], "scores": {}}'))!.ranking, ["B", "A", "C"]));
t("scores only", () => deq(Core.extractBallot(F('{"scores": {"A": 4, "B": 9, "C": 6}}'))!.ranking, ["B", "C", "A"]));
t("clamp", () => { const b = Core.extractBallot(F('{"ranking":["A","B","C"],"scores":{"A":14,"B":0,"C":"5"}}'))!; deq([b.scores.A, b.scores.B, b.scores.C], [10, 1, 5]); });
t("no ballot", () => assert.strictEqual(Core.extractBallot("## Verdict\nNo JSON here."), null));
t("garbage ballot", () => assert.strictEqual(Core.extractBallot(F('{"ranking": "unclear"}')), null));
t("string ranking", () => deq(Core.extractBallot(F('{"ranking": "C > A > B", "scores": {"A": 5, "B": 3, "C": 7}}'))!.ranking, ["C", "A", "B"]));
t("placeholder echo rejected", () => assert.strictEqual(Core.extractBallot(F('{"ranking": ["<best>", "<middle>", "<worst>"], "scores": {"A": <1-10>}}')), null));

// ---------- reviewBody ----------
t("reviewBody cuts ballot", () => assert.ok(Core.reviewBody(review).endsWith("The sign-out sheet.")));
t("reviewBody streaming partial fence", () => assert.strictEqual(Core.reviewBody("Keep it.\n\n``"), "Keep it."));
t("reviewBody streaming ```js", () => assert.strictEqual(Core.reviewBody("Keep it.\n\n```js"), "Keep it."));
t("reviewBody streaming raw", () => assert.strictEqual(Core.reviewBody('Keep it.\n{"ran'), "Keep it."));
t("reviewBody streaming raw brace", () => assert.strictEqual(Core.reviewBody("Keep it.\n{"), "Keep it."));
t("reviewBody lead-in heading", () => assert.strictEqual(Core.reviewBody('Keep it.\n\n## Ballot\n\n```json\n{"ranking":["A","B","C"]}\n```'), "Keep it."));
t("reviewBody bold lead-in", () => assert.strictEqual(Core.reviewBody('Keep it.\n\n**My ballot:**\n```json\n{"ranking":["A","B","C"]}\n```'), "Keep it."));
t("reviewBody keeps normal heading", () => assert.strictEqual(Core.reviewBody("## Verdict\nText\n\n## Worth keeping"), "## Verdict\nText\n\n## Worth keeping"));
t("reviewBody keeps non-ballot code", () => assert.ok(Core.reviewBody("Look:\n```\ncode here\n```\nMore text").includes("More text")));
t("reviewBody empty", () => assert.strictEqual(Core.reviewBody(""), ""));

// ---------- Tally ----------
const B = (r: string[], s?: Record<string, number>): Ballot => ({ ranking: r, scores: s || {} });
t("tally points", () => {
  const T = Core.computeTally({ advocate: B(["B", "A", "C"], { A: 7, B: 9, C: 4 }), skeptic: B(["A", "B", "C"], { A: 8, B: 7, C: 3 }), strategist: B(["B", "C", "A"], { A: 5, B: 8, C: 6 }) });
  assert.strictEqual(T.winner, "B"); assert.strictEqual(T.decidedBy, "points");
  deq([T.rows.A.points, T.rows.B.points, T.rows.C.points], [6, 8, 4]);
  deq(T.sorted.map(r => r.letter), ["B", "A", "C"]);
  assert.strictEqual(Core.verdictText(T, { A: "Alpha", B: "Beta", C: "" }, null), "Proposal B, \u201CBeta\u201D, wins with 8 of 9 possible points.");
});
t("dissenters", () => {
  const ballots = { advocate: B(["B", "A", "C"]), skeptic: B(["A", "C", "B"]), strategist: B(["B", "C", "A"]) };
  deq(Core.dissenters(Core.computeTally(ballots), ballots, "B"), ["skeptic"]);
});
t("tally unanimous", () => {
  const T = Core.computeTally({ advocate: B(["C", "A", "B"], { A: 5, B: 4, C: 9 }), skeptic: B(["C", "B", "A"], { A: 5, B: 6, C: 8 }), strategist: B(["C", "A", "B"], { A: 6, B: 5, C: 9 }) });
  assert.strictEqual(T.winner, "C"); assert.ok(T.unanimous);
  assert.strictEqual(Core.verdictText(T, { A: "", B: "", C: "" }, null), "Proposal C wins with 9 of 9 possible points. Every councilor ranked it first.");
});
t("tally firsts decide a points tie", () => {
  const T = Core.computeTally({ advocate: B(["A", "B", "C"], { A: 5, B: 9, C: 1 }), skeptic: B(["A", "B", "C"], { A: 5, B: 9, C: 1 }), strategist: B(["B", "C", "A"], { A: 5, B: 9, C: 1 }) });
  deq([T.rows.A.points, T.rows.B.points], [7, 7]);
  assert.strictEqual(T.decidedBy, "firsts"); assert.strictEqual(T.winner, "A");
  deq(T.sorted.map(r => r.letter), ["A", "B", "C"]);
  assert.strictEqual(Core.verdictText(T, { A: "Alpha", B: "Beta", C: "Gamma" }, null), "Proposal A, \u201CAlpha\u201D, wins on first-place votes after tying with Proposal B at 7 points.");
});
t("tally scores decide", () => {
  const T = Core.computeTally({ advocate: B(["A", "B", "C"], { A: 9, B: 6, C: 3 }), skeptic: B(["B", "C", "A"], { A: 5, B: 8, C: 6 }), strategist: B(["C", "A", "B"], { A: 7, B: 4, C: 8 }) });
  assert.strictEqual(T.decidedBy, "scores"); assert.strictEqual(T.winner, "A");
  assert.strictEqual(Core.verdictText(T, { A: "Alpha", B: "", C: "" }, null), "Proposal A, \u201CAlpha\u201D, wins on combined scores, 21 to 18, after a three-way tie on points and first-place votes.");
});
t("tally chair deadlock", () => {
  const T = Core.computeTally({ advocate: B(["A", "B", "C"], { A: 8, B: 6, C: 4 }), skeptic: B(["B", "C", "A"], { A: 4, B: 8, C: 6 }), strategist: B(["C", "A", "B"], { A: 6, B: 4, C: 8 }) });
  assert.strictEqual(T.decidedBy, "chair"); assert.strictEqual(T.winner, null); deq(T.tied, ["A", "B", "C"]);
  assert.strictEqual(Core.verdictText(T, {}, null), "All three proposals are tied on points, first-place votes and combined scores. The Chair will cast the deciding vote.");
  assert.strictEqual(Core.verdictText(T, { B: "Beta" }, "B"), "The council was deadlocked, so the Chair cast the deciding vote for Proposal B, \u201CBeta\u201D.");
  deq(Core.orderRows(T, "C").map(r => r.letter), ["C", "A", "B"]);
});
t("deciding vote parse", () => {
  assert.strictEqual(Core.parseDecidingVote("# T\n\n## The decision\nI cast the deciding vote for Proposal C.", ["A", "C"]), "C");
  assert.strictEqual(Core.parseDecidingVote("## The decision\nI cast the deciding vote for **Proposal B**.", ["A", "B"]), "B");
  assert.strictEqual(Core.parseDecidingVote("## The decision\nI cast the deciding vote for a stronger plan: Proposal B.\n## Scope\nProposal A", ["A", "B"]), "B");
  assert.strictEqual(Core.parseDecidingVote("## Scope\nnothing", ["C", "A"]), "C");
  assert.strictEqual(Core.parseDecidingVote("## La décision\nJe choisis la Proposal A.", ["B", "A"]), "A");
});

// ---------- Prompts ----------
const props = { A: "# Shelf Share\n> pitch\n\n## The approach\nx", B: "# Lend Loop\n> p\n", C: "# Tool Commons\n> p\n" };
const brief = { feature: "Add CSV export", context: [{ title: "Product requirements", text: "- A button\n  - respects filters" }, { title: "", text: "   " }, { title: "", text: "    const x = 1;\n" }] };
t("builder prompt", () => {
  const p = Core.builderPrompt(Core.BUILDERS[0], brief, 450);
  assert.ok(p.startsWith("You are The Pragmatist, one of three builders on Quorum, a small council that decides how to implement a feature in an existing software project."));
  assert.ok(p.includes('The feature request:\n"""\nAdd CSV export\n"""'));
  assert.ok(p.includes("=== Context: Product requirements ===\n- A button\n  - respects filters\n=== End of context: Product requirements ==="));
  assert.ok(p.includes("=== Context: Context 2 ===\n    const x = 1;\n=== End of context: Context 2 ==="), "indentation kept, blank blocks dropped");
  assert.ok(p.includes("about 450 words"));
  assert.ok(p.includes("## What changes"));
});
t("builder prompt without context", () => assert.ok(Core.builderPrompt(Core.BUILDERS[1], { feature: "X", context: [] }, 300).includes("No other context was provided.")));
t("council prompt order", () => {
  const p = Core.councilPrompt(Core.COUNCIL[1], brief, props, 240, 12000);
  assert.ok(p.includes("=== Context: Product requirements ==="));
  const iB = p.indexOf("=== Proposal B ==="), iC = p.indexOf("=== Proposal C ==="), iA = p.indexOf("=== Proposal A ===");
  assert.ok(iB < iC && iC < iA, "skeptic reads B, C, A");
  assert.ok(!/Pragmatist|Visionary|Architect/.test(p), "blind");
  assert.ok(p.trim().endsWith("Write nothing after the code block."));
});
t("chair prompt", () => {
  const ballots = { advocate: B(["B", "A", "C"], { A: 7, B: 9, C: 4 }), skeptic: B(["A", "C", "B"], { A: 8, B: 3, C: 6 }), strategist: B(["B", "C", "A"], { A: 5, B: 8, C: 6 }) };
  const T = Core.computeTally(ballots);
  const reviews = { advocate: review, skeptic: "## Verdict\nA.\n```json\n{}\n```", strategist: "## Verdict\nB." };
  const p = Core.chairPrompt({ brief, proposals: props, reviews, ballots, tally: T } as unknown as SessionView, 1000, 12000);
  assert.ok(p.includes("=== Context: Product requirements ==="));
  assert.ok(p.includes("## Implementation steps") && p.includes("## Rollout") && p.includes("## Requirements"));
  assert.ok(p.includes('Result: Proposal B, "Lend Loop", won with 7 of 9 possible points.'), p.slice(p.indexOf("Result"), p.indexOf("Result") + 120));
  assert.ok(p.includes("## Dissent\nThe Skeptic ranked Proposal B last."));
  assert.ok(p.includes("Ballot: 1st B, 2nd A, 3rd C. Scores out of 10: A 7, B 9, C 4."));
  assert.ok(!p.includes('"ranking"'), "ballot JSON stripped from reviews");
});
t("chair prompt deadlock", () => {
  const ballots = { advocate: B(["A", "B", "C"], { A: 8, B: 6, C: 4 }), skeptic: B(["B", "C", "A"], { A: 4, B: 8, C: 6 }), strategist: B(["C", "A", "B"], { A: 6, B: 4, C: 8 }) };
  const p = Core.chairPrompt({ brief: { feature: "Idea", context: [] }, proposals: props, reviews: { advocate: "", skeptic: "", strategist: "" }, ballots, tally: Core.computeTally(ballots) } as unknown as SessionView, 850, 12000);
  assert.ok(p.includes('"I cast the deciding vote for Proposal X."'));
  assert.ok(p.includes("If a councilor ranked the proposal you choose last"));
});
t("fitPrompt shrinks", () => {
  const big = { A: "# A\n" + "字".repeat(20000), B: "# B\n" + "字".repeat(20000), C: "# C\n" + "字".repeat(20000) };
  const p = Core.fitPrompt((nn, cc) => Core.councilPrompt(Core.COUNCIL[0], { feature: "Idea", context: [] }, big, 240, nn, cc));
  assert.ok(Core.utf8Len(p) <= Core.MAX_PROMPT_BYTES, "bytes " + Core.utf8Len(p));
  assert.ok(p.includes("[Cut for length.]"));
});
t("fitPrompt clips context only when proposals alone aren't enough", () => {
  const small = { A: "# A\nshort", B: "# B\nshort", C: "# C\nshort" };
  const okCtx = { feature: "Idea", context: [{ title: "Spec", text: "x".repeat(24000) }] };
  const p1 = Core.fitPrompt((nn, cc) => Core.councilPrompt(Core.COUNCIL[0], okCtx, small, 240, nn, cc));
  assert.ok(!p1.includes("[Cut for length.]"), "24,000 characters of context fits whole");
  const huge = { feature: "Idea", context: [{ title: "Spec", text: "é".repeat(40000) }] };
  const p2 = Core.fitPrompt((nn, cc) => Core.councilPrompt(Core.COUNCIL[0], huge, small, 240, nn, cc));
  assert.ok(Core.utf8Len(p2) <= Core.MAX_PROMPT_BYTES, "bytes " + Core.utf8Len(p2));
  assert.ok(p2.includes("[Cut for length.]"));
});
t("utf8Len", () => assert.strictEqual(Core.utf8Len("aé字😀"), 1 + 2 + 3 + 4));

// ---------- Record ----------
t("record", () => {
  const ballots = { advocate: B(["B", "A", "C"], { A: 7, B: 9, C: 4 }), skeptic: B(["A", "B", "C"], { A: 8, B: 7, C: 3 }), strategist: B(["B", "C", "A"], { A: 5, B: 8, C: 6 }) };
  const T = Core.computeTally(ballots);
  const tiers = { A: "Fast", B: "Fast", C: "Fast", advocate: "Frontier", skeptic: "Frontier", strategist: "Frontier", chair: "Frontier" };
  const r = Core.recordMarkdown({ brief: { feature: "Line one\nLine two", context: [{ title: "Relevant code", text: "const a = 1;\n```\nnested fence\n```\n" }] }, setupLine: "Models: " + Core.modelsSentence(Core.DEFAULT_MODELS) + " Length: Standard.", tiers, proposals: props, reviews: { advocate: review, skeptic: "## Verdict\nOk", strategist: "## Verdict\nFine" }, ballots, tally: T, decided: null, plan: "# The Plan\n\n## The decision\nB." } as unknown as RecordView);
  assert.ok(r.startsWith("# The Plan"));
  assert.ok(r.includes("## The feature request\n\n> Line one\n> Line two"));
  assert.ok(r.includes("## The context\n\n### Relevant code\n\n````text\nconst a = 1;\n```\nnested fence\n```\n````\n"), r.slice(r.indexOf("## The context"), r.indexOf("## The context") + 200));
  assert.ok(r.includes("| B: Lend Loop (adopted) | 1st | 2nd | 1st | 8 |"), r);
  assert.ok(r.includes("### Proposal A: Shelf Share\n\n*By the Pragmatist, on Fast*\n\n> pitch\n\n#### The approach"), r);
  assert.ok(r.includes("### The Advocate\n\n*Reviewed blind, on Frontier*\n\n#### Verdict"));
  assert.ok(r.includes("> Line two\n\nModels: Builders on Fast, the council on Frontier and the Chair on Frontier. Length: Standard.\n"));
  assert.ok(r.includes("#### Verdict"));
  assert.ok(!r.includes('"ranking"'));
  assert.ok(r.includes("Ballot: 1st B, 2nd A, 3rd C."));
});
t("models", () => {
  deq(Core.normalizeModels(null), { builders: "quick", council: "complex", chair: "complex", review: "complex" });
  deq(Core.normalizeModels({ builders: "default", council: "nope", chair: "quick" }), { builders: "default", council: "complex", chair: "quick", review: "complex" });
  assert.strictEqual(Core.roleOf("B"), "builders");
  assert.strictEqual(Core.roleOf("skeptic"), "council");
  assert.strictEqual(Core.roleOf("chair"), "chair");
  assert.strictEqual(Core.modelsSentence({ builders: "quick", council: "default", chair: "complex" }), "Builders on Fast, the council on Balanced and the Chair on Frontier.");
});
t("shiftHeadings fence", () => assert.strictEqual(Core.shiftHeadings("## a\n```\n# not\n```\n# b", 2), "#### a\n```\n# not\n```\n### b"));
// ---------- Agents and providers ----------
t("agents default by environment", () => {
  deq(Core.normalizeAgents(null, true), { builders: { provider: "claude", model: "quick" }, council: { provider: "claude", model: "complex" }, chair: { provider: "claude", model: "complex" }, review: { provider: "claude", model: "complex" } });
  deq(Core.normalizeAgents(null, false), { builders: { provider: "openrouter", model: "z-ai/glm-5.3" }, council: { provider: "openrouter", model: "z-ai/glm-5.3" }, chair: { provider: "openrouter", model: "z-ai/glm-5.3" }, review: { provider: "openrouter", model: "z-ai/glm-5.3" } }, "every seat on OpenRouter runs on GLM 5.3");
});
t("agents move off providers that can't run here", () => {
  const saved = { builders: { provider: "hermes", model: "alice" }, council: { provider: "claude", model: "complex" }, chair: { provider: "custom", model: " llama3.1:8b " } };
  deq(Core.normalizeAgents(saved, false), { builders: { provider: "hermes", model: "alice" }, council: { provider: "openrouter", model: "z-ai/glm-5.3" }, chair: { provider: "custom", model: "llama3.1:8b" }, review: { provider: "openrouter", model: "z-ai/glm-5.3" } });
  deq(Core.normalizeAgents(saved, true), { builders: { provider: "claude", model: "quick" }, council: { provider: "claude", model: "complex" }, chair: { provider: "claude", model: "complex" }, review: { provider: "claude", model: "complex" } });
  deq(Core.normalizeAgents({ builders: { provider: "claude", model: "huge" } }, true).builders, { provider: "claude", model: "quick" });
  deq(Core.normalizeAgents({ builders: { provider: "nope" } }, false).builders, { provider: "openrouter", model: "z-ai/glm-5.3" });
  deq(Core.normalizeAgents({ builders: { provider: "claude-code", model: "" } }, false).builders, { provider: "claude-code", model: "" });
  deq(Core.normalizeAgents({ builders: { provider: "claude-code", model: " opus " } }, false).builders, { provider: "claude-code", model: "opus" });
  deq(Core.normalizeAgents({ builders: { provider: "claude-code", model: "opus" } }, true).builders, { provider: "claude", model: "quick" });
});
t("agent labels", () => {
  assert.strictEqual(Core.agentLabel({ provider: "claude", model: "complex" }), "Claude Frontier");
  assert.strictEqual(Core.agentLabel({ provider: "openrouter", model: "z-ai/glm-5.3" }), "glm-5.3 via OpenRouter");
  assert.strictEqual(Core.agentLabel({ provider: "hermes", model: "hermes-agent" }), "Hermes Agent");
  assert.strictEqual(Core.agentLabel({ provider: "hermes", model: "alice" }), "alice via Hermes Agent");
  assert.strictEqual(Core.agentLabel({ provider: "custom", model: "llama3.1:8b" }, { customUrl: "http://localhost:11434/v1" }), "llama3.1:8b via localhost:11434");
  assert.strictEqual(Core.agentLabel({ provider: "custom", model: "m" }, { customUrl: "not a url" }), "m via your endpoint");
  assert.strictEqual(Core.agentLabel({ provider: "claude-code", model: "" }), "Claude Code");
  assert.strictEqual(Core.agentLabel({ provider: "claude-code", model: "opus" }), "opus via Claude Code");
  assert.strictEqual(Core.agentLabel({ provider: "claude-code", model: "claude-opus-5-5" }), "claude-opus-5-5 via Claude Code");
  assert.strictEqual(Core.agentsSentence(Core.normalizeAgents(null, false)), "Builders on glm-5.3 via OpenRouter, the council on glm-5.3 via OpenRouter and the Chair on glm-5.3 via OpenRouter.");
});
t("SSE parser", () => {
  const got: unknown[] = [];
  const p = Core.createSSEParser(e => got.push(e));
  p.feed(": OPENROUTER PROCESSING\n\ndata: {\"a\":1}\n\nevent: hermes.tool.progress\ndata: {\"tool\":\"read_file\"}\n\ndata: li");
  p.feed("ne1\ndata: line2\n\n: keepalive\r\n\r");
  p.feed("\ndata: [DONE]\n\n");
  p.feed("data: tail");
  p.end();
  deq(got, [
    { event: "message", data: "{\"a\":1}" },
    { event: "hermes.tool.progress", data: "{\"tool\":\"read_file\"}" },
    { event: "message", data: "line1\nline2" },
    { event: "message", data: "[DONE]" },
    { event: "message", data: "tail" },
  ]);
});
t("think traces are dropped", () => {
  assert.strictEqual(Core.stripThinking("<think>plan it</think>\n\n# Title"), "# Title");
  assert.strictEqual(Core.stripThinking("<think>still going"), "");
  assert.strictEqual(Core.stripThinking("# Title\nbody"), "# Title\nbody");
  assert.strictEqual(Core.stripThinking("<THINK>x</THINK>ok <think>y"), "ok ");
});
t("HTTP errors map to Quorum codes", () => {
  assert.strictEqual(Core.httpErrorCode(401, "No auth credentials found"), "auth_failed");
  assert.strictEqual(Core.httpErrorCode(402, "Insufficient credits"), "no_credits");
  assert.strictEqual(Core.httpErrorCode(400, "nousresearch/hermes-9 is not a valid model ID"), "bad_model");
  assert.strictEqual(Core.httpErrorCode(404, "No endpoints found for model x"), "bad_model");
  assert.strictEqual(Core.httpErrorCode(404, "Not Found"), "not_found");
  assert.strictEqual(Core.httpErrorCode(400, "This endpoint's maximum context length is 8192 tokens"), "prompt_too_large");
  assert.strictEqual(Core.httpErrorCode(400, "temperature must be a number"), "bad_request");
  assert.strictEqual(Core.httpErrorCode(429, "Too many concurrent runs (max 10)"), "rate_limited");
  assert.strictEqual(Core.httpErrorCode(503, ""), "upstream_error");
  assert.strictEqual(Core.streamErrorCode({ code: "server_error", message: "Provider disconnected unexpectedly" }), "upstream_error");
  assert.strictEqual(Core.streamErrorCode({ code: 429, message: "Rate limit exceeded" }), "rate_limited");
  assert.strictEqual(Core.errorMessageFrom('{"error":{"code":401,"message":"No auth credentials found"}}'), "No auth credentials found");
  assert.strictEqual(Core.errorMessageFrom('{"detail":"Invalid API key"}'), "Invalid API key");
  assert.strictEqual(Core.errorMessageFrom("<html><body>Bad Gateway</body></html>"), "Bad Gateway");
});
t("agents with tools are invited to read the project, others aren't", () => {
  const b = { feature: "X", context: [] };
  assert.ok(Core.builderPrompt(Core.BUILDERS[0], b, 300, undefined, { explore: true }).includes("You may have tools that can read the project's files."));
  assert.ok(!Core.builderPrompt(Core.BUILDERS[0], b, 300).includes("You may have tools"));
  const props = { A: "# A", B: "# B", C: "# C" };
  const c = Core.councilPrompt(Core.COUNCIL[0], b, props, 200, 1000, 1000, { explore: true });
  assert.ok(c.includes("check what the proposals claim about the existing code"));
  assert.ok(c.trim().endsWith("Write nothing after the code block."));
});
t("agents inside the project folder are told to explore it and ground their work in the code", () => {
  const b = { feature: "X", context: [], project: { path: "/home/me/app", name: "app" } };
  const inside = { explore: true, inProject: true };
  const p = Core.builderPrompt(Core.BUILDERS[0], b, 300, undefined, inside);
  assert.ok(p.includes("You're running inside the project's folder, /home/me/app, with tools that can read and search its files but not change them. Before you propose, explore the code this feature touches"));
  assert.ok(p.includes("Then write the whole proposal as your final message."));
  assert.ok(p.includes("Work from the project's code and the context: when you refer to parts of the existing system, use the names you found"));
  assert.ok(p.includes("No other context was provided. Learn how the existing system works from the project's files"));
  assert.ok(!p.includes("You may have tools") && !p.includes("Work from the context:"));
  const props = { A: "# A", B: "# B", C: "# C" };
  const c = Core.councilPrompt(Core.COUNCIL[1], b, props, 200, 1000, 1000, inside);
  assert.ok(c.includes("assumes about the existing system that the code or the context doesn't support."));
  assert.ok(c.includes("read the files they name. Then write your whole review, ending with the ballot, as your final message."));
  const ballots = { advocate: { ranking: ["A", "B", "C"], scores: {} }, skeptic: { ranking: ["A", "C", "B"], scores: {} }, strategist: { ranking: ["B", "A", "C"], scores: {} } };
  const s = { brief: b, proposals: props, reviews: { advocate: "", skeptic: "", strategist: "" }, ballots, tally: Core.computeTally(ballots) } as unknown as SessionView;
  const ch = Core.chairPrompt(s, 800, 1000, 1000, inside);
  assert.ok(ch.includes("Work from the project's code and the context, and where they don't cover something the plan depends on"));
  assert.ok(ch.includes("Only name files, modules or services you found in the project or the context; otherwise describe them."));
  assert.ok(ch.includes("Then write the whole plan as your final message."));
  // Agents with tools of their own are told where the project is; agents without tools aren't told anything.
  assert.ok(Core.builderPrompt(Core.BUILDERS[0], b, 300, undefined, { explore: true }).includes("don't change any files or run anything that modifies the project. The project's files are in /home/me/app."));
  const plain = Core.builderPrompt(Core.BUILDERS[0], b, 300);
  assert.ok(!plain.includes("/home/me/app") && plain.includes("Work from the context:"));
  // Without a project there's nothing to run inside, so an agent with tools gets the general note.
  assert.ok(Core.exploreNote("builder", { feature: "X", context: [] }, inside).startsWith("You may have tools"));
  assert.strictEqual(Core.exploreNote("builder", b, {}), "");
});
// ---------- Naming the session ----------
t("the naming prompt gives the feature, the project and what context comes with it", () => {
  const p = Core.namePrompt({ feature: "Export reports as CSV.", context: [{ title: "Product requirements", text: "x" }, { title: "", text: "  " }, { title: "", text: "code" }], project: { path: "/p/app", name: "app" } });
  assert.ok(p.startsWith("Name a session of Quorum, a small council that decides how to implement a feature in an existing software project, so it can be told apart"));
  assert.ok(p.includes('The feature request:\n"""\nExport reports as CSV.\n"""\n\nThe project: app\n\nThe context it comes with: Product requirements and Context 2.'));
  assert.ok(p.includes("about ten words"));
  assert.ok(p.trim().endsWith("Answer with the name alone, on one line, without quotes, Markdown or a full stop. Don't use any tools."));
  assert.ok(!Core.namePrompt({ feature: "X", context: [] }).includes("The project:"));
});
t("a session's name is the answer's first line, tidied", () => {
  assert.strictEqual(Core.sessionName("CSV Export for Every Report, Streamed or Emailed When Large"), "CSV Export for Every Report, Streamed or Emailed When Large");
  assert.strictEqual(Core.sessionName("\u201CCSV export for reports.\u201D"), "CSV export for reports");
  assert.strictEqual(Core.sessionName("# Session name: **CSV export** for reports\n\nIt names the feature."), "CSV export for reports");
  assert.strictEqual(Core.sessionName("<think>Keep it short.</think>\n\nTitle: Two-factor sign-in with backup codes"), "Two-factor sign-in with backup codes");
  assert.strictEqual(Core.sessionName("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen"),
    "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen", "a rambling answer is cut to sixteen words");
  assert.strictEqual(Core.sessionName("   \n  "), "");
  assert.strictEqual(Core.sessionName(null), "");
});

// ---------- The session graph ----------
const G = Core.SESSION;
const H = (id: string, kind: string, data: unknown) => Graph.handoff(id, kind, data);
const taskFor = (node: string, handoffs: Handoffs, graph?: GraphDef): Task => {
  const g = graph || G, inputs: Handoffs = {};
  g.nodes[node].needs.forEach(d => { inputs[d] = handoffs[d]; });
  return { node, kind: g.nodes[node].kind, inputs };
};
const sBrief = H("brief", "brief", { feature: "Export reports as CSV.", context: [{ title: "Constraints", text: "No new services." }], length: "brief" });
const sProps: Handoffs = {};
["A", "B", "C"].forEach(L => { sProps[L] = H(L, "proposal", { text: "# Plan " + L + "\n> Pitch " + L + ".", title: "Plan " + L }); });
const ballotBlock = (r: string[], s: Record<string, number>) => "## Verdict\nOk.\n\n```json\n" + JSON.stringify({ ranking: r, scores: s }) + "\n```";
const sReviews = {
  advocate: H("advocate", "review", { text: ballotBlock(["A", "B", "C"], { A: 8, B: 6, C: 4 }), ballot: { ranking: ["A", "B", "C"], scores: { A: 8, B: 6, C: 4 } } }),
  skeptic: H("skeptic", "review", { text: ballotBlock(["B", "C", "A"], { A: 4, B: 8, C: 6 }), ballot: { ranking: ["B", "C", "A"], scores: { A: 4, B: 8, C: 6 } } }),
  strategist: H("strategist", "review", { text: ballotBlock(["C", "A", "B"], { A: 6, B: 4, C: 8 }), ballot: { ranking: ["C", "A", "B"], scores: { A: 6, B: 4, C: 8 } } }),
};
const sAll = Object.assign({ brief: sBrief, revision: H("revision", "revision", null) }, sProps, sReviews);
t("the session graph runs brief, proposals, reviews, tally, plan", () => {
  deq(G.order, ["brief", "revision", "A", "B", "C", "advocate", "skeptic", "strategist", "tally", "chair"]);
  deq(G.nodes.A.needs, ["brief", "revision"]);
  deq(G.nodes.skeptic.needs, ["brief", "revision", "A", "B", "C"]);
  deq(G.nodes.tally.needs, ["advocate", "skeptic", "strategist"]);
  deq(G.nodes.chair.needs, ["brief", "revision", "A", "B", "C", "advocate", "skeptic", "strategist", "tally"]);
  deq(G.order.map(id => G.nodes[id].kind), ["brief", "revision", "proposal", "proposal", "proposal", "review", "review", "review", "tally", "plan"]);
  assert.ok(G.order.every(id => Core.HANDED_IN.indexOf(id) >= 0 || Core.STEPS[G.nodes[id].kind]), "every step has a worker");
});
t("a builder writes from the brief it's handed", () => {
  const p = STEPS.proposal.prompt(taskFor("B", sAll), {});
  assert.ok(p.startsWith("You are The Visionary"));
  assert.ok(p.includes('"""\nExport reports as CSV.\n"""'));
  assert.ok(p.includes("=== Context: Constraints ===\nNo new services."));
  assert.ok(p.includes("about 300 words"), "length comes from the brief");
  deq(STEPS.proposal.result(taskFor("B", sAll), "# Lend Loop\nText"), { text: "# Lend Loop\nText", title: "Lend Loop" });
});
t("a councilor reviews the proposals it's handed", () => {
  const p = STEPS.review.prompt(taskFor("skeptic", sAll), { explore: true });
  assert.ok(p.startsWith("You are The Skeptic"));
  assert.ok(p.indexOf("=== Proposal B ===\n# Plan B") < p.indexOf("=== Proposal A ===\n# Plan A"));
  assert.ok(p.includes("check what the proposals claim about the existing code"));
  assert.ok(p.includes("about 160 words"));
});
t("a review must end with a ballot", () => {
  const task = taskFor("advocate", sAll);
  deq(STEPS.review.result(task, sReviews.advocate.data.text).ballot, { ranking: ["A", "B", "C"], scores: { A: 8, B: 6, C: 4 } });
  let err: any = null;
  try { STEPS.review.result(task, "## Verdict\nNo ballot."); } catch (e) { err = e; }
  assert.strictEqual(err.code, "bad_ballot");
  assert.strictEqual(err.text, "## Verdict\nNo ballot.", "the review is kept for the reader");
});
t("the tally counts the ballots it's handed", () => {
  const T = STEPS.tally.compute(taskFor("tally", sAll));
  deq(T, Core.computeTally({ advocate: sReviews.advocate.data.ballot, skeptic: sReviews.skeptic.data.ballot, strategist: sReviews.strategist.data.ballot }));
  assert.strictEqual(T.decidedBy, "chair");
});
t("the Chair plans from everything, and decides a deadlock", () => {
  const tallied = Object.assign({ tally: H("tally", "tally", STEPS.tally.compute(taskFor("tally", sAll))) }, sAll);
  const task = taskFor("chair", tallied);
  const p = STEPS.plan.prompt(task, {});
  assert.ok(p.startsWith("You are the Chair"));
  assert.ok(p.includes("=== Proposal C, by the Architect ===\n# Plan C"));
  assert.ok(p.includes("=== Review by the Skeptic ===\n## Verdict\nOk.\nBallot: 1st B, 2nd C, 3rd A."));
  assert.ok(p.includes("I cast the deciding vote for Proposal X."));
  assert.ok(p.includes("about 650 words"));
  deq(STEPS.plan.result(task, "# P\n\n## The decision\nI cast the deciding vote for Proposal C."), { text: "# P\n\n## The decision\nI cast the deciding vote for Proposal C.", decided: "C" });
  const won = Object.assign({}, tallied, { tally: H("tally", "tally", Object.assign({}, tallied.tally.data, { decidedBy: "points", winner: "A" })) });
  assert.strictEqual(STEPS.plan.result(taskFor("chair", won), "# P\nProposal C was good too.").decided, null);
});
t("sessionOf reads the handoffs back", () => {
  const s = Core.sessionOf(Object.assign({ chair: H("chair", "plan", { text: "# Plan", decided: "C" }) }, sAll));
  assert.strictEqual(s.brief.feature, "Export reports as CSV.");
  deq(s.proposals, { A: "# Plan A\n> Pitch A.", B: "# Plan B\n> Pitch B.", C: "# Plan C\n> Pitch C." });
  deq(s.ballots.skeptic.ranking, ["B", "C", "A"]);
  assert.strictEqual(s.tally, null);
  assert.strictEqual(s.plan, "# Plan");
  assert.strictEqual(s.decided, "C");
  const empty = Core.sessionOf({});
  assert.strictEqual(empty.brief, null);
  assert.strictEqual(empty.revision, null);
  assert.strictEqual(empty.proposals.A, "");
});
// ---------- Revision rounds ----------
const sTally = H("tally", "tally", Core.computeTally({ advocate: { ranking: ["B", "A", "C"], scores: {} }, skeptic: { ranking: ["B", "C", "A"], scores: {} }, strategist: { ranking: ["A", "B", "C"], scores: {} } }));
const round1 = Object.assign({}, sAll, { tally: sTally, chair: H("chair", "plan", { text: "# Plan B wins\n\n## The decision\nB.", decided: null }) });
const rev2 = Core.nextRevision(Core.sessionOf(round1), "  Why not reuse the job queue?\nAlso, exports must be audited.  ");
t("a revision carries the input and the round it revises", () => {
  deq(rev2, {
    round: 2,
    input: "Why not reuse the job queue?\nAlso, exports must be audited.",
    earlier: [],
    previous: {
      round: 1, plan: "# Plan B wins\n\n## The decision\nB.", winner: "B",
      titles: { A: "Plan A", B: "Plan B", C: "Plan C" },
      proposals: { A: "# Plan A\n> Pitch A.", B: "# Plan B\n> Pitch B.", C: "# Plan C\n> Pitch C." },
    },
  });
  const round2 = Object.assign({}, round1, { revision: H("revision", "revision", rev2), chair: H("chair", "plan", { text: "# Plan B, revised", decided: null }) });
  const rev3 = Core.nextRevision(Core.sessionOf(round2), "Ship it behind a flag.");
  assert.strictEqual(rev3.round, 3);
  deq(rev3.earlier, [{ round: 2, input: "Why not reuse the job queue?\nAlso, exports must be audited." }]);
  assert.strictEqual(rev3.previous.round, 2);
  assert.strictEqual(rev3.previous.plan, "# Plan B, revised");
});
t("in a revision round, each builder revises its own proposal against the input and the last plan", () => {
  const inputs = Object.assign({}, sAll, { revision: H("revision", "revision", rev2) });
  const p = STEPS.proposal.prompt(taskFor("A", inputs), {});
  assert.ok(p.includes("This is round 2. In round 1 the council adopted Proposal B, \u201CPlan B\u201D, and the Chair wrote the plan below."));
  assert.ok(p.includes("The requester's input on the round 1 plan:\n\"\"\"\nWhy not reuse the job queue?\nAlso, exports must be audited.\n\"\"\""));
  assert.ok(p.includes("=== Plan from round 1 ===\n# Plan B wins"));
  assert.ok(p.includes("Your proposal from round 1, Proposal A:\n\n=== Your proposal from round 1 ===\n# Plan A\n> Pitch A."));
  assert.ok(!p.includes("# Plan C\n> Pitch C."), "a builder sees only its own earlier proposal");
  assert.ok(p.indexOf("## What changed") > p.indexOf("## Risks and trade-offs") && p.indexOf("## What changed") < p.indexOf("## Why the council should choose this"));
  assert.ok(!p.includes("What the requester asked for before"), "no earlier inputs in round 2");
  const first = STEPS.proposal.prompt(taskFor("A", sAll), {});
  assert.ok(!first.includes("This is round") && !first.includes("## What changed"), "the first round is unchanged");
});
t("in a revision round, the council judges the revised proposals against the input", () => {
  const inputs = Object.assign({}, sAll, { revision: H("revision", "revision", rev2) });
  const p = STEPS.review.prompt(taskFor("skeptic", inputs), {});
  assert.ok(p.includes("This is round 2. The requester read the round 1 plan and responded with the input below, and the builders revised their proposals."));
  assert.ok(p.indexOf("=== Plan from round 1 ===") < p.indexOf("=== Proposal B ==="), "the input and the last plan come before the proposals");
  assert.ok(p.includes("exports must be audited."));
  assert.ok(p.trim().endsWith("Write nothing after the code block."), "the ballot is still last");
});
t("in a revision round, the Chair answers the input in the revised plan", () => {
  const later = Core.nextRevision(Core.sessionOf(Object.assign({}, round1, { revision: H("revision", "revision", rev2) })), "Ship it behind a flag.");
  const inputs: Handoffs = Object.assign({}, round1, { revision: H("revision", "revision", later) });
  delete inputs.chair;
  const p = STEPS.plan.prompt(taskFor("chair", inputs), {});
  assert.ok(p.includes("This is round 3. The requester read the round 2 plan and responded with the input above"));
  assert.ok(p.includes("Answer every question in the requester's latest input directly"));
  assert.ok(p.includes("What the requester asked for before, which still stands unless the latest input changes it:\n\nInput that started round 2:\n\"\"\"\nWhy not reuse the job queue?"));
  assert.ok(p.indexOf("## Your input, answered") > p.indexOf("## The decision") && p.indexOf("## Your input, answered") < p.indexOf("## Requirements"));
  const huge = Object.assign({}, later, { previous: Object.assign({}, later.previous, { plan: "word ".repeat(40000) }) });
  const fitted = STEPS.plan.prompt(taskFor("chair", Object.assign({}, inputs, { revision: H("revision", "revision", huge) })), {});
  assert.ok(Core.utf8Len(fitted) <= Core.MAX_PROMPT_BYTES, "a long earlier plan is shortened to fit");
});
// ---------- The final review ----------
const R = Core.REVIEWED;
const draftPlan = "# Plan B wins\n\n## The decision\nB.\n\n## Design\nA queue.";
const scalingText = "## Verdict\nNot yet.\n\n## Findings\n1. **High**: exports scan the whole table. Add an index.\n2. **Medium** \u2014 no backpressure on the queue.\n3. **low:** logs are chatty.\n\n## What the plan gets right\nThe queue.";
const securityText = "## Verdict\nReady.\n\n## Findings\nNo findings.\n\n## What the plan gets right\n- Access checks.";
const reviewedHandoffs = Object.assign({}, round1, {
  chair: H("chair", "plan", { text: draftPlan, decided: null }),
  scaling: H("scaling", "check", { text: scalingText, findings: Core.countFindings(scalingText) }),
  security: H("security", "check", { text: securityText, findings: Core.countFindings(securityText) }),
});
t("with a final review, reviewers check the plan and the Chair revises it", () => {
  deq(R.order, ["brief", "revision", "A", "B", "C", "advocate", "skeptic", "strategist", "tally", "chair", "scaling", "security", "final"]);
  deq(R.nodes.scaling.needs, ["brief", "revision", "chair"]);
  deq(R.nodes.final.needs, ["brief", "revision", "chair", "scaling", "security"]);
  deq(R.order.map(id => R.nodes[id].kind).slice(-3), ["check", "check", "final"]);
  assert.ok(R.order.every(id => Core.HANDED_IN.indexOf(id) >= 0 || Core.STEPS[R.nodes[id].kind]), "every step has a worker");
  assert.strictEqual(Core.graphFor({ review: true }), R);
  assert.strictEqual(Core.graphFor({ review: false }), G);
  assert.strictEqual(Core.graphFor(null), G);
  deq(Core.ROLES.map(r => r.id + ":" + r.seats.slice(0, 3).join(",")), ["builders:A,B,C", "council:advocate,skeptic,strategist", "chair:chair,final", "review:scaling,security"]);
  assert.strictEqual(Core.roleOf("ask-skeptic-B"), "council", "the councilors ask the questions");
  assert.strictEqual(Core.roleOf("amend-B"), "builders", "and the builders answer them");
  assert.strictEqual(Core.roleOf("security"), "review");
  assert.strictEqual(Core.roleOf("final"), "chair");
});
t("each reviewer reads the Chair's plan through its lens and grades its findings", () => {
  const p = STEPS.check.prompt(taskFor("scaling", reviewedHandoffs, R), {});
  assert.ok(p.startsWith("You are The Scaling Reviewer, one of two reviewers who give the plan from Quorum"));
  assert.ok(p.includes("you review it for how it holds up as usage grows, and the Security Reviewer reviews it for security and privacy."));
  assert.ok(p.includes("=== The Chair's plan ===\n# Plan B wins"));
  assert.ok(p.includes("Begin each finding with its severity in bold, one of **Critical**, **High**, **Medium** or **Low**"));
  assert.ok(p.includes("about 220 words"), "reviews have their own length");
  assert.ok(!p.includes("=== Proposal"), "the reviewers review the plan, not the proposals");
  const sec = STEPS.check.prompt(taskFor("security", reviewedHandoffs, R), {});
  assert.ok(sec.includes("Your lens: Examine the plan for security and privacy: authentication and authorization"));
  assert.ok(sec.includes("ready to build as far as security and privacy goes"));
  const inside = STEPS.check.prompt(taskFor("security", Object.assign({}, reviewedHandoffs, { brief: H("brief", "brief", Object.assign({}, sBrief.data, { project: { path: "/p", name: "p" } })) }), R), { explore: true, inProject: true });
  assert.ok(inside.includes("Read the code the plan changes, and look for problems of your kind that the plan doesn't account for."));
  deq(STEPS.check.result(null, scalingText), { text: scalingText, findings: { critical: 0, high: 1, medium: 1, low: 1 } });
});
t("findings are counted by severity from the Findings section only", () => {
  deq(Core.countFindings(securityText), { critical: 0, high: 0, medium: 0, low: 0 });
  deq(Core.countFindings("## Verdict\n1. **High** is what the verdict says\n\n## Findings\n- **Severity: Critical** \u2014 tokens in logs\n- [High] secrets in the repo\n1) Low: noisy\n\n## What the plan gets right\n1. **High** marks elsewhere don't count"),
    { critical: 1, high: 1, medium: 0, low: 1 });
  assert.strictEqual(Core.findingsText({ critical: 0, high: 2, medium: 1, low: 0 }), "2 high, 1 medium");
  assert.strictEqual(Core.findingsText({ critical: 0, high: 0, medium: 0, low: 0 }), "No findings");
  assert.strictEqual(Core.findingsText(null), "");
});
t("the Chair revises its plan to answer the final review, and that becomes the plan", () => {
  const p = STEPS.final.prompt(taskFor("final", reviewedHandoffs, R), {});
  assert.ok(p.startsWith("You are the Chair of Quorum, a small council that decides how to implement a feature in an existing software project, finishing the plan after its final review."));
  assert.ok(p.includes("Before it's final, the Scaling Reviewer reviewed it for how it holds up as usage grows, and the Security Reviewer for security and privacy."));
  assert.ok(p.includes("fix every Critical and High finding in the plan itself"));
  assert.ok(p.includes("=== Your plan ===\n# Plan B wins"));
  assert.ok(p.includes("=== Review by the Scaling Reviewer ===\n## Verdict\nNot yet."));
  assert.ok(p.indexOf("## Final review") > p.indexOf("## Risks and mitigations") && p.indexOf("## Final review") < p.indexOf("## Open questions"));
  assert.ok(p.includes("If your plan ends with a Dissent section, keep it as the last section."));
  assert.ok(!Core.chairPrompt(Object.assign(Core.sessionOf(round1), { tally: sTally.data }), 800, 1000, 1000, {}).includes("## Final review"), "the first plan has no final review section");
  const done = Object.assign({}, reviewedHandoffs, { final: H("final", "final", { text: "# Plan B, reviewed\n\n## Final review\n- Added an index." }) });
  const s = Core.sessionOf(done);
  assert.strictEqual(s.plan, "# Plan B, reviewed\n\n## Final review\n- Added an index.");
  assert.strictEqual(s.draft, draftPlan);
  assert.strictEqual(s.reviewed, true);
  deq(s.findings.scaling, { critical: 0, high: 1, medium: 1, low: 1 });
  assert.strictEqual(Core.nextRevision(s, "More?").previous.plan, s.plan, "the next round revises the reviewed plan");
  const r = Core.recordMarkdown(Object.assign(s, { tiers: { scaling: "Claude Frontier", chair: "Claude Frontier" } }));
  assert.ok(r.startsWith("# Plan B, reviewed"), "the record leads with the reviewed plan");
  assert.ok(r.includes("## The final review\n\nThe reviewers checked the Chair's plan before it was final"));
  assert.ok(r.includes("### The Scaling Reviewer\n\n*1 high, 1 medium, 1 low, on Claude Frontier*\n\n#### Verdict\nNot yet."));
  assert.ok(r.includes("### The Security Reviewer\n\n*No findings*"));
  assert.ok(r.includes("### The plan before the final review: Plan B wins\n\n*By the Chair, on Claude Frontier*\n\n#### The decision"));
  assert.ok(!Core.recordMarkdown(Object.assign(Core.sessionOf(round1), { tally: sTally.data })).includes("final review"));
});
// ---------- The council's questions ----------
const Q = Core.graphFor({ questions: true });
const qText = "## Questions\n1. What happens when two exports run at once?\n2. Which roles may export?\n   It isn't in the requirements.";
const qHandoffs = Object.assign({}, sAll, {
  "ask-advocate-A": H("ask-advocate-A", "question", { text: "## Questions\nNo questions.", questions: [] }),
  "ask-skeptic-A": H("ask-skeptic-A", "question", { text: qText, questions: Core.parseQuestions(qText) }),
  "ask-strategist-A": H("ask-strategist-A", "question", { text: "## Questions\nNo questions.", questions: [] }),
});
["B", "C"].forEach(L => ["advocate", "skeptic", "strategist"].forEach(c => {
  qHandoffs["ask-" + c + "-" + L] = H("ask-" + c + "-" + L, "question", { text: "## Questions\nNo questions.", questions: [] });
}));
t("with the council's questions, each proposal is questioned and answered before the reviews", () => {
  deq(Core.ASK_IDS.slice(0, 3), ["ask-advocate-A", "ask-skeptic-A", "ask-strategist-A"]);
  deq(Q.nodes["ask-skeptic-B"].needs, ["brief", "revision", "B"], "a councilor questions a proposal as soon as it's in");
  deq(Q.nodes["amend-B"].needs, ["brief", "revision", "B", "ask-advocate-B", "ask-skeptic-B", "ask-strategist-B"]);
  deq(Q.nodes.skeptic.needs, ["brief", "revision", "amend-A", "amend-B", "amend-C"], "the council reviews the answered proposals");
  deq(Q.nodes.chair.needs.slice(2, 5), ["amend-A", "amend-B", "amend-C"]);
  assert.strictEqual(Q.order.length, 22);
  assert.ok(Q.order.every(id => Core.HANDED_IN.indexOf(id) >= 0 || Core.STEPS[Q.nodes[id].kind]), "every step has a worker");
  const both = Core.graphFor({ questions: true, review: true });
  assert.strictEqual(both.order.length, 25);
  assert.strictEqual(Core.graphFor({ questions: true, review: true }), both, "each kind of graph is made once");
  assert.strictEqual(Core.graphFor({}), G);
});
t("a councilor asks about edge cases, missing requirements and technical debt, through its lens", () => {
  const p = STEPS.question.prompt(taskFor("ask-skeptic-B", qHandoffs, Q), {});
  assert.ok(p.startsWith("You are The Skeptic, one of three councilors on Quorum, a small council that decides how to implement a feature in an existing software project, questioning Proposal B before the council votes."));
  assert.ok(p.includes("Your lens: Look for what could break."));
  assert.ok(p.includes("edge cases it doesn't handle, requirements in the request or the context that it misses or misreads, and technical debt it would create"));
  assert.ok(p.includes("Ask at most three, most important first. If it leaves nothing open that matters, ask nothing."));
  assert.ok(p.includes("=== Proposal B ===\n# Plan B\n> Pitch B."));
  assert.ok(!p.includes("=== Proposal A ==="), "it reads only the proposal it's questioning");
  assert.ok(p.includes("about 90 words at most"), "the brief is Brief length");
  deq(STEPS.question.result(null, qText).questions, ["What happens when two exports run at once?", "Which roles may export? It isn't in the requirements."]);
});
t("questions are read from a list, or from prose that asks something", () => {
  deq(Core.parseQuestions("## Questions\nNo questions."), []);
  deq(Core.parseQuestions("No questions. The proposal is clear."), []);
  deq(Core.parseQuestions("## Questions\n- **Edge case:** empty reports?\n* Retries?"), ["**Edge case:** empty reports?", "Retries?"]);
  deq(Core.parseQuestions("## Questions\nWhat about deleted users, whose rows still reference them?"), ["What about deleted users, whose rows still reference them?"]);
  assert.strictEqual(Core.parseQuestions("1. a\n2. b\n3. c\n4. d\n5. e\n6. f").length, 5, "a long list is cut short");
});
t("a builder answers the council and adjusts its proposal, unless no one asked anything", () => {
  const withA = Object.assign({}, qHandoffs, { A: sProps.A });
  const p = STEPS.amend.prompt(taskFor("amend-A", withA, Q), {});
  assert.ok(p.startsWith("You are The Pragmatist, one of three builders on Quorum, a small council that decides how to implement a feature in an existing software project, answering the council's questions about your proposal."));
  assert.ok(p.includes("=== Your proposal ===\n# Plan A\n> Pitch A."));
  assert.ok(p.includes("The Advocate asks:\nNo questions.\n\nThe Skeptic asks:\n1. What happens when two exports run at once?\n2. Which roles may export? It isn't in the requirements."));
  assert.ok(p.includes("## Answers to the council"));
  assert.ok(p.includes("about 400 words"));
  assert.strictEqual(STEPS.amend.skip(taskFor("amend-A", withA, Q)), null, "questions were asked, so the builder answers");
  const quiet = STEPS.amend.skip(taskFor("amend-B", qHandoffs, Q));
  deq(quiet, { text: "# Plan B\n> Pitch B.", title: "Plan B", amended: false, truncated: false, agent: null, served: "" });
  deq(STEPS.amend.result(null, "# Plan A, answered\n\n## Answers to the council\n- Queued."), { text: "# Plan A, answered\n\n## Answers to the council\n- Queued.", title: "Plan A, answered", amended: true });
});
t("the council reviews the answered proposals, and the record keeps the questions", () => {
  const answered = Object.assign({}, qHandoffs, {
    "amend-A": H("amend-A", "amend", { text: "# Plan A, answered\n\n## Answers to the council\n- One at a time.", title: "Plan A, answered", amended: true }),
    "amend-B": H("amend-B", "amend", { text: "# Plan B\n> Pitch B.", title: "Plan B", amended: false }),
    "amend-C": H("amend-C", "amend", { text: "# Plan C\n> Pitch C.", title: "Plan C", amended: false }),
  });
  const p = STEPS.review.prompt(taskFor("advocate", answered, Q), {});
  assert.ok(p.includes("=== Proposal A ===\n# Plan A, answered"));
  const s = Core.sessionOf(answered);
  assert.strictEqual(s.proposals.A, "# Plan A, answered\n\n## Answers to the council\n- One at a time.");
  assert.strictEqual(s.drafts.A, "# Plan A\n> Pitch A.");
  deq(s.amended, { A: true, B: false, C: false });
  assert.strictEqual(Core.sectionText(s.proposals.A, "Answers to the council"), "- One at a time.");
  assert.strictEqual(Core.sectionText("# T\n## One\na\n### Sub\nb\n## Two\nc", "one"), "a\n### Sub\nb");
  assert.strictEqual(Core.sectionText("# T", "Missing"), "");
  const r = Core.recordMarkdown(Object.assign(s, { tally: sTally.data, plan: "# P" }));
  assert.ok(r.includes("## The council's questions\n\nBefore the vote, each councilor questioned each proposal"));
  assert.ok(r.includes("### Questions on Proposal A\n\n**The Advocate** had no questions.\n\n**The Skeptic asked:**\n\n1. What happens when two exports run at once?"));
  assert.ok(r.includes("#### Proposal A as first submitted\n\n> Pitch A."));
  assert.ok(r.includes("*Proposal B stands as first submitted.*"));
  assert.ok(r.includes("### Proposal A: Plan A, answered"), "the proposals in the record are as answered");
  assert.ok(!Core.recordMarkdown(Object.assign(Core.sessionOf(round1), { tally: sTally.data })).includes("council's questions"));
});
t("the record of a revision round quotes the input", () => {
  const T = sTally.data;
  const r = Core.recordMarkdown({ brief: sBrief.data, revision: rev2, proposals: Core.sessionOf(round1).proposals, reviews: { advocate: "", skeptic: "", strategist: "" }, ballots: { advocate: { ranking: ["B", "A", "C"], scores: {} }, skeptic: { ranking: ["B", "C", "A"], scores: {} }, strategist: { ranking: ["A", "B", "C"], scores: {} } }, tally: T, decided: null, plan: "# Revised" } as unknown as RecordView);
  assert.ok(r.includes("## Your input on the round 1 plan\n\n> Why not reuse the job queue?\n> Also, exports must be audited."));
});

// ---------- Conversations ----------
t("reasoning between think tags is kept apart from the answer", () => {
  assert.strictEqual(Core.thinkingOf("<think>Plan it.</think>\n# Answer"), "Plan it.");
  assert.strictEqual(Core.thinkingOf("<THINK> a </THINK>b<think>c"), "a\n\nc", "several blocks, and one that never closed");
  assert.strictEqual(Core.thinkingOf("<think> </think># Answer"), "");
  assert.strictEqual(Core.thinkingOf("# Answer"), "");
  assert.strictEqual(Core.stripThinking("<think>Plan it.</think>\n# Answer"), "# Answer");
});
t("usage reads as a short line", () => {
  assert.strictEqual(Core.usageText({ turns: 1, inputTokens: 12345, outputTokens: 678, costUsd: 0.01234, durationMs: 9000 }), "1 turn \u00B7 12,345 tokens in, 678 out \u00B7 $0.0123");
  assert.strictEqual(Core.usageText({ turns: 4, costUsd: 2.5 }), "4 turns \u00B7 $2.50");
  assert.strictEqual(Core.usageText({ outputTokens: 10 }), "10 out");
  assert.strictEqual(Core.usageText(null), "");
  // @ts-expect-error: a count that isn't a number is left out
  assert.strictEqual(Core.usageText({ turns: "3" }), "");
});
t("a tool call reads as the tool and what it was used on", () => {
  assert.strictEqual(Core.toolLine({ name: "Read", detail: "src/app.js" }), "Read src/app.js");
  assert.strictEqual(Core.toolLine({ name: "Glob" }), "Glob");
  assert.strictEqual(Core.toolLine({}), "A tool");
});
t("a conversation becomes Markdown, every attempt and every turn", () => {
  const failed = {
    status: "error", error: { code: "bad_ballot", message: "The review ends without a readable ballot." }, agent: { provider: "claude-code", model: "opus" }, served: "claude-opus-5-5",
    entries: [
      { type: "prompt", text: "You are The Skeptic.\n```json\n{}\n```" },
      { type: "thinking", text: "Check the queue." },
      { type: "text", text: "Let me look." },
      { type: "tool", name: "Read", detail: "src/jobs.py", input: { file_path: "/p/src/jobs.py" }, result: "def run(): pass", error: false },
      { type: "tool", name: "Grep", detail: "TODO", input: { pattern: "TODO" }, result: "No such file", error: true },
      { type: "tool", name: "Glob", detail: "*.py", input: { pattern: "*.py" }, result: null },
      { type: "text", text: "## Verdict\nA.", final: true },
    ],
  };
  const done = { status: "done", usage: { turns: 2 }, entries: [{ type: "prompt", text: "Again." }, { type: "event", name: "hermes.tool.progress", data: "{\"tool\":\"read_file\"}" }, { type: "text", text: "## Verdict\nB.", final: true }] };
  const md = Core.conversationMarkdown([failed, done] as unknown as Transcript[], { title: "Review \u00B7 The Skeptic", who: "The Skeptic", agent: x => (x.served ? x.served + " via Claude Code" : "") });
  assert.ok(md.startsWith("## Review \u00B7 The Skeptic\n\n### Attempt 1 of 2\n\n*claude-opus-5-5 via Claude Code \u00B7 Couldn't finish*\n\nIt couldn't finish: The review ends without a readable ballot.\n\n#### What Quorum sent\n\n````text\nYou are The Skeptic.\n```json\n{}\n```\n````"), md);
  assert.ok(md.includes("#### The Skeptic thought\n\n```text\nCheck the queue.\n```"));
  assert.ok(md.includes("#### The Skeptic wrote\n\nLet me look."));
  assert.ok(md.includes('#### Read src/jobs.py\n\nInput:\n\n```json\n{\n  "file_path": "/p/src/jobs.py"\n}\n```\n\nWhat came back:\n\n```text\ndef run(): pass\n```'));
  assert.ok(md.includes("#### Grep TODO\n\nInput:"), md);
  assert.ok(md.includes("It failed:\n\n```text\nNo such file\n```"));
  assert.ok(md.includes("#### Glob *.py\n\nInput:\n\n```json\n{\n  \"pattern\": \"*.py\"\n}\n```\n\n*Nothing came back.*"));
  assert.ok(md.includes("#### The Skeptic\u2019s answer\n\n###### Verdict\nA."), "the agent's own headings go below the conversation's");
  assert.ok(md.includes("### Attempt 2 of 2\n\n*Finished \u00B7 2 turns*"));
  assert.ok(md.includes('#### hermes.tool.progress\n\n```text\n{"tool":"read_file"}\n```'));
  const one = Core.conversationMarkdown([{ status: "stopped", rebuilt: true, entries: [{ type: "prompt", text: "P" }, { type: "text", text: "Half", partial: true }] }] as unknown as Transcript[], { title: "Plan", who: "The Chair" });
  assert.ok(one.includes("*Stopped*\n\n*Rebuilt from the saved session:"));
  assert.ok(one.includes("### What Quorum sent"), "a single attempt's turns go one level up");
  assert.ok(one.includes("### What the Chair had written when it stopped\n\nHalf"));
});
