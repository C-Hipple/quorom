// Tests for Quorum's agent loop and the read-only tools it gives agents, against a stand-in OpenAI-compatible service.
import { afterAll, test } from "bun:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentLoop } from "../harness/agent-loop";
import type { AgentTask } from "../harness/harness";
import { projectTools } from "../harness/tools";
import { fakeOpenAI, type FakeReply, type FakeRequest } from "./fake-openai";

const made: string[] = [];
afterAll(() => made.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

// A project in a Git repository: a folder inside it is the project, with an AGENTS.md at each level, some ignored and
// some hidden files, a binary file, and a link that leads out of the project.
function tmpRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "quorum-harness-")));
  made.push(repo);
  const write = (rel: string, text: string | Uint8Array) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  Bun.spawnSync(["git", "init", "-q", repo]);
  write("AGENTS.md", "# The monorepo\nEvery package is tested with bun test.");
  write("secret.txt", "outside the project");
  write("app/AGENTS.md", "# The app\nKeep the server and the page apart.");
  write("app/.gitignore", "build/\n*.log\n");
  write("app/src/server.ts", "export function serve() {\n  // TODO: rate limits\n  return listen(8080);\n}\n");
  write("app/src/page.tsx", "export const Page = () => <main>Todo list</main>;\n");
  write("app/src/db/AGENTS.md", "Migrations only go forward.");
  write("app/src/db/schema.sql", "CREATE TABLE todo (id INTEGER);\n");
  write("app/build/out.js", "TODO: built");
  write("app/debug.log", "TODO: log");
  write("app/logo.png", new Uint8Array([137, 80, 78, 71, 0, 0, 0, 13]));
  write("app/long.txt", Array.from({ length: 2500 }, (_, i) => "line " + (i + 1)).join("\n") + "\n");
  fs.symlinkSync(path.join(repo, "secret.txt"), path.join(repo, "app", "leak.txt"));
  return { repo, project: path.join(repo, "app") };
}

const { repo, project } = tmpRepo();
const tools = projectTools(project);
const call = (name: string, input: Record<string, unknown>) => tools.call(name, input);

test("Read gives a file with line numbers, a part at a time", async () => {
  const r = await call("Read", { file_path: "src/server.ts" });
  assert.strictEqual(r.error, undefined);
  assert.strictEqual(r.content, "     1\texport function serve() {\n     2\t  // TODO: rate limits\n     3\t  return listen(8080);\n     4\t}");
  assert.strictEqual((await call("Read", { file_path: path.join(project, "src", "server.ts"), offset: 3, limit: 1 })).content, "     3\t  return listen(8080);\n\n[Lines 3 to 3 of 4. Read on with offset 4.]");
  const long = await call("Read", { file_path: "long.txt" });
  assert.ok(long.content.endsWith("  2000\tline 2000\n\n[Lines 1 to 2000 of 2500. Read on with offset 2001.]"), "2000 lines at a time");
  assert.ok((await call("Read", { file_path: "long.txt", offset: 2001 })).content.endsWith("  2500\tline 2500"));
});

