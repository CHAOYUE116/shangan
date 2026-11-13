// 把历史遗留的「非标准一级模块名」归一成粉笔六个模块 / 公基八个模块
// 用法：node tools/normalize-category.mjs [--dry] [--apply] [--db path]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = args.indexOf('--' + n);
  return i >= 0 ? (args[i + 1] ?? true) : d;
};
const DB = String(arg('db', path.join(ROOT, 'app-assets', 'tiku_app.db')));
const APPLY = args.includes('--apply');

// 行测/职测：变体名 → 标准模块
const XC = {
  常识应用能力: '常识判断',
  常识判断单选题: '常识判断',
  常识判断多选题: '常识判断',
  常识部分: '常识判断',
  基本常识: '常识判断',
  科学素养: '常识判断',
  综合基础知识: '常识判断',
  '公共基础知识-单项选择题': '常识判断',
  '公共基础知识-判断题': '常识判断',
  '公共基础知识-多项选择题': '常识判断',
  判断推理能力: '判断推理',
  推理判断: '判断推理',
  逻辑推理: '判断推理',
  逻辑判断: '判断推理',
  演绎推理: '判断推理',
  科学推理: '判断推理',
  图形推理: '判断推理',
  类比推理: '判断推理',
  定义判断: '判断推理',
  判断推理能力测验: '判断推理',
  辨析题: '判断推理',
  数理能力: '数量关系',
  数量关系与资料分析: '数量关系',
  '数量关系（数学运算）': '数量关系',
  '数量关系（数字推理）': '数量关系',
  言语理解与表达能力: '言语理解与表达',
  言语能力与表达: '言语理解与表达',
  选词填空: '言语理解与表达',
  实词填空: '言语理解与表达',
  段落阅读: '言语理解与表达',
  语句表达: '言语理解与表达',
  资料分斩: '资料分析',
  综合分析能力: '资料分析',
  法律基础知识: '常识判断',
  事件排序: '判断推理',
  公基判断题: '常识判断',
  专业知识单项选择题: '未分类',
  '专业知识和专业能力（计算机类主观题）': '未分类',
  专业知识多项选择题: '未分类',
  思维能力测验: '未分类',
  行政职业能力测验: '未分类',
  '[object Object]': '未分类',
  政治理论: '政治理论',
  常识判断: '常识判断',
  言语理解与表达: '言语理解与表达',
  数量关系: '数量关系',
  判断推理: '判断推理',
  资料分析: '资料分析',
};

// 公基：出现行测类模块名时，回到「综合常识」（粉笔把这类题放在综合常识里）
const GJ_EXTRA = ['判断推理', '言语理解与表达', '资料分析', '常识判断', '数量关系'];

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout = 30000');

const rows = db
  .prepare(`SELECT subject AS subj, category AS cat, COUNT(DISTINCT question_id) AS c FROM question_categories GROUP BY subj, cat`)
  .all();

const plan = [];
for (const r of rows) {
  let target = null;
  if (r.subj === '事业编·公基') {
    if (GJ_EXTRA.includes(r.cat)) target = '综合常识';
  } else if (r.subj === '事业编·职测' || r.subj === '公务员·行测') {
    const key = String(r.cat).replace(/[（(].*?[)）]/g, '').trim();
    target = XC[r.cat] || XC[key] || null;
  }
  if (target && target !== r.cat) plan.push({ subj: r.subj, from: r.cat, to: target, c: r.c });
}

console.log('待归一：', JSON.stringify(plan.reduce((m, x) => ((m[x.to] = (m[x.to] || 0) + x.c), m), {})));
console.log('明细：', JSON.stringify(plan.slice(0, 12)));

if (!APPLY) {
  console.log('（dry-run，加 --apply 写库）');
  process.exit(0);
}

const upd = db.prepare('UPDATE question_categories SET category = ? WHERE subject = ? AND category = ?');
db.exec('BEGIN');
try {
  let n = 0;
  for (const p of plan) n += upd.run(p.to, p.subj, p.from).changes ?? 0;
  db.exec('COMMIT');
  console.log('已更新行数：', n);
} catch (e) {
  try {
    db.exec('ROLLBACK');
  } catch {}
  throw e;
}
console.log('integrity', db.prepare('PRAGMA integrity_check').get());
