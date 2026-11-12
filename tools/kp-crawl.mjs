#!/usr/bin/env node
/**
 * tools/kp-crawl.mjs —— 考点散题采集（v2，cookie 直连，不用浏览器）
 *
 * 为什么重写：
 *   老工具 fenbi-keypoint-fetch.mjs 每轮建练习后有一句 `if (res.questions.length < COUNT) break;`
 *   粉笔每个练习只回 ~30 题（< count 200），于是第一轮就 break —— 363 个考点每个只采了 30 来题。
 *   实测：职测考点池 68,048 题，我们只采到 27,068，逻辑填空/对应关系 池 2,847 采 38。
 *
 * 链路（与老工具一致）：
 *   GET  /api/{course}/categories/home?filter=keypoint   → 考点树（含 count）
 *   POST /api/{course}/exercises?type=2 {type:2,keypointIds,count,exerciseTimeMode} → {key}
 *   POST /combine/exercise/submit?key=…&routecs=…
 *   GET  /combine/exercise/getSolution?format=json&key=…&routecs=…  → switchVO.requestKey
 *   GET  /combine/static/solution?key=…&routecs=…&type=1            → {materials[], solutions[]}
 *
 * 用法：
 *   node tools/kp-crawl.mjs --probe                 # 试 4 种建练习参数，看每种回多少题
 *   node tools/kp-crawl.mjs --course syzc --rounds 12 --gap 20
 *   node tools/kp-crawl.mjs --course syzc --limit 5 --dry
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const COURSE = arg('course', 'syzc');
const ROUNDS = Number(arg('rounds', 12));
const GAP = Number(arg('gap', 20));           // 秒，每轮间隔
const COOLDOWN = Number(arg('cooldown', 300)); // 秒，403 后等待
const COOLDOWN_MAX = Number(arg('cooldownmax', 10));
const LIMIT = Number(arg('limit', 9999));
const SKIP = Number(arg('skip', 0));
const MINRATIO = Number(arg('minratio', 0.9)); // 已采 >= 池×ratio 就跳过
const DRY = argv.includes('--dry');
const PROBE = argv.includes('--probe');

const Q = 'app=web&kav=131&av=134&hav=128&gav=2&apcid=0&deviceId=';
const COOKIE = fs.readFileSync(path.join(ROOT, 'cookie.txt'), 'utf8').trim();
const H = { cookie: COOKIE, 'user-agent': 'Mozilla/5.0', accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jget = async (u, opt = {}) => {
  const r = await fetch(u, { headers: H, ...opt, signal: AbortSignal.timeout(30000) });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch { /* ignore */ }
  return { status: r.status, ok: r.ok, j, text: t };
};

