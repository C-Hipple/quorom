// Stands in for `claude -p --output-format stream-json` in the tests. What it does depends on the prompt:
//   FAKE:auth    fails as Claude Code does when it isn't signed in
//   FAKE:crash   writes to stderr and exits without a result
//   FAKE:slow    starts, then waits until it's killed, having added its pid to FAKE_PID_FILE
//   FAKE:pause   waits a moment after reading a file, before it writes
//   naming       a prompt to name the session is answered at once, with a name made from the feature
//   otherwise    thinks, says it will look, reads src/app.js, then answers: as the Quorum seat the prompt names, or
//                with the arguments and folder it was run with. With FAKE_LOG set, it adds { args, cwd, prompt } to that file as a line of JSON.
import fs from "node:fs";
import path from "node:path";
import { nameAnswer, seatAnswer } from "./seat-answers";

if (process.argv.includes("--version")) {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const ev = (event: unknown) => out({ type: "stream_event", event, parent_tool_use_id: null });

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c: string) => { prompt += c; });

process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, cwd: process.cwd(), prompt }) + "\n");
  const mi = args.indexOf("--model");
  const model = mi >= 0 ? "claude-" + args[mi + 1] + "-fake" : "claude-default-fake";
  out({ type: "system", subtype: "init", cwd: process.cwd(), model, tools: ["Glob", "Grep", "Read"] });

  // Naming the session is answered at once, whatever the feature asks the stand-in to do.
  const name = nameAnswer(prompt);
  if (name) {
    out({ type: "assistant", message: { content: [{ type: "text", text: name }] }, parent_tool_use_id: null });
    out({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: name, num_turns: 1 });
    return;
  }

  if (prompt.includes("FAKE:crash")) {
    process.stderr.write("Something went wrong\nfatal: the fake crashed\n");
    process.exit(1);
  }
  if (prompt.includes("FAKE:auth")) {
    const msg = "Invalid API key · Please run /login";
    out({ type: "assistant", message: { content: [{ type: "text", text: msg }] }, error: "authentication_failed", parent_tool_use_id: null });
    out({ type: "result", subtype: "success", is_error: true, api_error_status: 401, result: msg });
    process.exit(1);
  }
  if (prompt.includes("FAKE:slow")) {
    if (process.env.FAKE_PID_FILE) fs.appendFileSync(process.env.FAKE_PID_FILE, process.pid + "\n");
    ev({ type: "message_start", message: { model } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Starting" } });
    setInterval(() => {}, 1000);
    return;
  }

  // Some reasoning, a preamble and a tool call, then the answer in a second message. Claude Code streams each
  // message's text as it's written, and sends each block again whole once it's done.
  const file = path.join(process.cwd(), "src", "app.js");
  ev({ type: "message_start", message: { model } });
  out({ type: "assistant", message: { content: [{ type: "thinking", thinking: "I should read the app first.", signature: "sig" }] }, parent_tool_use_id: null });
  ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Let me look first." } });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Let me look first." }] }, parent_tool_use_id: null });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: file } }] }, parent_tool_use_id: null });
  // A subagent's work is ignored.
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Grep", input: { pattern: "secret" } }] }, parent_tool_use_id: "t9" });
  const found = fs.existsSync(file);
  out({
    type: "user", parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: found ? fs.readFileSync(file, "utf8") : "<tool_use_error>File does not exist.</tool_use_error>", is_error: !found }] },
  });
  setTimeout(() => {
    ev({ type: "message_start", message: { model } });
    const answer = seatAnswer(prompt, process.cwd()) || "# Fake answer\n\n" + JSON.stringify({ args, cwd: process.cwd(), prompt });
    (answer.match(/[\s\S]{1,40}/g) || []).forEach(p => ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } }));
    out({ type: "assistant", message: { content: [{ type: "text", text: answer }] }, parent_tool_use_id: null });
    out({
      type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: answer,
      num_turns: 2, duration_ms: 1500, total_cost_usd: 0.0123, usage: { input_tokens: 1000, cache_read_input_tokens: 200, output_tokens: 300 },
    });
  }, prompt.includes("FAKE:pause") ? 600 : 0);
});
