// The Claude Code harness: each run is a headless `claude -p` in the project folder, with only its tools for reading
// and searching files. It can't edit, run commands or use MCP servers, it ignores the project's own settings and
// hooks, and anything that would need permission is denied.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { toolDetail, toolOutput, type AgentEvent, type Harness, type Usage } from "./harness";

export const TOOLS = "Read,Grep,Glob";

export type Env = Record<string, string | undefined>;

// How to run Claude Code: a command and the arguments that come before Quorum's own.
export interface ClaudeCommand {
  command: string;
  args: string[];
}

// Claude Code's stream-json messages are read loosely: only the fields the translator checks are relied on.
type Json = Record<string, any>;

export function claudeArgs(model?: string): string[] {
  const args = [
    "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--tools", TOOLS, "--permission-mode", "dontAsk",
    "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence",
  ];
  if (model) args.push("--model", model);
  return args;
}

// Model names and aliases only, so a model can't be read as another flag.
export function validModel(m: unknown): boolean {
  return m === "" || (typeof m === "string" && m.length <= 100 && /^[A-Za-z0-9][\w.:[\]-]*$/.test(m));
}

function findOnPath(name: string, env: Env): string | null {
  const exts = process.platform === "win32" ? String(env.PATHEXT || ".EXE").split(";") : [""];
  for (const dir of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        if (fs.statSync(file).isFile()) return file;
      } catch (_) { /* not here */ }
    }
  }
  return null;
}

// Claude Code's errors as Quorum's error codes.
export function errorCode(status: number, kind: string, message: string): string {
  const s = String(kind || "") + " " + String(message || "");
  if (/model_not_found|unrecognized_model/i.test(s) || (status === 404 && /model/i.test(s))) return "bad_model";
  if (status === 401 || status === 403 || /authentication|not logged in|\/login|invalid api key/i.test(s)) return "auth_failed";
  if (status === 402 || /billing|credit balance/i.test(s)) return "no_credits";
  if (status === 429 || status === 529 || /rate_limit|rate limit|usage limit|overloaded/i.test(s)) return "rate_limited";
  if (status === 413 || /prompt is too long|context window/i.test(s)) return "prompt_too_large";
  return "upstream_error";
}

// How long a run took and what it used, from Claude Code's result: any of turns, costUsd, durationMs, inputTokens
// (including tokens read from and written to the cache) and outputTokens, or null if it said none of them.
function usageOf(m: Json): Usage | null {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const u: Json = m.usage && typeof m.usage === "object" ? m.usage : {};
  const inputs = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].map(k => n(u[k])).filter(v => v !== null);
  const all = { turns: n(m.num_turns), costUsd: n(m.total_cost_usd), durationMs: n(m.duration_ms),
    inputTokens: inputs.length ? inputs.reduce((a, b) => a + b, 0) : null, outputTokens: n(u.output_tokens) };
  const out: Usage = {};
  (Object.keys(all) as (keyof Usage)[]).forEach(k => { const v = all[k]; if (v !== null) out[k] = v; });
  return Object.keys(out).length ? out : null;
}

// Turns Claude Code's stream-json messages into the harness events (see harness.ts). What the run has used so far is
// counted from each message as it streams; its result gives the final count.
export function createTranslator(emit: (event: AgentEvent, data: Json) => void, cwd: string) {
  let model = "", failure = "", finished = false;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const live = { turns: 0, inputTokens: 0, outputTokens: 0, before: 0 };
  const used = () => emit("usage", { turns: live.turns, inputTokens: live.inputTokens, outputTokens: live.outputTokens });
  return {
    feed(m: Json) {
      if (finished || !m || typeof m !== "object" || m.parent_tool_use_id) return;
      if (m.type === "system" && m.subtype === "init") {
        model = typeof m.model === "string" ? m.model : "";
        emit("start", { model, tools: Array.isArray(m.tools) ? m.tools.filter((t: unknown) => typeof t === "string") : [] });
      } else if (m.type === "stream_event" && m.event) {
        const e = m.event;
        if (e.type === "message_start") {
          emit("turn", {});
          const u = e.message && e.message.usage;
          if (u && typeof u === "object") {
            live.turns += 1;
            live.inputTokens += n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
            live.before = live.outputTokens;
            live.outputTokens = live.before + n(u.output_tokens);
            used();
          }
        } else if (e.type === "message_delta" && e.usage && typeof e.usage.output_tokens === "number") {
          live.outputTokens = live.before + e.usage.output_tokens;
          used();
        } else if (e.type === "content_block_delta" && e.delta && e.delta.type === "text_delta" && e.delta.text) emit("text", { delta: e.delta.text });
      } else if (m.type === "assistant" && m.message) {
        if (m.error) failure = String(m.error);
        (m.message.content || []).forEach((c: Json) => {
          if (!c) return;
          if (c.type === "tool_use") {
            emit("tool", { id: String(c.id || ""), tool: String(c.name || ""), detail: toolDetail(c.input, cwd), input: c.input === undefined ? null : c.input });
          } else if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
            emit("block", { type: "text", text: c.text });
          } else if (c.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim()) {
            emit("block", { type: "thinking", text: c.thinking });
          }
        });
      } else if (m.type === "user" && m.message && Array.isArray(m.message.content)) {
        m.message.content.forEach((c: Json) => {
          if (c && c.type === "tool_result") emit("tool_result", { id: String(c.tool_use_id || ""), content: toolOutput(c.content), error: !!c.is_error });
        });
      } else if (m.type === "result") {
        finished = true;
        const usage = usageOf(m), used = usage ? { usage } : {};
        if (m.is_error || m.subtype !== "success") {
          const message = String(m.result || (Array.isArray(m.errors) && m.errors[0]) || m.subtype || "");
          emit("error", Object.assign({ code: errorCode(m.api_error_status, failure || m.subtype, message), message }, used));
        } else {
          emit("done", Object.assign({ text: String(m.result || ""), truncated: m.stop_reason === "max_tokens", model }, used));
        }
      }
    },
    finished: () => finished,
  };
}

