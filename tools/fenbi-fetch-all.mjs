#!/usr/bin/env node
/**
 * tools/fenbi-fetch-all.mjs — 按分类批量采集整卷（事业编三类一把抓）
 *
 * 与 fenbi-fetch-papers.mjs 的区别：它一次只跑一个 label；
 * 这个脚本读 research/fenbi-coverage.json，把指定科目的所有分类串起来跑，
 * 单个浏览器实例复用，已存在的卷自动跳过（断点续跑）。
 *
 * 用法：
 *   $env:HTTPS_PROXY='http://127.0.0.1:18926'
 *   node tools/fenbi-fetch-all.mjs --courses syzc,sydw,zhyynl
 *   node tools/fenbi-fetch-all.mjs --courses syzc --size 30 --delay 700 --max-pages 40
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.resolve(ROOT, '..', 'research', 'fenbi', 'browser-profile');
const COVERAGE = path.resolve(ROOT, '..', 'research', 'fenbi-coverage.json');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const COMMON = 'app=web&kav=131&av=134&hav=128&apcid=0';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const COURSES = String(arg('courses', 'syzc,sydw,zhyynl')).split(',').map((s) => s.trim()).filter(Boolean);
const SIZE = Number(arg('size', 15));
const DELAY = Number(arg('delay', 800));
const MAX_PAGES = Number(arg('max-pages', 60));
const SKIP_CATS = ['推荐', '全部', '最新', '模考'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 分类清单（同 course + labelId 去重，跳过聚合类） ----
const cov = JSON.parse(fs.readFileSync(COVERAGE, 'utf8'));
const seen = new Set();
const jobs = [];
for (const c of COURSES) {
  for (const x of cov.filter((v) => v.course === c)) {
    if (!x.labelId) continue;                       // labelId=0 是「推荐」，与其他分类重叠
    if (SKIP_CATS.some((k) => String(x.cat).includes(k))) continue;
    const key = c + '#' + x.labelId;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push({ course: c, cat: x.cat, labelId: x.labelId, total: x.total || 0 });
  }
}
const expected = jobs.reduce((a, b) => a + b.total, 0);
console.log(`课程 ${COURSES.join(',')} → ${jobs.length} 个分类，粉笔在架合计 ${expected} 套`);

// ---- 输出目录 ----
const dirs = {};
for (const c of COURSES) {
  const out = path.resolve(ROOT, '..', 'research', 'fenbi-raw', c);
  fs.mkdirSync(path.join(out, 'papers'), { recursive: true });
  fs.mkdirSync(path.join(out, 'sheets'), { recursive: true });
  dirs[c] = out;
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: true,
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://www.fenbi.com/spa/tiku', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

async function api(p) {
  return await page.evaluate(async (u) => {
    try {
      const res = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
      const t = await res.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      return { s: res.status, j, len: t.length };
    } catch (e) { return { s: 0, len: 0, err: e.message }; }
  }, 'https://tiku.fenbi.com/api' + p);
}

const stat = { listed: 0, exist: 0, ok: 0, fail: 0, empty: 0, q: 0 };
const t0 = Date.now();

for (const job of jobs) {
  const out = dirs[job.course];
  const pages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(job.total / SIZE)));
  let got = 0;
  for (let p = 0; p < pages; p++) {
    const r = await api(`/${job.course}/papers/v2?labelId=${job.labelId}&toPage=${p}&pageSize=${SIZE}&${COMMON}`);
    const list = r.j?.list || [];
    const info = r.j?.pageInfo || {};
    if (!list.length) {
      if (p === 0) console.log(`  [${job.course}] ${job.cat} label=${job.labelId} 列表空（status=${r.s} 共${info.totalItem ?? '?'}）`);
      break;
    }
    for (const x of list) {
      const dest = path.join(out, 'papers', `${x.id}.json`);
      if (fs.existsSync(dest)) { stat.exist++; got++; continue; }
      try {
        // 综应（zhyynl）的答卷接口是 /{course}/papers/{id}/sheet；
        // 其余科目走 /{course}/comptroller/papers/{id}/sheet，用错会 403。
        const sheetPath = job.course === 'zhyynl'
          ? `/${job.course}/papers/${x.id}/sheet?${COMMON}`
          : `/${job.course}/comptroller/papers/${x.id}/sheet?${COMMON}`;
        const sheetR = await api(sheetPath);
        const sheet = sheetR.j;
        const ids = sheet?.questionIds || [];
        if (!ids.length) { stat.empty++; continue; }
        fs.writeFileSync(path.join(out, 'sheets', `${x.id}.json`), JSON.stringify(sheet, null, 1));
        const questions = [];
        for (let k = 0; k < ids.length; k += 100) {
          const qr = await api(`/${job.course}/questions?ids=${ids.slice(k, k + 100).join(',')}&${COMMON}`);
          const arr = Array.isArray(qr.j) ? qr.j : (qr.j?.data || []);
          questions.push(...arr);
          await sleep(300);
        }
        const rec = {
          paperId: x.id, name: sheet.name, cat: job.cat, labelId: job.labelId,
          chapters: sheet.chapters, time: sheet.time, questionCount: sheet.questionCount,
          questionIds: ids,
          questions: questions.map((q) => {
            const opts = (q.accessories || []).find((a) => Array.isArray(a.options))?.options || [];
            const ch = q.correctAnswer?.choice;
            const idx = ch == null ? -1 : Number(ch);
            return {
              questionId: q.id, type: q.type, content: q.content, material: q.material || null,
              options: opts, answerIndex: idx,
              answer: idx >= 0 && opts[idx] != null ? opts[idx] : null,
              answerLetter: idx >= 0 ? String.fromCharCode(65 + idx) : null,
              difficulty: q.difficulty, analysis: null,
            };
          }),
        };
        fs.writeFileSync(dest, JSON.stringify(rec, null, 1));
        stat.ok++; stat.q += questions.length; got++;
      } catch (e) {
        stat.fail++;
        if (stat.fail <= 20) console.log(`  ✗ ${x.id} ${String(e.message).slice(0, 70)}`);
      }
      await sleep(DELAY);
    }
    stat.listed += list.length;
    if (p + 1 >= (info.totalPage ?? 0)) break;
    await sleep(DELAY);
  }
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`[${job.course}] ${job.cat} (label ${job.labelId}) 本轮 ${got}/${job.total} · 累计 新采 ${stat.ok} / 已有 ${stat.exist} / 失败 ${stat.fail} / 空卷 ${stat.empty} · ${mins}min`);
}

console.log(`\n===== 完成 =====`);
console.log(`新采 ${stat.ok} 卷 / ${stat.q} 题；已存在跳过 ${stat.exist}；失败 ${stat.fail}；空卷 ${stat.empty}`);
await ctx.close();
