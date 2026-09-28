// Stands in for OpenRouter and other OpenAI-compatible services in the tests. Each chat completion is answered by the
// test's reply function, streamed the way these services stream: text a few characters at a time, and each tool call's
// arguments in pieces, so the agent loop has to put them back together.
import { nameAnswer, seatAnswer } from "./seat-answers";

export interface FakeRequest {
  path: string;
  headers: Headers;
  body: any;
}

export interface FakeReply {
  // Answers with this status and body instead of a completion.
  status?: number;
  error?: unknown;
  text?: string;
  reasoning?: string;
  tools?: { name: string, input: unknown, id?: string }[];
  // Sent after the text, as the error some services stream when they fail part-way.
  streamError?: { code: unknown, message: string };
  finish?: string;
  model?: string;
  usage?: Record<string, number>;
  // Milliseconds between chunks.
  wait?: number;
  // Starts answering and never finishes.
  hang?: boolean;
}

export interface FakeService {
  url: string;
  requests: FakeRequest[];
  // Requests the client closed before the answer ended.
  aborted: number;
  stop(): Promise<void>;
}

export function fakeOpenAI(reply: (req: FakeRequest, n: number) => FakeReply | Promise<FakeReply>): FakeService {
  const requests: FakeRequest[] = [];
  const service: FakeService = { url: "", requests, aborted: 0, stop: async () => {} };
  const enc = new TextEncoder();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "glm-test", object: "model" }, { id: "other-model", name: "Other" }] });
      }
      const body = await req.json();
      const r: FakeRequest = { path, headers: req.headers, body };
      requests.push(r);
      const out = await reply(r, requests.length);
      if (out.status) return Response.json(out.error ?? { error: { message: "failed" } }, { status: out.status });
      const model = out.model || body.model;
      const frames: unknown[] = [];
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        frames.push({ id: "gen", model, choices: [{ index: 0, delta, finish_reason: finish }] });
      (out.reasoning || "").match(/[\s\S]{1,12}/g)?.forEach(p => chunk({ reasoning: p }));
      (out.text || "").match(/[\s\S]{1,20}/g)?.forEach(p => chunk({ content: p }));
      (out.tools || []).forEach((t, i) => {
        const args = JSON.stringify(t.input);
        chunk({ tool_calls: [{ index: i, id: t.id || "call_" + requests.length + "_" + i, type: "function", function: { name: t.name, arguments: "" } }] });
        (args.match(/[\s\S]{1,7}/g) || []).forEach(p => chunk({ tool_calls: [{ index: i, function: { arguments: p } }] }));
      });
      if (out.streamError) frames.push({ error: out.streamError });
      else {
        chunk({}, out.finish || (out.tools && out.tools.length ? "tool_calls" : "stop"));
        frames.push({ id: "gen", model, choices: [], usage: out.usage || { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 } });
      }
      let timer: ReturnType<typeof setTimeout> | undefined, closed = false;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          let i = 0;
          const push = () => {
            if (closed) return;
            if (i < frames.length) c.enqueue(enc.encode("data: " + JSON.stringify(frames[i++]) + "\n\n"));
            else if (!out.hang) {
              if (!out.streamError) c.enqueue(enc.encode("data: [DONE]\n\n"));
              closed = true;
              c.close();
              return;
            }
            timer = setTimeout(push, out.wait ?? 1);
          };
          c.enqueue(enc.encode(": OPENROUTER PROCESSING\n\n"));
          push();
        },
        cancel() {
          closed = true;
          clearTimeout(timer);
          service.aborted++;
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  service.url = "http://127.0.0.1:" + server.port + "/v1";
  service.stop = async () => { await server.stop(true); };
  return service;
}

// An agent for any of Quorum's seats: it first reads src/app.js, then answers as its seat, saying where it ran. The
// project folder is read from what the agent loop tells the model. A session is named at once, without tools.
export function seatAgent(req: FakeRequest): FakeReply {
  const messages: { role: string, content: string }[] = req.body.messages;
  const prompt = (messages.find(m => m.role === "user") || { content: "" }).content;
  const where = (/folder, (\S+)\. You have/.exec(messages[0].content) || [])[1] || "";
  const name = nameAnswer(prompt);
  if (name) return { text: name };
  if (!messages.some(m => m.role === "tool")) {
    return { text: "Let me look first.", reasoning: "I should read the app first.", tools: [{ name: "Read", input: { file_path: "src/app.js" } }] };
  }
  return { text: seatAnswer(prompt, where) || "# Fake answer" };
}
