#!/usr/bin/env node
/**
 * tools/fetch-paper-meta.mjs — 遍历粉笔分类，抓全量试卷元数据（难度/平均分/做题人数/日期）
 * 输出 research/fenbi/paper-meta.json：{ [name]: { difficulty, averageScore, doneCount, date, paperId, category } }
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = 'D:/Projects/上岸APP';
const COURSES = (process.argv.find((a) => a.startsWith('--course=')) || '--course=syzc,xingce,shenlun').split('=')[1].split(',');

const raw = fs.readFileSync(path.join(ROOT, 'kaogong-shuati', 'cookie.txt'), 'utf8').trim();
const cookies = raw.split(/;\s*/).map((kv) => {
  const i = kv.indexOf('=');
  return { name: kv.slice(0, i), value: kv.slice(i + 1), domain: '.fenbi.com', path: '/' };
}).filter((c) => c.name);

const b = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await b.newContext();
await ctx.addCookies(cookies);
const p = await ctx.newPage();

const outPath = path.join(ROOT, 'research', 'fenbi', 'paper-meta.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
let all = {};
if (fs.existsSync(outPath)) { try { all = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch {} }

for (const course of COURSES) {
  const guide = course === 'shenlun'
    ? `https://www.fenbi.com/spa/tiku/guide/shenlunList/${course}/1000`
    : `https://www.fenbi.com/spa/tiku/guide/realTest/sydw/${course}`;
  await p.goto(guide, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(3000);

  const cats = await p.evaluate(() => [...document.querySelectorAll('.categories-item')].map((e) => e.innerText.trim()).filter(Boolean));
  console.log(`[${course}] ${cats.length} 个分类`);

  let hits = [];
  p.removeAllListeners('request');
  p.on('request', (r) => { if (/papers\/v2/.test(r.url())) hits.push(r.url()); });

  let total = 0;
  for (const cat of cats) {
    const el = p.locator('.categories-item', { hasText: new RegExp('^' + cat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }).first();
    if (!(await el.count())) continue;
    hits = [];
    await el.click({ timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(1600);
    const u = hits[hits.length - 1];
    if (!u) continue;
    const qs = new URL(u).searchParams;
    const examcatid = qs.get('examcatid') || '';
    // 用抓到的分类 id 翻页拉全
    const got = await p.evaluate(async ({ course, examcatid }) => {
      const list = [];
      for (let page = 0; page < 20; page++) {
        const url = `https://tiku.fenbi.com/api/${course}/papers/v2?labelId=0&toPage=${page}&pageSize=100&app=web${examcatid ? `&examcatid=${examcatid}` : ''}`;
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) break;
        const j = await r.json();
        const arr = j.list || [];
        for (const x of arr) list.push({ name: x.name, date: x.date, d: x.paperMeta?.difficulty, a: x.paperMeta?.averageScore, c: x.paperMeta?.exerciseCount, id: x.id });
        if (arr.length < 100) break;
      }
      return list;
    }, { course, examcatid }).catch(() => []);

    for (const it of got) {
      if (!it.name) continue;
      all[it.name] = { difficulty: it.d, averageScore: it.a, doneCount: it.c, date: it.date, paperId: it.id, category: cat, course };
    }
    total += got.length;
    console.log(`  ${cat}: ${got.length}`);
  }
  console.log(`[${course}] 累计 ${total} 份\n`);
}

fs.writeFileSync(outPath, JSON.stringify(all, null, 1));
console.log(`✓ 写入 ${Object.keys(all).length} 份卷元数据 → ${outPath}`);
await b.close();
