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
const db = new DatabaseSync('tiku.db');
let total = 0;
if (apply) db.exec('BEGIN');
try {
  const upd = db.prepare('UPDATE questions SET chapter = ? WHERE chapter = ?');
  for (const [from, to] of Object.entries(ALIAS)) {
    const n = db.prepare('SELECT COUNT(*) c FROM questions WHERE chapter = ?').get(from).c;
    if (!n) continue;
    console.log(`${from.padEnd(14)} → ${to}  (${n} 题)`);
    if (apply) upd.run(to, from);
    total += n;
  }
  if (apply) db.exec('COMMIT');
} catch (e) {
  if (apply) db.exec('ROLLBACK');
  throw e;
}
console.log(apply ? `✓ 归树 ${total} 题` : `预演：将归树 ${total} 题`);
db.close();
