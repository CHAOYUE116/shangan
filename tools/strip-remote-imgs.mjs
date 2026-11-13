#!/usr/bin/env node
// 把解析里那些还指向粉笔 CDN 的图片标签去掉。
//
// 为什么：离线包里没有这些图，做题时整块显示成破图图标，比没有更难看。
// 题干/材料里的远程图不走这里 —— 那种题本身做不了，交给 flag-bad-questions 的 R9 拦住。
//
// 用法：node tools/strip-remote-imgs.mjs [--apply] [--db path]
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const APPLY = process.argv.includes('--apply');
const dbArg = process.argv.indexOf('--db');
const dbPath = dbArg > 0 ? process.argv[dbArg + 1] : path.join(ROOT, 'app-assets', 'tiku_app.db');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 30000');

const rows = db.prepare(`
  SELECT id, questionId, analysisHtml
  FROM questions
  WHERE analysisHtml LIKE '%fbstatic.cn%' OR analysisHtml LIKE '%tarzan/images%'
`).all();

const IMG = /<img\b[^>]*?(?:fbstatic\.cn|\/tarzan\/images)[^>]*>/gi;
const upd = APPLY ? db.prepare('UPDATE questions SET analysisHtml = ? WHERE id = ?') : null;
let changed = 0;
for (const r of rows) {
  const next = String(r.analysisHtml || '').replace(IMG, '');
  if (next === r.analysisHtml) continue;
  changed++;
  if (upd) upd.run(next, r.id);
}
console.log(`扫描 ${rows.length} 行，去掉远程图片标签 ${changed} 行${APPLY ? '（已写库）' : '（dry-run，加 --apply 才写）'}`);
db.close();
