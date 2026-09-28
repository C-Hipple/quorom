// The tools Quorum's own agent loop gives an agent: Read, Grep and Glob, the same read-only tools Claude Code runs
// with. They only read, and only inside the project folder: a path that leads outside it, including through a symbolic
// link, is refused. Grep and Glob skip what Git ignores, and without Git, hidden folders and node_modules. The project's
// AGENTS.md files, which say how it's designed and how to work in it, are found here too.
import fs from "node:fs";
import path from "node:path";

export interface ToolResult {
  content: string;
  error?: boolean;
}

// A tool as a model is told about it, in the OpenAI function-calling format.
export interface ToolSpec {
  type: "function";
  function: { name: string, description: string, parameters: Record<string, unknown> };
}

// An AGENTS.md: where it is, relative to the project folder, and what it says.
export interface Guide {
  path: string;
  text: string;
}

export interface ProjectTools {
  names: string[];
  specs: ToolSpec[];
  // The AGENTS.md files that apply to the whole project folder, most general first: the project folder's own, and
  // when it's inside a larger Git repository, those in the folders between it and the repository's root.
  guides(): Guide[];
  // The AGENTS.md files further down, which apply to their own folders, relative to the project folder.
  nestedGuides(): string[];
  // Runs a tool. What goes wrong, such as a missing file, comes back as an error result for the agent to read.
  call(name: string, input: Record<string, unknown>): Promise<ToolResult>;
}

const READ_LINES = 2000;
const LINE_CHARS = 2000;
// The most a single Read, Grep or Glob gives the agent, so one call can't fill its context.
const MAX_RESULT = 100000;
const MAX_MATCHES = 300;
const MAX_FILES = 500;
const MAX_LISTED = 50000;
const MAX_SEARCHED_BYTES = 2 * 1024 * 1024;
const MAX_READ_BYTES = 20 * 1024 * 1024;
const GUIDE = "AGENTS.md";
const MAX_GUIDE = 40000;

class ToolError extends Error {}

const object = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: "object", properties, required, additionalProperties: false });

const SPECS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "Read",
      description: "Reads a text file in the project, with line numbers. The path is relative to the project folder, or absolute inside it. " +
        "Reads up to " + READ_LINES + " lines at a time; read a long file in parts with offset and limit.",
      parameters: object({
        file_path: { type: "string", description: "The file to read." },
        offset: { type: "integer", description: "The line to start at, counting from 1." },
        limit: { type: "integer", description: "How many lines to read." },
      }, ["file_path"]),
    },
  },
  {
    type: "function",
    function: {
      name: "Grep",
      description: "Searches the contents of the project's files for a regular expression, in JavaScript syntax, and lists each matching line as path:line: text. " +
        "Narrow the search with path, a file or folder, and glob, such as *.ts or src/**/*.py.",
      parameters: object({
        pattern: { type: "string", description: "The regular expression to search for." },
        path: { type: "string", description: "The file or folder to search in. The whole project if left out." },
        glob: { type: "string", description: "Only search files whose paths match this glob. One without a slash, such as *.ts, matches file names." },
        ignore_case: { type: "boolean", description: "Match regardless of case." },
      }, ["pattern"]),
    },
  },
  {
    type: "function",
    function: {
      name: "Glob",
      description: "Lists the project's files whose paths match a glob pattern, such as **/*.ts or src/**/test_*.py, relative to the project folder, or to path if it's given.",
      parameters: object({
        pattern: { type: "string", description: "The glob pattern to match." },
        path: { type: "string", description: "The folder to look in. The project folder if left out." },
      }, ["pattern"]),
    },
  },
];

const toPosix = (p: string) => p.split(path.sep).join("/");

