import { DatabaseSync } from 'node:sqlite';

const MAP = {
  '言语表达与理解': '言语理解与表达',
  '常识应用': '常识判断',
  '公共基础知识': '常识判断',
  '专业知识': '常识判断',
  '策略选择': '判断推理',
  '数字推理': '数量关系',
  '数量分析': '数量关系',
  '单项选择题': '常识判断',
  '多项选择题': '常识判断',
  '未分类': '常识判断',
};

const apply = process.argv.includes('--apply');
const db = new DatabaseSync('D:/Projects/上岸APP/kaogong-shuati/tiku.db');

let total = 0;
for (const [from, to] of Object.entries(MAP)) {
  const n = db.prepare('SELECT COUNT(*) c FROM questions WHERE chapter = ?').get(from).c;
  if (!n) continue;
  console.log(`  ${from} → ${to}  ${n} 行`);
  total += n;
  if (apply) db.prepare('UPDATE questions SET chapter = ? WHERE chapter = ?').run(to, from);
}
console.log(`合计 ${total} 行${apply ? '（已写入）' : '（预览，加 --apply 写入）'}`);

if (apply) {
  const rows = db.prepare(`
    SELECT p.subjectName s, COUNT(DISTINCT q.questionId) c
    FROM questions q JOIN papers p ON p.id = q.paperId
    GROUP BY p.subjectName ORDER BY c DESC`).all();
  rows.forEach((r) => console.log(' ', r.s, r.c));
}
db.close();
