/* 结构难度估计 —— 只写新列（difficulty_est / difficulty_b / difficulty_src / diff_band），
 * 绝不动原来的 difficulty 字段（那是历史导入的缺省值，几乎全是 5，没有信息量）。
 *
 * 为什么要分位定档（2026-11-12 实测）：
 *   原来用 est = round(5 + 1.6b)：b 的分布集中在 0.3 附近，结果 5:54,788 / 6:33,143 /
 *   7:4,328 / 8:6，**易档(≤4)几乎为零**。而 ZPD 选题要「抽更简单的题把正确率拉回 0.75」，
 *   没有易题就等于这条路走不通。
 *   改成「同一章节内按 b 的排名分位」定档：每章的题自动摊到 1..9，
 *   easy/mid/hard 三档各占约 1/3，任何模块都能抽出三档题。
 *
 * difficulty_est 语义：5 = 该章节的中位难度，越小越容易。
 * diff_band：≤4 easy / 5~6 mid / ≥7 hard（按分位定档后三档大致 44% / 22% / 33%）
 *
 * 写入范围：同一 questionId 的所有行都写（库里有跨卷重复行，只写最新一行会导致
 * 按 questionId join 时大量 NULL —— 上一版就是这么漏掉了 5 万多道）。
 *
 * 用法：
 *   node tools/estimate-difficulty.mjs            # 只统计
 *   node tools/estimate-difficulty.mjs --apply    # 写库
 */
import { DatabaseSync } from 'node:sqlite';

const APPLY = process.argv.includes('--apply');
const argDb = (() => {
  const i = process.argv.indexOf('--db');
  return i > 0 ? process.argv[i + 1] : null;
})();
const DB = argDb || process.env.TIKU_DB || 'app-assets/tiku_app.db';

// 题型基础难度：判断题天然容易（只有对/错），多选/不定项难
const TYPE_PRIOR = (t) => {
  const s = String(t ?? '');
  if (s === '5') return -0.6;
  if (s === '2') return 0.8;
  if (s === '3') return 1.0;
  return 0;
};
// 章节（模块）基础难度
const CH_PRIOR = (ch) => {
  const s = String(ch || '');
  if (/数量关系|数学运算|数字推理/.test(s)) return 0.9;
  if (/资料分析/.test(s)) return 0.7;
  if (/判断推理|图形推理|逻辑判断|逻辑推理|演绎推理|类比推理|定义判断/.test(s)) return 0.4;
  if (/言语|语句|选词|填空|阅读|理解/.test(s)) return 0.1;
  if (/常识判断|常识应用|基本常识|综合常识|人文常识|科技常识|地理|国情|生活常识|文化常识/.test(s)) return 0;
  if (/政治理论|新思想|时事政治|毛中特|马克思主义/.test(s)) return -0.1;
  return 0.2;
};
const optCount = (s) => { try { return JSON.parse(s || '[]').length; } catch { return 0; } };

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout = 30000');
const hasOfficial = db.prepare("SELECT name FROM pragma_table_info('questions')").all().some((c) => c.name === 'fenbi_difficulty');
console.log(`官方难度列：${hasOfficial ? '有' : '无'}`);
const rows = db.prepare(`
  SELECT id, questionId, chapter, type, options, length(content) stemLen,
         ${hasOfficial ? 'fenbi_difficulty' : 'NULL AS fenbi_difficulty'},
         (CASE WHEN material IS NULL OR length(material) < 20 THEN 0 ELSE length(material) END) matLen
  FROM questions
  WHERE id IN (SELECT MAX(id) FROM questions GROUP BY questionId)
    AND type IN (1,2,3,5) AND options <> '[]'
`).all();

// 0) 粉笔全站正确率（question_meta）：有它就用真难度，没有才退回结构先验
const meta = new Map();
try {
  for (const m of db.prepare('SELECT questionId, correctRatio FROM question_meta WHERE correctRatio IS NOT NULL').all()) {
    meta.set(m.questionId, m.correctRatio / 100);
  }
} catch { /* 表还没有 */ }
const guessOf = (t, oc) => (String(t) === '2' || String(t) === '3') ? 0.1 : String(t) === '5' ? 0.5 : (oc >= 2 ? 1 / oc : 0.25);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// 1) 每题一个难度 b：优先正确率反推，否则结构先验
const byQid = new Map();
let ratioN = 0;
let officialN = 0;
for (const r of rows) {
  const oc = optCount(r.options);
  let b = TYPE_PRIOR(r.type) + CH_PRIOR(r.chapter)
    + 0.25 * Math.log(1 + (r.stemLen || 0) / 60)
    + 0.2 * Math.log(1 + (r.matLen || 0) / 300)
    - 0.15 * Math.log(Math.max(1, oc));
  let src = 'structural-chapter';
  const structB = b;
  const p = meta.get(r.questionId);
  let ratioB = null;
  if (p != null) {
    const c = guessOf(r.type, oc);
    const x = clamp((p - c) / (1 - c), 0.02, 0.98);
    ratioB = -Math.log(x / (1 - x));   // 正确率反推的 logit 难度
    b = ratioB;
    src = 'fenbi-ratio';
    ratioN++;
  }
  // 官方难度（1~9，5 为中等）：最可信，直接给 b，并在同难度内用正确率/结构做次序
  const fd = r.fenbi_difficulty;
  let score;
  if (fd != null && Number(fd) > 0) {
    b = (Number(fd) - 5) * 0.45;
    src = 'fenbi-api';
    let tie = clamp((structB + 2) / 8, 0, 0.999);
    if (ratioB != null) tie = 0.5 + clamp(ratioB, -4, 4) / 8 * 0.5;
    score = Number(fd) * 10 + tie;
    officialN++;
  } else {
    score = 0 + clamp((b + 2) / 8, 0, 0.999);   // 没有官方难度：只按 b 排序
  }
  byQid.set(r.questionId, { b, src, score, chapter: r.chapter || '', type: r.type });
}