// o.claude   { command, args } to run Claude Code with, or null to look for `claude` on the PATH
// o.env      the environment for Claude Code, process.env by default
export function createClaudeCode(o: { claude?: ClaudeCommand | null, env?: Env }) {
  const env = o.env || process.env;
  let claude = o.claude || null;
  let version: string | null = null;

  function locate(): ClaudeCommand | null {
    if (claude) return claude;
    const bin = env.QUORUM_CLAUDE_BIN || findOnPath("claude", env);
    if (bin) claude = { command: bin, args: [] };
    return claude;
  }

  // The installed version, or null if Claude Code isn't installed.
  function claudeVersion(): Promise<string | null> {
    const c = locate();
    if (!c) return Promise.resolve(null);
    if (version) return Promise.resolve(version);
    return new Promise(resolve => {
      execFile(c.command, c.args.concat(["--version"]), { timeout: 15000, env }, (err, stdout) => {
        const v = err ? null : (String(stdout).trim().split(/\s+/)[0] || "unknown");
        if (v) version = v;
        resolve(v);
      });
    });
  }

  const harness: Harness = {
    checkModel: m => (validModel(m) ? undefined : "That isn't a model name Claude Code accepts."),
    run(task, emit) {
      const c = locate();
      if (!c) {
        emit("error", { code: "claude_code_missing", message: "Claude Code isn't installed, or isn't on the PATH." });
        return Promise.resolve();
      }
      return new Promise(resolve => {
        const child = spawn(c.command, c.args.concat(claudeArgs(task.model)), { cwd: task.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
        let ended = false, buf = "", stderr = "";
        // Once the page has its answer, or has stopped the seat, Claude Code is stopped if it's still running.
        const stop = () => {
          ended = true;
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill("SIGTERM");
          setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 3000).unref();
        };
        const end = (event: AgentEvent, data: Json) => {
          if (ended) return;
          emit(event, data);
          stop();
          resolve();
        };
        task.signal.addEventListener("abort", () => { stop(); resolve(); });
        const tr = createTranslator((event, data) => (event === "done" || event === "error" ? end(event, data) : !ended && emit(event, data)), task.cwd);
        const feedLine = (line: string) => {
          if (!line.trim()) return;
          let m;
          try { m = JSON.parse(line); } catch (_) { return; }
          tr.feed(m);
        };
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            feedLine(buf.slice(0, i));
            buf = buf.slice(i + 1);
          }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (s: string) => { stderr = (stderr + s).slice(-4000); });
        child.on("error", (e: NodeJS.ErrnoException) => {
          end("error", e && e.code === "ENOENT" ?
            { code: "claude_code_missing", message: "Claude Code isn't installed, or isn't on the PATH." } :
            { code: "upstream_error", message: String((e && e.message) || e) });
        });
        child.on("close", code => {
          feedLine(buf);
          buf = "";
          const last = stderr.trim().split("\n").pop() || "";
          end("error", { code: errorCode(0, "", stderr), message: last || "Claude Code stopped without an answer (exit code " + code + ")." });
        });
        child.stdin.on("error", () => { /* Claude Code exited before reading the prompt; close reports it */ });
        child.stdin.end(task.prompt);
      });
    },
  };

  return { harness, locate, claudeVersion };
}
