import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { licenseService } from "../dist/license.js";

const origin = "https://billing.example.com";

/** Runs `run` with INKMAP_HOME in a temporary folder, so the trial clock never touches ~/.inkmap. */
async function withHome(t, run) {
  const home = await mkdtemp(join(tmpdir(), "inkmap-license-"));
  const saved = process.env.INKMAP_HOME;
  process.env.INKMAP_HOME = home;
  t.after(async () => {
    if (saved === undefined) delete process.env.INKMAP_HOME;
    else process.env.INKMAP_HOME = saved;
    await rm(home, { recursive: true, force: true });
  });
  return run(home);
}

function fakeFetch(t, handler) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init);
  t.after(() => { globalThis.fetch = realFetch; });
}

test("remembers the last sign-in email across sign-out and restarts", async t => {
  await withHome(t, async () => {
    let saved;
    const storage = { read: async () => saved, write: async value => { saved = value; } };
    fakeFetch(t, url => {
      if (url === `${origin}/billing/v1/phone-sign-in/send`) return new Response(null, { status: 204 });
      if (url === `${origin}/billing/v1/phone-sign-in/verify`) return Response.json({ token: "s".repeat(43) }, { status: 201 });
      if (url === `${origin}/billing/v1/entitlement`) {
        return Response.json({ connected: true, active: true, entitlement: "inkmap.pro", account: "a***@example.com" });
      }
      return new Response(null, { status: 204 });
    });

    const first = licenseService(storage, () => origin, { loginOnly: true });
    t.after(() => first.dispose());
    assert.equal((await first.state()).lastSignIn, undefined);
    assert.equal((await first.sendPhoneCode("Alice@Example.com")).ok, true);
    assert.equal((await first.state()).lastSignIn, "Alice@Example.com");
    assert.equal((await first.signInByPhone("Alice@Example.com", "123456")).ok, true);
    assert.equal(JSON.parse(saved).lastSignIn, "Alice@Example.com");

    await first.deactivate();
    assert.deepEqual(JSON.parse(saved), { lastSignIn: "Alice@Example.com" }, "sign-out keeps only the remembered email");
    const afterSignOut = await first.state();
    assert.equal(afterSignOut.connected, undefined);
    assert.equal(afterSignOut.lastSignIn, "Alice@Example.com");

    const restarted = licenseService(storage, () => origin, { loginOnly: true });
    t.after(() => restarted.dispose());
    assert.equal((await restarted.state()).lastSignIn, "Alice@Example.com");
  });
});

const DAY = 24 * 60 * 60 * 1000;
const POLL = 20;

/** A home folder whose trial started 8 days ago, i.e. a 7-day trial that is over. */
async function withExpiredTrial(t, run) {
  return withHome(t, async home => {
    await writeFile(join(home, "trial-start"), String(Date.now() - 8 * DAY));
    return run(home);
  });
}

/**
 * The billing server's email flow (ZhiyuanPlatform internal/billing): each email send returns a new pending token,
 * the email's button binds that token to the account, typing the code returns a separate token, and Pro belongs to
 * the account, so a payment makes every token bound to it active.
 */
function fakeBilling(t) {
  const tokens = new Map();
  const paid = new Set();
  const sent = [];
  let counter = 0;
  const newToken = () => String(++counter).padStart(43, "t");
  fakeFetch(t, (url, init = {}) => {
    if (url === `${origin}/billing/v1/connections`) return new Response(null, { status: 503 });
    if (url === `${origin}/billing/v1/phone-sign-in/send`) {
      const token = newToken();
      tokens.set(token, { email: JSON.parse(init.body).phone, account: null });
      sent.push(token);
      return new Response(null, { status: 204, headers: { "x-inkmap-pending-token": token } });
    }
    if (url === `${origin}/billing/v1/phone-sign-in/verify`) {
      const token = newToken();
      const email = JSON.parse(init.body).phone;
      tokens.set(token, { email, account: email });
      return Response.json({ token }, { status: 201 });
    }
    if (url === `${origin}/billing/v1/entitlement`) {
      const token = String(init.headers?.authorization ?? "").slice("Bearer ".length);
      const entry = tokens.get(token);
      if (init.method === "DELETE") {
        tokens.delete(token);
        return new Response(null, { status: 204 });
      }
      if (!entry) return Response.json({ error: "请重新登录" }, { status: 401 });
      const connected = Boolean(entry.account);
      const active = connected && paid.has(entry.account);
      return Response.json({
        connected,
        active,
        entitlement: "inkmap.pro",
        pending: !active,
        ...(connected && { account: entry.account.replace(/^(.).*@/, "$1***@") }),
      });
    }
    return new Response(null, { status: 204 });
  });
  return {
    sent,
    /** The user opens the email and presses its button (which also leads to payment). */
    click: token => { tokens.get(token).account = tokens.get(token).email; },
    pay: email => paid.add(email),
    bind: (token, email) => tokens.set(token, { email, account: email }),
  };
}

function trackedService(t, storage, options) {
  const svc = licenseService(storage, () => origin, { waitPollMs: POLL, ...options });
  t.after(() => svc.dispose());
  const states = [];
  svc.onChange(state => states.push(state));
  return { svc, states };
}

