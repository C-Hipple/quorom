// Records the screenshots in the README. It serves the built page, stands a scripted OpenRouter in for the real one,
// and works through the "CSV export for reports" example, saving a picture of each stage to docs/screenshots.
//
//   npm run screenshots
//
// It needs Playwright and a Chromium it can drive, which aren't among the project's dependencies:
//   npm install --no-save playwright && npx playwright install chromium
const fs = require("fs");
const path = require("path");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (_) {
  console.error("The screenshots need Playwright. Install it with:\n  npm install --no-save playwright && npx playwright install chromium");
  process.exit(1);
}

const answers = require("./scripted-session");
const root = path.join(__dirname, "..");
const out = path.join(root, "docs", "screenshots");

// Where seats pause, as [gate, fraction of the answer written], so the stages in progress can be photographed.
const HOLDS = { A: ["builders", 0.55], B: ["builders", 0.3], C: ["builders", 0], chair: ["chair", 0] };

// Runs in the page before Quorum does. It answers OpenRouter's chat completions from the script, a few words at a
// time, the way a real stream arrives, and holds a seat at its gate until the gate is released.
function standIn({ answers, holds, pace }) {
  const gates = {};
  const gate = name => gates[name] || (gates[name] = { open: false, waiters: [], held: 0 });
  window.__standIn = {
    release(name) { const g = gate(name); g.open = true; g.waiters.splice(0).forEach(go => go()); },
    held: name => gate(name).held,
  };
  const SEATS = { "The Pragmatist": "A", "The Visionary": "B", "The Architect": "C", "The Advocate": "advocate", "The Skeptic": "skeptic", "The Strategist": "strategist", "the Chair": "chair" };
  const seatOf = prompt => { const m = /^You are (The \w+|the Chair)/.exec(prompt); return m && SEATS[m[1]]; };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String((input && input.url) || input);
    if (!url.startsWith("https://openrouter.ai/api/v1/")) return realFetch(input, init);
    if (url.endsWith("/models")) return new Response('{"data":[]}', { headers: { "content-type": "application/json" } });
    const body = JSON.parse(init.body);
    const seat = seatOf(body.messages[0].content);
    const pieces = answers[seat].match(/[\s\S]{1,24}/g);
    const hold = holds[seat];
    const holdAt = hold ? Math.floor(pieces.length * hold[1]) : -1;
    const enc = new TextEncoder();
    return new Response(new ReadableStream({
      async start(c) {
        const send = o => c.enqueue(enc.encode("data: " + JSON.stringify(o) + "\n\n"));
        for (let i = 0; i < pieces.length; i++) {
          const g = hold && gate(hold[0]);
          if (i === holdAt && !g.open) {
            g.held += 1;
            await new Promise(go => g.waiters.push(go));
          }
          send({ model: body.model, choices: [{ index: 0, delta: { content: pieces[i] } }] });
          await new Promise(r => setTimeout(r, pace));
        }
        send({ model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    }), { headers: { "content-type": "text/event-stream" } });
  };
}

// A remembered OpenRouter key, so the page opens set up. The stand-in never sends it anywhere.
function setUp() {
  try {
    if (localStorage.getItem("quorum:providers")) return;
    localStorage.setItem("quorum:providers", JSON.stringify({ urls: { hermes: "", custom: "" }, remember: { openrouter: true, hermes: false, custom: false } }));
    localStorage.setItem("quorum:key:openrouter", "sk-or-scripted");
  } catch (_) { /* storage unavailable */ }
}

(async () => {
  const html = fs.readFileSync(path.join(root, "dist", "quorum.html"));
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch(proxy ? { proxy: { server: proxy } } : {});
  try {
    fs.mkdirSync(out, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
    await context.addInitScript(standIn, { answers, holds: HOLDS, pace: 4 });
    await context.addInitScript(setUp);
    // The page is served from here rather than the network, at the address npm start uses.
    await context.route("http://localhost:8765/", route => route.fulfill({ body: html, contentType: "text/html; charset=utf-8" }));
    // Its fonts come from Google Fonts. Node fetches them rather than the browser, because a proxy that re-signs
    // TLS is often trusted by Node (NODE_EXTRA_CA_CERTS) and not by the browser Playwright drives.
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, async route => {
      try {
        await route.fulfill({ response: await route.fetch() });
      } catch (_) {
        await route.abort();
      }
    });
    const page = await context.newPage();
    // The scripted answers arrive in a moment, where real agents take minutes. The page's clock is moved on at
    // each stage so the session timer reads the way it would.
    await page.clock.install();
    await page.goto("http://localhost:8765/");

    const shot = async (name, sectionId) => {
      await page.evaluate(id => {
        if (document.activeElement) document.activeElement.blur();
        if (id) document.getElementById(id).scrollIntoView({ block: "start" });
        else window.scrollTo(0, 0);
      }, sectionId || "");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(out, name + ".png") });
      console.log("Saved docs/screenshots/" + name + ".png");
    };
    const held = (gate, n) => page.waitForFunction(([g, k]) => window.__standIn.held(g) === k, [gate, n]);
    const advance = async seconds => {
      await page.clock.setSystemTime(await page.evaluate(() => Date.now()) + seconds * 1000);
      await page.waitForTimeout(1100); // the session timer ticks once a second
    };

    await page.click('.example[data-example="1"]');
    await shot("convene");

    await page.click("#convene");
    await held("builders", 3);
    await advance(41);
    await shot("proposals", "sec-proposals");

    await page.evaluate(() => window.__standIn.release("builders"));
    await held("chair", 1);
    await advance(97);
    await page.click("#tab-skeptic");
    await shot("council", "sec-council");
    await shot("vote", "sec-vote");

    await advance(72);
    await page.evaluate(() => window.__standIn.release("chair"));
    await page.waitForFunction(() => /adjourned/.test(document.getElementById("status").textContent));
    await shot("plan", "sec-plan");

    await page.emulateMedia({ colorScheme: "dark" });
    await shot("vote-dark", "sec-vote");

    const loaded = await page.evaluate(() => [...document.fonts].filter(f => f.status === "loaded").map(f => f.family));
    if (!loaded.some(f => /Newsreader/.test(f)) || !loaded.some(f => /Public Sans/.test(f))) {
      console.warn("The web fonts didn't load, so the screenshots use fallback fonts.");
    }
  } finally {
    await browser.close();
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});