// 2) 同一章节内按 b 排名 → 分位定档（保证每章三档都有）
const byChapter = new Map();
for (const [qid, v] of byQid) {
  const k = v.chapter || '(未分类)';
  if (!byChapter.has(k)) byChapter.set(k, []);
  byChapter.get(k).push([qid, v.score]);
}
const est = new Map();
for (const [, arr] of byChapter) {
  arr.sort((a, b) => a[1] - b[1]);
  const n = arr.length;
  arr.forEach(([qid], i) => {
    const p = n <= 1 ? 0.5 : i / (n - 1);        // 0..1 排名
    est.set(qid, Math.max(1, Math.min(9, Math.ceil(p * 9))));
  });
}

const bandOf = (e) => (e <= 4 ? 'easy' : e <= 6 ? 'mid' : 'hard');
const hist = new Map();
const bands = new Map();
for (const [qid, e] of est) {
  hist.set(e, (hist.get(e) || 0) + 1);
  const bd = bandOf(e);
  bands.set(bd, (bands.get(bd) || 0) + 1);
}

const total = est.size;
console.log(`库：${DB}`);
console.log(`客观题（去重后）：${total.toLocaleString()} 道 / 章节 ${byChapter.size} 个 / 官方难度 ${officialN.toLocaleString()} 道 / 真正确率 ${ratioN.toLocaleString()} 道`);
console.log('新难度分布（章节内分位）：');
for (const d of [...hist.keys()].sort((a, b) => a - b)) {
  const n = hist.get(d);
  console.log(`  ${d}  ${String(n).padStart(7)}  ${((n / total) * 100).toFixed(1)}%`);
}
console.log('三档：', [...bands].map(([k, v]) => `${k} ${v.toLocaleString()} (${((v / total) * 100).toFixed(0)}%)`).join(' / '));

if (!APPLY) {
  console.log('（只统计，没写库；要写加 --apply）');
  db.close();
  process.exit(0);
}

const cols = new Set(db.prepare("SELECT name FROM pragma_table_info('questions')").all().map((r) => r.name));
if (!cols.has('difficulty_est')) db.exec('ALTER TABLE questions ADD COLUMN difficulty_est INTEGER');
if (!cols.has('difficulty_b')) db.exec('ALTER TABLE questions ADD COLUMN difficulty_b REAL');
if (!cols.has('difficulty_src')) db.exec('ALTER TABLE questions ADD COLUMN difficulty_src TEXT');
if (!cols.has('diff_band')) db.exec('ALTER TABLE questions ADD COLUMN diff_band TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_questions_est ON questions(difficulty_est)');

const up = db.prepare('UPDATE questions SET difficulty_est = ?, difficulty_b = ?, difficulty_src = ?, diff_band = ? WHERE questionId = ?');
db.exec('BEGIN');
for (const [qid, e] of est) { const v = byQid.get(qid); up.run(e, Math.round(v.b * 1000) / 1000, v.src, bandOf(e), qid); }
db.exec('COMMIT');

const chk = db.prepare('SELECT diff_band b, COUNT(*) c FROM questions WHERE diff_band IS NOT NULL GROUP BY b').all();
const nulls = db.prepare(`SELECT COUNT(*) c FROM questions WHERE type IN (1,2,3,5) AND options <> '[]' AND diff_band IS NULL`).get().c;
const integrity = db.prepare('PRAGMA integrity_check').get();
console.log('已写入 difficulty_est / difficulty_b / difficulty_src / diff_band（含同一 questionId 的重复行）');
console.log('库内校验：', chk.map((r) => `${r.b}:${r.c}`).join(' '), `| 仍为 NULL：${nulls}`);
console.log('integrity_check：', Object.values(integrity)[0]);
db.close();