// Every file in the project, relative to its folder: what Git would track, or failing that, a walk of the folder.
function listFiles(root: string): string[] {
  try {
    const git = Bun.spawnSync(["git", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { stdout: "pipe", stderr: "ignore" });
    if (git.exitCode === 0) return git.stdout.toString().split("\0").filter(Boolean).slice(0, MAX_LISTED);
  } catch (_) { /* no Git here */ }
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (out.length >= MAX_LISTED) return;
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(toPosix(path.relative(root, p)));
    }
  };
  walk(root);
  return out;
}

function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

// Cuts a result to MAX_RESULT characters at a line break, saying what was left out.
function capped(text: string, more: string): string {
  if (text.length <= MAX_RESULT) return text;
  const cut = text.lastIndexOf("\n", MAX_RESULT);
  return text.slice(0, cut > 0 ? cut : MAX_RESULT) + "\n\n[" + more + "]";
}

export function projectTools(folder: string): ProjectTools {
  const root = fs.realpathSync(folder);
  let files: string[] | null = null;
  // The project doesn't change while the agent reads it, so it's listed once.
  const allFiles = () => files || (files = listFiles(root));

  // The absolute path p names, if it's inside the project; otherwise a ToolError.
  function inside(p: unknown): string {
    if (typeof p !== "string" || !p.trim()) throw new ToolError("Give a path.");
    // Where the path really leads, through any symbolic links, or if nothing's there, where it names.
    let real = path.resolve(root, p.trim());
    try { real = fs.realpathSync(real); } catch (_) { /* it isn't there */ }
    const r = path.relative(root, real);
    if (r.startsWith("..") || path.isAbsolute(r)) throw new ToolError(p + " is outside the project folder, " + root + ".");
    return real;
  }
  const rel = (abs: string) => toPosix(path.relative(root, abs)) || ".";
  // The project's files under a folder, relative to the project folder.
  const under = (dir: string) => {
    const prefix = dir === root ? "" : rel(dir) + "/";
    return allFiles().filter(f => f.startsWith(prefix));
  };

  async function read(o: Record<string, unknown>): Promise<string> {
    const file = inside(o.file_path);
    let stat;
    try { stat = fs.statSync(file); } catch (_) { throw new ToolError("There's no file at " + rel(file) + "."); }
    if (stat.isDirectory()) throw new ToolError(rel(file) + " is a folder. Use Glob to see what's in it.");
    if (stat.size > MAX_READ_BYTES) throw new ToolError(rel(file) + " is too large to read.");
    const bytes = await Bun.file(file).bytes();
    if (isBinary(bytes)) throw new ToolError(rel(file) + " isn't a text file.");
    const lines = new TextDecoder().decode(bytes).split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    if (!lines.length) return "(" + rel(file) + " is empty.)";
    const start = Math.max(1, Math.floor(Number(o.offset) || 1));
    const count = Math.max(1, Math.floor(Number(o.limit) || READ_LINES));
    if (start > lines.length) throw new ToolError(rel(file) + " has only " + lines.length + " lines.");
    const end = Math.min(lines.length, start + count - 1);
    const body = lines.slice(start - 1, end).map((l, i) =>
      String(start + i).padStart(6) + "\t" + (l.length > LINE_CHARS ? l.slice(0, LINE_CHARS) + "…" : l)).join("\n");
    const note = end < lines.length ? "\n\n[Lines " + start + " to " + end + " of " + lines.length + ". Read on with offset " + (end + 1) + ".]" : "";
    return capped(body, "Cut for length. Read fewer lines at a time with offset and limit.") + note;
  }

  async function grep(o: Record<string, unknown>): Promise<string> {
    if (typeof o.pattern !== "string" || !o.pattern) throw new ToolError("Give a pattern.");
    let re: RegExp;
    try { re = new RegExp(o.pattern, o.ignore_case ? "i" : ""); } catch (e) {
      throw new ToolError("That isn't a regular expression JavaScript can read: " + (e as Error).message);
    }
    const target = o.path === undefined ? root : inside(o.path);
    const one = fs.existsSync(target) && fs.statSync(target).isFile();
    let list = one ? [rel(target)] : under(target);
    if (typeof o.glob === "string" && o.glob) {
      const g = new Bun.Glob(o.glob), byName = !o.glob.includes("/");
      const base = one ? "" : target === root ? "" : rel(target) + "/";
      list = list.filter(f => g.match(byName ? path.posix.basename(f) : f.slice(base.length)));
    }
    const hits: string[] = [];
    let more = 0;
    for (const f of list) {
      const abs = path.join(root, f);
      let bytes: Uint8Array;
      try {
        if (fs.statSync(abs).size > MAX_SEARCHED_BYTES) continue;
        bytes = await Bun.file(abs).bytes();
      } catch (_) { continue; }
      if (isBinary(bytes)) continue;
      const lines = new TextDecoder().decode(bytes).split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        if (hits.length >= MAX_MATCHES) { more++; continue; }
        const l = lines[i].trim();
        hits.push(f + ":" + (i + 1) + ": " + (l.length > 300 ? l.slice(0, 300) + "…" : l));
      }
    }
    if (!hits.length) return "No matches for " + o.pattern + ".";
    return capped(hits.join("\n"), "Cut for length. Narrow the search.") +
      (more ? "\n\n[And " + more + " more matching lines. Narrow the search with path or glob.]" : "");
  }

  async function glob(o: Record<string, unknown>): Promise<string> {
    if (typeof o.pattern !== "string" || !o.pattern) throw new ToolError("Give a pattern.");
    const base = o.path === undefined ? root : inside(o.path);
    const g = new Bun.Glob(o.pattern.replace(/^\.\//, ""));
    const prefix = base === root ? "" : rel(base) + "/";
    const found = under(base).filter(f => g.match(f.slice(prefix.length)) && fs.existsSync(path.join(root, f)));
    if (!found.length) return "No files match " + o.pattern + ".";
    return found.slice(0, MAX_FILES).join("\n") +
      (found.length > MAX_FILES ? "\n\n[And " + (found.length - MAX_FILES) + " more. Narrow the pattern.]" : "");
  }

  function guides(): Guide[] {
    let top = root;
    try {
      const git = Bun.spawnSync(["git", "-C", root, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
      if (git.exitCode === 0) top = fs.realpathSync(git.stdout.toString().trim());
    } catch (_) { /* no Git here */ }
    const within = path.relative(top, root);
    if (within.startsWith("..") || path.isAbsolute(within)) top = root;
    const dirs = [root];
    for (let d = root; d !== top && path.dirname(d) !== d; ) dirs.unshift(d = path.dirname(d));
    const out: Guide[] = [];
    for (const d of dirs) {
      const file = path.join(d, GUIDE);
      try {
        if (!fs.statSync(file).isFile()) continue;
        const text = fs.readFileSync(file, "utf8").trim();
        if (!text) continue;
        out.push({
          path: toPosix(path.relative(root, file)),
          text: text.length > MAX_GUIDE ? text.slice(0, MAX_GUIDE) + "\n\n[Cut for length. Read the rest with Read.]" : text,
        });
      } catch (_) { /* none here */ }
    }
    return out;
  }

  function nestedGuides(): string[] {
    return allFiles().filter(f => f !== GUIDE && path.posix.basename(f) === GUIDE).slice(0, 50);
  }

  const run: Record<string, (o: Record<string, unknown>) => Promise<string>> = { Read: read, Grep: grep, Glob: glob };
  return {
    names: SPECS.map(s => s.function.name),
    specs: SPECS,
    guides,
    nestedGuides,
    async call(name, input) {
      const fn = run[name];
      if (!fn) return { content: "There's no tool called " + name + ". The tools are Read, Grep and Glob.", error: true };
      try {
        return { content: await fn(input && typeof input === "object" ? input : {}) };
      } catch (e) {
        if (e instanceof ToolError) return { content: e.message, error: true };
        return { content: "The tool failed: " + String((e as Error)?.message || e), error: true };
      }
    },
  };
}
