// 粉笔网页端 step4b：用 JS 点击「事业单位」，再打开第一张卷
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = 'D:\\Projects\\上岸APP\\research\\fenbi\\browser-profile';
const OUT = 'D:\\Projects\\上岸APP\\research\\fenbi-web-shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME, headless: false,
  viewport: { width: 1280, height: 960 },
  args: ['--no-sandbox'],
});
const page = ctx.pages()[0] || (await ctx.newPage());
const shot = async (n) => { const p = path.join(OUT, n + '.png'); await page.screenshot({ path: p }); console.log('shot', p); };
const text = async () => (await page.evaluate(() => document.body.innerText)).replace(/\n{2,}/g, '\n');

try {
  await page.goto('https://fenbi.com/spa/tiku/guide/catalog', { waitUntil: 'domcontentloaded' });
  await sleep(6000);
  const clicked = await page.evaluate(() => {
    const els = [...document.querySelectorAll('a,div,span,li')];
    const el = els.find((e) => e.children.length === 0 && (e.textContent || '').trim() === '事业单位');
    if (!el) return 'notfound';
    el.click();
    return 'clicked';
  });
  console.log('click', clicked);
  await sleep(5000);
  console.log('url', page.url());
  console.log('---TEXT---\n' + (await text()).slice(0, 1000));
  await shot('04b-sydw');
} catch (e) {
  console.log('ERR', e.message);
} finally {
  await ctx.close();
}
