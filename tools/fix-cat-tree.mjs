import { DatabaseSync } from 'node:sqlite';

const ALIAS = {
  科技常识: '常识判断', 经济常识: '常识判断', 人文常识: '常识判断',
  法律常识: '常识判断', 地理国情: '常识判断', 综合常识: '常识判断',
  常识应用: '常识判断', 公共基础知识: '常识判断', 公基多选题: '常识判断',
  公基单选题: '常识判断', 公基判断题: '常识判断', 公文写作: '常识判断',
  策略选择: '判断推理', 综合分析: '资料分析', 数量分析: '数量关系',
  数学运算: '数量关系', 综合知识: '常识判断', 专业知识: '常识判断',
};

const apply = process.argv.includes('--apply');
const db = new DatabaseSync('practice.db');

const before = db.prepare(`
  SELECT category AS c, COUNT(*) n FROM question_categories GROUP BY category ORDER BY n DESC
`).all();
console.log('修前 category 分布：');
for (const x of before) console.log('  ', String(x.c ?? '(null)').padEnd(16), x.n);

if (apply) {
  db.exec('BEGIN');
  try {
    const upd = db.prepare('UPDATE question_categories SET category = ? WHERE category = ?');
    let total = 0;
    for (const [from, to] of Object.entries(ALIAS)) {
      const n = db.prepare('SELECT COUNT(*) c FROM question_categories WHERE category = ?').get(from).c;
      if (!n) continue;
      upd.run(to, from);
      total += n;
    }
    db.exec('COMMIT');
    console.log('✓ 归一', total, '行');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const after = db.prepare(`SELECT category AS c, COUNT(*) n FROM question_categories GROUP BY category ORDER BY n DESC`).all();
console.log('修后：');
for (const x of after) console.log('  ', String(x.c ?? '(null)').padEnd(16), x.n);
db.close();
