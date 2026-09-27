// Quorum's database of sessions, kept by the local server in SQLite. A session is one council run: what it's about,
// the agents it uses, its status, and for each round, the handoff each step made. The page saves each handoff as the
// step finishes, so a session opened again after the page or the server stopped carries on from where it got to.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const STATUSES = ["running", "paused", "stopped", "done", "blocked"];

function defaultFile(env) {
  return (env && env.QUORUM_DB) || path.join(os.homedir(), ".quorum", "quorum.db");
}

// Opens the database at file, creating it if need be. Returns null when this Node.js has no SQLite (before 22.13).
function openSessions(file) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (_) {
    return null;
  }
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      project TEXT,
      status TEXT NOT NULL,
      round INTEGER NOT NULL,
      agents TEXT NOT NULL,
      elapsed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS handoffs (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      node TEXT NOT NULL,
      kind TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, round, node)
    );
  `);

  const now = () => new Date().toISOString();
  const row = r => (r ? {
    id: r.id, title: r.title, project: r.project, status: r.status, round: r.round,
    agents: JSON.parse(r.agents), elapsed: r.elapsed, created_at: r.created_at, updated_at: r.updated_at,
  } : null);
  const q = {
    list: db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC, created_at DESC LIMIT ?"),
    get: db.prepare("SELECT * FROM sessions WHERE id = ?"),
    insert: db.prepare("INSERT INTO sessions (id, title, project, status, round, agents, elapsed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)"),
    touch: db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?"),
    handoffs: db.prepare("SELECT round, node, kind, data FROM handoffs WHERE session_id = ? ORDER BY round, created_at, rowid"),
    put: db.prepare(`INSERT INTO handoffs (session_id, round, node, kind, data, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id, round, node) DO UPDATE SET kind = excluded.kind, data = excluded.data`),
    remove: db.prepare("DELETE FROM sessions WHERE id = ?"),
  };

  return {
    file,
    list(limit) {
      return q.list.all(limit || 50).map(row);
    },
    create(o) {
      const id = crypto.randomUUID(), t = now();
      q.insert.run(id, o.title, o.project || null, o.status, o.round || 1, JSON.stringify(o.agents || {}), t, t);
      return row(q.get.get(id));
    },
    get(id) {
      const session = row(q.get.get(id));
      if (!session) return null;
      const handoffs = q.handoffs.all(id).map(h => ({ round: h.round, node: h.node, kind: h.kind, data: JSON.parse(h.data) }));
      return { session, handoffs };
    },
    // Changes any of title, status, round, agents and elapsed.
    update(id, patch) {
      const cols = [], vals = [];
      ["title", "status", "round", "elapsed"].forEach(k => {
        if (patch[k] !== undefined) { cols.push(k + " = ?"); vals.push(patch[k]); }
      });
      if (patch.agents !== undefined) { cols.push("agents = ?"); vals.push(JSON.stringify(patch.agents)); }
      cols.push("updated_at = ?");
      vals.push(now(), id);
      const res = db.prepare("UPDATE sessions SET " + cols.join(", ") + " WHERE id = ?").run(...vals);
      return res.changes ? row(q.get.get(id)) : null;
    },
    putHandoff(id, round, node, kind, data) {
      if (!q.get.get(id)) return false;
      const t = now();
      q.put.run(id, round, node, kind, JSON.stringify(data === undefined ? null : data), t);
      q.touch.run(t, id);
      return true;
    },
    remove(id) {
      return q.remove.run(id).changes > 0;
    },
    close() {
      db.close();
    },
  };
}

module.exports = { openSessions, defaultFile, STATUSES };
