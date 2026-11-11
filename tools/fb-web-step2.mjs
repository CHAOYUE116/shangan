// 粉笔网页端全流程走查 step2：打开一份整卷，进入作答
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = 'D:\\Projects\\上岸APP\\research\\fenbi\\profile-walk';
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
const urls = async () => page.evaluate(() => location.href);

try {
  await page.goto('https://fenbi.com/spa/tiku/guide/catalog', { waitUntil: 'domcontentloaded' });
  await sleep(6000);
  console.log('catalog url', await urls());
  // 点第一张卷子
  await page.getByText('2026年国家公务员录用考试《行测》题（行政执法卷网友回忆版）').first().click();
  await sleep(4000);
  console.log('after click url', await urls());
  console.log('---TEXT---\n' + (await text()).slice(2, 1200));
  await shot('02-after-click');
} catch (e) {
  console.log('ERR', e.message);
} finally {
  await ctx.close();
}
