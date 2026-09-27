const fs = require("fs"), vm = require("vm"), assert = require("assert");
const read = f => fs.readFileSync(require("path").join(__dirname, "..", "src", f), "utf8");
const ctx = { URL }; vm.createContext(ctx);
const Core = vm.runInContext(read("graph.js") + "\n" + read("core.js") + "\nCore;", ctx);
const J = v => JSON.parse(JSON.stringify(v));
const deq = (a, b) => assert.deepStrictEqual(J(a), J(b));
let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error("FAIL:", name, "\n", e.message); process.exitCode = 1; } };

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
const F = body => "```json\n" + body + "\n```";
t("extract fenced", () => deq(Core.extractBallot(review), { ranking: ["B", "A", "C"], scores: { A: 7, B: 9, C: 4 } }));
t("extract raw", () => deq(Core.extractBallot('Text\n{"ranking":["C","B","A"],"scores":{"A":3,"B":5,"C":8}}').ranking, ["C", "B", "A"]));
t("extract after other fence", () => deq(Core.extractBallot("```\ncode\n```\ntext\n" + F('{"ranking":["A","C","B"],"scores":{"A":9,"B":2,"C":5}}')).ranking, ["A", "C", "B"]));
t("extract unterminated", () => deq(Core.extractBallot('x\n```json\n{"ranking": ["A","B","C"], "scores": {"A":1,"B":2,"C":3}}').ranking, ["A", "B", "C"]));
t("extract smart quotes + trailing comma", () => deq(Core.extractBallot(F("{\u201Cranking\u201D: [\u201CB\u201D, \u201CC\u201D, \u201CA\u201D,], \u201Cscores\u201D: {\u201CA\u201D: 2, \u201CB\u201D: 8, \u201CC\u201D: 6}}")).ranking, ["B", "C", "A"]));
t("proposal names in ranking", () => deq(Core.extractBallot(F('{"ranking": ["Proposal C", "Proposal A", "Proposal B"], "scores": {"Proposal A": 6, "Proposal B": 4, "Proposal C": 8.6}}')), { ranking: ["C", "A", "B"], scores: { A: 6, B: 4, C: 9 } }));
t("two-letter ranking filled", () => deq(Core.extractBallot(F('{"ranking": ["b", "a"], "scores": {}}')).ranking, ["B", "A", "C"]));
t("scores only", () => deq(Core.extractBallot(F('{"scores": {"A": 4, "B": 9, "C": 6}}')).ranking, ["B", "C", "A"]));
t("clamp", () => { const b = Core.extractBallot(F('{"ranking":["A","B","C"],"scores":{"A":14,"B":0,"C":"5"}}')); deq([b.scores.A, b.scores.B, b.scores.C], [10, 1, 5]); });
t("no ballot", () => assert.strictEqual(Core.extractBallot("## Verdict\nNo JSON here."), null));
t("garbage ballot", () => assert.strictEqual(Core.extractBallot(F('{"ranking": "unclear"}')), null));
t("string ranking", () => deq(Core.extractBallot(F('{"ranking": "C > A > B", "scores": {"A": 5, "B": 3, "C": 7}}')).ranking, ["C", "A", "B"]));
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
const B = (r, s) => ({ ranking: r, scores: s || {} });
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
  const p = Core.chairPrompt({ brief, proposals: props, reviews, ballots, tally: T }, 1000, 12000);
  assert.ok(p.includes("=== Context: Product requirements ==="));
  assert.ok(p.includes("## Implementation steps") && p.includes("## Rollout") && p.includes("## Requirements"));
  assert.ok(p.includes('Result: Proposal B, "Lend Loop", won with 7 of 9 possible points.'), p.slice(p.indexOf("Result"), p.indexOf("Result") + 120));
  assert.ok(p.includes("## Dissent\nThe Skeptic ranked Proposal B last."));
  assert.ok(p.includes("Ballot: 1st B, 2nd A, 3rd C. Scores out of 10: A 7, B 9, C 4."));
  assert.ok(!p.includes('"ranking"'), "ballot JSON stripped from reviews");
});
t("chair prompt deadlock", () => {
  const ballots = { advocate: B(["A", "B", "C"], { A: 8, B: 6, C: 4 }), skeptic: B(["B", "C", "A"], { A: 4, B: 8, C: 6 }), strategist: B(["C", "A", "B"], { A: 6, B: 4, C: 8 }) };
  const p = Core.chairPrompt({ brief: { feature: "Idea", context: [] }, proposals: props, reviews: { advocate: "", skeptic: "", strategist: "" }, ballots, tally: Core.computeTally(ballots) }, 850, 12000);
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
  const r = Core.recordMarkdown({ brief: { feature: "Line one\nLine two", context: [{ title: "Relevant code", text: "const a = 1;\n```\nnested fence\n```\n" }] }, setupLine: "Models: " + Core.modelsSentence(Core.DEFAULT_MODELS) + " Length: Standard.", tiers, proposals: props, reviews: { advocate: review, skeptic: "## Verdict\nOk", strategist: "## Verdict\nFine" }, ballots, tally: T, decided: null, plan: "# The Plan\n\n## The decision\nB." });
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
  deq(Core.normalizeModels(null), { builders: "quick", council: "complex", chair: "complex" });
  deq(Core.normalizeModels({ builders: "default", council: "nope", chair: "quick" }), { builders: "default", council: "complex", chair: "quick" });
  assert.strictEqual(Core.roleOf("B"), "builders");
  assert.strictEqual(Core.roleOf("skeptic"), "council");
  assert.strictEqual(Core.roleOf("chair"), "chair");
  assert.strictEqual(Core.modelsSentence({ builders: "quick", council: "default", chair: "complex" }), "Builders on Fast, the council on Balanced and the Chair on Frontier.");
});
t("shiftHeadings fence", () => assert.strictEqual(Core.shiftHeadings("## a\n```\n# not\n```\n# b", 2), "#### a\n```\n# not\n```\n### b"));
// ---------- Agents and providers ----------
t("agents default by environment", () => {
  deq(Core.normalizeAgents(null, true), { builders: { provider: "claude", model: "quick" }, council: { provider: "claude", model: "complex" }, chair: { provider: "claude", model: "complex" } });
  deq(Core.normalizeAgents(null, false), { builders: { provider: "openrouter", model: "nousresearch/hermes-4-70b" }, council: { provider: "openrouter", model: "nousresearch/hermes-4-405b" }, chair: { provider: "openrouter", model: "nousresearch/hermes-4-405b" } });
});
t("agents move off providers that can't run here", () => {
  const saved = { builders: { provider: "hermes", model: "alice" }, council: { provider: "claude", model: "complex" }, chair: { provider: "custom", model: " llama3.1:8b " } };
  deq(Core.normalizeAgents(saved, false), { builders: { provider: "hermes", model: "alice" }, council: { provider: "openrouter", model: "nousresearch/hermes-4-405b" }, chair: { provider: "custom", model: "llama3.1:8b" } });
  deq(Core.normalizeAgents(saved, true), { builders: { provider: "claude", model: "quick" }, council: { provider: "claude", model: "complex" }, chair: { provider: "claude", model: "complex" } });
  deq(Core.normalizeAgents({ builders: { provider: "claude", model: "huge" } }, true).builders, { provider: "claude", model: "quick" });
  deq(Core.normalizeAgents({ builders: { provider: "nope" } }, false).builders, { provider: "openrouter", model: "nousresearch/hermes-4-70b" });
});
t("agent labels", () => {
  assert.strictEqual(Core.agentLabel({ provider: "claude", model: "complex" }), "Claude Frontier");
  assert.strictEqual(Core.agentLabel({ provider: "openrouter", model: "nousresearch/hermes-4-70b" }), "hermes-4-70b via OpenRouter");
  assert.strictEqual(Core.agentLabel({ provider: "hermes", model: "hermes-agent" }), "Hermes Agent");
  assert.strictEqual(Core.agentLabel({ provider: "hermes", model: "alice" }), "alice via Hermes Agent");
  assert.strictEqual(Core.agentLabel({ provider: "custom", model: "llama3.1:8b" }, { customUrl: "http://localhost:11434/v1" }), "llama3.1:8b via localhost:11434");
  assert.strictEqual(Core.agentLabel({ provider: "custom", model: "m" }, { customUrl: "not a url" }), "m via your endpoint");
  assert.strictEqual(Core.agentsSentence(Core.normalizeAgents(null, false)), "Builders on hermes-4-70b via OpenRouter, the council on hermes-4-405b via OpenRouter and the Chair on hermes-4-405b via OpenRouter.");
});
t("SSE parser", () => {
  const got = [];
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
// ---------- The session graph ----------
const Graph = vm.runInContext("Graph", ctx);
const G = Core.SESSION;
const H = (id, kind, data) => Graph.handoff(id, kind, data);
const taskFor = (node, handoffs) => {
  const inputs = {};
  G.nodes[node].needs.forEach(d => { inputs[d] = handoffs[d]; });
  return { node, kind: G.nodes[node].kind, inputs };
};
const sBrief = H("brief", "brief", { feature: "Export reports as CSV.", context: [{ title: "Constraints", text: "No new services." }], length: "brief" });
const sProps = {};
["A", "B", "C"].forEach(L => { sProps[L] = H(L, "proposal", { text: "# Plan " + L + "\n> Pitch " + L + ".", title: "Plan " + L }); });
const ballotBlock = (r, s) => "## Verdict\nOk.\n\n```json\n" + JSON.stringify({ ranking: r, scores: s }) + "\n```";
const sReviews = {
  advocate: H("advocate", "review", { text: ballotBlock(["A", "B", "C"], { A: 8, B: 6, C: 4 }), ballot: { ranking: ["A", "B", "C"], scores: { A: 8, B: 6, C: 4 } } }),
  skeptic: H("skeptic", "review", { text: ballotBlock(["B", "C", "A"], { A: 4, B: 8, C: 6 }), ballot: { ranking: ["B", "C", "A"], scores: { A: 4, B: 8, C: 6 } } }),
  strategist: H("strategist", "review", { text: ballotBlock(["C", "A", "B"], { A: 6, B: 4, C: 8 }), ballot: { ranking: ["C", "A", "B"], scores: { A: 6, B: 4, C: 8 } } }),
};
const sAll = Object.assign({ brief: sBrief }, sProps, sReviews);
t("the session graph runs brief, proposals, reviews, tally, plan", () => {
  deq(G.order, ["brief", "A", "B", "C", "advocate", "skeptic", "strategist", "tally", "chair"]);
  deq(G.nodes.skeptic.needs, ["brief", "A", "B", "C"]);
  deq(G.nodes.tally.needs, ["advocate", "skeptic", "strategist"]);
  deq(G.nodes.chair.needs, ["brief", "A", "B", "C", "advocate", "skeptic", "strategist", "tally"]);
  deq(G.order.map(id => G.nodes[id].kind), ["brief", "proposal", "proposal", "proposal", "review", "review", "review", "tally", "plan"]);
  assert.ok(G.order.every(id => G.nodes[id].kind === "brief" || Core.STEPS[G.nodes[id].kind]), "every step has a worker");
});
t("a builder writes from the brief it's handed", () => {
  const p = Core.STEPS.proposal.prompt(taskFor("B", sAll), {});
  assert.ok(p.startsWith("You are The Visionary"));
  assert.ok(p.includes('"""\nExport reports as CSV.\n"""'));
  assert.ok(p.includes("=== Context: Constraints ===\nNo new services."));
  assert.ok(p.includes("about 300 words"), "length comes from the brief");
  deq(Core.STEPS.proposal.result(taskFor("B", sAll), "# Lend Loop\nText"), { text: "# Lend Loop\nText", title: "Lend Loop" });
});
t("a councilor reviews the proposals it's handed", () => {
  const p = Core.STEPS.review.prompt(taskFor("skeptic", sAll), { explore: true });
  assert.ok(p.startsWith("You are The Skeptic"));
  assert.ok(p.indexOf("=== Proposal B ===\n# Plan B") < p.indexOf("=== Proposal A ===\n# Plan A"));
  assert.ok(p.includes("check what the proposals claim about the existing code"));
  assert.ok(p.includes("about 160 words"));
});
t("a review must end with a ballot", () => {
  const task = taskFor("advocate", sAll);
  deq(Core.STEPS.review.result(task, sReviews.advocate.data.text).ballot, { ranking: ["A", "B", "C"], scores: { A: 8, B: 6, C: 4 } });
  let err = null;
  try { Core.STEPS.review.result(task, "## Verdict\nNo ballot."); } catch (e) { err = e; }
  assert.strictEqual(err.code, "bad_ballot");
  assert.strictEqual(err.text, "## Verdict\nNo ballot.", "the review is kept for the reader");
});
t("the tally counts the ballots it's handed", () => {
  const T = Core.STEPS.tally.compute(taskFor("tally", sAll));
  deq(T, Core.computeTally({ advocate: sReviews.advocate.data.ballot, skeptic: sReviews.skeptic.data.ballot, strategist: sReviews.strategist.data.ballot }));
  assert.strictEqual(T.decidedBy, "chair");
});
t("the Chair plans from everything, and decides a deadlock", () => {
  const tallied = Object.assign({ tally: H("tally", "tally", Core.STEPS.tally.compute(taskFor("tally", sAll))) }, sAll);
  const task = taskFor("chair", tallied);
  const p = Core.STEPS.plan.prompt(task, {});
  assert.ok(p.startsWith("You are the Chair"));
  assert.ok(p.includes("=== Proposal C, by the Architect ===\n# Plan C"));
  assert.ok(p.includes("=== Review by the Skeptic ===\n## Verdict\nOk.\nBallot: 1st B, 2nd C, 3rd A."));
  assert.ok(p.includes("I cast the deciding vote for Proposal X."));
  assert.ok(p.includes("about 650 words"));
  deq(Core.STEPS.plan.result(task, "# P\n\n## The decision\nI cast the deciding vote for Proposal C."), { text: "# P\n\n## The decision\nI cast the deciding vote for Proposal C.", decided: "C" });
  const won = Object.assign({}, tallied, { tally: H("tally", "tally", Object.assign({}, tallied.tally.data, { decidedBy: "points", winner: "A" })) });
  assert.strictEqual(Core.STEPS.plan.result(taskFor("chair", won), "# P\nProposal C was good too.").decided, null);
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
  assert.strictEqual(empty.proposals.A, "");
});
console.log(n + " tests passed" + (process.exitCode ? " (with failures)" : ""));
