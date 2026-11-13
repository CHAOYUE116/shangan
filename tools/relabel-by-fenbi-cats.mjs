#!/usr/bin/env node
/**
 * 把「其他」桶里的题按粉笔的二级分类归位（不新增分类，只用粉笔已有的二级名）。
 *
 * 背景：`question_categories.sub` 为空的题（职测 判断推理 6,100 道）在题库页被算成「其他 6135」，
 * 点进去只能一把抓。粉笔自己的树是「判断推理 → 图形推理/类比推理/逻辑判断/定义判断/事件排序」，
 * 每个二级下面有叶子考点；这些题的 `question_keypoints` 里就存着叶子名，可以直接映射回二级。
 *
 *   node tools/relabel-by-fenbi-cats.mjs --group 判断推理 --dry
 *   node tools/relabel-by-fenbi-cats.mjs --group 判断推理 --apply
 */
import fs from 'node:fs';
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
const GROUP = String(arg('group', '判断推理'));
const APPLY = !!arg('apply', false);
const DB = String(arg('db', path.join(ROOT, 'app-assets/tiku_app.db')));
const COURSE_OF = { '公务员·行测': 'xingce', '事业编·职测': 'syzc', '事业编·公基': 'sydw' };

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout = 30000');

/** leaf 名 → 二级名；同时接受二级名本身（有些 kp 直接就是二级） */
function buildMap(course, root) {
  const file = path.join(ROOT, `report/cats-${course}.json`);
  if (!fs.existsSync(file)) return new Map();
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const node = (d.baseKeypointVOS || []).find((x) => x.name === root);
  const map = new Map();
  if (!node) return map;
  for (const sub of node.children || []) {
    map.set(sub.name, sub.name);
    for (const leaf of sub.children || []) map.set(leaf.name, sub.name);
  }
  return map;
}

const upd = APPLY ? db.prepare(`UPDATE question_categories SET sub = ? WHERE question_id = ? AND category = ?`) : null;
const stat = { 目标: 0, 有考点: 0, 归位: 0, 无考点: 0, 考点认不出: 0, 明细: {} };

for (const [subject, course] of Object.entries(COURSE_OF)) {
  const map = buildMap(course, GROUP);
  if (!map.size) continue;
  const rows = db.prepare(`
    SELECT DISTINCT qc.question_id AS qid
    FROM question_categories qc
    WHERE qc.subject = ? AND qc.category = ? AND COALESCE(qc.sub, '') = ''`).all(subject, GROUP);
  if (!rows.length) continue;
  stat.目标 += rows.length;
  console.log(`${subject} · ${GROUP} · sub 为空：${rows.length} 道`);

  const staged = [];
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200).map((r) => r.qid);
    const kps = db.prepare(`
      SELECT questionId, kpName FROM question_keypoints
      WHERE questionId IN (${chunk.map(() => '?').join(',')})`).all(...chunk);
    const byQ = new Map();
    for (const k of kps) {
      if (!byQ.has(k.questionId)) byQ.set(k.questionId, []);
      byQ.get(k.questionId).push(k.kpName);
    }
    for (const qid of chunk) {
      const list = byQ.get(qid) || [];
      if (!list.length) { stat.无考点++; continue; }
      stat.有考点++;
      const hit = list.map((n) => map.get(n)).filter(Boolean)[0];
      if (!hit) { stat.考点认不出++; continue; }
      stat.归位++;
      stat.明细[hit] = (stat.明细[hit] || 0) + 1;
      staged.push([hit, qid]);
    }
  }
  if (APPLY) {
    db.exec('BEGIN');
    try { for (const [sub, qid] of staged) upd.run(sub, qid, GROUP); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}

console.log(JSON.stringify(stat, null, 1));
if (APPLY) {
  const left = db.prepare(`SELECT COUNT(DISTINCT question_id) n FROM question_categories WHERE category = ? AND COALESCE(sub,'') = ''`).get(GROUP).n;
  console.log(`${GROUP} 仍为空 sub 的题：${left}`);
}
