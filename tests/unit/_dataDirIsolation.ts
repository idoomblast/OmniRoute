// Per-file DATA_DIR isolation for suites that touch the pricing / synced-model stores.
//
// Put this import FIRST in the file:
//
//     import "./_dataDirIsolation.ts";
//
// Why FIRST matters: ESM hoists every static import, but evaluates their module bodies in
// DECLARATION ORDER. So a helper imported before `src/lib/db/core.ts` (directly, or through
// `open-sse/executors/antigravity.ts`) has already set `process.env.DATA_DIR` by the time
// `core.ts` resolves its `DATA_DIR`/`SQLITE_FILE` consts. Setting the env var in the test
// file's own body is NOT equivalent: the body runs after ALL hoisted imports have evaluated,
// which is exactly how an earlier attempt at this isolation silently did nothing.
//
// Without this, a suite that persists pricing overrides or synced models writes them into the
// operator's real ~/.omniroute database, and any other suite asserting DEFAULT rates reads
// those values instead — making results depend on file scheduling.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.DATA_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-test-isolated-"));
  process.env.DATA_DIR = dir;
  process.on("exit", () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the OS reaps its temp dir eventually */
    }
  });
}
