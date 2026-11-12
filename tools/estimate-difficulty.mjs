/* 给题库补一个「算出来的难度」。
 *
 * 背景：粉笔接口不下发每题难度（我扫过 1,384 份整卷语料，difficulty 字段 100% 是 null），
 * 我们库里那个 5 是早期整卷数据的默认值 —— 单选 53% 是 5、判断题 86% 是 5，等于没标。
 *
 * 所以这里不假装能给「真难度」，只给一个可解释的结构先验：
 *   b = 题型(判断 -0.6 / 多选 +0.8 / 不定项 +1.0 / 单选 0)
 *     + 模块(数量关系 +0.9 / 资料分析 +0.7 / 判断推理 +0.4 / 言语 +0.1 / 常识 0 / 政治理论 -0.1 / 其他 +0.2)
 *     + 0.25·ln(1 + 题干长度/60) + 0.20·ln(1 + 材料长度/300) − 0.15·ln(选项数)
 * 再映射到 1..9：difficulty = round(5 + 1.6·b)，夹在 1..9。
 *
 * 用法：
 *   node tools/estimate-difficulty.mjs            # 只统计，不写库
 *   node tools/estimate-difficulty.mjs --apply    # 写 difficulty，并标 difficulty_source='structural'
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const APPLY = process.argv.includes('--apply');
const DB = 'app-assets/tiku_app.db';

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
let changed = 0;
const updates = [];
for (const r of rows) {
  const oc = optCount(r.options);
  const b = TYPE_PRIOR(r.type) + CH_PRIOR(r.chapter)
    + 0.25 * Math.log(1 + (r.stemLen || 0) / 60)
    + 0.2 * Math.log(1 + (r.matLen || 0) / 300)
    - 0.15 * Math.log(Math.max(1, oc));
  const d = Math.max(1, Math.min(9, Math.round(5 + 1.6 * b)));
  hist.set(d, (hist.get(d) || 0) + 1);
  if (Number(r.difficulty) !== d) changed += 1;
  updates.push([d, r.id]);
}

console.log(`去重题 ${rows.length.toLocaleString()} 道`);
console.log('难度分布（1..9）：');
for (const d of [...hist.keys()].sort((a, b) => a - b)) {
  const n = hist.get(d);
  console.log(`  ${d}  ${String(n).padStart(7)}  ${((n / rows.length) * 100).toFixed(1)}%`);
}
console.log(`与原 difficulty 不同的：${changed.toLocaleString()} 道（${((changed / rows.length) * 100).toFixed(1)}%）`);

if (APPLY) {
  const has = db.prepare("SELECT COUNT(*) c FROM pragma_table_info('questions') WHERE name = 'difficulty_source'").get();
  if (!has.c) db.exec("ALTER TABLE questions ADD COLUMN difficulty_source TEXT");
  const up = db.prepare('UPDATE questions SET difficulty = ?, difficulty_source = ? WHERE id = ?');
  db.exec('BEGIN');
  for (const [d, id] of updates) up.run(d, 'structural', id);
  db.exec('COMMIT');
  console.log('已写入 difficulty（来源标记 structural）');
} else {
  console.log('（只统计，没写库；要写加 --apply）');
}
db.close();
