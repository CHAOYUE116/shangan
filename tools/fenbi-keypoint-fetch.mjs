#!/usr/bin/env node
/**
 * tools/fenbi-keypoint-fetch.mjs — 按考点（散题池）批量采集粉笔题目 + 解析
 *
 * 为什么需要它：整卷采集只覆盖「成套试卷」，而粉笔一半的题散挂在考点树上，
 * 不成套、也从来不会出现在任何一份卷子里。实测题量差：
 *   事业编·职测 考点池 53,580  vs 我们 30,989（缺 22,591）
 *   事业编·公基 考点池 51,086  vs 我们 23,910（缺 27,176）
 *
 * 链路（2026-11-10 实测跑通）：
 *   GET  /api/{course}/categories/home?filter=keypoint   → baseKeypointVOS[]（三层考点树，带 count）
 *   POST /api/{course}/exercises?type=2  form { type:2, keypointIds, count:200, exerciseTimeMode:2 } → { key }
 *   POST /combine/exercise/submit?key=<key>&routecs={course}            json {}
 *   GET  /combine/exercise/getSolution?format=json&key=<key>&routecs={course} → data.switchVO.requestKey
 *   GET  /combine/static/solution?key=<requestKey>&routecs={course}&type=1     → { name, materials, solutions[], card }
 *
 * 每次「创建练习」最多给 200 题，考点题量大就反复建练习，直到没有新题。
 * 题目按 globalId 全局去重，落盘 research/fenbi-keypoint/<course>/<keypointId>.json。
 *
 * 用法：
 *   node tools/fenbi-keypoint-fetch.mjs --course syzc --gap 8
 *   node tools/fenbi-keypoint-fetch.mjs --course syzc --limit 40 --max-rounds 30
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
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const COURSE = arg('course', 'syzc');
const LIMIT = Number(arg('limit', 9999));
const SKIP = Number(arg('skip', 0));
const GAP = Number(arg('gap', 8));
const GAP_MAX = Number(arg('gapmax', 120));
const RETRY_WAIT = Number(arg('retry', 60));
const RETRY_MAX = Number(arg('retrymax', 4));
const COOLDOWN = Number(arg('cooldown', 600));
const COOLDOWN_MAX = Number(arg('cooldownmax', 12));
const MAX_ROUNDS = Number(arg('max-rounds', 40));   // 单个考点最多建多少次练习
const COUNT = String(Number(arg('count', 200)));
const DRY = argv.includes('--dry');

const Q = 'app=web&kav=131&av=134&hav=128&gav=2&apcid=0&deviceId=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (sec) => Math.round(sec * 1000 * (1 + (Math.random() - 0.5) * 0.4));

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

const outDir = path.resolve(ROOT, '..', 'research', 'fenbi-keypoint', COURSE);
fs.mkdirSync(outDir, { recursive: true });
const stateFile = path.join(outDir, '_state.json');
const state = (() => {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { done: {}, collected: 0 }; }
})();
const saveState = () => { try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 0)); } catch { /* ignore */ } };

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: false,
  viewport: { width: 1200, height: 800 },
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://www.fenbi.com/spa/tiku/guide/catalog', { waitUntil: 'domcontentloaded', timeout: 60000 });
await sleep(1200);
const req = ctx.request;

/* ---------- 1. 拉考点树 ---------- */
const treeRes = await req.get(`https://tiku.fenbi.com/api/${COURSE}/categories/home?filter=keypoint&${Q}`, { timeout: 30000 });
if (treeRes.status() !== 200) {
  console.error(`考点树拉取失败 HTTP ${treeRes.status()}`);
  process.exit(1);
}
const treeJson = await treeRes.json();
const roots = (treeJson.data && treeJson.data.baseKeypointVOS) || [];
const leaves = [];
(function walk(list, parent) {
  for (const n of list || []) {
    const item = { id: n.id, name: n.name, count: Number(n.count || 0), parent };
    if (Array.isArray(n.children) && n.children.length) walk(n.children, `${parent}/${n.name}`);
    else leaves.push(item);
  }
})(roots, '');
// 只留有题的叶子节点，题多的先采
leaves.sort((a, b) => b.count - a.count);
const todo = leaves.filter((x) => x.count > 0).slice(SKIP, SKIP + LIMIT);
console.log(`考点采集 ${COURSE}: 根节点 ${roots.length} / 叶子 ${leaves.length} / 有题 ${leaves.filter((x) => x.count > 0).length} / 本轮 ${todo.length}`);
console.log(`考点题量合计 ${leaves.reduce((s, x) => s + x.count, 0)}，已采 ${state.collected || 0}`);
if (DRY) { todo.slice(0, 15).forEach((t) => console.log(`  ${t.count}\t${t.parent}/${t.name}\t${t.id}`)); process.exit(0); }

/* ---------- 2. 逐考点建练习 → 交卷 → 取解析 ---------- */
let gapNow = GAP;
const gapAfterOk = () => { gapNow = Math.max(GAP, Math.round(gapNow * 0.85)); };
const gapAfter403 = () => { gapNow = Math.min(GAP_MAX, Math.max(gapNow + 2, Math.round(gapNow * 1.8))); };

const all = new Map();          // globalId -> question（跨考点去重）
const knownIds = new Set();     // 已有落盘文件里的 id
for (const f of fs.readdirSync(outDir)) {
  if (!f.endsWith('.json') || f.startsWith('_')) continue;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
    for (const q of j.questions || []) knownIds.add(String(q.globalId));
  } catch { /* ignore */ }
}

