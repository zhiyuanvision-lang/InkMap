#!/usr/bin/env node
/**
 * Usage: node scripts/sync-icon.mjs <source-svg-or-image-path>
 *
 * Generates all multi-platform icon variants from a single high-resolution square SVG or PNG/JPG:
 *  - packages/vscode/images/icon.svg          (Pure vector SVG when input is .svg, used by Antigravity & DeepSeek)
 *  - packages/vscode/images/icon.png          (256x256 squircle PNG with transparent corners for VS Code / OpenVSX / README)
 *  - packages/vscode/images/icon-512.png      (512x512 full-bleed square PNG for Claude Directory / Codex / Cursor)
 *  - .claude-plugin/icon.png                  (512x512 full-bleed square PNG — required by `claude plugin validate`)
 *  - packages/claude-plugin/.claude-plugin/icon.png (512x512 full-bleed square PNG)
 *  - assets/logo-400.png                      (400x400 squircle PNG for Product Hunt / directories)
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { ROOT as root } from "./lib/bundle-utils.mjs";

const require = createRequire(join(root, "packages", "vscode", "package.json"));
const puppeteer = require("puppeteer-core");

const srcArg = process.argv[2];
if (!srcArg) {
  console.error("Usage: npm run icon:apply -- <path-to-square-svg-or-image>");
  process.exit(1);
}

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const srcPath = resolve(srcArg);
const raw = await readFile(srcPath);
const ext = extname(srcPath).toLowerCase();
const isSvg = ext === ".svg";
const svgText = isSvg ? raw.toString("utf8") : "";
const mime = ext === ".png" ? "image/png" : isSvg ? "image/svg+xml" : "image/jpeg";
const dataUrl = `data:${mime};base64,${raw.toString("base64")}`;

await Promise.all([
  mkdir(join(root, "packages", "vscode", "images"), { recursive: true }),
  mkdir(join(root, ".claude-plugin"), { recursive: true }),
  mkdir(join(root, "packages", "claude-plugin", ".claude-plugin"), { recursive: true }),
  mkdir(join(root, "assets"), { recursive: true }),
]);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage();

  async function renderFromSvg(size, fullBleedSquare, outPath) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    let contentSvg = svgText;
    if (fullBleedSquare) {
      // Expand the outer squircle rect (x="16" y="16" width="480" height="480" rx="108") to full-bleed 512x512 square
      contentSvg = svgText
        .replace(/<rect x="16" y="16" width="480" height="480" rx="108"/g, '<rect x="0" y="0" width="512" height="512" rx="0"')
        .replace(/<rect x="18" y="18" width="476" height="476" rx="106"[^>]*\/>/g, "");
    }
    await page.setContent(`<!doctype html>
<html><head><style>
  html, body { margin: 0; padding: 0; width: ${size}px; height: ${size}px; background: transparent; overflow: hidden; }
  svg { width: ${size}px; height: ${size}px; display: block; }
</style></head><body>${contentSvg}</body></html>`, { waitUntil: "load" });
    await page.screenshot({ path: outPath, omitBackground: !fullBleedSquare });
  }

  async function renderFromBitmap(size, rounded, outPath) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    const radius = rounded ? Math.round(size * 0.215) : 0;
    const inset = rounded ? Math.round(size * 0.03) : 0;
    const inner = size - inset * 2;
    await page.setContent(`<!doctype html>
<html><head><style>
  html, body { margin: 0; padding: 0; width: ${size}px; height: ${size}px; background: transparent; overflow: hidden; }
  .frame {
    position: absolute; left: ${inset}px; top: ${inset}px;
    width: ${inner}px; height: ${inner}px;
    border-radius: ${radius}px; overflow: hidden;
  }
  img { width: 100%; height: 100%; object-fit: cover; display: block; }
</style></head><body><div class="frame"><img src="${dataUrl}" /></div></body></html>`, { waitUntil: "load" });
    await page.screenshot({ path: outPath, omitBackground: rounded });
  }

  const out256 = join(root, "packages", "vscode", "images", "icon.png");
  const out512 = join(root, "packages", "vscode", "images", "icon-512.png");
  const out400 = join(root, "assets", "logo-400.png");
  const outSvg = join(root, "packages", "vscode", "images", "icon.svg");

  if (isSvg) {
    await renderFromSvg(256, false, out256);
    await renderFromSvg(512, true, out512);
    await renderFromSvg(400, false, out400);
    await writeFile(outSvg, svgText.replace(/width="512" height="512"/, 'width="256" height="256"'), "utf8");
  } else {
    await renderFromBitmap(256, true, out256);
    await renderFromBitmap(512, false, out512);
    await renderFromBitmap(400, true, out400);
    const png256Base64 = (await readFile(out256)).toString("base64");
    await writeFile(
      outSvg,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">\n  <image href="data:image/png;base64,${png256Base64}" x="0" y="0" width="256" height="256"/>\n</svg>\n`,
      "utf8",
    );
  }

  await Promise.all([
    copyFile(out512, join(root, ".claude-plugin", "icon.png")),
    copyFile(out512, join(root, "packages", "claude-plugin", ".claude-plugin", "icon.png")),
  ]);

  console.log("[sync-icon] Updated all icon targets (pure SVG, 256px squircle, 512px Claude/Codex full-bleed, 400px directory).");
} finally {
  await browser.close();
}
