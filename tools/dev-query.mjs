#!/usr/bin/env node
/**
 * dev-query.mjs — 本地题库/App 查询 CLI（不启动 UI，毫秒级）
 *
 * 直接查 App 使用的 app-assets/tiku_app.db，输出 JSON。
 *
 * 用法：
 *   node tools/dev-query.mjs counts
 *   node tools/dev-query.mjs subjects
 *   node tools/dev-query.mjs chapters "事业编·公基"
 *   node tools/dev-query.mjs papers "事业编·公基"
 *   node tools/dev-query.mjs question 17506364
 *   node tools/dev-query.mjs search "乡村振兴"
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createLocalApi } from '../lib/local-queries.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(path.join(ROOT, 'app-assets', 'tiku_app.db'), { readOnly: true });
const ad = {
  get: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
};
const api = createLocalApi(ad, ad, {});
const cmd = process.argv[2] || 'counts';
const arg = process.argv[3];

function out(v) { console.log(JSON.stringify(v, null, 1)); }

if (cmd === 'counts') {
  out(db.prepare(`SELECT p.subjectName, COUNT(DISTINCT p.id) papers, COUNT(DISTINCT q.questionId) questions
    FROM papers p LEFT JOIN questions q ON q.paperId = p.id GROUP BY p.subjectName ORDER BY papers DESC`).all());
} else if (cmd === 'subjects') {
  out(api.subjects());
} else if (cmd === 'chapters') {
  if (!arg) throw new Error('用法: chapters "科目名"');
  out(api.chapters(arg).map((g) => ({ group: g.group, total: g.total, subs: g.subs.map((s) => ({ name: s.name, total: s.total })) })));
} else if (cmd === 'papers') {
  if (!arg) throw new Error('用法: papers "科目名" [category]');
  out(api.papers(arg, process.argv[4] || null, 50));
} else if (cmd === 'question') {
  const qid = Number(arg);
  const q = db.prepare(`SELECT q.questionId, q.content, q.options, q.answer, q.analysis,
      p.name AS paper, p.subjectName, p.category, qc.category AS treeCategory, qc.sub AS treeSub
    FROM questions q JOIN papers p ON p.id = q.paperId
    LEFT JOIN question_categories qc ON qc.question_id = q.questionId AND qc.subject = p.subjectName
    WHERE q.questionId = ? LIMIT 1`).get(qid);
  const mat = db.prepare(`SELECT m.content FROM q_material_map mm JOIN q_materials m
    ON m.material_id = mm.material_id AND m.subject = mm.subject WHERE mm.question_id = ? LIMIT 1`).get(qid);
  out({ ...q, material: mat ? mat.content : null });
} else if (cmd === 'search') {
  if (!arg) throw new Error('用法: search "关键词"');
  out(db.prepare(`SELECT questionId, subjectName, paper, content FROM (
      SELECT q.questionId, p.subjectName, p.name AS paper, q.content
      FROM questions q JOIN papers p ON p.id = q.paperId
      WHERE q.content LIKE ? LIMIT 20)`).all(`%${arg}%`));
} else {
  console.error('未知命令:', cmd);
  process.exit(1);
}
