/* 大样本模拟：用真实题库的结构（题型/模块/选项数/题干长度/有无材料），
 * 造多个「已知真相」的学生，比较各模型与各参数。
 *
 * 想回答三个问题：
 *   1. 难度字段值不值得补？（真难度 vs 结构先验 vs 干脆不要难度）
 *   2. 参数各取多少？（K、初始不确定度、衰减、遗忘、收缩强度 κ）
 *   3. 400 条作答够不够？还是需要层级结构（模块级 + 考点偏移）？
 *
 * 跑法：node tools/lab-sim.mjs [每题作答数=400] [学生数=24]
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const PER = Number(process.argv[2] || 400);
const USERS = Number(process.argv[3] || 24);
const DB = 'app-assets/tiku_app.db';

let seed = 20261112;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => { const u = Math.max(1e-9, rnd()); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
const sig = (x) => 1 / (1 + Math.exp(-x));

// ---------- 1. 从真实题库抽题，提取结构特征 ----------
const db = new DatabaseSync(DB, { readOnly: true });
const rows = db.prepare(`
  SELECT q.questionId, q.chapter, q.type, q.options, length(q.content) stemLen,
         (CASE WHEN q.material IS NULL OR length(q.material) < 20 THEN 0 ELSE length(q.material) END) matLen,
         (SELECT MIN(kpName) FROM question_keypoints k WHERE k.questionId = q.questionId) kp
  FROM questions q
  WHERE q.id IN (SELECT MAX(id) FROM questions GROUP BY questionId)
    AND q.type IN (1,2,3,5) AND q.options IS NOT NULL AND q.options <> '[]'
`).all();
db.close();

const CH_PRIOR = (c) => {
  if (/数量关系/.test(c)) return 0.9;
  if (/资料分析/.test(c)) return 0.7;
  if (/判断推理/.test(c)) return 0.4;
  if (/言语理解/.test(c)) return 0.1;
  if (/常识判断/.test(c)) return 0;
  if (/政治理论/.test(c)) return -0.1;
  return 0.2;
};
const TYPE_PRIOR = (t) => (String(t) === '5' ? -0.6 : String(t) === '2' ? 0.8 : String(t) === '3' ? 1.0 : 0);
const optCount = (s) => { try { return JSON.parse(s || '[]').length; } catch { return 0; } };

const items = rows.map((r) => {
  const oc = optCount(r.options);
  const structural =
    TYPE_PRIOR(r.type) + CH_PRIOR(r.chapter) +
    0.25 * Math.log(1 + (r.stemLen || 0) / 60) +
    0.2 * Math.log(1 + (r.matLen || 0) / 300) -
    0.15 * Math.log(Math.max(1, oc));
  return {
    b: structural,                                  // 模型能算出来的结构先验
    bTrue: structural + gauss() * 0.45,             // 「真难度」= 结构 + 我们看不到的那部分
    c: String(r.type) === '5' ? 0.5 : oc >= 2 ? 1 / oc : 0.25,
    kp: r.kp || r.chapter || '未分类',
    chapter: r.chapter || '未分类',
    type: String(r.type),
  };
});
const byKp = new Map();
for (const it of items) {
  if (!byKp.has(it.kp)) byKp.set(it.kp, []);
  byKp.get(it.kp).push(it);
}
const usableKps = [...byKp.keys()].filter((k) => byKp.get(k).length >= 5);

// ---------- 2. 造学生并生成作答序列 ----------
function makeUser() {
  // 真实世界里：同一个模块下的考点水平是相关的（一个模块弱，往往几个考点都弱）
  const ability = new Map();
  const modAbility = new Map();
  for (const it of items) if (!modAbility.has(it.chapter)) modAbility.set(it.chapter, gauss() * 0.8);
  for (const k of usableKps) {
    const ch = byKp.get(k)[0].chapter;
    ability.set(k, (modAbility.get(ch) || 0) + gauss() * 0.55);
  }
  const seq = [];
  let day = 0;
  // 大多数人是「集中练」：把 80% 的题投在 40 个考点的固定池子里
  const FOCUS = Math.max(1, Math.min(40, Math.floor(usableKps.length * 0.08)));
  const focus = [];
  while (focus.length < FOCUS) { const k = usableKps[Math.floor(rnd() * usableKps.length)]; if (!focus.includes(k)) focus.push(k); }
  let recent = focus[Math.floor(rnd() * focus.length)];
  for (let i = 0; i < PER; i++) {
    day += 0.05 + rnd() * 0.05;
    const kp = rnd() < 0.65 ? recent : rnd() < 0.8 ? focus[Math.floor(rnd() * focus.length)] : usableKps[Math.floor(rnd() * usableKps.length)];
    if (rnd() < 0.15) recent = focus[Math.floor(rnd() * focus.length)];
    const pool = byKp.get(kp);
    const it = pool[Math.floor(rnd() * pool.length)];
    const p = it.c + (1 - it.c) * sig(ability.get(kp) - it.bTrue);
    seq.push({ kp, it, y: rnd() < p ? 1 : 0, day, pTrue: p });
  }
  return seq;
}

// ---------- 3. 模型 ----------
// base 基线 · A 只看强弱 · B 加难度 · C 加难度+蒙对 · H 层级（模块 θ + 考点偏移，收缩）
function runModel(seq, cfg) {
  const KP = new Map(); const MOD = new Map();
  const preds = [];
  const pickB = (it) => (cfg.useB === 'true' ? it.bTrue : cfg.useB === 'none' ? 0 : it.b * cfg.bScale);

  for (const e of seq) {
    let s = KP.get(e.kp);
    if (!s) { s = { d: 0, n: 0, ok: 0, last: 0 }; KP.set(e.kp, s); }
    let m = MOD.get(e.it.chapter);
    if (!m) { m = { t: 0 }; MOD.set(e.it.chapter, m); }
    const b = pickB(e.it);
    const shrink = s.n / (s.n + cfg.kappa);
    const theta = cfg.model === 'H' ? m.t + s.d * shrink : s.d;
    const days = s.last ? Math.max(0, e.day - s.last) : 0;
    const unc = s.n === 0 ? cfg.rd0 : cfg.rd0 / (1 + cfg.rdGrow * s.n) + cfg.decay * Math.sqrt(days);

    let p;
    if (cfg.model === 'base') p = (s.ok + 0.5) / (s.n + 1);
    else if (cfg.model === 'A') p = sig(theta);
    else if (cfg.model === 'B') p = sig(theta - b);
    else p = e.it.c + (1 - e.it.c) * sig(theta - b);
    preds.push({ p, y: e.y });

    // 更新：残差用「带蒙对概率」的形式算，能力才不会被蒙对带偏
    const resid = e.y - (e.it.c + (1 - e.it.c) * sig(theta - b));
    const gain = cfg.K * (unc / (unc + 0.5));
    if (cfg.model === 'H') {
      m.t += gain * cfg.modW * resid;
      s.d += gain * resid;
    } else {
      s.d += gain * resid;
    }
    s.n += 1; if (e.y) s.ok += 1; s.last = e.day;
  }
  return preds.slice(Math.floor(seq.length * 0.2));
}

function auc(rows) {
  const pos = rows.filter((r) => r.y === 1).map((r) => r.p);
  const neg = rows.filter((r) => r.y === 0).map((r) => r.p);
  if (!pos.length || !neg.length) return null;
  let win = 0;
  for (const a of pos) for (const b of neg) win += a > b ? 1 : a === b ? 0.5 : 0;
  return win / (pos.length * neg.length);
}
const mean = (xs) => { const v = xs.filter((x) => x != null); return v.reduce((a, b) => a + b, 0) / v.length; };

const users = Array.from({ length: USERS }, makeUser);
const evalCfg = (cfg) => mean(users.map((seq) => auc(runModel(seq, cfg))));
const ceil = mean(users.map((seq) => auc(seq.slice(Math.floor(seq.length * 0.2)).map((e) => ({ p: e.pTrue, y: e.y })))));

const BASE = { model: process.env.MODEL || 'H', useB: 'est', bScale: 1, K: 0.35, rd0: 1.2, rdGrow: 0.3, decay: 0.03, kappa: 6, modW: 0.35 };
console.log(`题库结构 ${items.length} 题 / ${usableKps.length} 个考点 · ${USERS} 名学生 × ${PER} 条作答\n`);

console.log('【一】模型对比');
const modelRows = [
  ['真实概率（上限）', ceil],
  ['基线·历史正确率', evalCfg({ ...BASE, model: 'base' })],
  ['A 只看强弱（单层）', evalCfg({ ...BASE, model: 'A' })],
  ['B 加难度（单层）', evalCfg({ ...BASE, model: 'B' })],
  ['C 加难度+蒙对（单层）', evalCfg({ ...BASE, model: 'C' })],
  ['H 层级+难度+蒙对', evalCfg(BASE)],
  ['H + 真难度（难度字段准的话）', evalCfg({ ...BASE, useB: 'true' })],
  ['H 不要难度', evalCfg({ ...BASE, useB: 'none' })],
];
for (const [n, v] of modelRows) console.log('  ' + n.padEnd(30) + (v == null ? '—' : v.toFixed(4)));

console.log('\n【二】参数扫描（H 模型，只动一个）');
const grid = {
  'K 学习率': ['K', [0.15, 0.25, 0.35, 0.5, 0.7]],
  'rd0 初始不确定度': ['rd0', [0.6, 0.9, 1.2, 1.8, 2.5]],
  'rdGrow 不确定度增长': ['rdGrow', [0.1, 0.3, 0.6, 1.0, 1.6]],
  'decay 遗忘': ['decay', [0, 0.03, 0.08, 0.15]],
  'kappa 收缩强度': ['kappa', [2, 4, 6, 10, 16, 30]],
  'bScale 难度权重': ['bScale', [0, 0.5, 0.8, 1.0, 1.3, 1.6]],
  'modW 模块更新权重': ['modW', [0.1, 0.35, 0.7, 1.2]],
};
for (const [label, [key, vals]] of Object.entries(grid)) {
  const out = vals.map((v) => `${v}→${evalCfg({ ...BASE, [key]: v }).toFixed(3)}`);
  console.log('  ' + label.padEnd(20) + out.join('  '));
}

console.log('\n【三】组合搜索');
let best = null;
for (const K of [0.25, 0.35, 0.5]) {
  for (const rd0 of [0.9, 1.2, 1.8]) {
    for (const kappa of [4, 6, 10]) {
      for (const decay of [0, 0.03, 0.08]) {
        const cfg = { ...BASE, K, rd0, kappa, decay };
        const v = evalCfg(cfg);
        if (!best || v > best.v) best = { v, cfg };
      }
    }
  }
}
const def = evalCfg(BASE);
console.log(`  最优：K=${best.cfg.K} rd0=${best.cfg.rd0} kappa=${best.cfg.kappa} decay=${best.cfg.decay} → AUC ${best.v.toFixed(4)}`);
console.log(`  默认：${def.toFixed(4)}（最优比默认 +${((best.v - def) * 100).toFixed(2)}pt）`);

fs.writeFileSync('report/lab-sim.json', JSON.stringify({ items: items.length, kps: usableKps.length, users: USERS, per: PER, ceil, models: modelRows, best: best.cfg, bestAuc: best.v, defaultAuc: def }, null, 2));
console.log('\n明细已写 report/lab-sim.json');
