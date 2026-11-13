// 把题干/材料里的 tarzan 图片 URL 改写成 formulas?latex=<hash>，让 App 从 images.db 取图
//   node tools/rewrite-tarzan.mjs --dry
//   node tools/rewrite-tarzan.mjs --apply
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const DB = String(arg('db', path.join(ROOT, 'app-assets', 'tiku_app.db')));
const APPLY = !!arg('apply', false);
const keyOf = (url) => crypto.createHash('sha1').update(url).digest('hex').slice(0, 24);
const RE = /(?:https?:)?\/\/[^"'\s>]*tarzan\/images[^"'\s>]*/g;
const TARGET = 'https://fb.fenbike.cn/api/planet/accessories/formulas?latex=';

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout = 30000');
const rows = db
  .prepare(
    `SELECT id, contentHtml, material FROM questions
     WHERE contentHtml LIKE '%tarzan/images%' OR material LIKE '%tarzan/images%'`,
  )
  .all();

const norm = (u) => {
  let s = u;
  if (s.startsWith('//')) s = 'https:' + s;
  s = s.replace(/^http:/, 'https:');
  return s.replace('//fb.fbstatic.cn/', '//fb.fenbike.cn/');
};

let changed = 0;
const upd = APPLY
  ? db.prepare('UPDATE questions SET contentHtml = ?, material = ? WHERE id = ?')
  : null;
if (APPLY) db.exec('BEGIN');
for (const r of rows) {
  let ch = String(r.contentHtml || '');
  let mt = String(r.material || '');
  let hit = 0;
  const swap = (html) =>
    html.replace(RE, (u) => {
      hit++;
      return TARGET + keyOf(norm(u));
    });
  ch = swap(ch);
  mt = swap(mt);
  if (!hit) continue;
  changed++;
  if (upd) upd.run(ch, mt, r.id);
}
if (APPLY) db.exec('COMMIT');
console.log(`${APPLY ? '写入' : '试算'}：${changed} 行 / 扫描 ${rows.length} 行`);
