// Quorum's database of sessions, kept by the local server in SQLite. A session is one council run: what it's about,
// the agents it uses, its status, and for each round, the handoff each step made. The page saves each handoff as the
// step finishes, so a session opened again after the page or the server stopped carries on from where it got to.
// It also saves each step's conversation with its agent, one row for each attempt at the step, while the step runs.
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STATUSES = ["running", "paused", "stopped", "done", "blocked"] as const;
export type Status = (typeof STATUSES)[number];

export interface Session {
  id: string;
  title: string;
  project: string | null;
  status: Status;
  round: number;
  agents: Record<string, unknown>;
  elapsed: number;
  created_at: string;
  updated_at: string;
}

export interface NewSession {
  title: string;
  project?: string | null;
  status: Status;
  round?: number;
  agents?: Record<string, unknown>;
}

// The fields of a session that can change.
export interface SessionPatch {
  title?: string;
  status?: Status;
  round?: number;
  agents?: Record<string, unknown>;
  elapsed?: number;
}

export interface SavedHandoff {
  round: number;
  node: string;
  kind: string;
  data: unknown;
}

export interface SavedTranscript {
  round: number;
  node: string;
  attempt: string;
  data: unknown;
}

export interface Sessions {
  file: string;
  list(limit?: number): Session[];
  create(o: NewSession): Session;
  get(id: string): { session: Session, handoffs: SavedHandoff[] } | null;
  update(id: string, patch: SessionPatch): Session | null;
  putHandoff(id: string, round: number, node: string, kind: string, data: unknown): boolean;
  transcripts(id: string, round?: number, node?: string): SavedTranscript[] | null;
  putTranscript(id: string, round: number, node: string, attempt: string, data: unknown): boolean;
  remove(id: string): boolean;
  close(): void;
}

// A session as its row stores it, with its agents as JSON.
type SessionRow = Omit<Session, "agents"> & { agents: string };
type DataRow = { round: number, node: string, data: string };

export function defaultFile(env: Record<string, string | undefined>): string {
  return (env && env.QUORUM_DB) || path.join(os.homedir(), ".quorum", "quorum.db");
}

// Opens the database at file, creating it if need be.
export function openSessions(file: string): Sessions {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
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
    CREATE TABLE IF NOT EXISTS transcripts (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      node TEXT NOT NULL,
      attempt TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, round, node, attempt)
    );
  `);

  const now = () => new Date().toISOString();
  const row = (r: SessionRow | null): Session | null => (r ? {
    id: r.id, title: r.title, project: r.project, status: r.status, round: r.round,
    agents: JSON.parse(r.agents), elapsed: r.elapsed, created_at: r.created_at, updated_at: r.updated_at,
  } : null);
  const q = {
    list: db.prepare<SessionRow, [number]>("SELECT * FROM sessions ORDER BY updated_at DESC, created_at DESC LIMIT ?"),
    get: db.prepare<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?"),
    insert: db.prepare<null, [string, string, string | null, string, number, string, string, string]>(
      "INSERT INTO sessions (id, title, project, status, round, agents, elapsed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)"),
    touch: db.prepare<null, [string, string]>("UPDATE sessions SET updated_at = ? WHERE id = ?"),
    handoffs: db.prepare<DataRow & { kind: string }, [string]>(
      "SELECT round, node, kind, data FROM handoffs WHERE session_id = ? ORDER BY round, created_at, rowid"),
    put: db.prepare<null, [string, number, string, string, string, string]>(`INSERT INTO handoffs (session_id, round, node, kind, data, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id, round, node) DO UPDATE SET kind = excluded.kind, data = excluded.data`),
    remove: db.prepare<null, [string]>("DELETE FROM sessions WHERE id = ?"),
    transcripts: db.prepare<DataRow & { attempt: string }, [string]>(
      "SELECT round, node, attempt, data FROM transcripts WHERE session_id = ? ORDER BY round, created_at, rowid"),
    transcriptsAt: db.prepare<DataRow & { attempt: string }, [string, number, string]>(
      "SELECT round, node, attempt, data FROM transcripts WHERE session_id = ? AND round = ? AND node = ? ORDER BY created_at, rowid"),
    putTranscript: db.prepare<null, [string, number, string, string, string, string, string]>(`INSERT INTO transcripts (session_id, round, node, attempt, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id, round, node, attempt) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`),
  };
  const transcript = (t: DataRow & { attempt: string }): SavedTranscript => ({ round: t.round, node: t.node, attempt: t.attempt, data: JSON.parse(t.data) });

  return {
    file,
    list(limit) {
      return q.list.all(limit || 50).map(r => row(r) as Session);
    },
    create(o) {
      const id = crypto.randomUUID(), t = now();
      q.insert.run(id, o.title, o.project || null, o.status, o.round || 1, JSON.stringify(o.agents || {}), t, t);
      return row(q.get.get(id)) as Session;
    },
    get(id) {
      const session = row(q.get.get(id));
      if (!session) return null;
      const handoffs = q.handoffs.all(id).map(h => ({ round: h.round, node: h.node, kind: h.kind, data: JSON.parse(h.data) }));
      return { session, handoffs };
    },
    // Changes any of title, status, round, agents and elapsed.
    update(id, patch) {
      const cols: string[] = [], vals: (string | number)[] = [];
      (["title", "status", "round", "elapsed"] as const).forEach(k => {
        const v = patch[k];
        if (v !== undefined) { cols.push(k + " = ?"); vals.push(v); }
      });
      if (patch.agents !== undefined) { cols.push("agents = ?"); vals.push(JSON.stringify(patch.agents)); }
      cols.push("updated_at = ?");
      vals.push(now(), id);
      const res = db.prepare<null, (string | number)[]>("UPDATE sessions SET " + cols.join(", ") + " WHERE id = ?").run(...vals);
      return res.changes ? row(q.get.get(id)) : null;
    },
    putHandoff(id, round, node, kind, data) {
      if (!q.get.get(id)) return false;
      const t = now();
      q.put.run(id, round, node, kind, JSON.stringify(data === undefined ? null : data), t);
      q.touch.run(t, id);
      return true;
    },
    // A session's conversations, oldest first: all of them, or every attempt at one step of one round. Null if
    // there's no such session.
    transcripts(id, round, node) {
      if (!q.get.get(id)) return null;
      return (round === undefined ? q.transcripts.all(id) : q.transcriptsAt.all(id, round, node as string)).map(transcript);
    },
    // Saves one attempt's conversation, replacing what was saved of it before.
    putTranscript(id, round, node, attempt, data) {
      if (!q.get.get(id)) return false;
      const t = now();
      q.putTranscript.run(id, round, node, attempt, JSON.stringify(data), t, t);
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
