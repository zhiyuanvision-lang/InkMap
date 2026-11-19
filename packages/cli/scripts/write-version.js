// Generates src/version.ts from package.json, so the CLI, MCP server and telemetry always report the released version.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const target = new URL("../src/version.ts", import.meta.url);
const text = `/** Product version shared by the CLI, MCP server and telemetry. Generated from package.json by scripts/write-version.js. */
export const INKMAP_VERSION = ${JSON.stringify(version)};
`;
let current = "";
try {
  current = readFileSync(target, "utf8");
} catch {}
// Only rewrite on change, so an unchanged version does not look like a fresh source edit.
if (current !== text) writeFileSync(target, text);
