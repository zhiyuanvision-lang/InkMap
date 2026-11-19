// Shared setup for the packaged-artifact tests (scripts/test-*.mjs), so they run from any working directory.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const SIDEBARS = join(ROOT, "dist", "sidebars");
export const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/** Test options that skip a browser test when Chrome is missing, like packages/cli/test and packages/vscode/test. */
export const NEEDS_CHROME = { skip: !existsSync(CHROME) && "Chrome not found (set CHROME_PATH)" };

/** The `version` field of a JSON manifest in the repository. */
export function manifestVersion(relPath) {
  return JSON.parse(readFileSync(join(ROOT, relPath), "utf8")).version;
}
