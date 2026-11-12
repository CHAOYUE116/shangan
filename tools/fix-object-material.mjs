#!/usr/bin/env node
/**
 * 修「材料被写成字符串 [object Object]」的题。
 *
 * 背景：早期导入把一个对象直接 JSON.stringify 成了字符串，落库里就是 "[object Object]"，
 * 真正正文在 q_material_map(question_id → material_id) + q_materials(material_id → content)。
 *
 *   node tools/fix-object-material.mjs            # dry-run，只报数
 *   node tools/fix-object-material.mjs --apply    # 写库
 *   node tools/fix-object-material.mjs --apply --db path/to/tiku_app.db
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const dbPath = argv.includes('--db') ? path.resolve(argv[argv.indexOf('--db') + 1]) : path.join(ROOT, 'app-assets', 'tiku_app.db');

const db = new DatabaseSync(dbPath);
const BAD = '[object Object]';

const broken = db.prepare(`SELECT COUNT(DISTINCT questionId) n FROM questions WHERE material = ?`).get(BAD).n;
const rowsBroken = db.prepare(`SELECT COUNT(*) n FROM questions WHERE material = ?`).get(BAD).n;

// 材料表导进内存再匹配：直接 JOIN 在 10 万行上会慢到几分钟
const byQ = new Map();
for (const r of db.prepare('SELECT question_id, material_id FROM q_material_map').all()) byQ.set(Number(r.question_id), r.material_id);
const byId = new Map();
for (const r of db.prepare('SELECT material_id, content FROM q_materials').all()) byId.set(r.material_id, String(r.content || ''));

const ids = db.prepare(`SELECT DISTINCT questionId FROM questions WHERE material = ?`).all(BAD).map((r) => Number(r.questionId));
const plan = [];
let noMap = 0;
let tooShort = 0;
for (const id of ids) {
  const mid = byQ.get(id);
  if (mid == null) { noMap += 1; continue; }
  const txt = byId.get(mid);
  if (!txt || txt.trim().length < 10) { tooShort += 1; continue; }
  plan.push([id, txt]);
}

console.log(`库里 material = "[object Object]"：${rowsBroken} 行 / ${broken} 道（按 questionId 去重）`);
console.log(`可回填：${plan.length} 道 · 没有材料映射：${noMap} 道 · 材料太短/空：${tooShort} 道`);

if (APPLY) {
  const backup = path.join(ROOT, 'tmp-before-matfix.db');
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(dbPath, backup);
    console.log('已备份 →', path.relative(ROOT, backup), fs.statSync(backup).size, 'B');
  }
  const upd = db.prepare(`UPDATE questions SET material = ? WHERE questionId = ? AND material = ?`);
  db.exec('BEGIN');
  let n = 0;
  try {
    for (const [id, txt] of plan) {
      const r = upd.run(txt, id, BAD);
      n += Number(r.changes || 0);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const left = db.prepare(`SELECT COUNT(DISTINCT questionId) n FROM questions WHERE material = ?`).get(BAD).n;
  const chk = db.prepare('PRAGMA integrity_check').get();
  console.log(`写入 ${n} 行；剩余脏材料 ${left} 道；integrity_check = ${Object.values(chk)[0]}`);
  fs.writeFileSync(path.join(ROOT, 'report', 'matfix.json'), JSON.stringify({ at: new Date().toISOString(), rows: n, left }, null, 1));
}
db.close();
