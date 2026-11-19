import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { fileSource, serve } from "../dist/server.js";
import { licenseService } from "../dist/license.js";

const WEB_ROOT = fileURLToPath(new URL("../dist/web/", import.meta.url));

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FIXTURE = new URL("../../core/test/fixtures/logic-design.md", import.meta.url);
const SIMPLE = `---
title: Demo
---

## Root

- alpha
  - alpha child
- | a | b |
  | --- | --- |
  | 1 | 2 |
- omega
`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(check, label, timeout = 5000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

describe("inkmap editor", { skip: !existsSync(CHROME) && "Chrome not found" }, () => {
  let dir, browser;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "inkmap-e2e-"));
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  });
  after(async () => {
    await browser?.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function open(name, content, options = {}) {
    const file = join(dir, name);
    await writeFile(file, content);
    const served = await serve({ source: await fileSource(file), webRoot: WEB_ROOT, port: 0, license: { state: async () => ({ pro: false, trialUntil: Date.now() + 60_000 }), onChange: () => () => {} }, ...options });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(served.url);
    await page.waitForFunction(() => window.inkmap?.mindMap);
    return { file, page, errors, close: async () => (await page.close(), await served.close()) };
  }

  async function withDoc(name, content, fn, options) {
    const t = await open(name, content, options);
    try {
      await fn(t);
    } finally {
      await t.close();
    }
  }

  const editorFocused = page =>
    waitFor(() => page.evaluate(() => document.activeElement?.classList.contains("smm-node-edit-wrap")), "text editor");

  const activate = (page, text) =>
    page.evaluate(text => {
      const { mindMap } = window.inkmap;
      let hit;
      const walk = n => {
        if (!hit && String(n.getData("md") ?? n.getData("text")).startsWith(text)) hit = n;
        (n.children ?? []).forEach(walk);
      };
      walk(mindMap.renderer.root);
      mindMap.execCommand("CLEAR_ACTIVE_NODE");
      hit.active();
      return !!hit;
    }, text);

  it("opens a real document without rewriting it", async () => {
    const original = await readFile(FIXTURE, "utf8");
    await withDoc("logic.md", original, async t => {
      await sleep(1200);
      assert.equal(await readFile(t.file, "utf8"), original);
      assert.equal(await t.page.evaluate(() => window.inkmap.currentMarkdown()), original);
      assert.deepEqual(t.errors, []);
    });
  });

  it("writes keyboard edits back and follows external changes", async () => {
    await withDoc("simple.md", SIMPLE, async t => {
      const read = () => readFile(t.file, "utf8");

      assert.ok(await activate(t.page, "alpha child"));
      await t.page.keyboard.press("Enter"); // sibling, opens the text editor
      await editorFocused(t.page);
      await t.page.keyboard.type("beta");
      await t.page.keyboard.press("Enter"); // finish editing
      await waitFor(async () => (await read()).includes("  - alpha child\n  - beta\n"), "sibling written");

      assert.ok(await activate(t.page, "omega"));
      await t.page.keyboard.press("Tab"); // child
      await editorFocused(t.page);
      await t.page.keyboard.type("**bold** idea");
      await t.page.keyboard.press("Enter");
      await waitFor(async () => (await read()).includes("- omega\n  - **bold** idea\n"), "child written");
      const rich = await t.page.evaluate(() => {
        let found;
        const walk = n => (n.getData("md") === "**bold** idea" && (found = n), (n.children ?? []).forEach(walk));
        walk(window.inkmap.mindMap.renderer.root);
        return found?.getData("rich") && !!found.group.node.querySelector(".ink-node strong");
    });
    assert.ok(rich, "markdown typed on the canvas is rendered");

    await t.page.evaluate(() => window.inkmap.mindMap.execCommand("BACK"));
    await waitFor(async () => !(await read()).includes("**bold** idea"), "undo written");

    const external = (await read()).replace("- omega\n", "- omega\n- from editor\n");
    await writeFile(t.file, external);
    await waitFor(() => t.page.evaluate(() => window.inkmap.currentMarkdown().includes("- from editor")), "external change shown");
    await sleep(600);
    assert.equal(await read(), external, "external change is not echoed back");
    assert.deepEqual(t.errors, []);
    });
  });

  it("expands every descendant of the selected node", async () => {
    const DEEP = "## Root\n\n- a\n  - b\n    - c\n      - d\n        - e\n- x\n  - y\n    - z\n      - w\n";
    await withDoc("deep.md", DEEP, async t => {
      const shown = text =>
        t.page.evaluate(text => {
          let hit = false;
          const walk = n => ((hit ||= n.getData("text") === text), (n.children ?? []).forEach(walk));
          const root = window.inkmap.mindMap.renderer.root;
          if (root) walk(root);
          return hit;
        }, text);
      assert.equal(await shown("d"), false, "deep levels start folded");

      assert.ok(await activate(t.page, "a"));
      await t.page.keyboard.down("Shift");
      await t.page.keyboard.press("Slash");
      await t.page.keyboard.up("Shift");
      await waitFor(() => shown("e"), "subtree expanded by ⇧/");
      assert.equal(await shown("w"), false, "other branches stay folded");
      assert.equal(await t.page.evaluate(() => !!document.querySelector(".smm-node-edit-wrap:focus")), false, "⇧/ does not start text editing");

      const box = await t.page.evaluate(() => {
        let x;
        const walk = n => (n.getData("text") === "x" && (x = n), (n.children ?? []).forEach(walk));
        walk(window.inkmap.mindMap.renderer.root);
        const r = x.group.node.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await t.page.mouse.click(box.x, box.y, { button: "right" });
      await t.page.waitForSelector("#node-menu:not([hidden])");
      await t.page.click("#menu-expand-subtree");
      await waitFor(() => shown("w"), "subtree expanded from the context menu");
      assert.ok(await t.page.$("#node-menu[hidden]"));

      await sleep(600);
      assert.equal(await readFile(t.file, "utf8"), DEEP, "expanding does not touch the file");
      assert.deepEqual(t.errors, []);
    });

    // Reopening the same file on a new server port restores the expanded branches from ~/.inkmap/view-state.
    await withDoc("deep.md", DEEP, async t => {
      const shown = text =>
        t.page.evaluate(text => {
          let hit = false;
          const walk = n => ((hit ||= n.getData("text") === text), (n.children ?? []).forEach(walk));
          const root = window.inkmap.mindMap.renderer.root;
          if (root) walk(root);
          return hit;
        }, text);
      await waitFor(() => shown("e"), "branch a restored expanded across server restart");
      await waitFor(() => shown("w"), "branch x restored expanded across server restart");
      assert.deepEqual(t.errors, []);
    });
  });

  it("renders Mermaid and writes edits back as diagram source", async () => {
    const md = await readFile(new URL("../../core/test/fixtures/diagrams.md", import.meta.url), "utf8");
    await withDoc("diagrams.md", md, async ({ page, file, errors }) => {
      await page.waitForFunction(() => document.querySelectorAll(".ink-diagram-image").length === 2);
      const rendered = () => page.$$eval(".ink-diagram-image", images => images.map(image => {
        const svg = decodeURIComponent(image.getAttribute("src").split(",")[1]);
        const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
        return {
          loaded: image.complete && image.naturalWidth > 0,
          labels: [...parsed.querySelectorAll("text")].map(node => node.textContent).join("\n"),
        };
      }));
      await page.waitForFunction(() => [...document.querySelectorAll(".ink-diagram-image")].every(image => image.complete && image.naturalWidth));
      const [flowchart, state] = await rendered();
      assert.match(flowchart.labels, /Answer/);
      assert.match(state.labels, /Keep practicing/);
      assert.equal(state.loaded, true);
      await (await page.$$(".ink-diagram-edit"))[1].click();
      const field = await page.$("#source-text");
      assert.match(await field.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd)), /stateDiagram-v2/);
      await field.evaluate(el => {
        el.value = el.value.replace("Answered correctly", "Practiced again").replace("Keep practicing", "Practice daily");
        el.dispatchEvent(new Event("input"));
      });
      await waitFor(async () => (await readFile(file, "utf8")).includes("Practice daily"), "Mermaid source saved");
      const saved = await readFile(file, "utf8");
      assert.ok(saved.includes("    New --> Review: Practiced again"));
      assert.ok(saved.includes("  ```mermaid"));
      assert.ok(!saved.includes("data:image/svg"));
      await waitFor(async () => (await rendered()).some(image => image.loaded && image.labels.includes("Practice daily")), "diagram updated");
      const exported = await page.evaluate(async () => {
        const svg = atob((await window.inkmap.mindMap.export("svg", false, "diagram")).split(",")[1]);
        const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
        return {
          srcs: [...parsed.querySelectorAll(".ink-diagram-image")].map(image => image.getAttribute("src").slice(0, 45)),
          controls: parsed.querySelectorAll(".ink-diagram-edit").length,
        };
      });
      assert.equal(exported.srcs.length, 2);
      assert.ok(exported.srcs.every(src => src.startsWith("data:image/")), JSON.stringify(exported));
      assert.equal(exported.controls, 0);
      assert.deepEqual(errors, []);
    });
  });

  it("blocks editing after the trial expires, including direct saves", async () => {
    await withDoc("expired.md", SIMPLE, async t => {
      await t.page.waitForSelector("#trial-expired-message:not([hidden])");
      await t.page.keyboard.press("Escape");
      assert.ok(await t.page.$("#upgrade:not([hidden])"));
      assert.equal(await t.page.$eval("#map", el => el.inert), true);
      const status = await t.page.evaluate(async () => {
        const doc = await (await fetch("/api/doc")).json();
        const response = await fetch("/api/doc", {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ md: "# blocked", baseVersion: doc.version }),
        });
        return response.status;
      });
      assert.equal(status, 403);
      assert.equal(await readFile(t.file, "utf8"), SIMPLE);
    }, { license: { state: async () => ({ pro: false, trialUntil: 1 }), onChange: () => () => {} } });
  });

  it("unlocks Pro after platform checkout and preserves the editor", async () => {
    let state = { pro: false };
    let notify;
    const license = {
      state: async () => state,
      onChange(listener) { notify = listener; return () => {}; },
      async connect(mode) {
        assert.equal(mode, "buy");
        state = { pro: true, connected: true, account: "138****0000" };
        notify(state);
        return "about:blank";
      },
      async deactivate() {
        state = { pro: false, trialUntil: Date.now() + 2 * 24 * 60 * 60 * 1000 };
        notify(state);
      },
    };
    await withDoc(
      "pro.md",
      SIMPLE,
      async t => {
        const read = () => readFile(t.file, "utf8");
        await t.page.waitForSelector("#upgrade:not([hidden])");
        assert.equal(await t.page.$eval("#account-actions", el => el.hidden), true, "sign-out hidden before sign-in");
        await t.page.evaluate(() => {
          window.open = () => ({ opener: null, location: { replace() {} }, close() {} });
        });
        await t.page.click("#buy-pro");
        await waitFor(() => t.page.$eval("html", el => el.classList.contains("pro-member")), "pro unlocked");
        assert.equal(await t.page.$eval("#account", el => el.dataset.plan), "pro", "lifetime badge on toolbar");
        assert.equal(await t.page.$eval("#upgrade", el => el.hidden), true);
        assert.match(await t.page.$eval("#account-text", el => el.textContent), /138\*\*\*\*0000/);
        assert.equal(await t.page.$eval("#account-actions", el => el.hidden), false, "sign-out shown when connected");
        assert.equal(await t.page.$("#ad"), null, "no ad element");
        await t.page.keyboard.press("Escape");

        await t.page.select("#layout-select", "timeline");
        await waitFor(async () => (await read()).includes("inkmap:\n  layout: timeline\n"), "layout saved");
        await t.page.select("#theme-select", "dusk");
        await waitFor(async () => (await read()).includes("  layout: timeline\n  theme: dusk\n"), "theme saved");
        assert.ok(await t.page.$eval("html", el => el.classList.contains("dark")));

        const png = await t.page.evaluate(() => window.inkmap.mindMap.export("png", false, "x"));
        assert.match(png, /^data:image\/png;base64,/);
        assert.ok(png.length > 5000);
        const svg = await t.page.evaluate(async () => atob((await window.inkmap.mindMap.export("svg", false, "x")).split(",")[1]));
        assert.match(svg, /\.ink-node/);
        assert.match(svg, /<table/);

        await t.page.click("#find");
        await t.page.waitForSelector("#search:not([hidden])");
        await t.page.$eval("#find-input", el => (el.value = ""));
        await t.page.type("#find-input", "alpha");
        await waitFor(() => t.page.$eval("#find-count", el => el.textContent === "1/2"), "two matches");
        await t.page.type("#replace-input", "Beta");
        await t.page.click("#replace-all");
        await waitFor(async () => (await read()).includes("- Beta\n  - Beta child\n"), "replace all saved");
        await t.page.keyboard.press("Escape");

        const before = await read();
        await t.page.click("#present");
        await waitFor(() => t.page.$eval("html", el => el.classList.contains("presenting")), "presentation started");
        await sleep(800);
        await t.page.keyboard.press("ArrowRight");
        await sleep(300);
        await t.page.keyboard.press("Escape");
        await waitFor(() => t.page.$eval("html", el => !el.classList.contains("presenting")), "presentation ended");
        await sleep(600);
        assert.equal(await read(), before, "presenting does not change the file");

        await t.page.click("#pro");
        await t.page.waitForSelector("#account-panel", { visible: true });
        await t.page.click("#sign-out");
        await waitFor(() => t.page.$eval("#account", el => el.dataset.plan === "ending"), "reverted to expiring trial after sign-out");
        assert.equal(await t.page.$eval("#account-actions", el => el.hidden), true);
        assert.deepEqual(t.errors, []);
      },
      { license },
    );
  });

  it("edits rich nodes through the source panel", async () => {
    await withDoc("table.md", SIMPLE, async t => {
      assert.ok(await activate(t.page, "| a | b |"));
      await t.page.evaluate(() => window.inkmap.mindMap.keyCommand.shortcutMap["Control+e"].forEach(f => f()));
      await t.page.waitForSelector("#source:not([hidden])");
      assert.equal(await t.page.$eval("#source-text", el => el.value), "| a | b |\n| --- | --- |\n| 1 | 2 |");
      await t.page.focus("#source-text");
      await t.page.keyboard.press("End");
      await t.page.keyboard.type("\n| 3 | 4 |");
      await waitFor(async () => (await readFile(t.file, "utf8")).includes("  | 1 | 2 |\n  | 3 | 4 |\n- omega"), "table row written");
      assert.deepEqual(t.errors, []);
    });
  });

  it("edits an escaped numbered node in place and preserves its Markdown", async () => {
    await withDoc("numbered.md", "# Root\n\n- 3\\. Step\n", async t => {
      const node = ".smm-node .ink-node";
      await t.page.waitForSelector(node, { visible: true });
      await t.page.click(node, { clickCount: 2 });
      await t.page.waitForSelector("#node-inline-edit", { visible: true });
      assert.equal(await t.page.$eval("#node-inline-edit", el => el.value), "3. Step");
      assert.equal(await t.page.$eval("#source", el => el.hidden), true);
      await t.page.keyboard.type("4. Updated");
      await t.page.keyboard.press("Enter");
      await waitFor(async () => (await readFile(t.file, "utf8")).includes("- 4\\. Updated\n"), "escaped numbered label saved");

      await t.page.click(node, { clickCount: 2 });
      await t.page.waitForSelector("#node-inline-edit", { visible: true });
      await t.page.keyboard.type("Discarded");
      await t.page.keyboard.press("Escape");
      assert.equal(await t.page.$eval("#node-inline-edit", el => el.hidden), true);
      assert.match(await t.page.$eval(node, el => el.textContent), /4\. Updated/);
      assert.deepEqual(t.errors, []);
    });
  });
});

