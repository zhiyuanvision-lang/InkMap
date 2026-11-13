// Renders the store screenshots from the built editor:  node scripts/screenshots.mjs [outDir]
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { fileSource, serve } from "../../cli/dist/server.js";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WEB_ROOT = fileURLToPath(new URL("../dist/web/", import.meta.url));
const out = process.argv[2] ?? fileURLToPath(new URL("../images/", import.meta.url));

const ZH = `---
title: 留学第一个月
---

## 留学第一个月

- 落地第一周
  - 办电话卡和银行卡
  - 注册 **学生证** 与校园网
  - 熟悉宿舍周边：超市、药店、公交
- 课程与学业
  - 选课：必修 / 选修
  - 了解 \`Office Hour\` 和助教
  - 作业规范
    | 项目 | 要求 |
    | --- | --- |
    | 引用格式 | APA 7 |
    | 查重 | Turnitin |
- 日常英语
  - 点餐与付款
  - 看病与预约
  - 和室友沟通
- 社交与安全
  - 加入社团
  - 紧急电话与保险
`;

const EN = `---
title: First Month Abroad
---

## First Month Abroad

- Week one
  - SIM card and bank account
  - Register **student ID** and campus Wi-Fi
  - Explore the area: groceries, pharmacy, buses
- Classes
  - Pick courses: core / electives
  - Find \`office hours\` and TAs
  - Assignment rules
    | Item | Rule |
    | --- | --- |
    | Citations | APA 7 |
    | Plagiarism check | Turnitin |
- Everyday English
  - Ordering and paying
  - Doctor appointments
  - Talking with roommates
- Social life and safety
  - Join a club
  - Emergency numbers and insurance
`;

const pro = { state: async () => ({ pro: true }), onChange: () => () => {} };
const free = { ...pro, state: async () => ({ pro: false, trialUntil: Date.now() + 7 * 24 * 60 * 60 * 1000 }) };

const dir = await mkdtemp(join(tmpdir(), "inkmap-shots-"));
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run", "--hide-scrollbars"] });

async function shot(name, { md, lang, license, setup, width = 1280, height = 800 }) {
  const file = join(dir, `${name}.md`);
  await writeFile(file, md);
  const served = await serve({ source: await fileSource(file), webRoot: WEB_ROOT, port: 0, license, ads: async () => [] });
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument(lang => Object.defineProperty(navigator, "language", { get: () => lang }), lang);
  await page.goto(served.url);
  await page.waitForFunction(() => window.inkmap?.mindMap);
  await page.evaluate(() => window.inkmap.mindMap.execCommand("EXPAND_ALL"));
  await new Promise(r => setTimeout(r, 600));
  await page.evaluate(() => window.inkmap.mindMap.view.fit());
  await new Promise(r => setTimeout(r, 1800));
  if (setup) await setup(page);
  await page.screenshot({ path: join(out, `${name}.png`) });
  await page.close();
  await served.close();
  console.log(join(out, `${name}.png`));
}

const pick = (id, value) => async page => {
  await page.select(id, value);
  await new Promise(r => setTimeout(r, 400));
  await page.evaluate(() => window.inkmap.mindMap.view.fit());
  await new Promise(r => setTimeout(r, 800));
};

const only = process.env.SHOTS?.split(",");
const shots = {
  "editor-zh": { md: ZH, lang: "zh-CN", license: free },
  "editor-en": { md: EN, lang: "en-US", license: free },
  "upgrade-zh": { md: ZH, lang: "zh-CN", license: free, setup: page => page.evaluate(() => window.inkmap.pro.openUpgrade()) },
  "upgrade-en": { md: EN, lang: "en-US", license: free, setup: page => page.evaluate(() => window.inkmap.pro.openUpgrade()) },
  "org-chart": { md: EN, lang: "en-US", license: pro, setup: pick("#layout-select", "organizationStructure") },
  "dark-zh": { md: ZH, lang: "zh-CN", license: pro, setup: async page => { await pick("#theme-select", "dusk")(page); await pick("#layout-select", "mindMap")(page); } },
  "timeline": { md: EN, lang: "en-US", license: pro, setup: pick("#layout-select", "timeline") },
};
for (const [name, opts] of Object.entries(shots)) if (!only || only.includes(name)) await shot(name, opts);
await browser.close();
