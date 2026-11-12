/* lab-policy.mjs —— 选题策略与复习调度器的对照实验（离线、可复算）
 *
 * 目的：回答两个「到底有没有用」的问题
 *   一、加 ZPD / 信息量 / Thompson 探索，比现在「按最弱考点抽」能多学到多少？
 *   二、记忆层换 FSRS，同样的保持率能不能少复习？
 *
 * 关键设计：学习增益函数对策略是黑箱
 *   gain(p) = LR · exp(−((p − PEAK)/WIDTH)²)
 *   真峰值 PEAK=0.70、宽度 WIDTH=0.30（不告诉策略），
 *   而 ZPD 策略按文献取 0.85 —— 故意让 ZPD 目标点偏一点，避免自证。
 *   这样「ZPD 赢」不是因为模拟器写了 ZPD，而是因为它真的更接近峰值。
 *
 * 跑法：node tools/lab-policy.mjs [每题预算=200] [学生数=12]
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUDGET = Number(process.argv[2] || 200);
const USERS = Number(process.argv[3] || 12);
const DB = path.join(ROOT, 'app-assets/tiku_app.db');

let seed = 20261112;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => { const u = Math.max(1e-9, rnd()); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
const sig = (x) => 1 / (1 + Math.exp(-x));

// ── 学习增益（对策略黑箱）───────────────────────────────
const PEAK = 0.70;
const WIDTH = 0.30;
const LR = 0.09;
const gain = (p) => LR * Math.exp(-Math.pow((p - PEAK) / WIDTH, 2));

// ── 1. 从真实题库取结构特征 ─────────────────────────────
const db = new DatabaseSync(DB, { readOnly: true });
const rows = db.prepare(`
  SELECT q.questionId, q.chapter, q.type, q.options, length(q.content) stemLen,
         (CASE WHEN q.material IS NULL OR length(q.material) < 20 THEN 0 ELSE length(q.material) END) matLen,
         (SELECT MIN(kpName) FROM question_keypoints k WHERE k.questionId = q.questionId) kp
  FROM questions q
  WHERE q.id IN (SELECT MAX(id) FROM questions GROUP BY questionId)
    AND q.type IN (1,2,3,5) AND q.options IS NOT NULL AND q.options <> '[]'
  LIMIT 12000
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
  const bStruct = TYPE_PRIOR(r.type) + CH_PRIOR(r.chapter)
    + 0.25 * Math.log(1 + (r.stemLen || 0) / 60)
    + 0.2 * Math.log(1 + (r.matLen || 0) / 300)
    - 0.15 * Math.log(Math.max(1, oc));
  return {
    id: String(r.questionId),
    kp: r.kp || r.chapter || '未分类',
    chapter: r.chapter || '未分类',
    type: String(r.type),
    c: String(r.type) === '5' ? 0.5 : oc >= 2 ? 1 / oc : 0.25,
    b: bStruct,                       // 模型能算到的
    bTrue: bStruct + gauss() * 0.45,  // 真难度 = 结构 + 看不到的那部分
  };
});
const byKp = new Map();
for (const it of items) {
  if (!byKp.has(it.kp)) byKp.set(it.kp, []);
  byKp.get(it.kp).push(it);
}
// 只留分布正常的考点（≥6 题），并限制在 ~150 个考点，控制运行时间
const KPS = [...byKp.entries()].filter(([, v]) => v.length >= 6).slice(0, 150);
const kpNames = KPS.map(([k]) => k);
const kpItems = new Map(KPS);

// ── 2. 学生 ─────────────────────────────────────────────
function makeStudent() {
  const modA = new Map();
  for (const it of items) if (!modA.has(it.chapter)) modA.set(it.chapter, gauss() * 0.8);
  const theta = new Map();
  for (const k of kpNames) theta.set(k, (modA.get(kpItems.get(k)[0].chapter) || 0) + gauss() * 0.55);
  return { theta, modA };
}

// ── 3. 策略 ─────────────────────────────────────────────
function makeState() {
  return {
    hist: new Map(),   // kp -> {n, ok, t, rd, last}
    seen: new Map(),   // itemId -> attempts
    log: [],           // {kp, item, pTrue, y}
  };
}
function st(state, kp) {
  let s = state.hist.get(kp);
  if (!s) { s = { t: 0, rd: 1.2, n: 0, ok: 0, last: 0 }; state.hist.set(kp, s); }
  return s;
}
const pTrueOf = (theta, kp, it) => it.c + (1 - it.c) * sig(theta.get(kp) - it.bTrue);
const pEstOf = (s, it) => it.c + (1 - it.c) * sig(s.t - 0.7 * it.b);

const POLICIES = {
  // 现在的 App：按「考点历史正确率」最低挑
  'weakest-rate（现在的 App）': (state) => {
    let best = null;
    for (const k of kpNames) {
      const s = state.hist.get(k);
      const rate = s ? (s.ok + 0.5) / (s.n + 1) : 0.5;      // 没做过的按 0.5，跟现实现象一致
      const score = rate + (s ? 0 : 0.02);                    // 未练过的略微靠后
      if (!best || score < best.score) best = { k, score };
    }
    return best.k;
  },
  // 0.7 实验版：按能力分最低挑
  'theta-lowest（0.7 实验室）': (state) => {
    let best = null;
    for (const k of kpNames) {
      const t = st(state, k).t;
      if (!best || t < best.t) best = { k, t };
    }
    return best.k;
  },
  // 纯随机（下界）
  'random（下界）': () => kpNames[Math.floor(rnd() * kpNames.length)],
  // ZPD：挑「预测做对概率最接近 0.85」的考点
  'zpd 0.85': (state) => {
    let best = null;
    for (const k of kpNames) {
      const s = st(state, k);
      // 考点里挑一道代表题（离目标最近的），用它的 p 作为该考点可提供的难度
      let bestP = null;
      for (const it of kpItems.get(k)) {
        const p = pEstOf(s, it);
        if (bestP == null || Math.abs(p - 0.85) < Math.abs(bestP - 0.85)) bestP = p;
      }
      const score = Math.abs(bestP - 0.85);
      if (!best || score < best.score) best = { k, score };
    }
    return best.k;
  },
  // ZPD + Thompson 探索（θ 从 N(t, rd) 抽样；15% 强制去没练过的考点）
  ...Object.fromEntries([0.7, 0.75, 0.8].map((target) => [`zpd ${target.toFixed(2)} + 探索`, makeZpd(target)])),
  'zpd + 探索（Thompson 15%）': makeZpd(0.85),
};

function makeZpd(target) {
  return (state) => {
    if (rnd() < 0.15) {
      const unseen = kpNames.filter((k) => !state.hist.has(k));
      if (unseen.length) return unseen[Math.floor(rnd() * unseen.length)];
    }
    let best = null;
    for (const k of kpNames) {
      const s = st(state, k);
      const tSample = s.t + gauss() * Math.min(1.5, s.rd);
      let bestP = null;
      for (const it of kpItems.get(k)) {
        const p = it.c + (1 - it.c) * sig(tSample - 0.7 * it.b);
        if (bestP == null || Math.abs(p - target) < Math.abs(bestP - target)) bestP = p;
      }
      const score = Math.abs(bestP - target);
      if (!best || score < best.score) best = { k, score };
    }
    return best.k;
  };
}

function runPolicy(name, pick, student) {
  const theta = new Map(student.theta);
  const state = makeState();
  let served = 0, inZpd = 0, learned = 0;
  const firstWrong = new Set();
  let conversionHits = 0, conversionBase = 0;
  for (let i = 0; i < BUDGET; i++) {
    const k = pick(state);
    const pool = kpItems.get(k);
    // 同一考点内部：优先没做过的题
    const fresh = pool.filter((it) => !state.seen.has(it.id));
    const it = (fresh.length ? fresh : pool)[Math.floor(rnd() * (fresh.length || pool.length))];
    const p = pTrueOf(theta, k, it);
    const y = rnd() < p ? 1 : 0;
    served += 1;
    if (p >= 0.7 && p <= 0.9) inZpd += 1;
    // 学习：答完这道题，真能力上升（增益只看真实 p，跟策略无关）
    const g = gain(p);
    theta.set(k, Math.min(4, theta.get(k) + g));
    learned += g;
    // 错题转化（考点级）：这个考点第一次做错之后，后续再做到它的正确率
    const first = state.hist.get(k);
    const hadWrong = first && first.ok < first.n;   // 之前在这个考点错过
    if (hadWrong) { conversionBase += 1; if (y === 1) conversionHits += 1; }
    const tries = state.seen.get(it.id) || 0;
    state.seen.set(it.id, tries + 1);
    // 模型更新（与 0.7 实验室同一套）
    const s = st(state, k);
    const pEst = pEstOf(s, it);
    s.t = Math.max(-4, Math.min(4, s.t + 0.4 * (s.rd / (s.rd + 0.5)) * ((y - pEst) / Math.max(0.35, 1 - it.c))));
    s.rd = Math.max(0.18, s.rd * 0.985);
    s.n += 1; if (y) s.ok += 1; s.last = i;
    state.log.push({ kp: k, p, y });
  }
  return { served, learned, zpd: inZpd / served, conv: conversionBase ? conversionHits / conversionBase : null, kps: state.hist.size };
}

// ── 4. 记忆调度器：Leitner（现状）vs FSRS 曲线 ───────────
// 半衰期模型：R(t) = 2^(−t/H)；答对 → H 增长，答错 → H 缩短。
const H0 = 2.2;                                  // 初始半衰期（天）
const recall = (t, H) => Math.pow(2, -t / H);

function simulateScheduler(kind, table, days = 90, nItems = 60, target = 0.9) {
  const items = Array.from({ length: nItems }, (_, i) => ({ born: i, H: H0, lvl: 0, last: i, due: i }));
  let reviews = 0;
  const atReview = [];
  const daily = [];
  for (let d = 0; d < days; d += 1) {
    for (const it of items) {
      if (d < it.born) continue;
      const R = recall(d - it.last, it.H);
      daily.push(R);
      if (d < it.due) continue;
      reviews += 1;
      atReview.push(R);
      const ok = rnd() < R;                        // 命中率 = 当时真实保持率
      if (ok) {
        if (kind === 'table') it.lvl = Math.min(table.length - 1, it.lvl + 1);
        // 答对：记忆强度上长（与当前 R 挂钩，R 越低长得越多，上限 2.6 倍）
        it.H = Math.min(200, it.H * Math.min(2.6, 1 + 1.9 * (1 - R)));
      } else {
        it.lvl = Math.max(0, it.lvl - 2);
        it.H = Math.max(1.1, it.H * 0.55);
      }
      it.last = d;
      it.due = d + Math.max(1, Math.round(kind === 'table'
        ? table[it.lvl]                                   // 现状：固定档位表
        : (Math.log(target) / Math.log(0.5)) * it.H));     // FSRS：按目标保持率反解
    }
  }
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  return { reviews, atReview: avg(atReview), daily: avg(daily) };
}

// ── 5. 跑 ───────────────────────────────────────────────
const students = Array.from({ length: USERS }, makeStudent);
console.log(`题库结构 ${items.length} 题 / ${kpNames.length} 个考点 · ${USERS} 名学生 × 每题预算 ${BUDGET}\n`);
console.log('【一】选题策略：同样答 200 题，谁让你真的变强（增益峰值 p=0.70，策略不知道）');
console.log('  策略'.padEnd(30) + '总增益'.padEnd(10) + 'ZPD命中'.padEnd(10) + '错题转化'.padEnd(10) + '覆盖考点');
const results = {};
for (const [name, pick] of Object.entries(POLICIES)) {
  const rs = students.map((s) => runPolicy(name, pick, s));
  const avg = (f) => rs.reduce((a, r) => a + (f(r) || 0), 0) / rs.length;
  results[name] = { learned: avg((r) => r.learned), zpd: avg((r) => r.zpd), conv: avg((r) => r.conv), kps: avg((r) => r.kps) };
  console.log('  ' + name.padEnd(28)
    + avg((r) => r.learned).toFixed(2).padEnd(10)
    + (avg((r) => r.zpd) * 100).toFixed(1).padStart(5) + '%'.padEnd(5)
    + (avg((r) => r.conv) == null ? '—' : (avg((r) => r.conv) * 100).toFixed(1) + '%').padEnd(10)
    + avg((r) => r.kps).toFixed(0));
}

const base = results['weakest-rate（现在的 App）'].learned;
console.log('\n  相对「现在的 App」：');
for (const [name, r] of Object.entries(results)) {
  if (name.startsWith('weakest')) continue;
  const d = ((r.learned - base) / base) * 100;
  console.log(`    ${name.padEnd(28)} 总增益 ${d >= 0 ? '+' : ''}${d.toFixed(1)}%`);
}

console.log('\n【二】复习调度：同一记忆模型下的「效率前沿」（复习次数 vs 复习时保持率）');
// 保持率越高越费复习，这是物理规律；真正要比的是「同一保持率下谁的次数少」。
// 所以两边各扫一组参数，画出前沿，再在同保持率处比较。
const TABLE = [1, 2, 4, 7, 15, 30];
const frontier = [];
for (const k of [0.6, 0.8, 1.0, 1.3, 1.7]) {
  const tb = TABLE.map((d) => Math.max(1, Math.round(d * k)));
  const r = simulateScheduler('table', tb);
  frontier.push({ name: `固定档位表 ×${k}（${tb.join('/')}）`, kind: 'table', ...r });
}
for (const target of [0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]) {
  const r = simulateScheduler('curve', null, 90, 60, target);
  frontier.push({ name: `按遗忘曲线反解（目标 ${(target * 100).toFixed(0)}%）`, kind: 'curve', target, ...r });
}
const mem = {};
console.log('  方案'.padEnd(38) + '复习次数'.padEnd(10) + '复习时保持率'.padEnd(12) + '平时保持率');
for (const f of frontier) {
  mem[f.name] = f;
  console.log('  ' + f.name.padEnd(36) + String(f.reviews).padEnd(10)
    + (f.atReview * 100).toFixed(1).padStart(6) + '%'.padEnd(6)
    + (f.daily * 100).toFixed(1).padStart(6) + '%');
}
const near = (kind, r) => frontier.filter((f) => f.kind === kind)
  .reduce((a, b) => (Math.abs(b.atReview - r) < Math.abs(a.atReview - r) ? b : a));
// 固定表最高只能到 ~70%，所以以它的最好成绩为对比基准（同保持率才有意义）
const tableBest = frontier.filter((f) => f.kind === 'table').reduce((a, b) => (b.atReview > a.atReview ? b : a));
const tb = tableBest;
const cv = near('curve', tb.atReview);
console.log(`\n  同保持率（≈${(tb.atReview * 100).toFixed(1)}%，即固定表能达到的最高水平）对比：`);
console.log(`    固定档位表 ${tb.name} → ${tb.reviews} 次 / 复习时保持率 ${(tb.atReview * 100).toFixed(1)}%`);
console.log(`    遗忘曲线   ${cv.name} → ${cv.reviews} 次 / 复习时保持率 ${(cv.atReview * 100).toFixed(1)}%`);
console.log(`    → ${cv.reviews < tb.reviews ? '曲线反解更省' : '固定表更省'} ${Math.abs(((cv.reviews - tb.reviews) / tb.reviews) * 100).toFixed(1)}%`);

fs.mkdirSync(path.join(ROOT, 'report'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'report/lab-policy.json'), JSON.stringify({ budget: BUDGET, users: USERS, items: items.length, kps: kpNames.length, policies: results, memory: mem }, null, 2));
console.log('\n明细已写 report/lab-policy.json');
