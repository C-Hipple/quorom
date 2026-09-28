// Records the screenshots in the README. It serves the built page, stands a scripted local server in for Quorum's, with
// every seat an agent on OpenRouter, and works through the "CSV export for reports" example, saving a picture of each
// stage to docs/screenshots.
//
//   bun run screenshots
//
// It needs Playwright and a Chromium it can drive, which aren't among the project's dependencies:
//   bun add --no-save playwright && bunx playwright install chromium
import fs from "node:fs";
import path from "node:path";
import { answers } from "./scripted-session";

// Playwright is optional, so it's imported by a name TypeScript doesn't look up, and used untyped.
const PLAYWRIGHT = "playwright";
let chromium: any;
try {
  ({ chromium } = await import(PLAYWRIGHT));
} catch (_) {
  console.error("The screenshots need Playwright. Install it with:\n  bun add --no-save playwright && bunx playwright install chromium");
  process.exit(1);
}

const root = path.join(import.meta.dir, "..");
const out = path.join(root, "docs", "screenshots");

type Holds = Record<string, [string, number]>;

// Where seats pause, as [gate, fraction of the answer written], so the stages in progress can be photographed.
const HOLDS: Holds = { A: ["builders", 0.55], B: ["builders", 0.3], C: ["builders", 0], chair: ["chair", 0] };

// What the stand-in adds to the page, for the script to release a gate and see how many seats wait at it.
interface StandIn {
  release(name: string): void;
  held(name: string): number;
}

