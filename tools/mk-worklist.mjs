import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('tiku.db');
// 缺解析的卷：按 paperId 聚合，统计无解析题数
const rows = db.prepare(`
  SELECT q.paperId AS paperId, p.subjectName AS subjectName, p.name AS name,
         COUNT(1) AS total,
         SUM(CASE WHEN q.analysis IS NULL OR TRIM(q.analysis) = '' THEN 1 ELSE 0 END) AS miss
  FROM questions q JOIN papers p ON p.id = q.paperId
  GROUP BY q.paperId
  HAVING miss > 0
  ORDER BY miss DESC
`).all();
const courseOf = (sub) => sub === '事业编·职测' ? 'syzc' : sub === '事业编·公基' ? 'sydw' : sub === '事业编·综应' ? 'zhyynl' : sub === '公务员·行测' ? 'xingce' : sub === '公务员·申论' ? 'shenlun' : null;
const items = rows.map((r) => ({ paperId: r.paperId, course: courseOf(r.subjectName), subject: r.subjectName, name: r.name, total: r.total, miss: r.miss })).filter((x) => x.course);
const byCourse = {};
for (const it of items) { byCourse[it.course] = (byCourse[it.course] || 0) + 1; }
fs.mkdirSync('D:/Projects/上岸APP/research', { recursive: true });
fs.writeFileSync('D:/Projects/上岸APP/research/solutions-worklist.json', JSON.stringify({ generatedAt: new Date().toISOString(), totalPapers: items.length, byCourse, items }, null, 1));
console.log('卷数', items.length, JSON.stringify(byCourse));
console.log('缺口最大的 8 卷：');
items.slice(0, 8).forEach((x) => console.log(' ', x.course, x.paperId, x.miss + '/' + x.total, String(x.name).slice(0, 40)));
