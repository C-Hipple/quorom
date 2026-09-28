// Quorum's own agent loop, for OpenRouter and other OpenAI-compatible services. Each turn streams one chat completion
// with the project tools on offer. When the model calls tools, the loop runs them in the project folder, hands back
// what they gave, and asks again; when it answers without calling any, that answer is the seat's. After maxTurns
// requests the model is asked to answer without more tools.
import { Core } from "../src/core";
import { toolDetail, toolOutput, type AgentTask, type Emit, type Harness, type Usage } from "./harness";
import { projectTools, type ProjectTools } from "./tools";

export interface AgentLoopOptions {
  // Headers for every request, besides the key, such as the app name OpenRouter shows.
  headers?: Record<string, string>;
  // Fields for every request body, besides the model, messages and tools.
  body?: Record<string, unknown>;
  // How many requests a run makes with tools before it's asked for its answer.
  maxTurns?: number;
  // The waits before each retry of a request that failed for a passing reason, such as a rate limit, in milliseconds.
  retryDelays?: number[];
}

// A message in the OpenAI chat format.
type Message =
  | { role: "system" | "user", content: string }
  | { role: "assistant", content: string | null, tool_calls?: ToolCall[] }
  | { role: "tool", tool_call_id: string, content: string };

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string, arguments: string };
}

// One turn's reply: what the model wrote, its reasoning, the tools it called and why it stopped.
interface Reply {
  raw: string;
  reasoning: string;
  calls: { id: string, name: string, args: string }[];
  finish: string | null;
}

// A request that failed: its code, and whether trying again may work.
class Failure extends Error {
  constructor(readonly code: string, message: string, readonly passing: boolean) { super(message); }
}

const PASSING = [408, 429, 500, 502, 503, 504, 529];

// What the model is told about working in the project, and the project's AGENTS.md files.
function systemPrompt(cwd: string, tools: ProjectTools): string {
  const out = [
    "You're working in a software project's folder, " + cwd + ". You have three read-only tools for its files: Read, Grep and Glob. " +
      "Paths are relative to the project folder, or absolute inside it. You can't change files, run commands or reach anything outside the folder. " +
      "Use the tools to learn what you need, then give your whole answer as your last message, without calling any more tools.",
  ];
  const guides = tools.guides();
  if (guides.length) {
    out.push("The project's AGENTS.md, which describes how the project is designed and how to work in it. Follow it where it applies to your task:");
    guides.forEach(g => out.push("=== " + g.path + " ===\n" + g.text + "\n=== End of " + g.path + " ==="));
  }
  const nested = tools.nestedGuides();
  if (nested.length) {
    out.push("These folders have their own AGENTS.md, which applies to the files in them. Read the one for any folder your task touches: " + nested.join(", ") + ".");
  }
  return out.join("\n\n");
}

// Why a request failed, as one of Quorum's error codes. A model that can't use tools is told apart from other refusals.
function httpFailure(status: number, detail: string): Failure {
  const noTools = /tool (use|calling|choice)|function calling|support(s)? tools|tools? (is|are) not supported/i.test(detail);
  const code = noTools && (status === 400 || status === 404 || status === 422) ? "no_tools" : Core.httpErrorCode(status, detail);
  return new Failure(code, detail || "The service answered " + status + ".", PASSING.includes(status));
}

