// Serves dist/ on this computer only, so the page has a fixed address that Hermes Agent
// and other local services can allow in their CORS settings.
const http = require("http");
const fs = require("fs");
const path = require("path");

const port = Number(process.env.PORT) || 8765;
const root = path.join(__dirname, "dist");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

http.createServer((req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch (_) {
    res.writeHead(400);
    return res.end();
  }
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
}).listen(port, "127.0.0.1", () => {
  console.log("Quorum is running at http://localhost:" + port + "/");
});