test("Read turns away what it can't or mustn't read", async () => {
  const no = async (input: Record<string, unknown>, message: RegExp) => {
    const r = await call("Read", input);
    assert.ok(r.error, JSON.stringify(input));
    assert.ok(message.test(r.content), r.content);
  };
  await no({ file_path: "src/nope.ts" }, /^There's no file at src\/nope\.ts\.$/);
  await no({ file_path: "src" }, /is a folder\. Use Glob/);
  await no({ file_path: "logo.png" }, /isn't a text file/);
  await no({ file_path: "../secret.txt" }, /is outside the project folder/);
  await no({ file_path: path.join(repo, "secret.txt") }, /is outside the project folder/);
  await no({ file_path: "leak.txt" }, /is outside the project folder/);
  await no({ file_path: "src/server.ts", offset: 99 }, /has only 4 lines/);
  await no({}, /Give a path/);
});

test("Glob lists the project's files that match, leaving out what Git ignores", async () => {
  assert.strictEqual((await call("Glob", { pattern: "**/*.ts" })).content, "src/server.ts");
  assert.strictEqual((await call("Glob", { pattern: "*.sql", path: "src/db" })).content, "src/db/schema.sql");
  assert.ok(!(await call("Glob", { pattern: "**/*" })).content.includes("build/"), "ignored files are left out");
  assert.strictEqual((await call("Glob", { pattern: "**/*.rs" })).content, "No files match **/*.rs.");
  assert.ok((await call("Glob", { pattern: "*", path: ".." })).error);
});

test("Grep finds matching lines, narrowed by path and glob", async () => {
  assert.strictEqual((await call("Grep", { pattern: "TODO" })).content, "src/server.ts:2: // TODO: rate limits", "ignored and binary files are skipped");
  assert.strictEqual((await call("Grep", { pattern: "todo", ignore_case: true, glob: "*.tsx" })).content, "src/page.tsx:1: export const Page = () => <main>Todo list</main>;");
  assert.strictEqual((await call("Grep", { pattern: "TABLE", path: "src/db/schema.sql" })).content, "src/db/schema.sql:1: CREATE TABLE todo (id INTEGER);");
  assert.strictEqual((await call("Grep", { pattern: "nothing like this" })).content, "No matches for nothing like this.");
  const bad = await call("Grep", { pattern: "(" });
  assert.ok(bad.error && /isn't a regular expression/.test(bad.content));
  const unknown = await tools.call("Bash", { command: "rm -rf /" });
  assert.ok(unknown.error && /There's no tool called Bash/.test(unknown.content));
});

test("the AGENTS.md files that apply are found, from the repository's root down", () => {
  assert.deepStrictEqual(tools.guides(), [
    { path: "../AGENTS.md", text: "# The monorepo\nEvery package is tested with bun test." },
    { path: "AGENTS.md", text: "# The app\nKeep the server and the page apart." },
  ]);
  assert.deepStrictEqual(tools.nestedGuides(), ["src/db/AGENTS.md"]);
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "quorum-bare-")));
  made.push(bare);
  fs.writeFileSync(path.join(bare, "a.txt"), "a");
  assert.deepStrictEqual(projectTools(bare).guides(), [], "a project without one");
});

// ---------- The loop ----------

type Events = [string, any][];
async function runLoop(reply: (req: FakeRequest, n: number) => FakeReply | Promise<FakeReply>, o: { maxTurns?: number, key?: string, signal?: AbortSignal, prompt?: string } = {}) {
  const service = fakeOpenAI(reply);
  const events: Events = [];
  const loop = createAgentLoop({ headers: { "X-Title": "Quorum" }, body: { usage: { include: true } }, maxTurns: o.maxTurns, retryDelays: [5, 5] });
  const task: AgentTask = {
    prompt: o.prompt || "You are The Pragmatist. Propose something.", model: "z-ai/glm-5.3", cwd: project,
    endpoint: { url: service.url + "/", key: o.key ?? "sk-or-test" }, signal: o.signal || new AbortController().signal,
  };
  await loop.run(task, (event, data) => events.push([event, data]));
  await service.stop();
  return { events, requests: service.requests, service };
}
const names = (events: Events) => events.map(e => e[0]);

test("the loop runs the tools the model asks for, and its last message is the answer", async () => {
  const { events, requests } = await runLoop((req, n) => (n === 1 ?
    { text: "Let me look first.", reasoning: "Read the server.", tools: [{ name: "Read", input: { file_path: "src/server.ts" } }, { name: "Grep", input: { pattern: "TODO" } }], model: "z-ai/glm-5.3-20260901" } :
    { text: "<think>It needs a limit.</think>\n# Rate limits\nAdd them to serve().", model: "z-ai/glm-5.3-20260901" }));
  assert.deepStrictEqual(names(events).filter(n => n !== "text"), ["start", "turn", "block", "block", "usage", "tool", "tool_result", "tool", "tool_result", "turn", "block", "block", "done"]);
  const of = (name: string) => events.filter(e => e[0] === name).map(e => e[1]);
  const soFar = of("usage")[0];
  assert.deepStrictEqual({ ...soFar, durationMs: 0 }, { turns: 1, durationMs: 0, inputTokens: 100, outputTokens: 20, costUsd: 0.001 }, "what the first turn used, before the tools run");
  assert.deepStrictEqual(of("start")[0], { model: "z-ai/glm-5.3", tools: ["Read", "Grep", "Glob"] });
  assert.deepStrictEqual(of("block"), [
    { type: "thinking", text: "Read the server." }, { type: "text", text: "Let me look first." },
    { type: "thinking", text: "It needs a limit." }, { type: "text", text: "# Rate limits\nAdd them to serve()." },
  ]);
  assert.deepStrictEqual(of("tool"), [
    { id: "call_1_0", tool: "Read", detail: "src/server.ts", input: { file_path: "src/server.ts" } },
    { id: "call_1_1", tool: "Grep", detail: "TODO", input: { pattern: "TODO" } },
  ]);
  assert.deepStrictEqual(of("tool_result")[0], { id: "call_1_0", content: "     1\texport function serve() {\n     2\t  // TODO: rate limits\n     3\t  return listen(8080);\n     4\t}", error: false });
  // What streams is each message's text, without the reasoning in <think>; a new turn starts the text again.
  const turnAt = events.findIndex((e, i) => i > 1 && e[0] === "turn");
  assert.strictEqual(events.slice(0, turnAt).filter(e => e[0] === "text").map(e => e[1].delta).join(""), "Let me look first.");
  assert.strictEqual(events.slice(turnAt).filter(e => e[0] === "text").map(e => e[1].delta).join(""), "# Rate limits\nAdd them to serve().");
  const done = of("done")[0];
  assert.deepStrictEqual({ ...done, usage: { ...done.usage, durationMs: 0 } }, {
    text: "# Rate limits\nAdd them to serve().", truncated: false, model: "z-ai/glm-5.3-20260901",
    usage: { turns: 2, durationMs: 0, inputTokens: 200, outputTokens: 40, costUsd: 0.002 },
  });

  assert.strictEqual(requests.length, 2);
  requests.forEach(r => {
    assert.strictEqual(r.path, "/v1/chat/completions");
    assert.strictEqual(r.headers.get("authorization"), "Bearer sk-or-test");
    assert.strictEqual(r.headers.get("x-title"), "Quorum");
    assert.deepStrictEqual(r.body.usage, { include: true });
    assert.strictEqual(r.body.stream, true);
    assert.strictEqual(r.body.tool_choice, "auto");
    assert.deepStrictEqual(r.body.tools.map((t: any) => t.function.name), ["Read", "Grep", "Glob"]);
  });
  const [system, user] = requests[0].body.messages;
  assert.ok(system.content.startsWith("You're working in a software project's folder, " + project + ". You have three read-only tools"));
  assert.ok(system.content.includes("=== ../AGENTS.md ===\n# The monorepo\nEvery package is tested with bun test.\n=== End of ../AGENTS.md ===\n\n=== AGENTS.md ===\n# The app"), "the project's AGENTS.md, most general first");
  assert.ok(system.content.endsWith("Read the one for any folder your task touches: src/db/AGENTS.md."));
  assert.deepStrictEqual(user, { role: "user", content: "You are The Pragmatist. Propose something." });
  const [, , asked, read, grep] = requests[1].body.messages;
  assert.deepStrictEqual(asked, {
    role: "assistant", content: "Let me look first.",
    tool_calls: [
      { id: "call_1_0", type: "function", function: { name: "Read", arguments: '{"file_path":"src/server.ts"}' } },
      { id: "call_1_1", type: "function", function: { name: "Grep", arguments: '{"pattern":"TODO"}' } },
    ],
  });
  assert.strictEqual(read.role, "tool");
  assert.strictEqual(read.tool_call_id, "call_1_0");
  assert.ok(read.content.includes("TODO: rate limits"));
  assert.deepStrictEqual(grep, { role: "tool", tool_call_id: "call_1_1", content: "src/server.ts:2: // TODO: rate limits" });
});

test("a tool call the loop can't read is answered with an error, and the agent carries on", async () => {
  const { events, requests } = await runLoop((req, n) => (n === 1 ? { tools: [{ name: "Read", input: "not an object" }] } : { text: "Done." }));
  const result = events.find(e => e[0] === "tool_result")![1];
  assert.ok(result.error && result.content.startsWith("The tool's arguments weren't a JSON object"));
  assert.strictEqual(requests[1].body.messages[3].role, "tool");
  assert.strictEqual(events[events.length - 1][1].text, "Done.");
});

test("after its last turn with tools, the agent is asked for its answer", async () => {
  const { events, requests } = await runLoop(req => (req.body.tool_choice === "none" ? { text: "My answer." } : { tools: [{ name: "Glob", input: { pattern: "**/*" } }] }), { maxTurns: 2 });
  assert.strictEqual(requests.length, 3);
  assert.deepStrictEqual(requests.map(r => r.body.tool_choice), ["auto", "auto", "none"]);
  assert.ok(requests[2].body.tools, "the tools are still described");
  assert.strictEqual(requests[2].body.messages[requests[2].body.messages.length - 1].content, "You've used all the tool calls this step allows. Write your final answer now, without calling any more tools.");
  assert.strictEqual(events[events.length - 1][0], "done");
  assert.strictEqual(events[events.length - 1][1].text, "My answer.");
});

test("failures become Quorum's error codes", async () => {
  const errorOf = async (reply: FakeReply) => {
    const { events } = await runLoop(() => reply);
    assert.strictEqual(events[events.length - 1][0], "error");
    return events[events.length - 1][1];
  };
  const auth = await errorOf({ status: 401, error: { error: { code: 401, message: "No auth credentials found" } } });
  assert.strictEqual(auth.code, "auth_failed");
  assert.strictEqual(auth.message, "No auth credentials found");
  assert.strictEqual(auth.usage.turns, 1);
  assert.strictEqual((await errorOf({ status: 404, error: { error: { code: 404, message: "No endpoints found that support tool use." } } })).code, "no_tools");
  assert.strictEqual((await errorOf({ status: 402, error: { error: { message: "Insufficient credits" } } })).code, "no_credits");
  assert.strictEqual((await errorOf({ status: 400, error: { error: { message: "x/y is not a valid model ID" } } })).code, "bad_model");
  // A failure after the answer has started isn't tried again: the page keeps what was written.
  const cut = await runLoop(() => ({ text: "Half an answer", streamError: { code: "server_error", message: "Provider disconnected unexpectedly" } }));
  assert.strictEqual(cut.requests.length, 1);
  assert.strictEqual(cut.events.filter(e => e[0] === "text").map(e => e[1].delta).join(""), "Half an answer");
  const last = cut.events[cut.events.length - 1];
  assert.deepStrictEqual([last[0], last[1].code, last[1].message], ["error", "upstream_error", "Provider disconnected unexpectedly"]);
});

test("a rate limit is waited out, and the request made again", async () => {
  const { events, requests } = await runLoop((req, n) => (n < 3 ? { status: 429, error: { error: { message: "Rate limit exceeded" } } } : { text: "Answer." }));
  assert.strictEqual(requests.length, 3);
  assert.strictEqual(events[events.length - 1][1].text, "Answer.");
  const gaveUp = await runLoop(() => ({ status: 429, error: { error: { message: "Rate limit exceeded" } } }));
  assert.strictEqual(gaveUp.requests.length, 3, "twice more, then it gives up");
  assert.strictEqual(gaveUp.events[gaveUp.events.length - 1][1].code, "rate_limited");
});

test("stopping a run closes its request, and it reports nothing more", async () => {
  const stop = new AbortController();
  const run = runLoop(() => ({ text: "Starting a long answer", hang: true, wait: 5 }), { signal: stop.signal });
  await new Promise(r => setTimeout(r, 100));
  stop.abort();
  const { events, service } = await run;
  assert.ok(!events.some(e => e[0] === "done" || e[0] === "error"));
  assert.strictEqual(service.aborted, 1);
});
