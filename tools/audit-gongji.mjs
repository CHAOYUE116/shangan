#!/usr/bin/env node
/**
 * tools/audit-gongji.mjs — 审核 linfukai 导入的公基题质量
 *
 * 判据参考《蒸馏方法参考》：
 *   §3.3 自动判据会误报（选非题、「锁定A、C」、「故不选D」），所以"不一致"只列为待人工看
 *   §6   五个指标：字段完备率 / 答案一致率 / 疑点率 / 题型覆盖 + 人工抽检
 *
 * 用法：node tools/audit-gongji.mjs [--sample 8]
 */
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? Number(argv[i + 1]) : d; };
const SAMPLE = arg('sample', 8);

const db = new DatabaseSync('D:/Projects/上岸APP/kaogong-shuati/tiku.db', { readOnly: true });
const rows = db.prepare(`
  SELECT questionId, chapter, type, content, material, options, answer, analysis
  FROM questions WHERE source = 'linfukai'
`).all();

const n = rows.length;
const p = (x) => `${x} (${(x / n * 100).toFixed(1)}%)`;
console.log(`审核样本：${n} 题\n`);

// ---------- 1 字段完备率 ----------
let noStem = 0, shortStem = 0, noOpts = 0, badOptCount = 0, emptyOpt = 0;
let noAns = 0, badAns = 0, noAna = 0, thinAna = 0, cidLeft = 0;
const optCounts = {};
const anaLens = [];

for (const r of rows) {
  const content = String(r.content || '').trim();
  const opts = (() => { try { return JSON.parse(r.options || '[]'); } catch { return []; } })();
  const ans = String(r.answer || '').trim();
  const ana = String(r.analysis || '').trim();

  if (!content) noStem += 1;
  else if (content.length < 10) shortStem += 1;
  if (!opts.length) noOpts += 1;
  optCounts[opts.length] = (optCounts[opts.length] || 0) + 1;
  if (opts.length && opts.length !== 4) badOptCount += 1;
  if (opts.some((o) => !String(o).trim())) emptyOpt += 1;
  if (!ans) noAns += 1;
  if (ans && !/^[A-D]$/.test(ans)) badAns += 1;
  if (!ana) noAna += 1;
  else if (ana.length < 20) thinAna += 1;
  if (/\(cid:\d+\)/.test(content + ana)) cidLeft += 1;
  if (ana) anaLens.push(ana.length);
}

console.log('【字段完备率】');
console.log(`  题干缺失/过短   ${p(noStem + shortStem)}`);
console.log(`  无选项          ${p(noOpts)}    选项数分布 ${JSON.stringify(optCounts)}`);
console.log(`  选项数≠4        ${p(badOptCount)}`);
console.log(`  空选项          ${p(emptyOpt)}`);
console.log(`  无答案          ${p(noAns)}`);
console.log(`  答案非 A-D      ${p(badAns)}`);
console.log(`  无解析          ${p(noAna)}    解析过短(<20字) ${p(thinAna)}`);
console.log(`  残留 (cid:xxx)  ${p(cidLeft)}`);
anaLens.sort((a, b) => a - b);
console.log(`  解析长度 中位 ${anaLens[Math.floor(anaLens.length / 2)]} / P90 ${anaLens[Math.floor(anaLens.length * 0.9)]}`);

// ---------- 2 答案 vs 解析一致性（§3.3 分层判据） ----------
const strong = [];
const weak = [];
for (const r of rows) {
  const ana = String(r.analysis || '');
  const ans = String(r.answer || '').trim();
  if (!ana || !ans) continue;
  const isNeg = /选非|不正确|错误的是|不属于|不能|除哪项外|不符合/.test(String(r.content || ''));
  // 结论层：答案为 X / 故选 X / 错误项为 X / 只有 X 项
  let m = ana.match(/(?:正确答案|答案为|故选|应选|答案选)\s*[:：]?\s*([A-D])/);
  if (m && m[1] !== ans) strong.push({ id: r.questionId, got: m[1], exp: ans, neg: isNeg, kind: 'strong', snip: ana.slice(0, 60) });
  else if (!m) {
    // 弱判据：X 项正确 / 应选 X 项 —— 仅在没有结论层命中时兜底，且排除否定语境
    const w = ana.match(/([A-D])\s*项(?:正确|说法正确|当选)/);
    if (w && w[1] !== ans && !isNeg) weak.push({ id: r.questionId, got: w[1], exp: ans, kind: 'weak', snip: ana.slice(0, 60) });
  }
}
console.log('\n【答案一致性】');
console.log(`  结论层冲突（strong，需人工看）: ${strong.length}`);
for (const s of strong.slice(0, 5)) console.log(`    qid=${s.id} 解析说 ${s.got} / 字段 ${s.exp}  选非=${s.neg}`);
console.log(`  弱判据冲突（weak，多为误报）  : ${weak.length}`);

// ---------- 3 人工抽检 ----------
console.log(`\n【随机抽检 ${SAMPLE} 题】`);
const pick = [];
const step = Math.max(1, Math.floor(n / SAMPLE));
for (let i = 0; i < SAMPLE && i * step < n; i++) pick.push(rows[i * step]);
for (const r of pick) {
  const opts = (() => { try { return JSON.parse(r.options || '[]'); } catch { return []; } })();
  console.log(`\n  ── qid=${r.questionId} [${r.chapter}] 答案=${r.answer}`);
  console.log(`  题干: ${String(r.content).replace(/\s+/g, ' ').slice(0, 110)}`);
  opts.forEach((o, i) => console.log(`    ${'ABCD'[i]}. ${String(o).slice(0, 60)}`));
  console.log(`  解析: ${String(r.analysis).replace(/\s+/g, ' ').slice(0, 130)}`);
}
db.close();
