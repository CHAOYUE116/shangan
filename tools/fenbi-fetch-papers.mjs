#!/usr/bin/env node
/**
 * tools/fenbi-fetch-papers.mjs — 粉笔题库整卷采集（纯 API，走已登录浏览器）
 *
 * 逆向结论（2026-11-08 实测，见 docs/粉笔逆向笔记.md）：
 *   1) 试卷列表   GET /api/{course}/papers/v2?labelId=&toPage=&pageSize=
 *   2) 卷内题号   GET /api/{course}/comptroller/papers/{paperId}/sheet  → questionIds
 *   3) 题目正文   GET /api/{course}/questions?ids=a,b,c...              → 题干/选项/答案
 *
 * 关键点：
 *   - course 是科目前缀：xingce(行测) shenlun(申论) sydw(事考公基) syzc(事编职测) zhyynl(综合应用能力/综应)
 *   - **必须走浏览器上下文**：直连会 453（粉笔 WAF 校验 TLS 指纹）
 *   - `questions?ids=` 一次可带 100 个 id，一份卷 1 个请求拿全
 *   - 返回**不含解析**（analysis）——粉笔把解析锁在交卷之后。答案在 `correctAnswer.choice`（0 基下标）
 *
 * 用法：
 *   node tools/fenbi-fetch-papers.mjs --course syzc --label 0 --pages 1 --limit 5
 *   node tools/fenbi-fetch-papers.mjs --course syzc --label 9170 --pages 2
 *   node tools/fenbi-fetch-papers.mjs --course zhyynl --label 0 --pages 2
 *   node tools/fenbi-fetch-papers.mjs --course syzc --paper 6674225
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.resolve(ROOT, '..', 'research', 'fenbi', 'browser-profile');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (n) => argv.includes('--' + n);
const all = (n) => { const o = []; argv.forEach((v, i) => { if (v === '--' + n && argv[i + 1]) o.push(argv[i + 1]); }); return o; };

const COURSE = arg('course', 'syzc');
const LABEL = arg('label', '0');
const PAGES = Number(arg('pages', 1));
const SIZE = Number(arg('size', 15));
const DELAY = Number(arg('delay', 900));
const LIMIT = Number(arg('limit', 0));          // 0 = 不限
const PAPERS = all('paper');
const OUT = path.resolve(ROOT, arg('out', `../research/fenbi-raw/${COURSE}`));
const COMMON = 'app=web&kav=131&av=134&hav=128&apcid=0';

fs.mkdirSync(path.join(OUT, 'papers'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'sheets'), { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: true,
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(`https://www.fenbi.com/spa/tiku/guide/realTest/sydw/${COURSE}`, {
  waitUntil: 'domcontentloaded', timeout: 60000,
}).catch(() => {});
await page.goto('https://www.fenbi.com/spa/tiku', { waitUntil: 'domcontentloaded', timeout: 60000 });

async function api(pathAndQuery) {
  const url = 'https://tiku.fenbi.com/api' + pathAndQuery;
  const r = await page.evaluate(async (u) => {
    try {
      const res = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
      const t = await res.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      return { s: res.status, j, len: t.length };
    } catch (e) { return { s: 0, len: 0, err: e.message }; }
  }, url);
  return r;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`粉笔整卷采集  course=${COURSE} label=${LABEL} pages=${PAGES} size=${SIZE} delay=${DELAY}ms`);
console.log(`输出 ${OUT}`);

// ---------- 1. 试卷清单 ----------
let targets = [];
if (PAPERS.length) {
  targets = PAPERS.map((id) => ({ paperId: Number(id) }));
  console.log(`指定试卷 ${targets.length} 份`);
} else {
  for (let p = 0; p < PAGES; p++) {
    const r = await api(`/${COURSE}/papers/v2?labelId=${LABEL}&toPage=${p}&pageSize=${SIZE}&${COMMON}`);
    const list = r.j?.list || [];
    const info = r.j?.pageInfo || {};
    console.log(`  第 ${p} 页 status=${r.s} ${list.length} 份 / 共 ${info.totalItem ?? '?'} 套`);
    for (const x of list) targets.push({ paperId: x.id, name: x.name, type: x.type });
    if (!list.length || p + 1 >= (info.totalPage ?? 0)) break;
    await sleep(DELAY);
  }
  if (LIMIT) targets = targets.slice(0, LIMIT);
}
console.log(`待采集 ${targets.length} 份\n`);

// ---------- 2. 逐卷 ----------
let ok = 0, fail = 0, totalQ = 0, withAns = 0;
for (let i = 0; i < targets.length; i++) {
  const { paperId } = targets[i];
  const dest = path.join(OUT, 'papers', `${paperId}.json`);
  if (fs.existsSync(dest)) {
    const old = JSON.parse(fs.readFileSync(dest, 'utf8'));
    totalQ += (old.questions || []).length;
    ok += 1;
    continue;
  }
  try {
    const sheetR = await api(`/${COURSE}/comptroller/papers/${paperId}/sheet?${COMMON}`);
    const sheet = sheetR.j;
    const ids = sheet?.questionIds || [];
    if (!ids.length) { console.log(`  ${paperId}: sheet 无 questionIds（status=${sheetR.s}）`); fail += 1; await sleep(DELAY); continue; }
    fs.writeFileSync(path.join(OUT, 'sheets', `${paperId}.json`), JSON.stringify(sheet, null, 1));

    const questions = [];
    for (let k = 0; k < ids.length; k += 100) {
      const batch = ids.slice(k, k + 100).join(',');
      const r = await api(`/${COURSE}/questions?ids=${batch}&${COMMON}`);
      const arr = Array.isArray(r.j) ? r.j : (r.j?.data || []);
      questions.push(...arr);
      await sleep(400);
    }

    const rec = {
      paperId, name: sheet.name, chapters: sheet.chapters, time: sheet.time,
      questionCount: sheet.questionCount, questionIds: ids,
      questions: questions.map((x) => {
        const opts = (x.accessories || []).find((a) => Array.isArray(a.options))?.options || [];
        const ch = x.correctAnswer?.choice;
        const idx = ch == null ? -1 : Number(ch);
        return {
          questionId: x.id,
          type: x.type,
          content: x.content,
          material: x.material || null,
          options: opts,
          answerIndex: idx,
          answer: idx >= 0 && opts[idx] != null ? opts[idx] : null,
          answerLetter: idx >= 0 ? String.fromCharCode(65 + idx) : null,
          difficulty: x.difficulty,
          analysis: null, // 粉笔不返回，需交卷后才有
        };
      }),
    };
    fs.writeFileSync(dest, JSON.stringify(rec, null, 1));
    ok += 1;
    totalQ += rec.questions.length;
    withAns += rec.questions.filter((x) => x.answerLetter).length;
    console.log(`  [${i + 1}/${targets.length}] ${paperId} ${rec.questions.length} 题  ${String(sheet.name).slice(0, 40)}`);
  } catch (e) {
    fail += 1;
    console.log(`  ${paperId} 失败: ${e.message.slice(0, 80)}`);
  }
  await sleep(DELAY);
}

console.log(`\n完成 ok=${ok} fail=${fail}`);
console.log(`题目 ${totalQ} 道，其中带答案 ${withAns}（${totalQ ? (withAns / totalQ * 100).toFixed(0) : 0}%），解析 0（需交卷）`);
await ctx.close();