async function eventually(check, label, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(ok => setTimeout(ok, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}
const settleFewPolls = () => new Promise(ok => setTimeout(ok, POLL * 6));

test("after the trial, pressing the email button only signs in once the payment is made", async t => {
  await withExpiredTrial(t, async () => {
    let saved;
    const billing = fakeBilling(t);
    const { svc } = trackedService(t, { read: async () => saved, write: async v => { saved = v; } }, { loginOnly: true });
    await svc.state();
    assert.equal((await svc.sendPhoneCode("buyer@example.com")).ok, true);
    billing.click(billing.sent[0]);
    await settleFewPolls();
    assert.equal((await svc.state()).connected, undefined, "an account without Pro stays signed out");

    billing.pay("buyer@example.com");
    await eventually(async () => (await svc.state()).pro, "automatic Pro sign-in");
    assert.equal(JSON.parse(saved).token, billing.sent[0]);
  });
});

test("after the trial, a typed code without Pro reports notPro, and paying later signs in without the code", async t => {
  await withExpiredTrial(t, async () => {
    let saved;
    const billing = fakeBilling(t);
    const { svc } = trackedService(t, { read: async () => saved, write: async v => { saved = v; } }, { loginOnly: true });
    await svc.sendPhoneCode("late@example.com");
    assert.deepEqual(await svc.signInByPhone("late@example.com", "123456"), { ok: false, reason: "notPro" });
    assert.equal((await svc.state()).connected, undefined);
    assert.equal(JSON.parse(saved).token, undefined, "no session is stored");

    // The email's link expired, so the user paid on a checkout page: the account still gets Pro.
    billing.pay("late@example.com");
    await eventually(async () => (await svc.state()).pro, "automatic Pro sign-in with the verified token");
  });
});

test("a resent code does not abandon the first email's button", async t => {
  await withExpiredTrial(t, async () => {
    let saved;
    const billing = fakeBilling(t);
    const { svc } = trackedService(t, { read: async () => saved, write: async v => { saved = v; } }, { loginOnly: true });
    await svc.sendPhoneCode("twice@example.com");
    await svc.sendPhoneCode("twice@example.com");
    billing.click(billing.sent[0]);
    billing.pay("twice@example.com");
    await eventually(async () => (await svc.state()).pro, "sign-in through the first email");
    assert.equal(JSON.parse(saved).token, billing.sent[0]);
  });
});

test("during the trial, pressing the email button signs in right away", async t => {
  await withHome(t, async () => {
    let saved;
    const billing = fakeBilling(t);
    const { svc, states } = trackedService(t, { read: async () => saved, write: async v => { saved = v; } }, { loginOnly: true });
    await svc.state();
    await svc.sendPhoneCode("trial@example.com");
    billing.click(billing.sent[0]);
    await eventually(() => states.some(s => s.connected === true && !s.pro), "sign-in without Pro during the trial");
  });
});

test("after the trial, a signed-in account without Pro is signed out but signs back in once it pays", async t => {
  await withExpiredTrial(t, async () => {
    const billing = fakeBilling(t);
    const session = "s".repeat(43);
    billing.bind(session, "member@example.com");
    let saved = JSON.stringify({ origin, token: session, lastSignIn: "member@example.com" });
    const { svc } = trackedService(t, { read: async () => saved, write: async v => { saved = v; } }, { loginOnly: true });
    const parked = await svc.state();
    assert.equal(parked.connected, undefined);
    assert.equal(parked.lastSignIn, "member@example.com", "the form is prefilled with the account's email");
    assert.equal(JSON.parse(saved).token, undefined);

    billing.pay("member@example.com");
    await eventually(async () => (await svc.state()).pro, "automatic sign-in after paying");
    assert.equal(JSON.parse(saved).token, session);
  });
});

test("a signed-in account that already has Pro is never signed out", async t => {
  await withExpiredTrial(t, async () => {
    const billing = fakeBilling(t);
    const session = "p".repeat(43);
    billing.bind(session, "pro@example.com");
    billing.pay("pro@example.com");
    let saved = JSON.stringify({ origin, token: session });
    const { svc } = trackedService(t, { read: async () => saved, write: async v => { saved = v; } }, { loginOnly: true });
    const state = await svc.state();
    assert.equal(state.pro, true);
    assert.equal(JSON.parse(saved).token, session);
  });
});

test("waiting for the email's button survives a restart", async t => {
  await withExpiredTrial(t, async () => {
    let saved;
    const storage = { read: async () => saved, write: async v => { saved = v; } };
    const billing = fakeBilling(t);
    const first = licenseService(storage, () => origin, { loginOnly: true, waitPollMs: POLL });
    await first.sendPhoneCode("restart@example.com");
    first.dispose();
    assert.equal(JSON.parse(saved).waiting.length, 1);

    const { svc } = trackedService(t, storage, { loginOnly: true });
    await svc.state();
    billing.click(billing.sent[0]);
    billing.pay("restart@example.com");
    await eventually(async () => (await svc.state()).pro, "sign-in after the restart");
  });
});

test("purchase hosts sign in from a direct email's button without waiting for payment", async t => {
  await withExpiredTrial(t, async () => {
    let saved;
    const billing = fakeBilling(t);
    const { svc, states } = trackedService(t, { read: async () => saved, write: async v => { saved = v; } });
    assert.equal((await svc.sendPhoneCode("buyer@example.com")).ok, true, "falls back to the direct email");
    billing.click(billing.sent[0]);
    await eventually(() => states.some(s => s.connected === true), "sign-in so the in-plugin checkout can be shown");
  });
});
