// A harness runs one seat as an agent on this computer: it's handed the seat's prompt, a model and the project folder,
// works in the folder with read-only tools until it has its answer, and reports what it does as it goes. Every harness
// reports in the same events, so the page shows any of them the same way, and one can be swapped for another without
// the page knowing:
//   start       {model, tools}               the run began on this model, with these tools
//   turn        {}                           the agent began a new message, so any text before it was a preamble
//   text        {delta}                      more of the current message
//   block       {type, text}                 a whole block of a message once it's written: "text", or "thinking"
//                                            for the agent's reasoning
//   tool        {id, tool, detail, input}    the agent used a tool, such as Read and the file it read
//   tool_result {id, content, error}         what the tool gave back
//   usage       {turns, inputTokens, outputTokens, costUsd?}  what the run has used so far, where the harness can
//                                            tell before it ends
//   done        {text, truncated, model, usage?}  the answer, which is the agent's final message
//   error       {code, message, usage?}      it couldn't finish, with one of Quorum's error codes
// A run ends with exactly one done or error.
import path from "node:path";

export type AgentEvent = "start" | "turn" | "text" | "block" | "tool" | "tool_result" | "usage" | "done" | "error";
export type Emit = (event: AgentEvent, data: Record<string, unknown>) => void;

export interface AgentTask {
  prompt: string;
  // The model to use, or "" for the harness's default.
  model: string;
  // The project folder, which the agent works in and can't reach outside of.
  cwd: string;
  // The model service and its key, for a harness that calls one itself.
  endpoint?: { url: string, key: string };
  // Aborted when the page stops the seat. The run then stops as soon as it can, and needn't report anything more.
  signal: AbortSignal;
}

export interface Harness {
  // Whether this harness can use the model the page asked for: undefined if so, or else why not.
  checkModel(model: string): string | undefined;
  // Runs the task, reporting as it goes. It resolves once the run has ended, and doesn't reject: what goes wrong is
  // reported as an error event.
  run(task: AgentTask, emit: Emit): Promise<void>;
}

// How long a run took and what it used, where the harness knows.
export interface Usage {
  turns?: number;
  costUsd?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

// The most of a tool's result the page is sent. The agent itself may be given less; see the tools.
export const MAX_TOOL_OUTPUT = 200000;

// What a tool call was about, for the page to show while the agent explores: a file, a folder or a search pattern.
export function toolDetail(input: unknown, cwd: string): string {
  const o: Record<string, unknown> = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const rel = (p: string) => {
    const r = path.relative(cwd, String(p));
    return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : String(p);
  };
  const d = typeof o.file_path === "string" ? rel(o.file_path) : typeof o.pattern === "string" ? o.pattern :
    typeof o.path === "string" ? rel(o.path) : "";
  return d.length > 120 ? d.slice(0, 119) + "…" : d;
}

// What a tool gave back, as the agent read it: its text, and a placeholder for anything else, such as an image.
export function toolOutput(content: unknown): string {
  const s = typeof content === "string" ? content : Array.isArray(content) ?
    content.map(c => (c && c.type === "text" ? String(c.text || "") : c && c.type ? "[" + c.type + "]" : "")).join("\n") : "";
  return s.length > MAX_TOOL_OUTPUT ? s.slice(0, MAX_TOOL_OUTPUT) + "\n\n[Quorum kept the first " + MAX_TOOL_OUTPUT + " of " + s.length + " characters.]" : s;
}
