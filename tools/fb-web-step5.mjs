// 粉笔网页端 step5：打开第一张行测卷 → 进入作答页（真实登录态）
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
  await page.getByText('2026年国家公务员录用考试《行测》题（行政执法卷网友回忆版）').first().click();
  await sleep(7000);
  console.log('url', page.url());
  const t = await text();
  console.log('LOGIN_MODAL:', /获取验证码/.test(t) ? 'YES' : 'NO');
  console.log('---TEXT---\n' + t.slice(0, 1500));
  await shot('05-paper');
} catch (e) {
  console.log('ERR', e.message);
} finally {
  await ctx.close();
}