// Runs in the page before Quorum does. It stands in for Quorum's local server, with a project folder and every seat an
// agent on OpenRouter: each agent reads the project's README, then writes its answer from the script a few words at a
// time, the way a real stream arrives, and holds at its gate until the gate is released.
function standIn({ answers, holds, pace }: { answers: Record<string, string>, holds: Holds, pace: number }) {
  const gates: Record<string, { open: boolean, waiters: (() => void)[], held: number }> = {};
  const gate = (name: string) => gates[name] || (gates[name] = { open: false, waiters: [], held: 0 });
  const standIn: StandIn = {
    release(name) { const g = gate(name); g.open = true; g.waiters.splice(0).forEach(go => go()); },
    held: name => gate(name).held,
  };
  (window as unknown as { __standIn: StandIn }).__standIn = standIn;
  const SEATS: Record<string, string> = { "The Pragmatist": "A", "The Visionary": "B", "The Architect": "C", "The Advocate": "advocate", "The Skeptic": "skeptic", "The Strategist": "strategist", "the Chair": "chair" };
  const seatOf = (prompt: string) => {
    if (/^Name a session/.test(prompt)) return "name";
    const m = /^You are (The \w+|the Chair)/.exec(prompt);
    return m ? SEATS[m[1]] : "";
  };
  const PROJECT = "/home/you/reports-app";
  const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
  const realFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String((input && (input as Request).url) || input);
    if (url === "https://openrouter.ai/api/v1/models") return json({ data: [] });
    if (!url.startsWith(location.origin + "/api/")) return realFetch(input, init);
    const route = url.slice(location.origin.length);
    if (route === "/api/local") return json({ claudeCode: { available: false, version: null }, sessions: null, project: PROJECT, home: "/home/you" });
    if (route.startsWith("/api/folder")) {
      return json({ path: PROJECT, name: "reports-app", parent: "/home/you", dirs: [], more: 0, unreadable: false,
        git: { root: PROJECT, branch: "main", detached: null }, claudeMd: false, agentsMd: true });
    }
    if (route !== "/api/agent") return json({ error: { code: "not_found", message: "Not found." } });
    const body = JSON.parse((init as RequestInit).body as string);
    const seat = seatOf(body.prompt);
    const answer = answers[seat];
    const pieces = answer.match(/[\s\S]{1,24}/g) as string[];
    const hold = holds[seat];
    const holdAt = hold ? Math.floor(pieces.length * hold[1]) : -1;
    const enc = new TextEncoder();
    return new Response(new ReadableStream({
      async start(c) {
        const send = (event: string, data: unknown) => c.enqueue(enc.encode("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"));
        send("start", { model: body.model, tools: ["Read", "Grep", "Glob"] });
        send("turn", {});
        send("tool", { id: "t1", tool: "Read", detail: "README.md", input: { file_path: "README.md" } });
        send("tool_result", { id: "t1", content: "# Reports\nReports are built by ReportService.", error: false });
        send("turn", {});
        for (let i = 0; i < pieces.length; i++) {
          const g = hold && gate(hold[0]);
          if (g && i === holdAt && !g.open) {
            g.held += 1;
            await new Promise<void>(go => g.waiters.push(go));
          }
          send("text", { delta: pieces[i] });
          await new Promise(r => setTimeout(r, pace));
        }
        send("block", { type: "text", text: answer });
        send("done", { text: answer, truncated: false, model: body.model, usage: { turns: 2 } });
        c.close();
      },
    }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

// A remembered OpenRouter key, so the page opens set up. The stand-in never sends it anywhere.
function setUp() {
  try {
    if (localStorage.getItem("quorum:providers")) return;
    localStorage.setItem("quorum:providers", JSON.stringify({ urls: { hermes: "", custom: "" }, remember: { openrouter: true, hermes: false, custom: false } }));
    localStorage.setItem("quorum:key:openrouter", "sk-or-scripted");
  } catch (_) { /* storage unavailable */ }
}

try {
  const html = fs.readFileSync(path.join(root, "dist", "quorum.html"));
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch(proxy ? { proxy: { server: proxy } } : {});
  try {
    fs.mkdirSync(out, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
    await context.addInitScript(standIn, { answers, holds: HOLDS, pace: 4 });
    await context.addInitScript(setUp);
    // The page is served from here rather than the network, at the address bun start uses.
    await context.route("http://localhost:8765/", (route: any) => route.fulfill({ body: html, contentType: "text/html; charset=utf-8" }));
    // Its fonts come from Google Fonts. This script fetches them rather than the browser, because a proxy that
    // re-signs TLS is often trusted here (NODE_EXTRA_CA_CERTS) and not by the browser Playwright drives.
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, async (route: any) => {
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

    const shot = async (name: string, sectionId?: string) => {
      await page.evaluate((id: string) => {
        if (document.activeElement) (document.activeElement as HTMLElement).blur();
        if (id) (document.getElementById(id) as HTMLElement).scrollIntoView({ block: "start" });
        else window.scrollTo(0, 0);
      }, sectionId || "");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(out, name + ".png") });
      console.log("Saved docs/screenshots/" + name + ".png");
    };
    // These functions run in the page, so they find the stand-in there.
    const held = (gate: string, n: number) => page.waitForFunction(([g, k]: [string, number]) => (window as unknown as { __standIn: StandIn }).__standIn.held(g) === k, [gate, n]);
    const advance = async (seconds: number) => {
      await page.clock.setSystemTime(await page.evaluate(() => Date.now()) + seconds * 1000);
      await page.waitForTimeout(1100); // the session timer ticks once a second
    };

    await page.click('.example[data-example="1"]');
    await shot("convene");

    await page.click("#convene");
    await held("builders", 3);
    await advance(41);
    await shot("proposals", "sec-proposals");

    await page.evaluate(() => (window as unknown as { __standIn: StandIn }).__standIn.release("builders"));
    await held("chair", 1);
    await advance(97);
    await page.click("#tab-skeptic");
    await shot("council", "sec-council");
    await shot("vote", "sec-vote");

    await advance(72);
    await page.evaluate(() => (window as unknown as { __standIn: StandIn }).__standIn.release("chair"));
    await page.waitForFunction(() => /adjourned/.test((document.getElementById("status") as HTMLElement).textContent || ""));
    await shot("plan", "sec-plan");

    await page.emulateMedia({ colorScheme: "dark" });
    await shot("vote-dark", "sec-vote");

    const loaded: string[] = await page.evaluate(() => [...document.fonts].filter(f => f.status === "loaded").map(f => f.family));
    if (!loaded.some(f => /Newsreader/.test(f)) || !loaded.some(f => /Public Sans/.test(f))) {
      console.warn("The web fonts didn't load, so the screenshots use fallback fonts.");
    }
  } finally {
    await browser.close();
  }
} catch (e) {
  console.error(e);
  process.exit(1);
}
