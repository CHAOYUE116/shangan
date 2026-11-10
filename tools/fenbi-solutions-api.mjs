#!/usr/bin/env node
/**
 * tools/fenbi-solutions-api.mjs — 纯 API 批量取粉笔解析（不点界面、不逐题作答）
 *
 * 逆向链路（2026-11-10 实测）：
 *   POST /api/{course}/exercises?type=1   form { type:1, paperId, exerciseTimeMode:2 }  → { key }
 *   POST /combine/exercise/submit?key=    json {}                                      → { code:1 }
 *   GET  /combine/exercise/getSolution?format=json&key=                                 → data.switchVO.requestKey
 *   GET  /combine/static/solution?key=<requestKey>&routecs={course}&type=1               → { name, materials, solutions[], card }
 *
 * solutions[] 每条含 id / globalId / content(题干富文本) / solution(解析富文本) / correctAnswer / keypoints
 *
 * 限流：粉笔对「创建练习」有频率限制，实测连续 31 卷即返回
 *   403 {"msg":"您创建练习的频率过高，请稍候再试"}
 * 所以本脚本默认 gap=22s、撞 403 退避 120s 重试 3 次，连续两卷都耗尽就整轮停下（稍后重跑会跳过已采的）。
 *
 * 用法：
 *   node tools/fenbi-solutions-api.mjs --list ../research/solutions-worklist.json --gap 22
 *   node tools/fenbi-solutions-api.mjs --list ../research/solutions-worklist.json --limit 30
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
const COURSE = arg('course', null);
const LIST = arg('list', null);
const LIMIT = Number(arg('limit', 9999));
const SKIP = Number(arg('skip', 0));
const GAP = Number(arg('gap', 22));
const RETRY_WAIT = Number(arg('retry', 120));
const RETRY_MAX = Number(arg('retrymax', 3));
const COOLDOWN = Number(arg('cooldown', 1800)); // 单卷重试用尽后，整轮歇多久再继续（秒）
const COOLDOWN_MAX = Number(arg('cooldownmax', 48)); // 最多歇几轮（48×30min＝24 小时）

const Q = 'app=web&kav=131&av=134&hav=128&gav=2&apcid=0&deviceId=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (sec) => Math.round(sec * 1000 * (1 + (Math.random() - 0.5) * 0.4));

/** 富文本 → 纯文本（粉笔 content/solution 是 {"name":"doc","children":[...]} 结构） */
function richToText(raw) {
  if (!raw) return '';
  let node = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s.startsWith('{') && !s.startsWith('[')) return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    try { node = JSON.parse(s); } catch { return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
  }
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.name === 'txt' && typeof n.value === 'string') { out.push(n.value); return; }
    if (n.name === 'img') { out.push('[图]'); return; }
    if (Array.isArray(n.children)) n.children.forEach(walk);
    if (['p', 'div', 'li', 'tr', 'br'].includes(n.name)) out.push('\n');
  };
  walk(node);
  return out.join('').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

const work = (() => {
  if (!LIST) return [];
  const raw = JSON.parse(fs.readFileSync(path.resolve(ROOT, LIST), 'utf8'));
  return Array.isArray(raw) ? raw : raw.items || [];
})();

