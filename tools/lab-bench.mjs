/* 实验室离线基准：用「已知真相」的模拟学生，验证四个模型能不能把真相捞回来。
 *
 * 为什么要这个：真机上只有几十条作答，AUC 的波动比模型之间的差距还大，
 * 拿它判断「哪个模型好」等于掷骰子。所以先造一批「我们知道答案」的数据：
 *   - 60 个考点，每个考点有个真能力 θ（围绕 0 波动）
 *   - 每道题的难度 b 由题型决定（判断简单、多选难），再加噪声
 *   - 四选一有 25% 蒙对，判断题 50%
 *   - 学过的考点能力会随时间衰减（30 天忘掉一部分）
 * 然后让每个模型只看「答对没答对」，去猜「下一题会不会答对」，
 * 跟真相比 AUC。谁接近「用真相算出来的上限」，谁就值得上。
 *
 * 跑法：node tools/lab-bench.mjs [作答条数，默认 4000]
 */
const N = Number(process.argv[2] || 4000);
const KPS = 60;

// 固定随机种子，保证每次跑结果一样
let seed = 20261112;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const gauss = () => {
  const u = Math.max(1e-9, rnd());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
};
const sig = (x) => 1 / (1 + Math.exp(-x));

// ---------- 1. 造一个「真实世界」 ----------
const kpTrue = Array.from({ length: KPS }, () => ({ theta: gauss() * 0.9, decay: 0.003 + rnd() * 0.004 }));
const TYPES = [
  { name: '单选', b: 0, c: 0.25, w: 0.7 },
  { name: '多选', b: 0.7, c: 0.1, w: 0.1 },
  { name: '判断', b: -0.5, c: 0.5, w: 0.2 },
];
const pickType = () => {
  const r = rnd();
  let acc = 0;
  for (const t of TYPES) { acc += t.w; if (r <= acc) return t; }
  return TYPES[0];
};

const truth = (kp, b, c, elapsedDays) => {
  const t = kp.theta - kp.decay * elapsedDays * kp.theta; // 越久没练，离 0 越近（遗忘）
  return c + (1 - c) * sig(t - b);
};

const events = [];
const lastSeen = new Array(KPS).fill(0);
let day = 0;
for (let i = 0; i < N; i++) {
  day += rnd() * 0.02; // 一天做几十道
  const k = Math.floor(rnd() * KPS);
  const t = pickType();
  const b = t.b + gauss() * 0.25;
  const elapsed = day - lastSeen[k];
  const p = truth(kpTrue[k], b, t.c, 0);
  const y = rnd() < p ? 1 : 0;
  lastSeen[k] = day;
  events.push({ k, b, c: t.c, y, day, elapsed, pTrue: p });
}

// ---------- 2. 四个模型，只看 (k, 题型) 和答对没答对 ----------
function evaluate(kind) {
  const S = new Map();
  const preds = [];
  for (const e of events) {
    let s = S.get(e.k);
    if (!s) { s = { t: 0, rd: 1.2, n: 0, ok: 0, last: 0 }; S.set(e.k, s); }
    const days = s.last ? Math.max(0, e.day - s.last) : 0;
    let p;
    if (kind === 'A') p = sig(s.t);
    else if (kind === 'B') p = sig(s.t - e.b);
    else if (kind === 'C') p = e.c + (1 - e.c) * sig(s.t - e.b);
    else if (kind === 'D') p = e.c + (1 - e.c) * sig(s.t - e.b + 0.05 * Math.sqrt(days));
    else p = (s.ok + 0.5) / (s.n + 1); // baseline：历史正确率
    preds.push({ p, y: e.y, pTrue: e.pTrue, n: s.n });
    const K = 0.35 * (s.rd / (s.rd + 0.5));
    s.t += K * (e.y - sig(s.t - e.b));
    s.rd = Math.max(0.18, s.rd * 0.985);
    s.n += 1;
    if (e.y) s.ok += 1;
    s.last = e.day;
  }
  // 前 15% 当热身（此时模型还没数据，没有参考价值）
  const warm = Math.floor(events.length * 0.15);
  return preds.slice(warm);
}

function auc(rows) {
  const pos = rows.filter((r) => r.y === 1).map((r) => r.p);
  const neg = rows.filter((r) => r.y === 0).map((r) => r.p);
  if (!pos.length || !neg.length) return null;
  let win = 0;
  for (const a of pos) for (const b of neg) win += a > b ? 1 : a === b ? 0.5 : 0;
  return win / (pos.length * neg.length);
}

const ceil = auc(events.slice(Math.floor(events.length * 0.15)).map((e) => ({ p: e.pTrue, y: e.y })));
const rows = [['真实概率（理论上限）', ceil], ['基线（历史正确率）', auc(evaluate('base'))], ['A 只看强弱', auc(evaluate('A'))], ['B 加题型难度', auc(evaluate('B'))], ['C 加蒙对概率', auc(evaluate('C'))], ['D 加遗忘', auc(evaluate('D'))]];

console.log(`模拟 ${N} 条作答 / ${KPS} 个考点 / 前 15% 热身不计分\n`);
console.log('模型'.padEnd(18) + 'AUC');
for (const [name, v] of rows) console.log(name.padEnd(16) + (v == null ? '—' : v.toFixed(4)));
