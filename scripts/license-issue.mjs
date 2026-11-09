#!/usr/bin/env node
// Issues license codes, one per line, ready to paste into the shop's auto-delivery list.
//   node scripts/license-issue.mjs --count 100 --channel afdian > codes.txt
// Re-issue a Creem order's code (same id as the one the license worker gave out):
//   node scripts/license-issue.mjs --channel creem --order ord_xxx
// Every code is also recorded in ~/.inkmap/issued.csv for support and revocation.
import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { checkLicense, issueLicense, orderLicenseId } from "../packages/core/src/license.ts";
import { LICENSE_PUBLIC_KEY } from "../packages/core/src/license-key.ts";

const { values } = parseArgs({
  options: {
    count: { type: "string", default: "1" },
    channel: { type: "string", default: "manual" },
    order: { type: "string" },
    note: { type: "string", default: "" },
  },
});
const count = Number(values.count);
if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error("--count 应为 1 到 10000 之间的整数");
if (values.order && count !== 1) throw new Error("--order 每次只能生成 1 个激活码");
const id = values.order ? await orderLicenseId(values.channel, values.order) : undefined;

const dir = process.env.INKMAP_KEY_DIR ?? join(homedir(), ".inkmap");
const privateKey = (await readFile(join(dir, "license-private.key"), "utf8")).trim();
const ledger = join(dir, "issued.csv");
const date = new Date().toISOString().slice(0, 10);

const rows = [];
for (let i = 0; i < count; i++) {
  const code = await issueLicense(privateKey, { id });
  const check = await checkLicense(code, LICENSE_PUBLIC_KEY);
  if (!check.ok) throw new Error("私钥与 license-key.ts 中的公钥不匹配");
  const note = [values.order, values.note].filter(Boolean).join(" ").replace(/,/g, " ");
  rows.push(`${check.id},${date},${values.channel},${note},${code}\n`);
  process.stdout.write(code + "\n");
}
await appendFile(ledger, rows.join(""), { mode: 0o600 });
console.error(`已生成 ${count} 个激活码，记录在 ${ledger}`);
