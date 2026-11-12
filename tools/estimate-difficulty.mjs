/* 给题库补一个「算出来的难度」——写新列，不动老字段。
 *
 * 背景：粉笔接口不下发每题难度（扫过 1,384 份整卷语料，difficulty 字段 100% 是 null），
 * 我们库里那个 5 是早期整卷数据的默认值 —— 单选 53% 是 5、判断题 86% 是 5，等于没标。
 *
 * 所以这里不假装能给「真难度」，只给一个可解释的结构先验：
 *   b = 题型(判断 -0.6 / 多选 +0.8 / 不定项 +1.0 / 单选 0)
 *     + 模块(数量关系 +0.9 / 资料分析 +0.7 / 判断推理 +0.4 / 言语 +0.1 / 常识 0 / 政治理论 -0.1 / 其他 +0.2)
 *     + 0.25·ln(1 + 题干长度/60) + 0.20·ln(1 + 材料长度/300) − 0.15·ln(选项数)
 *
 * 写入三列（都是新列，老 difficulty 原样保留，方便对比与回滚）：
 *   difficulty_est  1..9 的整数，给人看、给「简单/中等/困难」筛选用
 *   difficulty_b    logit，给引擎算 sigmoid 用
 *   difficulty_src  'structural'（结构先验）/ 'record'（将来按作答反推）
 *
 * 用法：
 *   node tools/estimate-difficulty.mjs            # 只统计，不写库
 *   node tools/estimate-difficulty.mjs --apply    # 写三列
 */
import { DatabaseSync } from 'node:sqlite';

const APPLY = process.argv.includes('--apply');
const DB = process.env.TIKU_DB || 'app-assets/tiku_app.db';

const TYPE_PRIOR = (t) => (String(t) === '5' ? -0.6 : String(t) === '2' ? 0.8 : String(t) === '3' ? 1.0 : 0);
const CH_PRIOR = (c) => {
  const s = String(c || '');
  if (/数量关系/.test(s)) return 0.9;
  if (/资料分析/.test(s)) return 0.7;
  if (/判断推理/.test(s)) return 0.4;
  if (/言语理解/.test(s)) return 0.1;
  if (/常识判断/.test(s)) return 0;
  if (/政治理论/.test(s)) return -0.1;
  return 0.2;
};
const optCount = (s) => { try { return JSON.parse(s || '[]').length; } catch { return 0; } };

const db = new DatabaseSync(DB);
const rows = db.prepare(`
  SELECT id, questionId, chapter, type, options, length(content) stemLen,
         (CASE WHEN material IS NULL OR length(material) < 20 THEN 0 ELSE length(material) END) matLen,
         difficulty
  FROM questions
  WHERE id IN (SELECT MAX(id) FROM questions GROUP BY questionId)
`).all();

const hist = new Map();
const shifts = new Map();
let changed = 0;
const updates = [];
for (const r of rows) {
  const oc = optCount(r.options);
  const b = TYPE_PRIOR(r.type) + CH_PRIOR(r.chapter)
    + 0.25 * Math.log(1 + (r.stemLen || 0) / 60)
    + 0.2 * Math.log(1 + (r.matLen || 0) / 300)
    - 0.15 * Math.log(Math.max(1, oc));
  const est = Math.max(1, Math.min(9, Math.round(5 + 1.6 * b)));
  hist.set(est, (hist.get(est) || 0) + 1);
  const old = Number(r.difficulty);
  if (Number.isFinite(old) && old > 0) {
    const d = est - old;
    shifts.set(d, (shifts.get(d) || 0) + 1);
    if (d !== 0) changed += 1;
  }
  updates.push([est, Math.round(b * 1000) / 1000, r.id]);
}

const total = rows.length;
console.log(`去重题 ${total.toLocaleString()} 道（库 ${DB}）`);
console.log('新难度分布（difficulty_est 1..9）：');
for (const d of [...hist.keys()].sort((a, b) => a - b)) {
  const n = hist.get(d);
  console.log(`  ${d}  ${String(n).padStart(7)}  ${((n / total) * 100).toFixed(1)}%`);
}
console.log(`与老 difficulty 不同的：${changed.toLocaleString()} 道（${((changed / total) * 100).toFixed(1)}%）`);
console.log('位移分布（est − 老值）：');
for (const d of [...shifts.keys()].sort((a, b) => a - b)) {
  console.log(`  ${d > 0 ? '+' : ''}${d}  ${String(shifts.get(d)).padStart(7)}`);
}
const mean = updates.reduce((s, x) => s + x[1], 0) / (updates.length || 1);
const sd = Math.sqrt(updates.reduce((s, x) => s + (x[1] - mean) ** 2, 0) / (updates.length || 1));
console.log(`difficulty_b：均值 ${mean.toFixed(3)} / 标准差 ${sd.toFixed(3)}`);

if (APPLY) {
  const cols = new Set(db.prepare("SELECT name FROM pragma_table_info('questions')").all().map((r) => r.name));
  if (!cols.has('difficulty_est')) db.exec('ALTER TABLE questions ADD COLUMN difficulty_est INTEGER');
  if (!cols.has('difficulty_b')) db.exec('ALTER TABLE questions ADD COLUMN difficulty_b REAL');
  if (!cols.has('difficulty_src')) db.exec('ALTER TABLE questions ADD COLUMN difficulty_src TEXT');
  const up = db.prepare('UPDATE questions SET difficulty_est = ?, difficulty_b = ?, difficulty_src = ? WHERE id = ?');
  db.exec('BEGIN');
  for (const [est, b, id] of updates) up.run(est, b, 'structural', id);
  db.exec('COMMIT');
  const chk = db.prepare('SELECT difficulty_est e, COUNT(*) c FROM questions WHERE difficulty_est IS NOT NULL GROUP BY e ORDER BY e').all();
  console.log('已写入 difficulty_est / difficulty_b / difficulty_src=structural');
  console.log('库内校验：', chk.map((r) => `${r.e}:${r.c}`).join(' '));
} else {
  console.log('（只统计，没写库；要写加 --apply）');
}
db.close();
