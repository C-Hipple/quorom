const Providers = (function (Core) {
  "use strict";

  // Every provider answers the same way: resolve { text, truncated, served }, or reject { code, message, text? }
  // with one of Quorum's error codes. `served` names the model or tier that actually answered.

  function joinUrl(base, path) {
    return String(base || "").trim().replace(/\/+$/, "") + "/" + path;
  }

  function authHeaders(key) {
    return key ? { Authorization: "Bearer " + key } : {};
  }

  // Feeds a streamed response body to an SSE parser until finished() says so or the stream ends.
  async function readStream(res, parser, finished) {
    const reader = res.body.getReader();
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
  async function streamChat(req) {
    const signal = req.signal;
    let res;
    try {
      res = await fetch(req.url, {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders(req.key), req.headers || {}),
        body: JSON.stringify({ model: req.model, messages: [{ role: "user", content: req.prompt }], stream: true }),
        signal,
      });
    } catch (e) {
      if (signal && signal.aborted) throw { code: "cancelled", message: "Stopped." };
      throw { code: "unreachable", message: String((e && e.message) || e) };
    }
    if (!res.ok) {
      let body = "";
      try { body = await res.text(); } catch (_) { /* no body */ }
      const detail = Core.errorMessageFrom(body);
      throw { code: Core.httpErrorCode(res.status, detail), message: detail, status: res.status };
    }

    let raw = "", finish = null, served = req.model, failure = null, done = false;
    const onData = data => {
      if (data === "[DONE]") { done = true; return; }
      let obj;
      try { obj = JSON.parse(data); } catch (_) { return; }
      if (obj && obj.error) { failure = obj.error; done = true; return; }
      if (obj && typeof obj.model === "string" && obj.model) served = obj.model;
      const choice = obj && obj.choices && obj.choices[0];
      if (!choice) return;
      const piece = choice.delta && typeof choice.delta.content === "string" ? choice.delta.content :
        choice.message && typeof choice.message.content === "string" ? choice.message.content : "";
      if (piece) {
        raw += piece;
        const visible = Core.stripThinking(raw);
        if (visible.trim() && req.onText) req.onText(visible);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
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
          return;
        }
        onData(ev.data);
      });
      try {
        await readStream(res, parser, () => done);
      } catch (e) {
        const text = Core.stripThinking(raw);
        if (signal && signal.aborted) throw { code: "cancelled", message: "Stopped.", text };
        throw { code: "upstream_error", message: String((e && e.message) || e), text };
      }
    }

    const text = Core.stripThinking(raw).replace(/\s+$/, "");
    if (failure) throw { code: Core.streamErrorCode(failure), message: failure.message || "", text };
    if (finish === "error") throw { code: "upstream_error", message: "The answer stopped with an error.", text };
    if (!text.trim()) throw { code: "empty_completion", message: "The answer was empty." };
    return { text, truncated: finish === "length", served };
  }

  // One seat on Claude Code, which Quorum's local server (serve.js) runs inside the project folder. The server
  // streams events: start {model}, turn {} when a new message begins, text {delta}, tool {tool, detail},
  // and finally done {text, truncated, model} or error {code, message}.
  async function claudeCode(req) {
    const signal = req.signal;
    let res;
    try {
      res = await fetch(req.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: req.prompt, model: req.model || "", cwd: req.cwd }),
        signal,
      });
    } catch (e) {
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

    let text = "", served = req.model, final = null, failure = null;
    const parser = Core.createSSEParser(ev => {
      if (final || failure) return;
      let d;
      try { d = JSON.parse(ev.data); } catch (_) { return; }
      if (!d || typeof d !== "object") return;
      if (ev.event === "start" && typeof d.model === "string" && d.model) served = d.model;
      else if (ev.event === "turn") text = "";
      else if (ev.event === "text" && typeof d.delta === "string") {
        text += d.delta;
        if (text.trim() && req.onText) req.onText(text);
      } else if (ev.event === "tool" && req.onActivity) req.onActivity("tool", ev.data);
      else if (ev.event === "done") final = d;
      else if (ev.event === "error") failure = d;
    });
    try {
      await readStream(res, parser, () => !!(final || failure));
    } catch (e) {
      if (signal && signal.aborted) throw { code: "cancelled", message: "Stopped.", text };
      throw { code: "upstream_error", message: String((e && e.message) || e), text };
    }
    if (failure) throw { code: typeof failure.code === "string" ? failure.code : "upstream_error", message: String(failure.message || ""), text };
    if (!final) throw { code: "upstream_error", message: "Claude Code stopped before it finished.", text };
    const out = String(final.text || text).replace(/\s+$/, "");
    if (!out.trim()) throw { code: "empty_completion", message: "The answer was empty." };
    return { text: out, truncated: !!final.truncated, served: final.model || served };
  }

  function openRouterHeaders() {
    const h = { "X-Title": "Quorum" };
    if (typeof location !== "undefined" && /^https?:$/.test(location.protocol)) h["HTTP-Referer"] = location.origin;
    return h;
  }

  // run(agent, prompt, { config, sample, cwd, signal, onText, onActivity })
  //   config: { keys: {openrouter, hermes, custom}, urls: {hermes, custom}, local }, where local is the address of
  //   Quorum's local server; cwd is the project folder for agents that run inside it
  async function run(agent, prompt, o) {
    const cfg = o.config || { keys: {}, urls: {} };
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
          signal: o.signal, onText: o.onText, onActivity: o.onActivity,
        });
      case "openrouter":
        if (!cfg.keys.openrouter) throw { code: "missing_key", message: "No OpenRouter API key." };
        return streamChat({
          url: "https://openrouter.ai/api/v1/chat/completions",
          key: cfg.keys.openrouter, model: agent.model, prompt, headers: openRouterHeaders(),
          signal: o.signal, onText: o.onText, onActivity: o.onActivity,
        });
      case "hermes":
        if (!cfg.keys.hermes) throw { code: "missing_key", message: "No Hermes Agent API key." };
        return streamChat({
          url: joinUrl(cfg.urls.hermes || Core.PROVIDERS.hermes.defaultUrl, "chat/completions"),
          key: cfg.keys.hermes, model: agent.model || "hermes-agent", prompt,
          signal: o.signal, onText: o.onText, onActivity: o.onActivity,
        });
      case "custom":
        if (!cfg.urls.custom) throw { code: "not_found", message: "No address for the endpoint." };
        return streamChat({
          url: joinUrl(cfg.urls.custom, "chat/completions"),
          key: cfg.keys.custom, model: agent.model, prompt,
          signal: o.signal, onText: o.onText, onActivity: o.onActivity,
        });
      default:
        throw { code: "bad_request", message: "Unknown provider." };
    }
  }

  // The models an endpoint offers, for the model pickers. Resolves [{ id, name }].
  async function listModels(provider, cfg) {
    const url = provider === "openrouter" ? "https://openrouter.ai/api/v1/models" :
      joinUrl(provider === "hermes" ? (cfg.urls.hermes || Core.PROVIDERS.hermes.defaultUrl) : cfg.urls.custom, "models");
    const key = provider === "openrouter" ? "" : cfg.keys[provider];
    let res;
    try {
      res = await fetch(url, { headers: authHeaders(key) });
    } catch (e) {
      throw { code: "unreachable", message: String((e && e.message) || e) };
    }
    const body = await res.text();
    if (!res.ok) {
      const detail = Core.errorMessageFrom(body);
      throw { code: Core.httpErrorCode(res.status, detail), message: detail, status: res.status };
    }
    let data;
    try { data = JSON.parse(body); } catch (_) { throw { code: "bad_request", message: "The model list wasn't JSON." }; }
    const list = Array.isArray(data) ? data : Array.isArray(data && data.data) ? data.data : [];
    return list
      .filter(m => m && typeof m.id === "string")
      .map(m => ({ id: m.id, name: typeof m.name === "string" ? m.name : "" }));
  }

  return { run, listModels, streamChat, joinUrl };
})(Core);
