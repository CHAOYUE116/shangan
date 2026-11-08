#!/usr/bin/env node
/** tools/audit-full.mjs — 全库体检报告（一次跑完所有维度） */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const db = new DatabaseSync(path.join(ROOT, 'tiku.db'));
const pdb = new DatabaseSync(path.join(ROOT, 'practice.db'));

const q = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);

console.log('=== 试卷表结构 ===');
console.log(one("SELECT sql FROM sqlite_master WHERE name='papers'").sql.replace(/\s+/g, ' ').slice(0, 300));

console.log('\n=== 总量 ===');
const tot = one('SELECT COUNT(*) c, COUNT(DISTINCT questionId) u FROM questions');
console.log(`题目行 ${tot.c}，唯一题 ${tot.u}（一题多卷 ${(tot.c / tot.u).toFixed(2)}×）`);
console.log(`试卷 ${one('SELECT COUNT(*) c FROM papers').c} 份`);

console.log('\n=== 按科目 ===');
const bySub = q(`
  SELECT p.subjectName sub, COUNT(DISTINCT q.questionId) n,
    (SELECT COUNT(DISTINCT q2.questionId) FROM questions q2 JOIN papers p2 ON p2.id=q2.paperId WHERE p2.subjectName=p.subjectName AND (q2.analysis IS NULL OR q2.analysis='')) noAna,
    (SELECT COUNT(DISTINCT q2.questionId) FROM questions q2 JOIN papers p2 ON p2.id=q2.paperId WHERE p2.subjectName=p.subjectName AND q2.analysis IS NOT NULL AND length(q2.analysis)<60) shortAna,
    (SELECT COUNT(DISTINCT q2.questionId) FROM questions q2 JOIN papers p2 ON p2.id=q2.paperId WHERE p2.subjectName=p.subjectName AND (q2.answer IS NULL OR q2.answer='')) noAns,
    (SELECT COUNT(DISTINCT q2.questionId) FROM questions q2 JOIN papers p2 ON p2.id=q2.paperId WHERE p2.subjectName=p.subjectName AND (q2.difficulty IS NULL OR q2.difficulty=0)) noDiff
  FROM questions q JOIN papers p ON p.id=q.paperId GROUP BY p.subjectName ORDER BY n DESC`);
for (const r of bySub) {
  const pct = (x) => ((x / r.n) * 100).toFixed(1) + '%';
  console.log(`${String(r.sub).padEnd(14)} ${String(r.n).padStart(6)}  无解析 ${pct(r.noAna).padStart(6)}  短解析 ${pct(r.shortAna).padStart(6)}  无答案 ${pct(r.noAns).padStart(6)}  无难度 ${pct(r.noDiff).padStart(6)}`);
}

console.log('\n=== 考点（新表） ===');
const kp = one('SELECT COUNT(DISTINCT questionId) q, COUNT(*) r, COUNT(DISTINCT kpName) n FROM question_keypoints');
console.log(`覆盖 ${kp.q} 题 / ${kp.r} 行 / ${kp.n} 个考点名`);
const kpCover = one('SELECT COUNT(*) c FROM questions WHERE questionId IN (SELECT DISTINCT questionId FROM question_keypoints)');
console.log(`占全库 ${((kpCover.c / tot.u) * 100).toFixed(1)}%`);

console.log('\n=== 解析质量 ===');
const badStart = one(`SELECT COUNT(DISTINCT questionId) c FROM questions
  WHERE analysis IS NOT NULL AND analysis <> '' AND (
    substr(analysis,1,1) IN ('的','是','了','所','上','而','与','之','其','并','但','且','或','及','以','用','对','为','在','从','由','于','，','。','、','；','：')
  )`);
console.log(`疑似截断（首字异常） ${badStart.c} 题`);
const formula = one(`SELECT COUNT(DISTINCT questionId) c FROM questions WHERE analysis GLOB '*，，*' OR analysis GLOB '*，，。*'`);
console.log(`公式丢失（连续逗号） ${formula.c} 题`);

console.log('\n=== 结构性缺陷 ===');
console.log(`题干空 ${one("SELECT COUNT(*) c FROM questions WHERE content IS NULL OR trim(content)=''").c} 行`);
console.log(`无选项 ${one("SELECT COUNT(*) c FROM questions WHERE options IS NULL OR options='' OR options='[]'").c} 行`);
console.log(`答案字母缺失但 answerIndex>=0 ${one("SELECT COUNT(*) c FROM questions WHERE (answer IS NULL OR answer='') AND answerIndex>=0").c} 行`);

console.log('\n=== 深度解析（question_deep） ===');
try {
  const d = one('SELECT COUNT(*) c FROM question_deep');
  console.log(`覆盖 ${d.c} 题`);
} catch (e) { console.log('表不存在'); }

console.log('\n=== 做题记录 ===');
const rec = pdb.prepare('SELECT COUNT(*) c, SUM(is_correct) ok FROM practice_records').get();
console.log(`记录 ${rec.c} 条，正确 ${rec.ok} 条（${((rec.ok / (rec.c || 1)) * 100).toFixed(1)}%）`);
const dirty = pdb.prepare("SELECT COUNT(*) c FROM practice_records WHERE cost_ms < 500").get();
console.log(`用时 <500ms 的（疑似自动化产生） ${dirty.c} 条`);

console.log('\n=== 分类表 ===');
const qc = pdb.prepare('SELECT subject, COUNT(*) c, COUNT(DISTINCT category) g, COUNT(DISTINCT sub) s FROM question_categories GROUP BY subject').all();
for (const r of qc) console.log(`${r.subject.padEnd(14)} ${String(r.c).padStart(6)} 题  ${r.g} 组  ${r.s} 子类`);