const outDir = (course) => {
  const d = path.resolve(ROOT, '..', 'research', 'fenbi-solutions', course);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: false,
  viewport: { width: 1200, height: 800 },
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://www.fenbi.com/spa/tiku/guide/realTest/sydw/syzc', { waitUntil: 'domcontentloaded', timeout: 60000 });
await sleep(1200);
const req = ctx.request;

let ok = 0, skip = 0, fail = 0, noKey = 0, quotaRounds = 0;
const todo = work.slice(SKIP, SKIP + LIMIT);
console.log(`解析补采 API  todo=${todo.length} gap=${GAP}s  retry=${RETRY_WAIT}s×${RETRY_MAX}  cooldown=${COOLDOWN}s×${COOLDOWN_MAX}\n`);

for (let i = 0; i < todo.length; i++) {
  const it = todo[i];
  const course = it.course || COURSE;
  const pid = it.paperId;
  const dest = path.join(outDir(course), `${pid}.json`);
  const tag = `[${i + 1}/${todo.length}] ${course} ${pid} ${String(it.name || '').slice(0, 26)}`;
  if (fs.existsSync(dest)) { skip += 1; console.log(`${tag} 已有，跳过`); continue; }

  let ex = null;
  let gaveUp = false;
  try {
    for (let round = 0; round <= COOLDOWN_MAX && !ex; round++) {
      if (round > 0) {
        const wait = COOLDOWN;
        console.log(`${tag} 配额仍未恢复，歇 ${(wait / 60).toFixed(0)} 分钟后再试（第 ${round}/${COOLDOWN_MAX} 轮）`);
        await sleep(wait * 1000);
      }
      for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
        const cr = await req.post(`https://tiku.fenbi.com/api/${course}/exercises?${Q}&type=1`, {
          form: { type: '1', paperId: String(pid), exerciseTimeMode: '2' },
          timeout: 30000,
        });
        if (cr.status() === 403) {
          if (attempt === RETRY_MAX) break;
          console.log(`${tag} 403 限流，等 ${RETRY_WAIT}s 重试（${attempt + 1}/${RETRY_MAX}）`);
          await sleep(RETRY_WAIT * 1000);
          continue;
        }
        if (cr.status() !== 200) { console.log(`${tag} create ${cr.status()}`); fail += 1; gaveUp = true; break; }
        ex = await cr.json();
        if (!ex.key) { console.log(`${tag} 无 exerciseKey`); fail += 1; gaveUp = true; ex = null; }
        break;
      }
    }
  } catch (e) {
    console.log(`${tag} ✗ create 异常 ${String(e.message).slice(0, 70)}`);
    fail += 1;
    gaveUp = true;
  }

  if (!ex) {
    if (!gaveUp) { console.log(`${tag} 冷却 ${COOLDOWN_MAX} 轮仍未恢复，整轮结束`); quotaRounds += 1; break; }
    continue;
  }

  try {
    await req.post(`https://tiku.fenbi.com/combine/exercise/submit?key=${ex.key}&routecs=${course}&${Q}`, { data: {}, timeout: 30000 });
    const gs = await (await req.get(`https://tiku.fenbi.com/combine/exercise/getSolution?format=json&key=${ex.key}&routecs=${course}&${Q}`, { timeout: 30000 })).json();
    const rk = gs?.data?.switchVO?.requestKey;
    if (!rk) { console.log(`${tag} 无 requestKey（${gs?.msg || gs?.code}）`); noKey += 1; continue; }

    const st = await req.get(`https://tiku.fenbi.com/combine/static/solution?key=${rk}&routecs=${course}&type=1&${Q}`, { timeout: 60000 });
    const raw = await st.text();
    if (st.status() !== 200 || raw.length < 200) { console.log(`${tag} solution ${st.status()} len=${raw.length}`); fail += 1; continue; }
    const j = JSON.parse(raw);
    const sols = j.solutions || [];
    if (!sols.length) { console.log(`${tag} 解析为空`); fail += 1; continue; }

    fs.writeFileSync(dest, JSON.stringify({
      paperId: pid,
      course,
      name: j.name || it.name,
      capturedAt: new Date().toISOString(),
      exerciseKey: ex.key,
      materials: j.materials || [],
      solutions: sols,
      card: j.card || null,
    }, null, 1));
    const withText = sols.filter((s) => richToText(s.solution)).length;
    console.log(`${tag} ✓ ${sols.length} 题 / 有解析 ${withText}`);
    ok += 1;
  } catch (e) {
    console.log(`${tag} ✗ ${String(e.message).slice(0, 80)}`);
    fail += 1;
  }
  await sleep(jitter(GAP));
}

console.log(`\n完成 ok=${ok} skip=${skip} fail=${fail} noKey=${noKey} 配额耗尽=${quotaRounds}`);
await ctx.close();
