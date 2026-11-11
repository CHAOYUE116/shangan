// 粉笔网页端 step20：等配额恢复 → 打开整卷 → 作答几题 → 交卷 → 抓成绩报告
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = 'D:\\Projects\\上岸APP\\research\\fenbi\\browser-profile';
const OUT = 'D:\\Projects\\上岸APP\\research\\fenbi-web-shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME, headless: false,
  viewport: { width: 1280, height: 960 },
  args: ['--no-sandbox'],
});
const page = ctx.pages()[0] || (await ctx.newPage());
const shot = async (n) => { await page.screenshot({ path: path.join(OUT, n + '.png') }); log('shot', n); };

try {
  await page.goto('https://fenbi.com/spa/tiku/guide/realTest/syzc/syzc', { waitUntil: 'domcontentloaded' });
  await sleep(6000);

  let entered = false;
  for (let attempt = 1; attempt <= 8 && !entered; attempt++) {
    log('attempt', attempt);
    // 点第一份卷
    const pos = await page.evaluate(() => {
      const el = [...document.querySelectorAll('div,span,a')].find((e) => (e.textContent || '').trim().startsWith('2026年4月25日浙江省事业单位统考'));
      if (!el) return 'no';
      const b = el.getBoundingClientRect();
      return Math.round(b.x + b.width / 2) + ',' + Math.round(b.y + b.height / 2);
    });
    if (pos === 'no') { log('paper not found; reload'); await page.goto('https://fenbi.com/spa/tiku/guide/realTest/syzc/syzc'); await sleep(6000); continue; }
    const [x, y] = pos.split(',').map(Number);
    await page.mouse.click(x, y);
    await sleep(7000);
    log('url', page.url());
    if (/\/exam\//.test(page.url())) { entered = true; break; }
    // 被 403 弹回列表或 catalog：等 3 分钟再来
    if (!page.url().includes('realTest')) {
      await page.goto('https://fenbi.com/spa/tiku/guide/realTest/syzc/syzc');
      await sleep(5000);
    }
    await sleep(180000);
  }

  if (!entered) { log('FAILED: quota still blocked after 8 attempts'); }
  else {
    await sleep(6000);
    await shot('20-exam-page');
    const t = (await page.evaluate(() => document.body.innerText)).replace(/\n{2,}/g, '\n');
    log('---EXAM TEXT---\n' + t.slice(0, 700));

    // 答前 6 题：点每题第一个选项
    const clicked = await page.evaluate(() => {
      const opts = [...document.querySelectorAll('[class*="option"]')].filter((e) => /^[A-D]$/.test((e.textContent || '').trim().slice(0, 1)));
      let n = 0;
      const seen = new Set();
      for (const o of opts) {
        const card = o.closest('[class*="question"], [class*="item"]') || o.parentElement;
        if (seen.has(card)) continue;
        seen.add(card);
        o.click();
        n++;
        if (n >= 6) break;
      }
      return n;
    });
    log('clicked options', clicked);
    await sleep(2000);
    await page.mouse.wheel(0, 4000);
    await sleep(1000);
    await shot('21-answered');

    // 找交卷/提交按钮
    const found = await page.evaluate(() => {
      const el = [...document.querySelectorAll('button,a,div,span')].find((e) => /^(交卷|提交|提交答案|完成)$/.test((e.textContent || '').trim()));
      if (!el) return 'no';
      const b = el.getBoundingClientRect();
      return (el.textContent || '').trim() + '@' + Math.round(b.x + b.width / 2) + ',' + Math.round(b.y + b.height / 2);
    });
    log('submit btn', found);
    if (found !== 'no') {
      const [label, coords] = found.split('@');
      const [sx, sy] = coords.split(',').map(Number);
      await page.mouse.click(sx, sy);
      await sleep(2500);
      // 可能弹确认框
      const ok = await page.evaluate(() => {
        const el = [...document.querySelectorAll('button,a,div,span')].find((e) => /^(确认|确定|交卷|提交)$/.test((e.textContent || '').trim()));
        if (!el) return 'no';
        const b = el.getBoundingClientRect();
        return Math.round(b.x + b.width / 2) + ',' + Math.round(b.y + b.height / 2);
      });
      log('confirm', ok);
      if (ok !== 'no') { const [cx, cy] = ok.split(',').map(Number); await page.mouse.click(cx, cy); }
      await sleep(7000);
      log('after submit url', page.url());
      const rt = (await page.evaluate(() => document.body.innerText)).replace(/\n{2,}/g, '\n');
      log('---REPORT---\n' + rt.slice(0, 1500));
      await shot('22-report');
      await page.mouse.wheel(0, 600);
      await sleep(1200);
      await shot('23-report2');
    }
  }
} catch (e) {
  log('ERR', e.message);
} finally {
  await ctx.close();
}
