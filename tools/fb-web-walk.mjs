// 粉笔网页端全流程走查（用已登录的浏览器 profile 副本）
// 用法：node tools/fb-web-walk.mjs step1
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = 'D:\\Projects\\上岸APP\\research\\fenbi\\profile-walk';
const OUT = 'D:\\Projects\\上岸APP\\research\\fenbi-web-shots';
fs.mkdirSync(OUT, { recursive: true });

const step = process.argv[2] || 'step1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: false,
  viewport: { width: 1280, height: 960 },
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
const pages = ctx.pages();
const page = pages.length ? pages[0] : await ctx.newPage();

const shot = async (n) => {
  const p = path.join(OUT, n + '.png');
  await page.screenshot({ path: p });
  console.log('shot', p);
};
const text = async () => (await page.evaluate(() => document.body.innerText)).replace(/\n{2,}/g, '\n').slice(0, 1200);

try {
  if (step === 'step1') {
    await page.goto('https://fenbi.com/spa/tiku/guide/catalog', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(7000);
    console.log('URL', page.url());
    console.log('TITLE', await page.title());
    console.log('---TEXT---\n' + (await text()));
    await shot('01-catalog');
  }
} catch (e) {
  console.log('ERR', e.message);
} finally {
  await ctx.close();
}
