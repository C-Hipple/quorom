// Serves dist/ on this computer only, so the page has a fixed address that Hermes Agent and other local services can
// allow in their CORS settings, and runs the local bridge that lets the page attach a project folder, use Claude Code
// and save sessions. `node serve.js [project folder]` starts with that folder attached. Sessions are saved in
// ~/.quorum/quorum.db, or the file QUORUM_DB names.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { createBridge, folderInfo } = require("./bridge");
const { openSessions, defaultFile } = require("./sessions");

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// The bridge reads folders and runs Claude Code, so it answers only the page itself: the Host must be this server,
// which stops DNS rebinding, and a browser's Origin must be too, which stops other sites from using it.
function sameSite(req, port) {
  const hosts = ["localhost:" + port, "127.0.0.1:" + port, "[::1]:" + port];
  if (hosts.indexOf(String(req.headers.host || "")) < 0) return false;
  const origin = req.headers.origin;
  return !origin || hosts.some(h => origin === "http://" + h);
}

// o.root      the folder to serve, dist/ by default
// o.project   a project folder to start with
// o.claude    { command, args } for Claude Code, found on the PATH by default
// o.db        the database file to save sessions in; without one, sessions aren't saved
function createServer(o) {
  const opts = o || {};
  const root = opts.root || path.join(__dirname, "dist");
  const sessions = opts.db ? openSessions(opts.db) : null;
  const bridge = createBridge({ project: opts.project, claude: opts.claude, env: opts.env, sessions });
  const server = http.createServer((req, res) => {
    let url, pathname;
    try {
      url = new URL(req.url, "http://localhost");
      pathname = decodeURIComponent(url.pathname);
    } catch (_) {
      res.writeHead(400);
      return res.end();
    }
    if (pathname.startsWith("/api/")) {
      if (!sameSite(req, server.address().port)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Forbidden");
      }
      return bridge.handle(req, res, url).catch(e => {
        console.error(e);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    }
    let rel = pathname;
    if (rel.endsWith("/")) rel += "quorum.html";
    const file = path.join(root, path.normalize(rel));
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Not found");
      }
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(data);
    });
  });
  server.bridge = bridge;
  server.sessions = sessions;
  server.on("close", () => { if (sessions) sessions.close(); });
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8765;
  const arg = process.argv[2];
  let project = null;
  if (arg) {
    const info = folderInfo(arg);
    if (info) project = info.path;
    else console.warn("There's no folder at " + arg + ", so Quorum starts without a project.");
  }
  const server = createServer({ project, db: defaultFile(process.env) });
  server.listen(port, "127.0.0.1", async () => {
    console.log("Quorum is running at http://localhost:" + port + "/");
    if (project) console.log("Project: " + project);
    console.log(server.sessions ? "Sessions are saved in " + server.sessions.file + "." :
      "Sessions aren't saved, because this Node.js has no SQLite. Use Node.js 22.13 or later.");
    const v = await server.bridge.claudeVersion();
    console.log(v ? "Claude Code " + v + " is available to the agents." :
      "Claude Code wasn't found, so it isn't offered. Install it, or set QUORUM_CLAUDE_BIN to its path.");
  });
}

module.exports = { createServer, sameSite };
