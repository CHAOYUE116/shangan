// 粉笔网页端 step3：用采集用的真实 profile 检查登录态并打开整卷
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
  const t = await text();
  console.log('LOGIN_STATE:', /登录\s*\/?\s*注册|获取验证码/.test(t) ? 'NOT_LOGGED_IN' : 'LOGGED_IN');
  console.log('URL', page.url());
  console.log('---HEAD---\n' + t.slice(0, 500));
  await shot('03-catalog-real');
} catch (e) {
  console.log('ERR', e.message);
} finally {
  await ctx.close();
}
