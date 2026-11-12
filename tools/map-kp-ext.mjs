/* 给「粉笔没给考点」的科目补考点 —— 写新表 question_keypoints_ext，不碰老表。
 *
 * 现状（2026-11 库）：
 *   公务员·行测   45,114 题 / 61% 有考点      → 暂不动（有 FENBI_TREE 的二级索引可用）
 *   事业编·职测   27,996 题 / 67% 有考点      → 暂不动
 *   事业编·公基   23,010 题 /  0% 有考点      → 本脚本处理
 *   综应 / 申论                                → 题量少或主观题，暂不做
 *
 * 公基的可用信息只有 question_categories 的 8 个 category（政治理论 / 法律常识 / 综合常识 /
 * 经济常识 / 科技常识 / 人文常识 / 地理国情 / 公文写作），和 questions.chapter 一致。
 * 所以补出来的是「8 大块」，粒度粗，但比完全没考点强：每日任务至少能按块抽题、
 * 也能算出「你哪一块最弱」。
 *
 * 命名：kpName = '公基·<category>'，避免和粉笔原考点（别的科目里也有「政治理论」这种名字）撞车。
 * 来源：source = 'structural-chapter'
 *
 * 用法：
 *   node tools/map-kp-ext.mjs                 # 只统计，不写库
 *   node tools/map-kp-ext.mjs --apply         # 建表 + 写入
 *   node tools/map-kp-ext.mjs --apply --db xxx.db
 */
import { DatabaseSync } from 'node:sqlite';

const APPLY = process.argv.includes('--apply');
const argDb = (() => {
  const i = process.argv.indexOf('--db');
  return i > 0 ? process.argv[i + 1] : null;
})();
const DB = argDb || process.env.TIKU_DB || 'app-assets/tiku_app.db';
const PREFIX = '公基';

const db = new DatabaseSync(DB);

// 公基里「有 category 的题」直接取 category；没有的退回 questions.chapter
const rows = db.prepare(`
  SELECT q.questionId AS qid, COALESCE(NULLIF(qc.category, ''), q.chapter) AS cat
  FROM questions q
  JOIN papers p ON p.id = q.paperId
  LEFT JOIN question_categories qc ON qc.question_id = q.questionId AND qc.subject = p.subjectName
  WHERE p.subjectName = '事业编·公基'
    AND q.id IN (SELECT MAX(id) FROM questions GROUP BY questionId)
`).all();

const buckets = new Map();
for (const r of rows) {
  const cat = String(r.cat || '').trim();
  if (!cat) continue;
  const kp = `${PREFIX}·${cat}`;
  if (!buckets.has(kp)) buckets.set(kp, 0);
  buckets.set(kp, buckets.get(kp) + 1);
}

console.log(`库：${DB}`);
console.log(`公基去重题：${rows.length.toLocaleString()} 道`);
console.log('将要补的考点（kpName / 题量）：');
for (const [kp, n] of [...buckets].sort((a, b) => b[1] - a[1])) console.log(`  ${kp}  ${n.toLocaleString()}`);
const covered = [...buckets.values()].reduce((s, x) => s + x, 0);
console.log(`可覆盖 ${covered.toLocaleString()} 道（${((covered / (rows.length || 1)) * 100).toFixed(1)}%）`);

if (!APPLY) {
  console.log('（只统计，没写库；要写加 --apply）');
  db.close();
  process.exit(0);
}

db.exec(`CREATE TABLE IF NOT EXISTS question_keypoints_ext (
  questionId INTEGER NOT NULL,
  kpName TEXT NOT NULL,
  subject TEXT NOT NULL,
  source TEXT,
  PRIMARY KEY (questionId, kpName)
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_qkp_ext_name ON question_keypoints_ext(kpName)');

const ins = db.prepare(`INSERT OR REPLACE INTO question_keypoints_ext (questionId, kpName, subject, source) VALUES (?, ?, ?, ?)`);
let written = 0;
db.exec('BEGIN');
for (const r of rows) {
  const cat = String(r.cat || '').trim();
  if (!cat) continue;
  ins.run(r.qid, `${PREFIX}·${cat}`, '事业编·公基', 'structural-chapter');
  written += 1;
}
db.exec('COMMIT');

const stat = db.prepare('SELECT kpName, COUNT(*) n FROM question_keypoints_ext GROUP BY kpName ORDER BY n DESC').all();
const integrity = db.prepare('PRAGMA integrity_check').get();
console.log(`已写入 ${written.toLocaleString()} 行 question_keypoints_ext`);
console.log('库内校验：', stat.map((s) => `${s.kpName}:${s.n}`).join(' '));
console.log('integrity_check：', Object.values(integrity)[0]);
db.close();
