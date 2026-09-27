// Serves dist/ on this computer only, so the page has a fixed address that Hermes Agent and other local services can
// allow in their CORS settings, and runs the local bridge that lets the page attach a project folder, use Claude Code
// and save sessions. `bun serve.ts [project folder]` starts with that folder attached. Sessions are saved in
// ~/.quorum/quorum.db, or the file QUORUM_DB names.
import path from "node:path";
import type { Server } from "bun";
import { createBridge, folderInfo, type Bridge, type ClaudeCommand, type Env } from "./bridge";
import { defaultFile, openSessions, type Sessions } from "./sessions";

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// The bridge reads folders and runs Claude Code, so it answers only the page itself: the Host must be this server,
// which stops DNS rebinding, and a browser's Origin must be too, which stops other sites from using it.
export function sameSite(req: Request, port: number): boolean {
  const hosts = ["localhost:" + port, "127.0.0.1:" + port, "[::1]:" + port];
  if (hosts.indexOf(req.headers.get("host") || "") < 0) return false;
  const origin = req.headers.get("origin");
  return !origin || hosts.some(h => origin === "http://" + h);
}

// o.root      the folder to serve, dist/ by default
// o.project   a project folder to start with
// o.claude    { command, args } for Claude Code, found on the PATH by default
// o.db        the database file to save sessions in; without one, sessions aren't saved
// o.port      the port to listen on, where 0 picks a free one; 8765 by default
export interface ServerOptions {
  root?: string;
  project?: string | null;
  claude?: ClaudeCommand | null;
  env?: Env;
  db?: string | null;
  port?: number;
}

export interface QuorumServer {
  server: Server<undefined>;
  port: number;
  bridge: Bridge;
  sessions: Sessions | null;
  // Stops listening, ends any open requests and closes the database.
  stop(): Promise<void>;
}

// Starts serving on 127.0.0.1.
export function startServer(o?: ServerOptions): QuorumServer {
  const opts = o || {};
  const root = opts.root || path.join(import.meta.dir, "dist");
  const sessions = opts.db ? openSessions(opts.db) : null;
  const bridge = createBridge({ project: opts.project, claude: opts.claude, env: opts.env, sessions });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 8765,
    // Claude Code can think for minutes without writing anything, so a quiet request isn't closed.
    idleTimeout: 0,
    development: false,
    async fetch(req, srv) {
      let url, pathname;
      try {
        url = new URL(req.url);
        pathname = decodeURIComponent(url.pathname);
      } catch (_) {
        return new Response(null, { status: 400 });
      }
      if (pathname.startsWith("/api/")) {
        if (!sameSite(req, srv.port as number)) {
          return new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        }
        return bridge.handle(req, url);
      }
      let rel = pathname;
      if (rel.endsWith("/")) rel += "quorum.html";
      const file = path.join(root, path.normalize(rel));
      if (!file.startsWith(root + path.sep)) return new Response(null, { status: 403 });
      const f = Bun.file(file);
      if (!(await f.exists())) {
        return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      return new Response(f, { headers: { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" } });
    },
    error(e) {
      console.error(e);
      return new Response(null, { status: 500 });
    },
  });
  return {
    server, port: server.port as number, bridge, sessions,
    async stop() {
      await server.stop(true);
      if (sessions) sessions.close();
    },
  };
}

if (import.meta.main) {
  const arg = process.argv[2];
  let project = null;
  if (arg) {
    const info = folderInfo(arg);
    if (info) project = info.path;
    else console.warn("There's no folder at " + arg + ", so Quorum starts without a project.");
  }
  const quorum = startServer({ project, db: defaultFile(process.env), port: Number(process.env.PORT) || 8765 });
  console.log("Quorum is running at http://localhost:" + quorum.port + "/");
  if (project) console.log("Project: " + project);
  if (quorum.sessions) console.log("Sessions are saved in " + quorum.sessions.file + ".");
  const v = await quorum.bridge.claudeVersion();
  console.log(v ? "Claude Code " + v + " is available to the agents." :
    "Claude Code wasn't found, so it isn't offered. Install it, or set QUORUM_CLAUDE_BIN to its path.");
}
