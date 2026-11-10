#!/usr/bin/env node
/**
 * tools/fix-raw-chapters.mjs — 把整卷采集带进来的「题型名」章节归一成模块树里的组
 *
 * 背景：fenbi-raw 的 chapters[] 是按分节切的，公基/职测卷常按题型分节
 * （单项选择题 / 多项选择题 / 判断题 …），这些不是知识模块，
 * 不归一就会在「按方向练习」里变成一堆挂不上树的脏模块。
 *
 * 用法：node tools/fix-raw-chapters.mjs [--apply]
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APPLY = process.argv.includes('--apply');

const MAP = {
  公共基础知识: '常识判断',
  常识应用: '常识判断',
  综合知识: '常识判断',
  专业知识: '常识判断',
  数量分析: '数量关系',
  数学运算: '数量关系',
  策略选择: '判断推理',
  规则解读: '判断推理',
  计划编排: '判断推理',
  综合分析: '资料分析',
  言语表达与理解: '言语理解与表达',
  言语理解: '言语理解与表达',
  阅读理解: '言语理解与表达',
  // 纯题型名：内容无法从章节名判断，统一收进常识判断（量很小）
  单项选择题: '常识判断',
  单项选择: '常识判断',
  多项选择题: '常识判断',
  多项选择: '常识判断',
  判断题: '常识判断',
  不定项选择题: '常识判断',
  案例分析题: '常识判断',
  简答题: '常识判断',
  论述题: '常识判断',
  材料分析题: '常识判断',
  数量运算: '数量关系',
  数字推理: '数量关系',
  言语理解与阅读: '言语理解与表达',
  言语表达: '言语理解与表达',
  资料分析题: '资料分析',
  判断推理题: '判断推理',
};

const tiku = new DatabaseSync(path.join(ROOT, 'tiku.db'), { timeout: 20000 });
const practice = new DatabaseSync(path.join(ROOT, 'practice.db'), { timeout: 20000 });

console.log(`${APPLY ? '【写入】' : '【演练】'} 章节归一`);

let total = 0;
// 先去掉章节名两头空白（采集来的 chapters 里偶尔带尾空格，会让映射全部落空）
if (APPLY) {
  const n = tiku.prepare(`SELECT COUNT(1) c FROM questions WHERE chapter <> TRIM(chapter)`).get().c;
  if (n) { tiku.exec(`UPDATE questions SET chapter = TRIM(chapter) WHERE chapter <> TRIM(chapter)`); console.log(`  去掉首尾空格 ${n} 行`); }
  practice.exec(`UPDATE question_categories SET category = TRIM(category) WHERE category <> TRIM(category)`);
}
for (const [from, to] of Object.entries(MAP)) {
  const n = tiku.prepare(`SELECT COUNT(1) c FROM questions WHERE chapter = ?`).get(from).c;
  const m = practice.prepare(`SELECT COUNT(1) c FROM question_categories WHERE category = ?`).get(from).c;
  if (!n && !m) continue;
  console.log(`  ${from} → ${to}：questions ${n} 行 / question_categories ${m} 行`);
  if (APPLY) {
    tiku.prepare(`UPDATE questions SET chapter = ? WHERE chapter = ?`).run(to, from);
    practice.prepare(`UPDATE question_categories SET category = ? WHERE category = ?`).run(to, from);
  }
  total += n;
}
console.log(`合计 ${total} 行${APPLY ? ' 已更新' : '（演练）'}`);

if (APPLY) {
  const rows = tiku.prepare(`
    SELECT p.subjectName s, q.chapter c, COUNT(1) n
    FROM questions q JOIN papers p ON p.id = q.paperId
    WHERE p.subjectName IN ('事业编·职测','事业编·公基')
    GROUP BY s, c ORDER BY s, n DESC
  `).all();
  let cur = '';
  for (const r of rows) {
    if (r.s !== cur) { console.log(`\n== ${r.s}`); cur = r.s; }
    console.log(`  ${r.c}\t${r.n}`);
  }
}
tiku.close(); practice.close();
