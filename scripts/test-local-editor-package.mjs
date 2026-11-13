import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

test("the standalone sidebar archive serves a Markdown file outside the repository", { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "inkmap-local-package-"));
  const archive = resolve("dist/sidebars/inkmap-local-editor.zip");
  const markdown = join(directory, "sample map.md");
  const original = "# Sample\n\n- Before\n";
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });

  execFileSync("unzip", ["-q", archive, "-d", directory]);
  await writeFile(markdown, original);
  child = spawn(process.execPath, ["inkmap-local-editor/inkmap.mjs", markdown, "--sidebar"], {
    cwd: directory, stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, INKMAP_HOME: directory },
  });
  const lines = createInterface({ input: child.stdout });
  let address;
  for await (const line of lines) {
    address = /http:\/\/127\.0\.0\.1:\d+\/s\/[a-f0-9]{48}\//.exec(line)?.[0];
    if (address) break;
  }
  assert.ok(address, "the archive starts a private loopback session");

  const document = await fetch(address + "api/doc");
  assert.equal(document.status, 200);
  assert.equal((await document.json()).md, original);
  const page = await fetch(address);
  assert.equal(page.status, 200);
  const script = /src="(\.\/assets\/[^"]+\.js)"/.exec(await page.text())?.[1];
  assert.ok(script, "the editor references bundled JavaScript");
  const asset = await fetch(new URL(script, address));
  assert.equal(asset.status, 200);
  await asset.body.cancel();
  const capabilities = await fetch(address + "api/capabilities");
  assert.equal((await capabilities.json()).purchase, false);
});
