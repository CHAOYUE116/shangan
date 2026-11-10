/**
 * 生成「还没采到解析」的卷清单（给定时任务用）。
 *
 * 判断标准：该卷还有题缺解析，且本地没有对应的解析文件（research/fenbi-solutions）。
 * 已经下架（404）的卷记在 solutions-dead.json 里，这里直接排除，避免每轮都去撞。
 *
 * 输出：research/solutions-worklist-pending.json（没有待采卷时写 `{ "total": 0 }`）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RES = path.resolve(ROOT, '..', 'research');
const SOL = path.join(RES, 'fenbi-solutions');
const OUT = path.join(RES, 'solutions-worklist-pending.json');

const COURSE_OF = {
  '事业编·职测': 'syzc',
  '事业编·公基': 'sydw',
  '事业编·综应': 'zhyynl',
  '公务员·行测': 'xingce',
  '公务员·申论': 'shenlun',
};

const dead = new Set();
try {
  const d = JSON.parse(fs.readFileSync(path.join(RES, 'solutions-dead.json'), 'utf8'));
  (Array.isArray(d) ? d : []).forEach((x) => dead.add(String(x)));
} catch { /* 没有死卷文件 */ }

const db = new DatabaseSync(path.join(ROOT, 'tiku.db'));
const rows = db.prepare(`
  SELECT p.id, p.subject AS subject, p.name AS name, COUNT(1) AS miss
  FROM questions q JOIN papers p ON p.id = q.paperId
  WHERE q.analysis IS NULL OR TRIM(q.analysis) = ''
  GROUP BY p.id ORDER BY miss DESC
`).all();

const items = [];
for (const r of rows) {
  const course = COURSE_OF[r.subject];
  if (!course) continue;                       // 主观题/未知科目不采
  if (course === 'shenlun' || course === 'zhyynl') continue; // 主观题粉笔不给解析
  if (dead.has(String(r.id))) continue;
  if (fs.existsSync(path.join(SOL, course, `${r.id}.json`))) continue;
  items.push({ course, paperId: r.id, name: r.name, miss: r.miss });
}

fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), total: items.length, items }), 'utf8');
const by = {};
for (const x of items) by[x.course] = (by[x.course] || 0) + 1;
console.log(`待采卷 ${items.length}`, JSON.stringify(by));