/* ---------- 富文本 → 文本 / HTML ---------- */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function richWalk(node, out, html) {
  if (!node || typeof node !== 'object') return;
  if (node.name === 'txt' && typeof node.value === 'string') {
    if (html) out.push(esc(node.value).replace(/\n/g, '<br>'));
    else out.push(node.value);
    return;
  }
  if (node.name === 'tex' && typeof node.value === 'string') {
    const key = String(node.value).split('?')[0];
    if (html) out.push(`<img flag="tex" src="https://fb.fenbike.cn/api/planet/accessories/formulas?latex=${key}">`);
    else out.push('[公式]');
    return;
  }
  if (node.name === 'img') {
    const src = typeof node.value === 'string' ? node.value : (node.src || '');
    if (html && src) out.push(`<img src="${src.startsWith('//') ? 'https:' + src : src}">`);
    else out.push('[图]');
    return;
  }
  const kids = node.children;
  if (Array.isArray(kids)) {
    const block = ['p', 'div', 'li', 'tr'].includes(node.name);
    if (html && block) out.push(`<${node.name === 'div' ? 'p' : node.name}>`);
    kids.forEach((k) => richWalk(k, out, html));
    if (html && block) out.push(`</${node.name === 'div' ? 'p' : node.name}>`);
    if (!html && block) out.push('\n');
    return;
  }
  if (node.name === 'br') out.push(html ? '<br>' : '\n');
}
function rich(raw, html = false) {
  if (!raw) return '';
  let node = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.startsWith('{') || s.startsWith('[')) {
      try { node = JSON.parse(s); } catch { return s; }
    } else {
      return html ? s : s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  const out = [];
  richWalk(node, out, html);
  const t = out.join('');
  return html ? t : t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------- 建练习 ---------- */
async function createExercise(kpId, mode = 'form') {
  const url = `https://tiku.fenbi.com/api/${COURSE}/exercises?${Q}&type=2`;
  if (mode === 'json') {
    return jget(url, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 2, keypointIds: [Number(kpId)], count: 200, exerciseTimeMode: 2 }),
    });
  }
  if (mode === 'form100') {
    const body = new URLSearchParams({ type: '2', keypointIds: String(kpId), count: '100', exerciseTimeMode: '2' }).toString();
    return jget(url, { method: 'POST', headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' }, body });
  }
  if (mode === 'array') {
    const body = new URLSearchParams({ type: '2', 'keypointIds[]': String(kpId), count: '200', exerciseTimeMode: '2' }).toString();
    return jget(url, { method: 'POST', headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' }, body });
  }
  const body = new URLSearchParams({ type: '2', keypointIds: String(kpId), count: '200', exerciseTimeMode: '2' }).toString();
  return jget(url, { method: 'POST', headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' }, body });
}

async function pull(key) {
  await jget(`https://tiku.fenbi.com/combine/exercise/submit?key=${encodeURIComponent(key)}&routecs=${COURSE}`, {
    method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: '{}',
  });
  const g = await jget(`https://tiku.fenbi.com/combine/exercise/getSolution?format=json&key=${encodeURIComponent(key)}&routecs=${COURSE}`);
  const rk = g.j && g.j.data && g.j.data.switchVO && g.j.data.switchVO.requestKey;
  if (!rk) return { error: 'no requestKey' };
  const s = await jget(`https://tiku.fenbi.com/combine/static/solution?key=${encodeURIComponent(rk)}&routecs=${COURSE}&type=1`);
  if (!s.ok || !s.j) return { error: `static ${s.status}` };
  const solutions = s.j.solutions || [];
  const mats = new Map((s.j.materials || []).map((m) => [String(m.id), m]));
  const qs = solutions.map((x) => {
    const opt = (Array.isArray(x.accessories) ? x.accessories.find((a) => a && Array.isArray(a.options) && a.options.length) : null)
      || (x.solutionAccessories && Array.isArray(x.solutionAccessories.options) ? x.solutionAccessories : null);
    const mat = x.materialId ? mats.get(String(x.materialId)) : null;
    return {
      globalId: String(x.globalId || x.id || ''),
      questionId: x.id || null,
      content: rich(x.content),
      contentHtml: rich(x.content, true),
      options: (opt && opt.options) || [],
      optionType: (opt && opt.type) || '',
      type: x.type || null,
      material: mat ? rich(mat.content || mat.text) : '',
      materialHtml: mat ? rich(mat.content || mat.text, true) : '',
      solution: rich(x.solution),
      solutionHtml: rich(x.solution, true),
      correctAnswer: x.correctAnswer || null,
      keypoints: x.keypoints || null,
      source: x.source || '',
    };
  });
  return { questions: qs, materials: mats.size };
}

/* ---------- 考点树 ---------- */
async function loadTree() {
  const r = await jget(`https://tiku.fenbi.com/api/${COURSE}/categories/home?filter=keypoint&${Q}`);
  if (!r.ok) throw new Error(`考点树 ${r.status}`);
  const roots = (r.j.data && r.j.data.baseKeypointVOS) || [];
  const leaves = [];
  (function walk(list, parent) {
    for (const n of list || []) {
      if (Array.isArray(n.children) && n.children.length) walk(n.children, `${parent}/${n.name}`);
      else leaves.push({ id: String(n.id), name: n.name, count: Number(n.count || 0), parent });
    }
  })(roots, '');
  return leaves.filter((x) => x.count > 0);
}

/* ---------- 探针 ---------- */
if (PROBE) {
  const leaves = await loadTree();
  leaves.sort((a, b) => b.count - a.count);
  const kp = leaves.find((x) => /对应关系/.test(x.name)) || leaves[0];
  console.log(`探针考点：${kp.parent}/${kp.name} 池 ${kp.count}（id ${kp.id}）`);
  for (const mode of ['form', 'form100', 'array', 'json']) {
    const r = await createExercise(kp.id, mode);
    const key = r.j && (r.j.key || (r.j.data && r.j.data.key));
    if (!key) {
      console.log(`${mode.padEnd(8)} → ${r.status} ${(r.j && (r.j.msg || r.j.message)) || r.text.slice(0, 80)}`);
      await sleep(COOLDOWN * 1000);
      continue;
    }
    const p = await pull(key);
    console.log(`${mode.padEnd(8)} → 200 题数 ${p.questions ? p.questions.length : 'ERR ' + p.error}（池 ${kp.count}，材料 ${p.materials || 0}）`);
    await sleep(GAP * 1000);
  }
  process.exit(0);
}

/* ---------- 采集 ---------- */
const outDir = path.resolve(ROOT, '..', 'research', 'fenbi-keypoint', COURSE);
fs.mkdirSync(outDir, { recursive: true });
const leaves = await loadTree();

const known = new Set();
const collectedByKey = new Map();
for (const f of fs.readdirSync(outDir)) {
  if (!f.endsWith('.json') || f.startsWith('_')) continue;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
    const key = `${j.parent}/${j.name}`;
    collectedByKey.set(key, (collectedByKey.get(key) || 0) + (j.questions || []).length);
    for (const q of j.questions || []) if (q.globalId) known.add(String(q.globalId));
  } catch { /* ignore */ }
}

const todo = leaves
  .map((l) => ({ ...l, got: collectedByKey.get(`${l.parent}/${l.name}`) || 0 }))
  .filter((l) => l.got < l.count * MINRATIO)
  .sort((a, b) => (b.count - b.got) - (a.count - a.got))
  .slice(SKIP, SKIP + LIMIT);

console.log(`考点 ${leaves.length} 个 · 池 ${leaves.reduce((s, x) => s + x.count, 0)} · 已有 ${known.size} 题（文件口径）`);
console.log(`待采 ${todo.length} 个（缺口 ${todo.reduce((s, x) => s + x.count - x.got, 0)} 题）`);
todo.slice(0, 8).forEach((t) => console.log(`  ${t.count - t.got}\t池${t.count} 采${t.got}\t${t.parent}/${t.name}\t${t.id}`));
if (DRY) process.exit(0);

let added = 0, files = 0, cools = 0;
for (let i = 0; i < todo.length; i++) {
  const kp = todo[i];
  const tag = `[${i + 1}/${todo.length}] ${kp.parent}/${kp.name} 池${kp.count} 采${kp.got}`;
  const dest = path.join(outDir, `${kp.id}.json`);
  const got = [];
  let stagnant = 0;

  for (let r = 0; r < ROUNDS; r++) {
    if (cools > COOLDOWN_MAX) break;
    const c = await createExercise(kp.id, 'form100');
    const key = c.j && (c.j.key || (c.j.data && c.j.data.key));
    if (!key) {
      if (c.status === 403) {
        cools++;
        console.log(`${tag} 403 冷却 ${COOLDOWN}s（${cools}/${COOLDOWN_MAX}）`);
        await sleep(COOLDOWN * 1000);
        r--; continue;
      }
      console.log(`${tag} 建练习失败 ${c.status} ${(c.j && c.j.msg) || ''}`);
      break;
    }
    const p = await pull(key);
    if (p.error) { console.log(`${tag} 拉取失败 ${p.error}`); break; }
    let n = 0;
    for (const q of p.questions) {
      if (!q.globalId || known.has(q.globalId)) continue;
      known.add(q.globalId);
      got.push(q); n++;
    }
    console.log(`${tag} 第 ${r + 1} 轮 回${p.questions.length} 新+${n}（累计 ${got.length}）`);
    if (n === 0) { stagnant++; if (stagnant >= 3) break; } else stagnant = 0;
    if (kp.got + got.length >= kp.count) break;
    await sleep(GAP * 1000);
  }

  if (got.length) {
    let prev = [];
    try { prev = JSON.parse(fs.readFileSync(dest, 'utf8')).questions || []; } catch { /* new */ }
    const seen = new Set(got.map((q) => q.globalId));
    const merged = [...got, ...prev.filter((q) => q && q.globalId && !seen.has(q.globalId))];
    fs.writeFileSync(dest, JSON.stringify({
      course: COURSE, keypointId: kp.id, name: kp.name, parent: kp.parent, count: kp.count,
      collectedAt: new Date().toISOString(), questions: merged,
    }, null, 0));
    added += got.length; files++;
    kp.got += got.length;
  }
  cools = 0;
  await sleep(GAP * 1000);
}

console.log(`\n完成：考点 ${files} 个 · 新题 ${added} · 全局已有 ${known.size}`);
