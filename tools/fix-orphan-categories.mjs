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

const db = new DatabaseSync('D:/Projects/上岸APP/kaogong-shuati/practice.db');
let total = 0;
for (const [from, to] of Object.entries(MAP)) {
  const n = db.prepare('SELECT COUNT(*) c FROM question_categories WHERE category = ?').get(from).c;
  if (!n) continue;
  console.log(`  ${from} → ${to}  ${n} 行`);
  total += n;
  db.prepare('UPDATE question_categories SET category = ? WHERE category = ?').run(to, from);
}
console.log(`question_categories 更新 ${total} 行`);

const rows = db.prepare(`
  SELECT category, COUNT(DISTINCT question_id) c FROM question_categories
  WHERE subject = '事业编·职测' GROUP BY category ORDER BY c DESC`).all();
rows.forEach((r) => console.log('  ', r.category, r.c));
db.close();
