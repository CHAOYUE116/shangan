// 把被误标成「常识判断/判断推理」的言语题搬回「言语理解与表达」
//
// 背景：扫 id 入库时章节是按 source 文本猜的，有一批「这段文字意在说明…」的片段阅读题
// 被挂到了常识判断/判断推理下面（做题时标签写着「常识判断」，内容却是言语题）。
// 只认强特征，避免把真正的常识题搬走。
//
// 用法：node tools/fix-mislabel-verbal.mjs [--apply]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const APPLY = process.argv.includes('--apply');
const DB = arg('db', path.join(ROOT, 'app-assets', 'tiku_app.db'));

const db = new DatabaseSync(DB);
if (APPLY) db.exec('PRAGMA busy_timeout = 60000');

// 片段阅读的强特征（题干里出现这些，基本就是言语）
const SNIP = [
  /这段文字(意在|旨在|主要|想要)?(说明|强调|表达|论述|介绍)/,
  /文段(意在|旨在|主要)/,
  /作者(想|意图|意在)/,
  /接下来(最|可能)?(谈论|讲|说)/,
  /填入(划横线|文中|括号)/,
  /依次填入/,
  /主旨|标题最恰当|概括最准确/,
  /意在说明|意在强调|主要说明/,
];
// 逻辑填空的强特征
const CLOZE = [/依次填入(划横线|文中括号|文中画横线)/, /填入划横线部分最恰当/];

const rows = db.prepare(`
  SELECT qc.question_id AS qid, qc.category AS cat, qc.sub AS sub, q.content AS content
  FROM question_categories qc
  JOIN questions q ON q.questionId = qc.question_id
  WHERE qc.category IN ('常识判断', '判断推理')
`).all();

const target = { 片段阅读: [], 逻辑填空: [] };
for (const r of rows) {
  const text = String(r.content || '');
  if (CLOZE.some((re) => re.test(text))) { target.逻辑填空.push(r.qid); continue; }
  if (SNIP.some((re) => re.test(text))) target.片段阅读.push(r.qid);
}

const total = target.片段阅读.length + target.逻辑填空.length;
console.log(JSON.stringify({ 待搬: total, 片段阅读: target.片段阅读.length, 逻辑填空: target.逻辑填空.length }));
if (!APPLY) {
  console.log('（dry-run，加 --apply 才写库）');
  process.exit(0);
}
if (!total) process.exit(0);

const updCat = db.prepare("UPDATE question_categories SET category = '言语理解与表达', sub = ? WHERE question_id = ? AND category IN ('常识判断','判断推理')");
const updQ = db.prepare("UPDATE questions SET chapter = '言语理解与表达' WHERE questionId = ? AND chapter IN ('常识判断','判断推理')");
let n = 0;
db.exec('BEGIN');
try {
  for (const [sub, ids] of Object.entries(target)) {
    for (const qid of ids) {
      updCat.run(sub, qid);
      updQ.run(qid);
      n++;
    }
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}
console.log('已搬回言语：', n);
console.log(db.prepare('PRAGMA integrity_check').get());
