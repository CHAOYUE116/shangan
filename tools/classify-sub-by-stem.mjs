#!/usr/bin/env node
/**
 * 把「判断推理 · 其他」按题干措辞归到粉笔已有的二级分类
 * （图形推理 / 定义判断 / 类比推理 / 逻辑判断 / 事件排序），不新增分类。
 *
 * 为什么按题干：这批题是扫 id 入库的，粉笔侧已下架（`questions?ids=` 返回 null），
 * 拿不到 keypoints；但题干措辞高度套路化，可以直接判。
 *
 *   node tools/classify-sub-by-stem.mjs --dry
 *   node tools/classify-sub-by-stem.mjs --apply
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const APPLY = !!arg('apply', false);
const GROUP = String(arg('group', '判断推理'));
const SHOW = Number(arg('show', '0')) || 0;
const DB = String(arg('db', path.join(ROOT, 'app-assets/tiku_app.db')));

/** 顺序即优先级：先强特征，后弱特征 */
const RULES = [
  ['事件排序', /(五个事件|事件排序|下列事件|按时间顺序|先后顺序排列|排序正确的是)/],
  ['图形推理', /(所给图形|下列图形|图形推理|填入问号|折叠|展开图|截面|立体图形|以下哪个图形|规律性)/],
  ['类比推理', /(逻辑关系最为(相似|相近|相同)|与[^。]{2,20}的关系|类比推理|最为贴近|最为类似)/],
  ['定义判断', /(定义|属于.{0,12}的是|不属于.{0,12}的是|符合上述|不符合上述|下列属于|下列不属于)/],
  ['逻辑判断', /(如果|那么|只有|除非|由此可以推出|可以推出|最能(削弱|加强|支持|质疑)|假设|以下哪项|为真|削弱的|加强的|结论是)/],
];

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout = 30000');

const rows = db.prepare(`
  SELECT DISTINCT qc.question_id AS qid, q.content AS content, q.paperId AS paperId
  FROM question_categories qc JOIN questions q ON q.questionId = qc.question_id
  WHERE qc.category = ? AND COALESCE(qc.sub,'') = ''
  GROUP BY qc.question_id`).all(GROUP);

const stat = { 目标: rows.length, 命中: 0, 未命中: 0, 明细: {}, 样例: {} };
const staged = [];
for (const r of rows) {
  const text = String(r.content || '').replace(/<[^>]+>/g, ' ');
  const hit = RULES.find(([, re]) => re.test(text));
  if (!hit) { stat.未命中++; continue; }
  stat.命中++;
  stat.明细[hit[0]] = (stat.明细[hit[0]] || 0) + 1;
  if (!stat.样例[hit[0]]) stat.样例[hit[0]] = text.replace(/\s+/g, ' ').slice(0, 42);
  staged.push([hit[0], r.qid]);
}
console.log(JSON.stringify(stat, null, 1));

if (APPLY) {
  const upd = db.prepare(`UPDATE question_categories SET sub = ? WHERE question_id = ? AND category = ?`);
  db.exec('BEGIN');
  try { for (const [sub, qid] of staged) upd.run(sub, qid, GROUP); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  const left = db.prepare(`SELECT COUNT(DISTINCT question_id) n FROM question_categories WHERE category = ? AND COALESCE(sub,'') = ''`).get(GROUP).n;
  console.log(`已写入 ${staged.length} 条；${GROUP} 仍为空 sub：${left}`);
}