describe("licenseService", () => {
  it("keeps the existing account on an invalid code and replaces it only after verified phone sign-in", async () => {
    const origin = "https://billing.example.com";
    const oldToken = "a".repeat(43);
    const newToken = "b".repeat(43);
    let saved = JSON.stringify({ origin, token: oldToken });
    const service = licenseService({ read: async () => saved, write: async value => { saved = value; } }, () => origin);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      assert.equal(init.redirect, "error");
      if (url === origin + "/billing/v1/phone-sign-in/send") {
        assert.deepEqual(JSON.parse(init.body), { product: "inkmap-pro", phone: "13800008000" });
        return new Response(null, { status: 204 });
      }
      if (url === origin + "/billing/v1/phone-sign-in/verify") {
        const { code } = JSON.parse(init.body);
        return code === "123456" ? Response.json({ token: newToken }, { status: 201 }) : new Response(null, { status: 400 });
      }
      assert.equal(url, origin + "/billing/v1/entitlement");
      const paid = init.headers.authorization === "Bearer " + newToken;
      return Response.json({ connected: true, active: paid, entitlement: "inkmap.pro", account: paid ? "138****8000" : "u***@example.com" });
    };
    try {
      assert.equal((await service.state()).account, "u***@example.com");
      assert.equal((await service.sendPhoneCode("13800008000")).ok, true);
      assert.deepEqual(await service.signInByPhone("13800008000", "000000"), { ok: false, reason: "invalid" });
      assert.equal(JSON.parse(saved).token, oldToken);
      const signedIn = await service.signInByPhone("13800008000", "123456");
      assert.equal(signedIn.ok, true);
      assert.equal(signedIn.value.pro, true);
      assert.equal(signedIn.value.account, "138****8000");
      assert.deepEqual(JSON.parse(saved), { origin, token: newToken });
    } finally {
      service.dispose();
      globalThis.fetch = realFetch;
    }
  });
  it("keeps login-only hosts away from legacy purchase pages", async () => {
    const origin = "https://billing.example.com";
    const flow = "0".repeat(32);
    const token = "a".repeat(43);
    const realFetch = globalThis.fetch;
    let path = "checkout";
    let saved;
    const service = licenseService({ read: async () => saved, write: async v => { saved = v; } },
      () => origin, { loginOnly: true });
    globalThis.fetch = async (url, init) => {
      assert.equal(url, origin + "/billing/v1/restore-connections");
      assert.deepEqual(JSON.parse(init.body), { product: "inkmap-pro" });
      return new Response(JSON.stringify({ url: origin + "/billing/" + path + "/" + flow, token }), { status: 201 });
    };
    try {
      await assert.rejects(service.connect("buy"), /Only Yunfan/);
      await assert.rejects(service.connect("restore"), /Invalid Yunfan account link/);
      assert.equal(saved, undefined);
      path = "login";
      assert.equal(await service.connect("restore"), origin + "/billing/login/" + flow);
    } finally {
      service.dispose();
      globalThis.fetch = realFetch;
    }
  });

  it("tracks connected account, paid Pro entitlement, and sign-out", async () => {
    let saved;
    const storage = { read: async () => saved, write: async v => { saved = v; } };
    const token = "a".repeat(43);
    const flowId = "0123456789abcdef0123456789abcdef";
    let entitlementBody = { connected: true, active: false, entitlement: "inkmap.pro", pending: true, account: "138****8000" };
    let deleted = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (url === "https://billing.example.com/billing/v1/connections") {
        return new Response(JSON.stringify({ url: `https://billing.example.com/billing/checkout/${flowId}`, token }), { status: 201 });
      }
      if (url === "https://billing.example.com/billing/v1/entitlement" && init?.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      if (url === "https://billing.example.com/billing/v1/entitlement") {
        return new Response(JSON.stringify(entitlementBody), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const svc = licenseService(storage, () => "https://billing.example.com");
    try {
      const checkoutUrl = await svc.connect("buy");
      assert.equal(checkoutUrl, `https://billing.example.com/billing/checkout/${flowId}`);

      const signedInFree = await svc.state();
      assert.equal(signedInFree.pro, false);
      assert.equal(signedInFree.connected, true);
      assert.equal(signedInFree.account, "138****8000");

      entitlementBody = { connected: true, active: true, entitlement: "inkmap.pro", pending: false, account: "138****8000" };
      await waitFor(async () => (await svc.state()).pro === true, "polled paid entitlement", 6000);
      const paid = await svc.state();
      assert.equal(paid.pro, true);
      assert.equal(paid.connected, true);
      assert.equal(paid.account, "138****8000");

      await svc.deactivate();
      assert.equal(deleted, true);
      assert.equal(saved, undefined);
      const signedOut = await svc.state();
      assert.equal(signedOut.pro, false);
      assert.equal(signedOut.connected, undefined);
      assert.equal(signedOut.account, undefined);
    } finally {
      svc.dispose();
      globalThis.fetch = realFetch;
    }
  });

  it("connects a checkout flow during phone sign-in and returns an inline WeChat QR on orderPro", async () => {
    let saved;
    const origin = "https://billing.example.com";
    const token = "c".repeat(43);
    const flowId = "fedcba9876543210fedcba9876543210";
    const checkoutUrl = `${origin}/billing/checkout/${flowId}`;
    let connected = false;
    let paid = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (url === `${origin}/billing/v1/connections`) {
        return Response.json({ url: checkoutUrl, token }, { status: 201 });
      }
      if (url === `${checkoutUrl}/sms`) {
        assert.equal(init.headers.origin, origin);
        return new Response(null, { status: 204 });
      }
      if (url === `${checkoutUrl}/login`) {
        assert.equal(init.headers.origin, origin);
        connected = true;
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json", "set-cookie": "yf_session=s1; Path=/; HttpOnly" },
        });
      }
      if (url === `${checkoutUrl}/order`) {
        if (!connected || !String(init.headers.cookie ?? "").includes("yf_session=s1")) {
          return Response.json({ error: "请先登录" }, { status: 401 });
        }
        if (paid) return Response.json({ active: true }, { status: 200 });
        return Response.json({ qr: "iVBORw0KGgo=", amountFen: 2990, expiresAt: "2026-11-13T21:00:00.000Z" }, { status: 200 });
      }
      if (url === `${origin}/billing/v1/entitlement`) {
        return Response.json({ connected: paid, pending: !paid, active: paid, entitlement: "inkmap.pro", account: paid ? "178****9014" : undefined });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const svc = licenseService({ read: async () => saved, write: async v => { saved = v; } }, () => origin);
    try {
      assert.deepEqual(await svc.orderPro(), { status: "needsPhone" });
      assert.equal((await svc.sendPhoneCode("17801509014")).ok, true);
      const signedIn = await svc.signInByPhone("17801509014", "660037");
      assert.equal(signedIn.ok, true);
      assert.equal(signedIn.value.account, "178****9014");

      const qrOrder = await svc.orderPro();
      assert.equal(qrOrder.status, "qr");
      assert.equal(qrOrder.amountFen, 2990);
      assert.equal(qrOrder.qr, "data:image/png;base64,iVBORw0KGgo=");

      paid = true;
      const activeOrder = await svc.orderPro();
      assert.equal(activeOrder.status, "active");
      assert.equal(activeOrder.state.pro, true);
    } finally {
      svc.dispose();
      globalThis.fetch = realFetch;
    }
  });

  it("auto-completes Category 2 login via X-Inkmap-Pending-Token when the user clicks the email magic link", async () => {
    let saved;
    const origin = "https://billing.example.com";
    const pendingToken = "m".repeat(43);
    let magicClicked = false;
    let paid = false;
    const states = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (url === `${origin}/billing/v1/phone-sign-in/send`) {
        return new Response(null, {
          status: 204,
          headers: { "x-inkmap-pending-token": pendingToken },
        });
      }
      if (url === `${origin}/billing/v1/entitlement`) {
        assert.equal(init.headers.authorization, "Bearer " + pendingToken);
        return Response.json({
          connected: magicClicked,
          active: paid,
          pending: !paid,
          entitlement: "inkmap.pro",
          ...(magicClicked && { account: "m***@example.com" }),
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const svc = licenseService({ read: async () => saved, write: async v => { saved = v; } }, () => origin, { loginOnly: true });
    svc.onChange(s => states.push(s));
    try {
      const sent = await svc.sendPhoneCode("magic@example.com", "zh");
      assert.equal(sent.ok, true);
      magicClicked = true;
      await waitFor(() => states.some(s => s.connected === true && s.account === "m***@example.com"), "magic link auto login", 5000);
      assert.equal(JSON.parse(saved).token, pendingToken);
      paid = true;
      await waitFor(() => states.some(s => s.pro === true), "magic link auto Pro unlock", 5000);
    } finally {
      svc.dispose();
      globalThis.fetch = realFetch;
    }
  });

  it("flushes plugin_activate and app_open telemetry immediately when requested", async () => {
    const origin = "https://telemetry.example.com";
    const payloads = [];
    const realFetch = globalThis.fetch;
    const prevAllow = process.env.INKMAP_ALLOW_TEST_TELEMETRY;
    const prevHome = process.env.INKMAP_HOME;
    const tmpHome = await mkdtemp(join(tmpdir(), "inkmap-tel-test-"));
    process.env.INKMAP_ALLOW_TEST_TELEMETRY = "1";
    process.env.INKMAP_HOME = tmpHome;
    globalThis.fetch = async (url, init) => {
      if (url === `${origin}/billing/v1/telemetry`) {
        payloads.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    };
    const svc = licenseService({ read: async () => undefined, write: async () => {} }, () => origin, { host: "trae" });
    try {
      svc.track("plugin_activate");
      await svc.flushTelemetry();
      assert.equal(payloads.length, 1);
      assert.equal(payloads[0].host, "trae");
      assert.equal(payloads[0].version, "0.3.10");
      assert.equal(payloads[0].events.app_open, 1);
      assert.equal(payloads[0].events.plugin_activate, 1);
    } finally {
      svc.dispose();
      globalThis.fetch = realFetch;
      if (prevAllow === undefined) delete process.env.INKMAP_ALLOW_TEST_TELEMETRY;
      else process.env.INKMAP_ALLOW_TEST_TELEMETRY = prevAllow;
      if (prevHome === undefined) delete process.env.INKMAP_HOME;
      else process.env.INKMAP_HOME = prevHome;
      await rm(tmpHome, { recursive: true, force: true });
    }
  });
});
