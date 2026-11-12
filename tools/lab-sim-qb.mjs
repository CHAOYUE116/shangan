/* 每题难度的在线估计到底有没有用：用真实题库结构造「已知真相」的学生，比较三种口径。
 *
 *   BASELINE  章节历史正确率（App 0.6 的做法：最弱章节 → 直接喂题）
 *   C         章节 θ + 题型/模块先验难度（0.7.1）
 *   Q         C + 每题难度（0.7.2：同一道题做过的次数越多，越信它自己的偏差）
 *
 * 真数据生成：θ_chapter ~ N(0, 0.9)；b_true = 先验 + 题目偏差 N(0, QB_SD)；
 * 作答概率 p = c + (1-c)·sigmoid(θ - b)。学生只在部分章节上练（模拟真实覆盖面）。
 *
 * 跑法：node tools/lab-sim-qb.mjs [每学生作答数=1200] [学生数=24]
 */
import { DatabaseSync } from 'node:sqlite';

const PER = Number(process.argv[2] || 1200);
const USERS = Number(process.argv[3] || 24);
const QB_SD = Number(process.argv[4] || 0.9);
// 每个学生只在自己那批题里循环：POOL=0 表示全库随机（每题基本只遇到一次），
// POOL=400 模拟「错题反复做 + 专项刷同一批题」
const POOL = Number(process.argv[5] || 0);

