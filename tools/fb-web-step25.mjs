// 粉笔网页端 step25：整卷作答 8 题 → 交卷 → 抓成绩报告
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
  await sleep(7000);
  const pos = await page.evaluate(() => {
    const el = [...document.querySelectorAll('div,span,a')].find((e) => (e.textContent || '').trim().startsWith('2026年4月25日浙江省事业单位统考'));
    if (!el) return 'no';
    const b = el.getBoundingClientRect();
    return Math.round(b.x + b.width / 2) + ',' + Math.round(b.y + b.height / 2);
  });
  if (pos !== 'no') { const [x, y] = pos.split(',').map(Number); await page.mouse.click(x, y); }
  await sleep(9000);
  log('url', page.url());
  if (!page.url().includes('/exam/')) { log('NOT IN EXAM'); await shot('25-notin'); }
  else {
    // 答前 10 题：每题点第一个选项
    const n = await page.evaluate(() => {
      const groups = new Map();
      document.querySelectorAll('label.choice-radio-label').forEach((lb) => {
        const q = lb.closest('[class*="question"], .question-item, section, li') || lb.parentElement;
        if (!groups.has(q)) groups.set(q, []);
        groups.get(q).push(lb);
      });
      let i = 0;
      for (const [, labels] of groups) {
        if (i >= 10) break;
        const pick = labels[i % labels.length] || labels[0];
        pick.querySelector('input').click();
        i++;
      }
      return i;
    });
    log('answered', n);
    await sleep(2000);
    await shot('25-answered');

    // 答题卡
    const sheetCount = await page.evaluate(() => {
      const el = [...document.querySelectorAll('div,span')].find((e) => /答题卡\s*\d+\/\d+/.test((e.textContent || '').trim()));
      return el ? (el.textContent || '').trim().slice(0, 20) : 'no';
    });
    log('answer sheet', sheetCount);

    // 交卷
    const sub = await page.evaluate(() => {
      const el = [...document.querySelectorAll('button,a,div,span')].find((e) => (e.textContent || '').trim() === '交卷');
      if (!el) return 'no';
      const b = el.getBoundingClientRect();
      return Math.round(b.x + b.width / 2) + ',' + Math.round(b.y + b.height / 2);
    });
    log('submit', sub);
    if (sub !== 'no') {
      const [sx, sy] = sub.split(',').map(Number);
      await page.mouse.click(sx, sy);
      await sleep(3000);
      await shot('26-submit-modal');
      // 确认
      const conf = await page.evaluate(() => {
        const el = [...document.querySelectorAll('button,a,div,span')].find((e) => /^(确认交卷|确认|确定)$/.test((e.textContent || '').trim()));
        if (!el) return 'no';
        const b = el.getBoundingClientRect();
        return (el.textContent || '').trim() + '@' + Math.round(b.x + b.width / 2) + ',' + Math.round(b.y + b.height / 2);
      });
      log('confirm', conf);
      if (conf !== 'no') {
        const [, c] = conf.split('@');
        const [cx, cy] = c.split(',').map(Number);
        await page.mouse.click(cx, cy);
      }
      await sleep(9000);
      log('after url', page.url());
      const t = (await page.evaluate(() => document.body.innerText)).replace(/\n{2,}/g, '\n');
      log('---REPORT---\n' + t.slice(0, 1800));
      await shot('27-report');
      await page.mouse.wheel(0, 700);
      await sleep(1500);
      await shot('28-report-scroll');
    }
  }
} catch (e) {
  log('ERR', e.message);
} finally {
  await ctx.close();
}
