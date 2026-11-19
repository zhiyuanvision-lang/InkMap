import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAppleLanguages, resolveOsLocale } from "../dist/license.js";
import { uriToPath } from "../dist/workspace-fs.js";

const probe = overrides => ({
  platform: "linux",
  env: {},
  timeZone: "UTC",
  intlLocale: "en-US",
  run: () => {
    throw new Error("ENOENT");
  },
  ...overrides,
});

test("parseAppleLanguages reads the first language, quoted or not", () => {
  assert.equal(parseAppleLanguages('(\n    "zh-Hans-CN",\n    "en-US"\n)\n'), "zh-Hans-CN");
  assert.equal(parseAppleLanguages('(\n    en,\n    "zh-Hans"\n)\n'), "en");
  assert.equal(parseAppleLanguages("(\n)\n"), "");
});

test("the edition follows the OS time zone or OS language only", () => {
  assert.equal(resolveOsLocale(probe({ timeZone: "Asia/Shanghai" })), "zh");
  assert.equal(resolveOsLocale(probe({ timeZone: "PRC" })), "zh");
  assert.equal(resolveOsLocale(probe({ env: { LANG: "zh_CN.UTF-8" } })), "zh");
  assert.equal(resolveOsLocale(probe({ env: { LC_ALL: "C", LANG: "zh_CN.UTF-8" } })), "en", "LC_ALL wins");
  assert.equal(resolveOsLocale(probe({ env: { LANG: "zhx" } })), "en");
  assert.equal(resolveOsLocale(probe({ env: { LANG: "en_US.UTF-8" } })), "en");
});

test("macOS uses the first AppleLanguages entry, and LANG only when defaults fails", () => {
  const defaults = output => () => output;
  assert.equal(resolveOsLocale(probe({ platform: "darwin", run: defaults('(\n    "zh-Hans-US",\n    en\n)\n') })), "zh");
  assert.equal(
    resolveOsLocale(probe({ platform: "darwin", run: defaults('(\n    en,\n    "zh-Hans"\n)\n'), env: { LANG: "zh_CN.UTF-8" } })),
    "en",
  );
  assert.equal(resolveOsLocale(probe({ platform: "darwin", env: { LANG: "zh_CN.UTF-8" } })), "zh");
});

test("Windows reads LocaleName from the registry, else Intl", () => {
  const reg = output => () => output;
  assert.equal(resolveOsLocale(probe({ platform: "win32", run: reg("\r\n    LocaleName    REG_SZ    zh-CN\r\n") })), "zh");
  assert.equal(resolveOsLocale(probe({ platform: "win32", run: reg("\r\n    LocaleName    REG_SZ    en-US\r\n"), intlLocale: "zh-CN" })), "en");
  assert.equal(resolveOsLocale(probe({ platform: "win32", intlLocale: "zh-CN" })), "zh");
});

test("INKMAP_LOCALE overrides detection", () => {
  assert.equal(resolveOsLocale(probe({ timeZone: "Asia/Shanghai", env: { INKMAP_LOCALE: "en" } })), "en");
  assert.equal(resolveOsLocale(probe({ env: { INKMAP_LOCALE: "zh_CN.UTF-8" } })), "zh");
});

test("uriToPath decodes file URIs for the given platform", () => {
  assert.equal(uriToPath("file:///c%3A/Users/me/notes.md", "win32"), "c:\\Users\\me\\notes.md");
  assert.equal(uriToPath("file:///C%3a/a%20b/%E4%B8%AD.md", "win32"), "C:\\a b\\中.md");
  assert.equal(uriToPath("file:///c%3A", "win32"), "c:\\");
  assert.equal(uriToPath("C:\\work\\x.md", "win32"), "C:\\work\\x.md");
  assert.equal(uriToPath("file:///home/u/a%20b.md", "linux"), "/home/u/a b.md");
  assert.equal(uriToPath("relative/x.md", "linux"), null);
  assert.equal(uriToPath("C:\\work\\x.md", "linux"), null);
  assert.equal(uriToPath("file:///a%E0%A4%A", "linux"), null);
  assert.equal(uriToPath("   "), null);
});
