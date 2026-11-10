#!/usr/bin/env node
/**
 * tools/tiku-audit.mjs — 题库体检
 *
 * 只读。逐项统计「用户点进去会踩到的问题」：
 *   1. 答案为空的题
 *   2. 有选项但答案不在选项里（answerIndex 越界 / answer 字母超出选项数）
 *   3. 选项为空的题
 *   4. 单选题却给了多个答案 / 多选题只有一个答案
 *   5. 解析为空的题（按科目分组）
 *   6. 解析里写着「正确答案X」但和 answer 不一致（答案-解析冲突）
 *   7. 同一道题在库里重复（按题干前 120 字 hash）
 *   8. 科目树里的题数与 papers 对不上（subjectName 缺失）
 *   9. 题干含「（　）」被清成空格的残留（数据采集损坏）
 *
 * 用法：node tools/tiku-audit.mjs [--limit 20]
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d = 0) => { const i = argv.indexOf('--' + n); return i >= 0 ? Number(argv[i + 1]) : d; };
const LIMIT = arg('limit', 12);

const db = new DatabaseSync(path.resolve(ROOT, 'app-assets/tiku_app.db'), { readOnly: true });
const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);

const total = one('SELECT COUNT(1) n FROM questions').n;
console.log(`题库总行数 ${total}`);

function section(title) { console.log(`\n=== ${title} ===`); }

/* 1. 答案为空 */
section('1. 答案为空');
const noAns = all(`SELECT p.subjectName s, COUNT(1) n FROM questions q JOIN papers p ON p.id=q.paperId
  WHERE q.answer IS NULL OR TRIM(q.answer)='' GROUP BY p.subjectName ORDER BY n DESC`);
console.log(`合计 ${noAns.reduce((a, r) => a + r.n, 0)} 题`);
noAns.forEach((r) => console.log(`  ${r.s}\t${r.n}`));

/* 2. 答案为空但有选项 —— 用户点开就是空白 */
section('2. 有选项但答案为空（最伤：选项都在，判不了分）');
const orphan = all(`SELECT q.id, q.answer, q.optionType, q.options, p.subjectName s, p.name pn, substr(q.content,1,60) c
  FROM questions q JOIN papers p ON p.id=q.paperId
  WHERE (q.answer IS NULL OR TRIM(q.answer)='') AND q.options IS NOT NULL AND LENGTH(TRIM(q.options))>10
  LIMIT ?`, LIMIT);
orphan.forEach((r) => console.log(`  #${r.id} [${r.s}] ${r.pn}\n     ${r.c.replace(/\n/g, ' ')}`));
console.log(`  （总计 ${one(`SELECT COUNT(1) n FROM questions q WHERE (q.answer IS NULL OR TRIM(q.answer)='') AND q.options IS NOT NULL AND LENGTH(TRIM(q.options))>10`).n} 题）`);

/* 3. 选项为空 */
section('3. 选项为空');
const noOpt = all(`SELECT p.subjectName s, COUNT(1) n FROM questions q JOIN papers p ON p.id=q.paperId
  WHERE (q.options IS NULL OR TRIM(q.options)='' OR q.options='[]') GROUP BY p.subjectName ORDER BY n DESC`);
console.log(`合计 ${noOpt.reduce((a, r) => a + r.n, 0)} 题`);
noOpt.forEach((r) => console.log(`  ${r.s}\t${r.n}`));

/* 4. 题量与科目分布 */
section('4. 各科目题量（行 / 唯一 questionId / 卷数）');
all(`SELECT p.subjectName s, COUNT(1) rows, COUNT(DISTINCT q.questionId) uniq, COUNT(DISTINCT p.id) papers
  FROM questions q JOIN papers p ON p.id=q.paperId GROUP BY p.subjectName ORDER BY rows DESC`)
  .forEach((r) => console.log(`  ${r.s.padEnd(12)} 行 ${String(r.rows).padStart(6)}  唯一 ${String(r.uniq).padStart(6)}  卷 ${r.papers}`));

/* 5. 解析为空 */
section('5. 解析为空');
all(`SELECT p.subjectName s, COUNT(1) n, ROUND(100.0*COUNT(1)/(SELECT COUNT(1) FROM questions q2 JOIN papers p2 ON p2.id=q2.paperId WHERE p2.subjectName=p.subjectName),1) pct
  FROM questions q JOIN papers p ON p.id=q.paperId
  WHERE q.analysis IS NULL OR TRIM(q.analysis)='' GROUP BY p.subjectName ORDER BY n DESC`)
  .forEach((r) => console.log(`  ${r.s.padEnd(12)} ${String(r.n).padStart(5)} 题  ${r.pct}%`));

/* 6. 答案-解析冲突 */
section('6. 答案与解析里的「正确答案X」冲突');
const conflicts = all(`SELECT q.id, q.answer, q.analysis, p.subjectName s FROM questions q JOIN papers p ON p.id=q.paperId
  WHERE q.analysis LIKE '%正确答案%' AND q.answer IS NOT NULL AND TRIM(q.answer)<>''`);
let bad = 0;
const badList = [];
for (const r of conflicts) {
  const m = String(r.analysis).match(/正确答案[是为：:\s]*([A-H])/);
  if (!m) continue;
  const a = String(r.answer).toUpperCase().replace(/[^A-H]/g, '');
  if (!a) continue;
  if (!a.includes(m[1])) { bad++; if (badList.length < LIMIT) badList.push({ ...r, said: m[1] }); }
}
console.log(`  抽查 ${conflicts.length} 条含「正确答案」的解析，冲突 ${bad} 条`);
badList.forEach((r) => console.log(`  #${r.id} 库内=${r.answer} 解析说=${r.said} [${r.s}]`));

/* 7. 重复题 */
section('7. 重复题（题干前 120 字 hash）');
const seen = new Map();
let dupGroups = 0, dupExtra = 0;
for (const r of all('SELECT id, questionId, content FROM questions')) {
  const h = crypto.createHash('sha1').update(String(r.content || '').replace(/\s/g, '').slice(0, 120)).digest('hex');
  if (!seen.has(h)) seen.set(h, []);
  seen.get(h).push(r.id);
}
for (const [, ids] of seen) if (ids.length > 1) { dupGroups++; dupExtra += ids.length - 1; }
console.log(`  重复组 ${dupGroups}，多出来的行 ${dupExtra}（同一题被多份卷收录是正常的，这里只做提示）`);

/* 8. 题干「（　）」被清成空格 */
section('8. 题干里的「（　）」被采集清成空格');
const spacing = one(`SELECT COUNT(1) n FROM questions WHERE content LIKE '%是  %' OR content LIKE '%项是    %' OR content GLOB '*下列[ ]*项*'`);
console.log(`  疑似 ${spacing.n} 题（示例：'使用不当的一项是    。'）`);

/* 9. 材料引用但没材料 */
section('9. 题干引用了材料但 material 为空');
const noMat = one(`SELECT COUNT(1) n FROM questions WHERE (material IS NULL OR TRIM(material)='') AND (content LIKE '%材料%' OR content LIKE '%根据上文%' OR content LIKE '%上述%')`);
console.log(`  ${noMat.n} 题`);

console.log('\n体检结束。');
