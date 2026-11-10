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
const GAP = Number(arg('gap', 8));
const RETRY_WAIT = Number(arg('retry', 60));
const RETRY_MAX = Number(arg('retrymax', 4));
const COOLDOWN = Number(arg('cooldown', 600)); // 撞限流后整轮歇多久（秒）
const COOLDOWN_MAX = Number(arg('cooldownmax', 24));
const GAP_MAX = Number(arg('gapmax', 120)); // 自适应上限：被限流后拉长到这么多秒
const DEAD_FILE = path.resolve(ROOT, '..', 'research', 'solutions-dead.json');

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

let ok = 0, skip = 0, fail = 0, noKey = 0, quotaRounds = 0, dead = 0;
const todo = work.slice(SKIP, SKIP + LIMIT);
console.log(`解析补采 API  todo=${todo.length} gap=${GAP}s（自适应 ${GAP}~${GAP_MAX}s）  retry=${RETRY_WAIT}s×${RETRY_MAX}  cooldown=${COOLDOWN}s×${COOLDOWN_MAX}\n`);

// 已经确认下架/不能建练习的卷，记下来，之后每次跑直接跳过——
// 之前这里把 404 当成「配额没恢复」，于是一卷死卷能耗掉 40×25 分钟。
let deadSet = new Set();
try {
  const d = JSON.parse(fs.readFileSync(DEAD_FILE, 'utf8'));
  deadSet = new Set(Array.isArray(d) ? d : []);
} catch { /* 首次运行没有这个文件 */ }
const saveDead = () => { try { fs.writeFileSync(DEAD_FILE, JSON.stringify([...deadSet], null, 0)); } catch { /* ignore */ } };

let gapNow = GAP;          // 当前实际间隔（秒），被限流就拉长，连续成功就慢慢收回
const gapAfterOk = () => { gapNow = Math.max(GAP, Math.round(gapNow * 0.85)); };
const gapAfter403 = () => { gapNow = Math.min(GAP_MAX, Math.max(gapNow + 2, Math.round(gapNow * 1.8))); };

for (let i = 0; i < todo.length; i++) {
  const it = todo[i];
  const course = it.course || COURSE;
  const pid = it.paperId;
  const dest = path.join(outDir(course), `${pid}.json`);
  const tag = `[${i + 1}/${todo.length}] ${course} ${pid} ${String(it.name || '').slice(0, 26)}`;
  if (fs.existsSync(dest)) { skip += 1; console.log(`${tag} 已有，跳过`); continue; }
  if (deadSet.has(String(pid))) { dead += 1; continue; }

  let ex = null;
  let gaveUp = false;
  try {
    for (let round = 0; round <= COOLDOWN_MAX && !ex && !gaveUp; round++) {
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
          gapAfter403();
          if (attempt === RETRY_MAX) break;
          console.log(`${tag} 403 限流，等 ${RETRY_WAIT}s 重试（${attempt + 1}/${RETRY_MAX}）  gap→${gapNow}s`);
          await sleep(RETRY_WAIT * 1000);
          continue;
        }
        if (cr.status() === 404) {
          // 卷子下架了，重试多少次都一样：记账、跳过、别占着冷却
          console.log(`${tag} 404 卷子已下架，跳过`);
          deadSet.add(String(pid)); saveDead(); dead += 1; gaveUp = true; break;
        }
        if (cr.status() !== 200) { console.log(`${tag} create ${cr.status()}，跳过`); fail += 1; gaveUp = true; break; }
        ex = await cr.json();
        if (!ex.key) { console.log(`${tag} 无 exerciseKey`); fail += 1; gaveUp = true; ex = null; }
        else gapAfterOk();
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
  await sleep(jitter(gapNow));
}

console.log(`\n完成 ok=${ok} skip=${skip} fail=${fail} noKey=${noKey} 下架跳过=${dead} 配额耗尽=${quotaRounds}`);
await ctx.close();
