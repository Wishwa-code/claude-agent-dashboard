// Headless screenshots of the dashboard at desktop and phone width, with a sideways-scroll check.
//   node tools/shot.js [url] [out-prefix]     (default http://localhost:4020, ./shot)
// Uses puppeteer-core from the shop repo's visual-check (PUPPETEER_DIR overrides) and Chrome at CHROME.
'use strict';
const os = require('os');
const path = require('path');
const puppeteer = require(path.join(process.env.PUPPETEER_DIR ||
  path.join(os.homedir(), 'Desktop/shopify-shop-demo/claude/scripts/visual-check/node_modules'), 'puppeteer-core'));

(async () => {
  const url = process.argv[2] || 'http://localhost:4020', out = process.argv[3] || 'shot';
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  let bad = 0;
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage();
      await page.setViewport({ width, height: 900 });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(url, { waitUntil: 'networkidle2' });
      await new Promise(r => setTimeout(r, 2500)); // first poll, tasks and tokens
      const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      await page.screenshot({ path: `${out}-${width}.png`, fullPage: true });
      const ok = sw <= cw && !errors.length;
      if (!ok) bad++;
      console.log(`${width}px: ${sw <= cw ? 'no sideways scroll' : `SIDEWAYS SCROLL ${sw} > ${cw}`}${errors.length ? '; page errors: ' + errors.join(' | ') : ''} -> ${out}-${width}.png`);
      await page.close();
    }
  } finally { await browser.close(); }
  process.exit(bad ? 1 : 0);
})();
