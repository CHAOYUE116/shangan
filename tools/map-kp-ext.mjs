/* 给「没有考点」的题补考点 —— 写新表 question_keypoints_ext，不碰老表 question_keypoints。
 *
 * 为什么要有这张表（2026-11-12 实测）：
 *   - 老表里 6,204 个考点，题量中位数只有 1 道（p25=1 / p50=1 / p75=3），
 *     拿它当「能力账本的账目」等于给每道题配一个能力值，估不出来。
 *   - 公基 23,010 道客观题 0% 有考点；行测 23,105 道客观题没有考点。
 *
 * 所以这里补的是「章节（模块）」粒度的考点，命名 `<科目短名>·<chapter>`：
 *   公基 → 公基·政治理论 / 公基·法律常识 …
 *   行测 → 行测·判断推理 / 行测·言语理解与表达 …（只补没有考点的题）
 * 粒度粗，但每题都有，可以估 θ、可以按块抽题、可以算「你哪一块最弱」。
 *
 * 来源标记：source = 'structural-chapter'
 * 用法：
 *   node tools/map-kp-ext.mjs                 # 只统计
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

// 科目 → 考点名前缀
const PREFIX = {
  '事业编·公基': '公基',
  '公务员·行测': '行测',
  '事业编·职测': '职测',
};

const db = new DatabaseSync(DB);

db.exec(`CREATE TABLE IF NOT EXISTS question_keypoints_ext (
  questionId INTEGER NOT NULL,
  kpName TEXT NOT NULL,
  subject TEXT NOT NULL,
  source TEXT,
  PRIMARY KEY (questionId, kpName)
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_qkp_ext_name ON question_keypoints_ext(kpName)');

const hasOld = db.prepare(`SELECT COUNT(*) c FROM question_keypoints`).get().c > 0;
const rows = db.prepare(`
  SELECT p.subjectName AS sub,
         q.questionId AS qid,
         COALESCE(NULLIF(qc.category, ''), q.chapter) AS cat
  FROM questions q
  JOIN papers p ON p.id = q.paperId
  LEFT JOIN question_categories qc ON qc.question_id = q.questionId AND qc.subject = p.subjectName
  WHERE q.id IN (SELECT MAX(id) FROM questions GROUP BY questionId)
    AND q.type IN (1,2,3,5)
    ${hasOld ? 'AND q.questionId NOT IN (SELECT questionId FROM question_keypoints)' : ''}
`).all();

const buckets = new Map();   // kpName -> n
const insert = [];           // [qid, kpName, subject]
let skipped = 0;
for (const r of rows) {
  const prefix = PREFIX[r.sub];
  const cat = String(r.cat || '').trim();
  if (!prefix || !cat) { skipped += 1; continue; }
  const kp = `${prefix}·${cat}`;
  buckets.set(kp, (buckets.get(kp) || 0) + 1);
  insert.push([r.qid, kp, r.sub]);
}

console.log(`库：${DB}`);
console.log(`没有老考点的客观题：${rows.length.toLocaleString()} 道（无法归类的 ${skipped} 道）`);
console.log('将要补的章节级考点：');
for (const [kp, n] of [...buckets].sort((a, b) => b[1] - a[1])) console.log(`  ${kp}  ${n.toLocaleString()}`);

if (!APPLY) {
  console.log('（只统计，没写库；要写加 --apply）');
  db.close();
  process.exit(0);
}

const ins = db.prepare(`INSERT OR REPLACE INTO question_keypoints_ext (questionId, kpName, subject, source) VALUES (?, ?, ?, 'structural-chapter')`);
db.exec('BEGIN');
for (const [qid, kp, sub] of insert) ins.run(qid, kp, sub);
db.exec('COMMIT');

const stat = db.prepare('SELECT kpName, COUNT(*) n FROM question_keypoints_ext GROUP BY kpName ORDER BY n DESC').all();
const integrity = db.prepare('PRAGMA integrity_check').get();
console.log(`已写入 ${insert.length.toLocaleString()} 行 question_keypoints_ext`);
console.log('库内校验：', stat.map((s) => `${s.kpName}:${s.n}`).join(' '));
console.log('integrity_check：', Object.values(integrity)[0]);
db.close();
