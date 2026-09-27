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
        const text = Core.stripThinking(raw);
        if (signal && signal.aborted) throw { code: "cancelled", message: "Stopped.", text };
        throw { code: "upstream_error", message: String((e && e.message) || e), text };
      } finally {
        try { reader.cancel().catch(() => {}); } catch (_) { /* already closed */ }
      }
    }

    const text = Core.stripThinking(raw).replace(/\s+$/, "");
    if (failure) throw { code: Core.streamErrorCode(failure), message: failure.message || "", text };
    if (finish === "error") throw { code: "upstream_error", message: "The answer stopped with an error.", text };
    if (!text.trim()) throw { code: "empty_completion", message: "The answer was empty." };
    return { text, truncated: finish === "length", served };
  }

  function openRouterHeaders() {
    const h = { "X-Title": "Quorum" };
    if (typeof location !== "undefined" && /^https?:$/.test(location.protocol)) h["HTTP-Referer"] = location.origin;
    return h;
  }

  // run(agent, prompt, { config, sample, signal, onText, onActivity })
  //   config: { keys: {openrouter, hermes, custom}, urls: {hermes, custom} }
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
