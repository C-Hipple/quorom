// Stands in for `claude -p --output-format stream-json` in the tests. What it does depends on the prompt:
//   FAKE:auth    fails as Claude Code does when it isn't signed in
//   FAKE:crash   writes to stderr and exits without a result
//   FAKE:slow    starts, then waits until it's killed, having added its pid to FAKE_PID_FILE
//   FAKE:pause   waits a moment after reading a file, before it writes
//   otherwise    reads a file, then answers: as the Quorum seat the prompt names, or with the arguments and folder
//                it was run with. With FAKE_LOG set, it adds { args, cwd, prompt } to that file as a line of JSON.
const fs = require("fs");
const path = require("path");

if (process.argv.includes("--version")) {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}

const out = o => process.stdout.write(JSON.stringify(o) + "\n");
const ev = event => out({ type: "stream_event", event, parent_tool_use_id: null });

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { prompt += c; });

// A valid answer for each Quorum seat, which says where it ran.
function seatAnswer(p) {
  const seat = (/^You are (The \w+ Reviewer|The \w+|the Chair)/.exec(p) || [])[1];
  const where = "Ran in " + process.cwd() + ".";
  if (/^You are the Chair[^\n]*finishing the plan after its final review/.test(p)) {
    return "# The Plan, Reviewed\nWhat we'll build.\n\n## The decision\nProposal A. " + where + "\n\n## Final review\n- **High**: fixed.";
  }
  if (/ Reviewer$/.test(seat || "")) {
    return "## Verdict\nNearly. " + where + "\n\n## Findings\n1. **High**: exports aren't rate limited. Add a limit.\n\n## What the plan gets right\nThe queue.";
  }
  if (["The Pragmatist", "The Visionary", "The Architect"].includes(seat)) {
    return "# " + seat.slice(4) + " Route\n> A pitch.\n\n## The approach\n" + where + "\n\n## What changes\n- src/app.js\n\n## How we'd build it\n1. Step\n\n## Testing and rollout\nTests.\n\n## Risks and trade-offs\nSome.\n\n## Why the council should choose this\nIt fits.";
  }
  if (["The Advocate", "The Skeptic", "The Strategist"].includes(seat)) {
    return "## Verdict\nA fits best. " + where + "\n\n## A: x\nGood.\n\n## B: y\nOk.\n\n## C: z\nOk.\n\n## Worth keeping\nTests.\n\n```json\n" +
      JSON.stringify({ ranking: ["A", "B", "C"], scores: { A: 8, B: 6, C: 4 } }) + "\n```";
  }
  if (seat === "the Chair") return "# The Plan\nWhat we'll build.\n\n## The decision\nProposal A. " + where + "\n\n## Implementation steps\n1. Build";
  return null;
}

process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, cwd: process.cwd(), prompt }) + "\n");
  const mi = args.indexOf("--model");
  const model = mi >= 0 ? "claude-" + args[mi + 1] + "-fake" : "claude-default-fake";
  out({ type: "system", subtype: "init", cwd: process.cwd(), model, tools: ["Glob", "Grep", "Read"] });

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

  // A preamble, a tool call, then the answer in a second message.
  ev({ type: "message_start", message: { model } });
  ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me look first." } });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: path.join(process.cwd(), "src", "app.js") } }] }, parent_tool_use_id: null });
  // A subagent's work is ignored.
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Grep", input: { pattern: "secret" } }] }, parent_tool_use_id: "t9" });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }] }, parent_tool_use_id: null });
  setTimeout(() => {
    ev({ type: "message_start", message: { model } });
    const answer = seatAnswer(prompt) || "# Fake answer\n\n" + JSON.stringify({ args, cwd: process.cwd(), prompt });
    (answer.match(/[\s\S]{1,40}/g) || []).forEach(p => ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } }));
    out({ type: "assistant", message: { content: [{ type: "text", text: answer }] }, parent_tool_use_id: null });
    out({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: answer });
  }, prompt.includes("FAKE:pause") ? 600 : 0);
});
