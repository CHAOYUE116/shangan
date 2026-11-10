#!/usr/bin/env node
/**
 * tools/fenbi-coverage.mjs — 粉笔题库覆盖度盘点
 *
 * 做法：逐个点开 guide 页左侧的分类，旁听 `/api/{course}/papers/v2` 的响应，
 * 拿到每个分类的 labelId 与 totalItem（该分类下粉笔一共有多少套卷），
 * 再和本地 `papers` 表按「归一化卷名」比对，找出我们还没采的。
 *
 * 用法：
 *   node tools/fenbi-coverage.mjs                    # 全科目全分类
 *   node tools/fenbi-coverage.mjs --course xingce    # 只盘行测
 *   node tools/fenbi-coverage.mjs --max-cats 5       # 每个科目只点前 5 个分类（试跑）
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(import.meta.dirname, '..');
const PROFILE = path.resolve(ROOT, '..', 'research', 'fenbi', 'browser-profile');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const COMMON = 'app=web&kav=131&av=134&hav=128&apcid=0';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const COURSES = arg('course') ? [arg('course')] : ['xingce', 'shenlun', 'sydw', 'syzc', 'zhyynl'];
const MAX_CATS = Number(arg('max-cats', 0));
const OUT = path.resolve(ROOT, arg('out', '../research/fenbi-coverage.json'));

/** 卷名归一：去掉「（网友回忆版）」这类尾巴、空格与全角标点，只留年份+地区+考试名 */
export function normTitle(s) {
  return String(s || '')
    .replace(/[（(][^）)]{0,12}(回忆|网友|考生|整理)[^）)]{0,6}[）)]/g, '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[《》「」【】()（）·・—\-_/、,，。.:：;；!！?？"'"']/g, '')
    .toLowerCase();
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME, headless: true, viewport: { width: 1400, height: 1000 },
});
const page = ctx.pages()[0] || (await ctx.newPage());

let last = null;
page.on('response', async (res) => {
  const u = res.url();
  if (!u.includes('/papers/v2')) return;
  try {
    const j = await res.json();
    if (j && j.pageInfo) last = { url: u, total: j.pageInfo.totalItem, list: j.list || [] };
  } catch { /* ignore */ }
});

const out = [];
for (const course of COURSES) {
  await page.goto(`https://www.fenbi.com/spa/tiku/guide/realTest/sydw/${course}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const n = await page.$$eval('.categories-item', (els) => els.length).catch(() => 0);
  const take = MAX_CATS > 0 ? Math.min(MAX_CATS, n) : n;
  console.log(`\n== ${course}: ${n} 个分类，本次点 ${take} 个`);
  for (let i = 0; i < take; i++) {
    const name = await page.evaluate((i) => {
      const el = document.querySelectorAll('.categories-item')[i];
      return el ? el.textContent.trim() : null;
    }, i).catch(() => null);
    if (!name) continue;
    last = null;
    await page.evaluate((i) => document.querySelectorAll('.categories-item')[i]?.click(), i).catch(() => {});
    for (let t = 0; t < 12 && !last; t++) await page.waitForTimeout(250);
    const labelId = last ? Number((last.url.match(/labelId=(\d+)/) || [])[1] || 0) : 0;
    const titles = last ? last.list.map((p) => (p.name || p.title || '').trim()).filter(Boolean) : [];
    console.log(`  ${String(i + 1).padStart(2)}. ${name}\tlabel=${labelId}\t共 ${last ? last.total : '?'} 套\t首页 ${titles.length} 条`);
    out.push({ course, cat: name, labelId, total: last ? last.total : null, sample: titles.slice(0, 3) });
    await page.waitForTimeout(300);
  }
}
await ctx.close();

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
console.log(`\n分类清单已写 ${OUT}（${out.length} 条）`);

// 对比本地题库
const db = new DatabaseSync(path.resolve(ROOT, 'app-assets/tiku_app.db'), { readOnly: true });
const rows = db.prepare('SELECT subjectName, name FROM papers').all();
const have = new Set(rows.map((r) => normTitle(r.name)));
const byCourse = { xingce: '公务员·行测', shenlun: '公务员·申论', sydw: '事业编·公基', syzc: '事业编·职测', zhyynl: '事业编·综应' };
const fenbiTotal = {};
for (const r of out) fenbiTotal[r.course] = (fenbiTotal[r.course] || 0) + (r.total || 0);

console.log('\n=== 覆盖对比（粉笔分类合计 vs 本地卷数）===');
for (const [c, subj] of Object.entries(byCourse)) {
  const mine = rows.filter((r) => r.subjectName === subj).length;
  console.log(`${c.padEnd(8)} ${subj.padEnd(12)} 粉笔 ${String(fenbiTotal[c] || 0).padStart(5)} 套 / 本地 ${String(mine).padStart(5)} 套`);
}

// 首页样例里出现、但本地没有的卷（只覆盖每个分类的前 15 条，作为「漏采线索」）
const missing = [];
for (const r of out) {
  for (const t of r.sample) if (!have.has(normTitle(t))) missing.push({ course: r.course, cat: r.cat, title: t });
}
console.log(`\n=== 首页样例中本地没有的卷：${missing.length} 条（每分类最多 3 条样本）===`);
missing.slice(0, 40).forEach((m) => console.log(`  [${m.course}/${m.cat}] ${m.title}`));
