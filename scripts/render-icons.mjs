#!/usr/bin/env node
/**
 * `npm run icons`: renders the app icon and logo from their SVG sources in assets/ to the PNG
 * files Home Assistant shows (ventilairsec2mqtt/icon.png 128 × 128, logo.png 250 × 100,
 * transparent background), with a headless Chromium driven by Playwright.
 *
 * Playwright is not a dependency of this project: install it anywhere with its Chromium and
 * point PLAYWRIGHT at its entry module, e.g.
 *   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs npm run icons
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const module = process.env.PLAYWRIGHT;
const { chromium } = await import(
  module === undefined || module === '' ? 'playwright' : pathToFileURL(module).href
);

const images = [
  { source: 'assets/icon.svg', target: 'ventilairsec2mqtt/icon.png', width: 128, height: 128 },
  { source: 'assets/logo.svg', target: 'ventilairsec2mqtt/logo.png', width: 250, height: 100 },
];

const browser = await chromium.launch();
try {
  for (const { source, target, width, height } of images) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const svg = readFileSync(join(root, source), 'utf8');
    await page.setContent(
      `<!doctype html><html><head><style>html,body{margin:0;background:transparent}` +
        `svg{display:block;width:${width}px;height:${height}px}</style></head>` +
        `<body>${svg}</body></html>`,
    );
    await page.screenshot({ path: join(root, target), omitBackground: true });
    await page.close();
    console.log(`${target} (${width} × ${height})`);
  }
} finally {
  await browser.close();
}
