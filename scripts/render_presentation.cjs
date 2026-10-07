// Render and verify the offline deck with the project's existing Playwright.
const { chromium } = require('../frontend/node_modules/playwright');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

(async () => {
  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'docs/submission');
  const evidence = path.join(root, 'tmp/review/presentation');
  fs.mkdirSync(evidence, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const results = [];
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    await page.goto(pathToFileURL(path.join(out, 'presentation.html')).href);
    for (const [width, height] of [[1920,1080],[1280,720],[768,1024],[375,667],[667,375]]) {
      await page.setViewportSize({ width, height });
      const overflow = await page.locator('.slide-content').evaluateAll(nodes =>
        nodes.map((el, index) => ({ slide: index + 1, vertical: el.scrollHeight > el.clientHeight + 1, horizontal: el.scrollWidth > el.clientWidth + 1 }))
          .filter(x => x.vertical || x.horizontal));
      results.push({ width, height, overflow });
      await page.locator('.slide').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(evidence, `title-${width}.png`) });
    }
    await page.setViewportSize({width:1280,height:720});
    await page.locator('.slide').first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(100);
    await page.waitForFunction(() => Math.abs(document.querySelectorAll('.slide')[1].getBoundingClientRect().top) < 2);
    await page.pdf({path:path.join(out,'technaryad-pitch.pdf'),printBackground:true,preferCSSPageSize:true});
    fs.writeFileSync(path.join(evidence,'layout.json'),JSON.stringify(results,null,2));
    console.log(JSON.stringify(results));
    if(results.some(r=>r.overflow.length))process.exitCode=1;
  } finally { await browser.close(); }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
