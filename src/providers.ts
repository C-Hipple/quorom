import { Core, type Agent, type SSEParser } from "./core";

export interface ProviderResult {
  text: string;
  truncated: boolean;
  served: string;
}

// Where the providers are and how to sign in to them. local is the address of Quorum's local server.
export interface ProviderConfig {
  keys: Record<string, string>;
  urls: Record<string, string>;
  local?: string;
}

export type TraceKind = "start" | "text" | "thinking" | "tool" | "tool_result" | "event" | "usage";
export type OnTrace = (kind: TraceKind, data: Record<string, any>) => void;

// Claude through the artifact runtime: the sample capability claude.ai gives the page.
export type SampleFn = (prompt: string, o: {
  modelTier: string,
  cache: boolean,
  signal?: AbortSignal,
  onText?: (u: { text: string }) => void,
}) => Promise<{ text?: string, truncated?: boolean, modelTierApplied?: string }>;

export interface RunOptions {
  config?: ProviderConfig;
  sample?: SampleFn | null;
  cwd?: string;
  signal?: AbortSignal;
  onText?: (text: string) => void;
  onActivity?: (event: string, data: string) => void;
  onTrace?: OnTrace;
}

interface StreamRequest {
  url: string;
  key?: string;
  model: string;
  prompt: string;
  headers?: Record<string, string>;
  cwd?: string;
  signal?: AbortSignal;
  onText?: (text: string) => void;
  onActivity?: (event: string, data: string) => void;
  onTrace?: OnTrace;
}

// Streamed JSON is read loosely: only the fields checked are relied on.
type Json = Record<string, any>;

