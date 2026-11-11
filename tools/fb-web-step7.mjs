// 粉笔网页端 step7：点「快速练习」，看配置弹层
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
  await sleep(7000);
  await page.getByText('快速练习', { exact: true }).first().click();
  await sleep(3000);
  console.log('url', page.url());
  console.log('---TEXT---\n' + (await text()).slice(0, 1200));
  await shot('07-quick-cfg');
} catch (e) {
  console.log('ERR', e.message);
} finally {
  await ctx.close();
}