let seed = 20261113;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => { const u = Math.max(1e-9, rnd()); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
const sig = (x) => 1 / (1 + Math.exp(-x));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/* ---------- 和 lab.js 保持一致的先验 ---------- */
const TYPE_PRIOR = { 1: 0, 2: 0.7, 3: 0.9, 5: -0.5 };
const CH_PRIOR = {
  数量关系: 0.6, 资料分析: 0.4, 判断推理: 0.2, 言语理解与表达: 0,
  常识判断: -0.2, 政治理论: -0.1,
  政治理论常识: -0.1, 法律常识: 0.1, 经济常识: 0.1, 科技常识: 0, 人文常识: 0, 地理国情: 0.1, 公文写作: 0,
};
const typePrior = (t) => (TYPE_PRIOR[Number(t)] ?? 0);
const chPrior = (ch) => (CH_PRIOR[String(ch || '')] ?? 0.2);
const B_SCALE = 0.7;
const guessOf = (t, n) => {
  const k = Number(n) || 4;
  if (Number(t) === 5) return 0.5;
  if (Number(t) === 2) return Math.min(0.3, 1 / Math.max(2, Math.pow(2, k - 1)));
  if (Number(t) === 3) return Math.min(0.3, 1 / Math.max(2, k));
  return 1 / Math.max(2, k);
};

/* ---------- 真实题目结构 ---------- */
const db = new DatabaseSync('app-assets/tiku_app.db', { readOnly: true });
const rows = db.prepare(`
  SELECT q.questionId, q.chapter, q.type, q.options
  FROM questions q
  WHERE q.id IN (SELECT MAX(id) FROM questions GROUP BY questionId)
    AND q.type IN (1,2,3,5) AND q.options IS NOT NULL AND q.options <> '[]'
    AND COALESCE(q.q_bad, 0) = 0
`).all();
db.close();
const pool = rows.map((r) => {
  let oc = 4;
  try { oc = JSON.parse(r.options).length || 4; } catch { oc = 4; }
  return { id: r.questionId, ch: r.chapter || '其他', type: r.type, oc };
}).filter((q) => q.ch && q.ch !== '其他');
console.log(`题库可用题 ${pool.length} 道 / 章节 ${new Set(pool.map((q) => q.ch)).size} 个`);

const byCh = new Map();
for (const q of pool) {
  if (!byCh.has(q.ch)) byCh.set(q.ch, []);
  byCh.get(q.ch).push(q);
}
const chapters = [...byCh.keys()];

/* ---------- 三个模型 ---------- */
function mkState() {
  return { ch: new Map(), q: new Map() };
}

function predBaseline(st, q) {
  const s = st.ch.get(q.ch);
  if (!s || !s.n) return 0.5;
  return (s.ok + 1) / (s.n + 2);
}
function predC(st, q) {
  const s = st.ch.get(q.ch);
  const b = B_SCALE * (typePrior(q.type) + chPrior(q.ch));
  const c = guessOf(q.type, q.oc);
  if (!s || !s.n) return c + (1 - c) * sig(0 - b);
  return c + (1 - c) * sig(s.t - b);
}
function predQ(st, q) {
  const s = st.ch.get(q.ch);
  const qq = st.q.get(q.id);
  const b = qq ? qq.b : B_SCALE * (typePrior(q.type) + chPrior(q.ch));
  const c = guessOf(q.type, q.oc);
  if (!s || !s.n) return c + (1 - c) * sig(0 - b);
  return c + (1 - c) * sig(s.t - b);
}

const K_GAIN = 0.4;
const B_LR = 0.35;
const B_SHRINK = 8;

function learn(st, q, y, p) {
  const s = st.ch.get(q.ch) || { t: 0, rd: 1.2, n: 0, ok: 0 };
  st.ch.set(q.ch, s);
  const c = guessOf(q.type, q.oc);
  const K = K_GAIN * (s.rd / (s.rd + 0.5));
  s.t = clamp(s.t + K * (y - p) / Math.max(0.35, 1 - c), -4, 4);
  s.rd = Math.max(0.18, s.rd * 0.985);
  s.n += 1;
  if (y) s.ok += 1;
  const qq = st.q.get(q.id) || { b: B_SCALE * (typePrior(q.type) + chPrior(q.ch)), n: 0 };
  st.q.set(q.id, qq);
  const lr = B_LR / (1 + qq.n / B_SHRINK);
  qq.b = clamp(qq.b + lr * (p - y), -2.5, 2.5);
  qq.n += 1;
}

/** Mann-Whitney 秩和法（并列取平均秩） */
function auc(scored) {
  const pos = scored.filter((s) => s.y === 1).length;
  const neg = scored.length - pos;
  if (!pos || !neg) return null;
  const arr = scored.map((s) => ({ p: s.p, y: s.y })).sort((a, b) => a.p - b.p);
  let i = 0;
  let rankSum = 0;
  while (i < arr.length) {
    let j = i;
    while (j + 1 < arr.length && arr[j + 1].p === arr[i].p) j += 1;
    const avg = (i + j) / 2 + 1; // 1-based 平均秩
    for (let k = i; k <= j; k += 1) if (arr[k].y) rankSum += avg;
    i = j + 1;
  }
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

const acc = { base: [], c: [], q: [] };
const oracle = [];

for (let u = 0; u < USERS; u += 1) {
  // 每个学生真实能力：只练 40%~70% 的章节
  const theta = new Map();
  const chosen = chapters.filter(() => rnd() < 0.55);
  const use = chosen.length >= 3 ? chosen : chapters.slice(0, 3);
  for (const ch of use) theta.set(ch, gauss() * 0.9);
  // 每题真实难度 = 先验 + 题目偏差
  const bTrue = new Map();
  for (const q of pool) {
    if (!theta.has(q.ch)) continue;
    bTrue.set(q.id, B_SCALE * (typePrior(q.type) + chPrior(q.ch)) + gauss() * QB_SD);
  }
  let cand = pool.filter((q) => bTrue.has(q.id));
  if (!cand.length) continue;
  if (POOL && cand.length > POOL) {
    const picked = [];
    const used = new Set();
    while (picked.length < POOL && used.size < cand.length) {
      const k = Math.floor(rnd() * cand.length);
      if (used.has(k)) continue;
      used.add(k); picked.push(cand[k]);
    }
    cand = picked;
  }

  const st = mkState();
  for (let i = 0; i < PER; i += 1) {
    const q = cand[Math.floor(rnd() * cand.length)];
    const b = bTrue.get(q.id);
    const c = guessOf(q.type, q.oc);
    const pTrue = c + (1 - c) * sig(theta.get(q.ch) - b);
    const y = rnd() < pTrue ? 1 : 0;
    const pB = predBaseline(st, q);
    const pC = predC(st, q);
    const pQ = predQ(st, q);
    if (i >= PER * 0.3) {
      acc.base.push({ p: pB, y });
      acc.c.push({ p: pC, y });
      acc.q.push({ p: pQ, y });
      oracle.push({ p: pTrue, y });
    }
    learn(st, q, y, pQ);
  }
}

const f = (x) => (x == null ? '  -  ' : x.toFixed(4));
console.log(`\n每学生 ${PER} 条作答 × ${USERS} 人，题目偏差 σ=${QB_SD}，题池 ${POOL || '全库'}（后 70% 计分）`);
console.log(`理论上限(AUC)   ${f(auc(oracle))}`);
console.log(`BASELINE  章节正确率  ${f(auc(acc.base))}`);
console.log(`C         章节θ+先验   ${f(auc(acc.c))}`);
console.log(`Q         +每题难度    ${f(auc(acc.q))}`);
const a = auc(acc.c); const b2 = auc(acc.q);
if (a != null && b2 != null) console.log(`每题难度带来的差：${(((b2 - a) * 100)).toFixed(2)} pt`);
