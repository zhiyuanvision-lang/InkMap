// Renders images/icon.svg to the 256px PNG the marketplaces require.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const svg = await readFile(new URL("../images/icon.svg", import.meta.url), "utf8");
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 256, height: 256 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg}`);
  const out = fileURLToPath(new URL("../images/icon.png", import.meta.url));
  await page.screenshot({ path: out, omitBackground: true });
  console.log(out);
} finally {
  await browser.close();
}