export const Providers = (function (Core) {
  "use strict";

  // Every provider answers the same way: resolve { text, truncated, served }, or reject { code, message, text? }
  // with one of Quorum's error codes. `served` names the model or tier that actually answered.
  // Along the way, onTrace(kind, data) hears what goes into the step's conversation, where the provider shows it:
  //   start {model, tools}, text {text}, thinking {text}, tool {id, name, detail, input}, tool_result {id, content,
  //   error}, event {name, data} for anything else a provider streams, and usage {turns, costUsd, durationMs, ...}.

  function joinUrl(base: string | null | undefined, path: string): string {
    return String(base || "").trim().replace(/\/+$/, "") + "/" + path;
  }

  function authHeaders(key?: string): Record<string, string> {
    return key ? { Authorization: "Bearer " + key } : {};
  }

  // Feeds a streamed response body to an SSE parser until finished() says so or the stream ends.
  async function readStream(res: Response, parser: SSEParser, finished: () => boolean) {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      while (!finished()) {
        const step = await reader.read();
        if (step.done) break;
        parser.feed(decoder.decode(step.value, { stream: true }));
      }
      if (!finished()) parser.end();
    } finally {
      try { reader.cancel().catch(() => {}); } catch (_) { /* already closed */ }
    }
  }

  // One streamed chat completion from an OpenAI-compatible endpoint.
  async function streamChat(req: StreamRequest): Promise<ProviderResult> {
    const signal = req.signal;
    let res: Response;
    try {
      res = await fetch(req.url, {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders(req.key), req.headers || {}),
        body: JSON.stringify({ model: req.model, messages: [{ role: "user", content: req.prompt }], stream: true }),
        signal,
      });
    } catch (e: any) {
      if (signal && signal.aborted) throw { code: "cancelled", message: "Stopped." };
      throw { code: "unreachable", message: String((e && e.message) || e) };
    }
    if (!res.ok) {
      let body = "";
      try { body = await res.text(); } catch (_) { /* no body */ }
      const detail = Core.errorMessageFrom(body);
      throw { code: Core.httpErrorCode(res.status, detail), message: detail, status: res.status };
    }

    // Set as the stream is read, so their types are given rather than narrowed from their first values.
    let raw = "", reasoning = "", finish = null as string | null, served = req.model, failure = null as Json | null, done = false, traced = false;
    const onData = (data: string) => {
      if (data === "[DONE]") { done = true; return; }
      let obj;
      try { obj = JSON.parse(data); } catch (_) { return; }
      if (obj && obj.error) { failure = obj.error; done = true; return; }
      if (obj && typeof obj.model === "string" && obj.model) served = obj.model;
      const choice = obj && obj.choices && obj.choices[0];
      if (!choice) return;
      const piece = choice.delta && typeof choice.delta.content === "string" ? choice.delta.content :
        choice.message && typeof choice.message.content === "string" ? choice.message.content : "";
      // Reasoning models on OpenRouter send their reasoning apart from the answer, and some servers call it reasoning_content.
      const part = choice.delta || choice.message || {};
      const why = typeof part.reasoning === "string" ? part.reasoning : typeof part.reasoning_content === "string" ? part.reasoning_content : "";
      if (why) reasoning += why;
      if (piece) {
        raw += piece;
        const visible = Core.stripThinking(raw);
        if (visible.trim() && req.onText) req.onText(visible);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    };
    // The reasoning goes into the conversation once, when the answer is over or has failed.
    const trace = () => {
      if (traced) return;
      traced = true;
      const thinking = [reasoning.trim(), Core.thinkingOf(raw)].filter(Boolean).join("\n\n");
      if (thinking && req.onTrace) req.onTrace("thinking", { text: thinking });
    };

    const type = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
    if (!res.body || !res.body.getReader || /application\/json/i.test(type)) {
      // A server that ignored stream:true and answered all at once.
      const body = await res.text();
      onData(body);
    } else {
      const parser = Core.createSSEParser(ev => {
        if (done) return;
        if (ev.event !== "message") {
          if (req.onActivity) req.onActivity(ev.event, ev.data);
          if (req.onTrace) req.onTrace("event", { name: ev.event, data: ev.data });
          return;
        }
        onData(ev.data);
      });
      try {
        await readStream(res, parser, () => done);
      } catch (e: any) {
        const text = Core.stripThinking(raw);
        trace();
        if (signal && signal.aborted) throw { code: "cancelled", message: "Stopped.", text };
        throw { code: "upstream_error", message: String((e && e.message) || e), text };
      }
    }
    trace();

    const text = Core.stripThinking(raw).replace(/\s+$/, "");
    if (failure) throw { code: Core.streamErrorCode(failure), message: failure.message || "", text };
    if (finish === "error") throw { code: "upstream_error", message: "The answer stopped with an error.", text };
    if (!text.trim()) throw { code: "empty_completion", message: "The answer was empty." };
    return { text, truncated: finish === "length", served };
  }

  // One seat on Claude Code, which Quorum's local server (serve.ts) runs inside the project folder. The server
  // streams events: start {model, tools}, turn {} when a new message begins, text {delta}, block {type, text} once a
  // block of a message is written, tool {id, tool, detail, input} and tool_result {id, content, error}, and finally
  // done {text, truncated, model, usage} or error {code, message, usage}.
  async function claudeCode(req: StreamRequest): Promise<ProviderResult> {
    const signal = req.signal;
    let res: Response;
    try {
      res = await fetch(req.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: req.prompt, model: req.model || "", cwd: req.cwd }),
        signal,
      });
    } catch (e: any) {
      if (signal && signal.aborted) throw { code: "cancelled", message: "Stopped." };
      throw { code: "unreachable", message: String((e && e.message) || e) };
    }
    if (!res.ok) {
      let body = "", code = "";
      try { body = await res.text(); } catch (_) { /* no body */ }
      try { code = JSON.parse(body).error.code; } catch (_) { /* not the server's own error */ }
      const detail = Core.errorMessageFrom(body);
      throw { code: typeof code === "string" && code ? code : Core.httpErrorCode(res.status, detail), message: detail, status: res.status };
    }

    let text = "", served = req.model, final = null as Json | null, failure = null as Json | null;
    const trace: OnTrace = (kind, data) => { if (req.onTrace) req.onTrace(kind, data); };
    const parser = Core.createSSEParser(ev => {
      if (final || failure) return;
      let d;
      try { d = JSON.parse(ev.data); } catch (_) { return; }
      if (!d || typeof d !== "object") return;
      if (ev.event === "start") {
        if (typeof d.model === "string" && d.model) served = d.model;
        trace("start", { model: served, tools: d.tools });
      } else if (ev.event === "turn") text = "";
      else if (ev.event === "text" && typeof d.delta === "string") {
        text += d.delta;
        if (text.trim() && req.onText) req.onText(text);
      } else if (ev.event === "block" && typeof d.text === "string") {
        trace(d.type === "thinking" ? "thinking" : "text", { text: d.text });
      } else if (ev.event === "tool") {
        if (req.onActivity) req.onActivity("tool", ev.data);
        trace("tool", { id: d.id, name: d.tool, detail: d.detail, input: d.input });
      } else if (ev.event === "tool_result") trace("tool_result", { id: d.id, content: d.content, error: d.error });
      else if (ev.event === "done") final = d;
      else if (ev.event === "error") failure = d;
      if ((final || failure) && d.usage) trace("usage", d.usage);
    });
    try {
      await readStream(res, parser, () => !!(final || failure));
    } catch (e: any) {
      if (signal && signal.aborted) throw { code: "cancelled", message: "Stopped.", text };
      throw { code: "upstream_error", message: String((e && e.message) || e), text };
    }
    if (failure) throw { code: typeof failure.code === "string" ? failure.code : "upstream_error", message: String(failure.message || ""), text };
    if (!final) throw { code: "upstream_error", message: "Claude Code stopped before it finished.", text };
    const out = String(final.text || text).replace(/\s+$/, "");
    if (!out.trim()) throw { code: "empty_completion", message: "The answer was empty." };
    return { text: out, truncated: !!final.truncated, served: final.model || served };
  }

  function openRouterHeaders(): Record<string, string> {
    const h: Record<string, string> = { "X-Title": "Quorum" };
    if (typeof location !== "undefined" && /^https?:$/.test(location.protocol)) h["HTTP-Referer"] = location.origin;
    return h;
  }

  // run(agent, prompt, { config, sample, cwd, signal, onText, onActivity, onTrace })
  //   config: { keys: {openrouter, hermes, custom}, urls: {hermes, custom}, local }, where local is the address of
  //   Quorum's local server; cwd is the project folder for agents that run inside it
  async function run(agent: Agent, prompt: string, o: RunOptions): Promise<ProviderResult> {
    const cfg: ProviderConfig = o.config || { keys: {}, urls: {} };
    switch (agent.provider) {
      case "claude": {
        if (typeof o.sample !== "function") throw { code: "claude_unavailable", message: "Claude isn't available here." };
        const res = await o.sample(prompt, {
          modelTier: agent.model,
          cache: false,
          signal: o.signal,
          onText: u => { if (o.onText) o.onText(u.text); },
        });
        return { text: String(res.text || ""), truncated: !!res.truncated, served: res.modelTierApplied || agent.model };
      }
      case "claude-code":
        if (!cfg.local) throw { code: "unreachable", message: "Quorum's local server isn't running." };
        if (!o.cwd) throw { code: "project_missing", message: "No project folder." };
        return claudeCode({
          url: joinUrl(cfg.local, "api/claude-code"), model: agent.model, prompt, cwd: o.cwd,
          signal: o.signal, onText: o.onText, onActivity: o.onActivity, onTrace: o.onTrace,
        });
      case "openrouter":
        if (!cfg.keys.openrouter) throw { code: "missing_key", message: "No OpenRouter API key." };
        return streamChat({
          url: "https://openrouter.ai/api/v1/chat/completions",
          key: cfg.keys.openrouter, model: agent.model, prompt, headers: openRouterHeaders(),
          signal: o.signal, onText: o.onText, onActivity: o.onActivity, onTrace: o.onTrace,
        });
      case "hermes":
        if (!cfg.keys.hermes) throw { code: "missing_key", message: "No Hermes Agent API key." };
        return streamChat({
          url: joinUrl(cfg.urls.hermes || Core.PROVIDERS.hermes.defaultUrl, "chat/completions"),
          key: cfg.keys.hermes, model: agent.model || "hermes-agent", prompt,
          signal: o.signal, onText: o.onText, onActivity: o.onActivity, onTrace: o.onTrace,
        });
      case "custom":
        if (!cfg.urls.custom) throw { code: "not_found", message: "No address for the endpoint." };
        return streamChat({
          url: joinUrl(cfg.urls.custom, "chat/completions"),
          key: cfg.keys.custom, model: agent.model, prompt,
          signal: o.signal, onText: o.onText, onActivity: o.onActivity, onTrace: o.onTrace,
        });
      default:
        throw { code: "bad_request", message: "Unknown provider." };
    }
  }

  // The models an endpoint offers, for the model pickers. Resolves [{ id, name }].
  async function listModels(provider: string, cfg: ProviderConfig): Promise<{ id: string, name: string }[]> {
    const url = provider === "openrouter" ? "https://openrouter.ai/api/v1/models" :
      joinUrl(provider === "hermes" ? (cfg.urls.hermes || Core.PROVIDERS.hermes.defaultUrl) : cfg.urls.custom, "models");
    const key = provider === "openrouter" ? "" : cfg.keys[provider];
    let res: Response;
    try {
      res = await fetch(url, { headers: authHeaders(key) });
    } catch (e: any) {
      throw { code: "unreachable", message: String((e && e.message) || e) };
    }
    const body = await res.text();
    if (!res.ok) {
      const detail = Core.errorMessageFrom(body);
      throw { code: Core.httpErrorCode(res.status, detail), message: detail, status: res.status };
    }
    let data;
    try { data = JSON.parse(body); } catch (_) { throw { code: "bad_request", message: "The model list wasn't JSON." }; }
    const list: Json[] = Array.isArray(data) ? data : Array.isArray(data && data.data) ? data.data : [];
    return list
      .filter(m => m && typeof m.id === "string")
      .map(m => ({ id: m.id, name: typeof m.name === "string" ? m.name : "" }));
  }

  return { run, listModels, streamChat, joinUrl };
})(Core);
