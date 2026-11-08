// 从 question_deep.kadian 导入考点，补上行测 27,506 题的考点数据
// kadian 格式：「一级 / 二级（三级细节）」，如「类比推理 / 对应关系-目的对应（主体通过活动获得结果）」
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');
const db = new DatabaseSync(fileURLToPath(new URL('../tiku.db', import.meta.url)));

const rows = db.prepare("SELECT questionId, kadian FROM question_deep WHERE kadian IS NOT NULL AND kadian != ''").all();
console.log(`扫描 ${rows.length} 条 kadian`);

const out = [];
const seen = new Set();
for (const r of rows) {
  const qid = Number(r.questionId);
  if (!qid) continue;
  const parts = String(r.kadian).split('/').map((s) => s.trim()).filter(Boolean);
  const lv1 = parts[0] || '';
  const lv2 = (parts[1] || '').replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim();
  for (const [rank, name] of [[0, lv1], [1, lv2]]) {
    if (!name || name === '其他' || name === '综合') continue;
    const key = `${qid}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ qid, name, rank });
  }
}

console.log(`生成 ${out.length} 行（去重后），覆盖 ${new Set(out.map((o) => o.qid)).size} 题`);
const byName = new Map();
for (const o of out) byName.set(o.name, (byName.get(o.name) || 0) + 1);
const top = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
console.log('Top20 考点：', top.map(([n, c]) => `${n}:${c}`).join('  '));
console.log(`不同考点名 ${byName.size} 个`);

if (!APPLY) {
  console.log('（演练模式，加 --apply 写入）');
  db.close();
  process.exit(0);
}

db.exec(`CREATE TABLE IF NOT EXISTS question_keypoints (
  questionId INTEGER NOT NULL,
  kpId INTEGER,
  kpName TEXT NOT NULL,
  rank INTEGER DEFAULT 0,
  PRIMARY KEY (questionId, kpName)
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_qkp_name ON question_keypoints (kpName)');

const before = db.prepare('SELECT COUNT(*) c FROM question_keypoints').get().c;
const ins = db.prepare('INSERT OR IGNORE INTO question_keypoints (questionId, kpId, kpName, rank) VALUES (?, NULL, ?, ?)');
db.exec('BEGIN');
try {
  for (const o of out) ins.run(o.qid, o.name, o.rank);
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('写入失败', e.message);
  db.close();
  process.exit(1);
}
const after = db.prepare('SELECT COUNT(*) c FROM question_keypoints').get().c;
console.log(`写入完成：${before} → ${after}（新增 ${after - before}）`);
db.close();
