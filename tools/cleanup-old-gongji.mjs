#!/usr/bin/env node
/**
 * tools/cleanup-old-gongji.mjs — 删除"源自行测真题"的旧公基种子题
 *
 * 背景：早期「事业编·公基」800 道是从行测政治/常识复制后重新赋号的占位数据
 *       （6 份卷名直接写着「（源自行测真题）」）。现已用 linfukai 的真实公基题替换。
 *
 * 用法：
 *   node tools/cleanup-old-gongji.mjs --dry-run
 *   node tools/cleanup-old-gongji.mjs --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TIKU = path.join(ROOT, 'tiku.db');
const PRACTICE = path.join(ROOT, 'practice.db');
const APPLY = process.argv.includes('--apply');

const tiku = new DatabaseSync(TIKU, { timeout: 10000 });
const practice = new DatabaseSync(PRACTICE, { timeout: 10000 });

// 定位旧公基：卷名含「源自行测」，或 source 既不是 linfukai 也不是空
const oldPapers = tiku.prepare(`
  SELECT id, name, questionCount FROM papers
  WHERE subjectName = '事业编·公基'
    AND (name LIKE '%源自行测%' OR name LIKE '%精选%')
`).all();

console.log('待删除的旧公基卷:');
for (const p of oldPapers) console.log(`  ${p.id}  ${p.name}  (${p.questionCount} 题)`);

if (!oldPapers.length) { console.log('没有匹配的旧卷。'); process.exit(0); }

const ids = oldPapers.map((p) => p.id);
const ph = ids.map(() => '?').join(',');
const qids = tiku.prepare(`SELECT DISTINCT questionId FROM questions WHERE paperId IN (${ph})`).all(...ids).map((r) => r.questionId);
console.log(`\n涉及题目 ${qids.length} 道，题号 ${Math.min(...qids)} … ${Math.max(...qids)}`);

// 安全检查：这些题号不能出现在其他科目的卷里
const qph = qids.map(() => '?').join(',');
const usedElsewhere = tiku.prepare(`
  SELECT COUNT(DISTINCT q.questionId) c FROM questions q JOIN papers p ON p.id = q.paperId
  WHERE q.questionId IN (${qph}) AND p.subjectName <> '事业编·公基'
`).get(...qids).c;
console.log(`其中被其他科目引用的：${usedElsewhere}（应为 0，否则会误删）`);

if (!APPLY) {
  console.log('\n[dry-run] 未删除。确认后加 --apply。');
  process.exit(0);
}
if (usedElsewhere > 0) {
  console.error('\n✗ 存在跨科目引用，中止删除。');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
for (const f of [TIKU, PRACTICE]) {
  try { new DatabaseSync(f, { timeout: 5000 }).prepare('PRAGMA wal_checkpoint(TRUNCATE)').all(); } catch {}
  fs.copyFileSync(f, `${f}.bak-cleanup-${stamp}`);
}
console.log(`\n备份 → *.bak-cleanup-${stamp}`);

let dq = 0, dp = 0, dc = 0;
tiku.exec('BEGIN');
practice.exec('BEGIN');
try {
  dq = tiku.prepare(`DELETE FROM questions WHERE paperId IN (${ph})`).run(...ids).changes;
  dp = tiku.prepare(`DELETE FROM papers WHERE id IN (${ph})`).run(...ids).changes;
  dc = practice.prepare(`DELETE FROM question_categories WHERE question_id IN (${qph})`).run(...qids).changes;
  tiku.exec('COMMIT');
  practice.exec('COMMIT');
} catch (e) {
  tiku.exec('ROLLBACK'); practice.exec('ROLLBACK');
  console.error('失败已回滚：', e.message); process.exit(1);
}
try { tiku.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all(); } catch {}

console.log(`✓ 删除：questions ${dq} 行，papers ${dp} 行，question_categories ${dc} 行`);
const left = tiku.prepare(`
  SELECT COUNT(DISTINCT q.questionId) q, COUNT(DISTINCT p.id) papers
  FROM questions q JOIN papers p ON p.id = q.paperId WHERE p.subjectName='事业编·公基'
`).get();
console.log(`  现存公基：${left.q} 题 / ${left.papers} 卷`);
tiku.close(); practice.close();