export function createAgentLoop(o: AgentLoopOptions = {}): Harness {
  const maxTurns = o.maxTurns ?? 40;
  const retryDelays = o.retryDelays ?? [1000, 4000];

  async function run(task: AgentTask, emit: Emit) {
    const started = Date.now();
    if (!task.endpoint) {
      emit("error", { code: "not_found", message: "No address for the model service." });
      return;
    }
    const endpoint = task.endpoint;
    const tools = projectTools(task.cwd);
    emit("start", { model: task.model, tools: tools.names });
    const messages: Message[] = [{ role: "system", content: systemPrompt(task.cwd, tools) }, { role: "user", content: task.prompt }];
    const used = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, counted: false, costed: false };
    let served = task.model;
    const usage = (): Usage => {
      const u: Usage = { turns: used.turns, durationMs: Date.now() - started };
      if (used.counted) Object.assign(u, { inputTokens: used.inputTokens, outputTokens: used.outputTokens });
      if (used.costed) u.costUsd = used.costUsd;
      return u;
    };

    const sleep = (ms: number) => new Promise<void>(resolve => {
      const t = setTimeout(resolve, ms);
      task.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });

    // One streamed chat completion. Text is passed on as it arrives; the rest comes back when the turn is over.
    async function complete(final: boolean, onText: (raw: string) => void): Promise<Reply> {
      const body = Object.assign({
        model: task.model, messages, stream: true,
        // A model is still shown the tools on its last turn, because some services refuse tool results without them.
        tools: tools.specs, tool_choice: final ? "none" : "auto",
      }, o.body || {});
      let res: Response;
      try {
        res = await fetch(endpoint.url.replace(/\/+$/, "") + "/chat/completions", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, endpoint.key ? { Authorization: "Bearer " + endpoint.key } : {}, o.headers || {}),
          body: JSON.stringify(body),
          signal: task.signal,
        });
      } catch (e) {
        throw new Failure("unreachable", String((e as Error)?.message || e), true);
      }
      if (!res.ok) {
        let text = "";
        try { text = await res.text(); } catch (_) { /* no body */ }
        throw httpFailure(res.status, Core.errorMessageFrom(text));
      }
      const reply: Reply = { raw: "", reasoning: "", calls: [], finish: null };
      let failure: Record<string, any> | null = null, done = false;
      const onData = (data: string) => {
        if (data === "[DONE]") { done = true; return; }
        let obj;
        try { obj = JSON.parse(data); } catch (_) { return; }
        if (!obj || typeof obj !== "object") return;
        if (obj.error) { failure = obj.error; done = true; return; }
        if (typeof obj.model === "string" && obj.model) served = obj.model;
        const u = obj.usage;
        if (u && typeof u === "object") {
          if (typeof u.prompt_tokens === "number") { used.inputTokens += u.prompt_tokens; used.counted = true; }
          if (typeof u.completion_tokens === "number") { used.outputTokens += u.completion_tokens; used.counted = true; }
          if (typeof u.cost === "number") { used.costUsd += u.cost; used.costed = true; }
        }
        const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
        if (!choice) return;
        // A streamed chunk carries a delta; a service that ignored stream:true answers with the whole message.
        const part = choice.delta || choice.message || {};
        if (typeof part.content === "string" && part.content) {
          reply.raw += part.content;
          onText(reply.raw);
        }
        // Reasoning models on OpenRouter send their reasoning apart from the answer, and some servers call it reasoning_content.
        const why = typeof part.reasoning === "string" ? part.reasoning : typeof part.reasoning_content === "string" ? part.reasoning_content : "";
        if (why) reply.reasoning += why;
        if (Array.isArray(part.tool_calls)) {
          part.tool_calls.forEach((tc: Record<string, any>, k: number) => {
            const i = typeof tc.index === "number" ? tc.index : k;
            const call = reply.calls[i] || (reply.calls[i] = { id: "", name: "", args: "" });
            if (typeof tc.id === "string" && tc.id) call.id = tc.id;
            const fn = tc.function || {};
            if (typeof fn.name === "string" && fn.name && fn.name !== call.name) call.name += fn.name;
            if (typeof fn.arguments === "string") call.args += fn.arguments;
            else if (fn.arguments && typeof fn.arguments === "object") call.args = JSON.stringify(fn.arguments);
          });
        }
        if (choice.finish_reason) reply.finish = choice.finish_reason;
      };
      const type = res.headers.get("content-type") || "";
      if (!res.body || /application\/json/i.test(type)) {
        onData(await res.text());
      } else {
        const parser = Core.createSSEParser(ev => { if (!done && ev.event === "message") onData(ev.data); });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        try {
          while (!done) {
            const step = await reader.read();
            if (step.done) break;
            parser.feed(decoder.decode(step.value, { stream: true }));
          }
          if (!done) parser.end();
        } catch (e) {
          throw new Failure("upstream_error", String((e as Error)?.message || e), !reply.raw && !reply.calls.length);
        } finally {
          reader.cancel().catch(() => {});
        }
      }
      if (failure) {
        const f: Record<string, any> = failure;
        throw new Failure(Core.streamErrorCode(f), String(f.message || ""), !reply.raw && !reply.calls.length);
      }
      if (reply.finish === "error") throw new Failure("upstream_error", "The answer stopped with an error.", false);
      reply.calls = reply.calls.filter(c => c && c.name);
      return reply;
    }

    for (let turn = 1; ; turn++) {
      const final = turn > maxTurns;
      if (final) {
        messages.push({ role: "user", content: "You've used all the tool calls this step allows. Write your final answer now, without calling any more tools." });
      }
      emit("turn", {});
      used.turns = turn;
      // What's passed on of the text is what's left once any <think> reasoning is taken out.
      let sent = "";
      const onText = (raw: string) => {
        const visible = Core.stripThinking(raw);
        if (visible.length > sent.length && visible.startsWith(sent)) {
          emit("text", { delta: visible.slice(sent.length) });
          sent = visible;
        }
      };
      let reply: Reply | null = null;
      for (let attempt = 0; !reply; attempt++) {
        try {
          reply = await complete(final, onText);
        } catch (e) {
          if (task.signal.aborted) return;
          const f = e instanceof Failure ? e : new Failure("upstream_error", String((e as Error)?.message || e), false);
          if (f.passing && !sent && attempt < retryDelays.length) {
            await sleep(retryDelays[attempt]);
            if (task.signal.aborted) return;
            continue;
          }
          emit("error", { code: f.code, message: f.message, usage: usage() });
          return;
        }
      }
      const thinking = [reply.reasoning.trim(), Core.thinkingOf(reply.raw)].filter(Boolean).join("\n\n");
      if (thinking) emit("block", { type: "thinking", text: thinking });
      const text = Core.stripThinking(reply.raw).replace(/\s+$/, "");
      if (text.trim()) emit("block", { type: "text", text });

      if (!reply.calls.length || final) {
        emit("done", { text, truncated: reply.finish === "length", model: served, usage: usage() });
        return;
      }
      // The run goes on, so the page hears what it has used so far.
      emit("usage", { ...usage() });
      const calls = reply.calls.map((c, i) => ({ id: c.id || "call_" + turn + "_" + i, name: c.name, args: c.args }));
      messages.push({
        role: "assistant", content: reply.raw || null,
        tool_calls: calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })),
      });
      for (const c of calls) {
        if (task.signal.aborted) return;
        let input: Record<string, unknown> | null = null;
        try {
          const v = c.args.trim() ? JSON.parse(c.args) : {};
          if (v && typeof v === "object" && !Array.isArray(v)) input = v;
        } catch (_) { /* reported below */ }
        emit("tool", { id: c.id, tool: c.name, detail: toolDetail(input, task.cwd), input: input || c.args });
        const result = input ? await tools.call(c.name, input) :
          { content: "The tool's arguments weren't a JSON object: " + c.args.slice(0, 200), error: true };
        emit("tool_result", { id: c.id, content: toolOutput(result.content), error: !!result.error });
        messages.push({ role: "tool", tool_call_id: c.id, content: result.content });
      }
    }
  }

  return {
    checkModel: m => (typeof m === "string" && m.trim() && m.length <= 200 && !/[\s\u0000-\u001f]/.test(m) ? undefined : "Enter a model name."),
    async run(task, emit) {
      try {
        await run(task, emit);
      } catch (e) {
        if (!task.signal.aborted) emit("error", { code: "upstream_error", message: String((e as Error)?.message || e) });
      }
    },
  };
}