async function createAndFetch(kp, round) {
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    const cr = await req.post(`https://tiku.fenbi.com/api/${COURSE}/exercises?${Q}&type=2`, {
      form: { type: '2', keypointIds: String(kp.id), count: COUNT, exerciseTimeMode: '2' },
      timeout: 30000,
    });
    if (cr.status() === 403) {
      gapAfter403();
      if (attempt === RETRY_MAX) return { quota: true };
      await sleep(RETRY_WAIT * 1000);
      continue;
    }
    if (!cr.ok()) return { error: `create ${cr.status()}` };
    const j = await cr.json();
    const key = j && (j.key || (j.data && j.data.key));
    if (!key) return { error: 'no key' };

    const sr = await req.post(`https://tiku.fenbi.com/combine/exercise/submit?key=${encodeURIComponent(key)}&routecs=${COURSE}`, { data: {}, timeout: 30000 });
    if (!sr.ok()) return { error: `submit ${sr.status()}` };

    const gr = await req.get(`https://tiku.fenbi.com/combine/exercise/getSolution?format=json&key=${encodeURIComponent(key)}&routecs=${COURSE}`, { timeout: 30000 });
    if (!gr.ok()) return { error: `getSolution ${gr.status()}` };
    const gj = await gr.json();
    const rk = gj && gj.data && gj.data.switchVO && gj.data.switchVO.requestKey;
    if (!rk) return { error: 'no requestKey' };

    const rr = await req.get(`https://tiku.fenbi.com/combine/static/solution?key=${encodeURIComponent(rk)}&routecs=${COURSE}&type=1`, { timeout: 60000 });
    if (!rr.ok()) return { error: `static ${rr.status()}` };
    const rj = await rr.json();

    const solutions = rj.solutions || [];
    const materials = rj.materials || [];
    const matById = new Map(materials.map((m) => [String(m.id), m]));
    const qs = solutions.map((s) => ({
      globalId: String(s.globalId || s.id || ''),
      questionId: s.id || null,
      content: richToText(s.content),
      // 选项在 accessories[0].options（[{type:101, options:["A项文字",…]}]），不取就是 4 个空选项
      options: (Array.isArray(s.accessories) ? s.accessories.find((a) => a && Array.isArray(a.options) && a.options.length) || {} : {}).options || [],
      optionType: (Array.isArray(s.accessories) ? (s.accessories.find((a) => a && a.type) || {}).type : '') || '',
      type: s.type || null,
      material: s.materialId && matById.get(String(s.materialId)) ? richToText(matById.get(String(s.materialId)).content || matById.get(String(s.materialId)).text) : '',
      materialRaw: s.materialId ? (matById.get(String(s.materialId)) || null) : null,
      solution: richToText(s.solution),
      correctAnswer: s.correctAnswer || null,
      keypoints: s.keypoints || null,
      source: s.source || '',
      analysisExist: !!s.solution,
    }));
    return { questions: qs, round };
  }
  return { error: 'exhausted' };
}

let files = 0, totalQ = 0, stopAll = false;
for (let i = 0; i < todo.length && !stopAll; i++) {
  const kp = todo[i];
  const tag = `[${i + 1}/${todo.length}] ${kp.id} ${kp.parent}/${kp.name} (${kp.count} 题)`;
  const dest = path.join(outDir, `${kp.id}.json`);
  if (state.done && state.done[String(kp.id)]) { console.log(`${tag} 已完成，跳过`); continue; }

  const got = [];
  let rounds = 0, stagnant = 0, cools = 0;
  for (let r = 0; r < MAX_ROUNDS; r++) {
    const res = await createAndFetch(kp, r);
    if (res.quota) {
      cools += 1;
      if (cools > COOLDOWN_MAX) { console.log(`${tag} 冷却 ${COOLDOWN_MAX} 次仍被限，跳过该考点`); break; }
      console.log(`${tag} 配额未恢复，冷却 ${COOLDOWN}s 后重试（第 ${cools}/${COOLDOWN_MAX} 次）`);
      await sleep(COOLDOWN * 1000);
      r -= 1;
      continue;
    }
    if (res.error) { console.log(`${tag} 第 ${r + 1} 轮失败：${res.error}`); break; }
    rounds += 1;
    let added = 0;
    for (const q of res.questions) {
      if (!q.globalId) continue;
      if (all.has(q.globalId) || knownIds.has(q.globalId)) continue;
      all.set(q.globalId, q);
      got.push(q);
      added += 1;
    }
    console.log(`${tag} 第 ${r + 1} 轮 +${added}（累计 ${got.length}）`);
    if (added === 0) { stagnant += 1; if (stagnant >= 2) break; } else stagnant = 0;
    if (res.questions.length < Number(COUNT)) break;   // 给不满 = 考点见底
    await sleep(jitter(gapNow));
  }

  if (got.length) {
    fs.writeFileSync(dest, JSON.stringify({ course: COURSE, keypointId: kp.id, name: kp.name, parent: kp.parent, count: kp.count, rounds, collectedAt: new Date().toISOString(), questions: got }, null, 0));
    files += 1;
    totalQ += got.length;
    state.collected = (state.collected || 0) + got.length;
    state.done = state.done || {};
    state.done[String(kp.id)] = got.length;
    saveState();
  }
  gapAfterOk();
  await sleep(jitter(gapNow));
}

console.log(`\n完成：考点 ${files} 个 / 新题 ${totalQ}（全局去重后累计 ${all.size}），gap=${gapNow}s`);
if (files === 0) console.log('提示：若全是「no key」，多半是登录态失效，重开浏览器手动登录一次粉笔。');
await ctx.close();
