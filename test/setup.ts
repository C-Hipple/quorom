// Runs before the tests (see bunfig.toml): builds the page they load, and gives each test time for the sessions it
// runs, which stream their answers a few words at a time.
import { setDefaultTimeout } from "bun:test";
import path from "node:path";
import { buildPage } from "../build";

setDefaultTimeout(30000);
await Bun.write(path.join(import.meta.dir, "..", "dist", "quorum.html"), await buildPage());
