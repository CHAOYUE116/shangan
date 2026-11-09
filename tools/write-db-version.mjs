#!/usr/bin/env node
/**
 * tools/write-db-version.mjs — 写 app-assets/db-version.txt
 *
 * 格式：<版本号> <questions 行数> <question_categories 行数>
 * 例如：0.5.9-20261110-0200 105293 63796
 *
 * 为什么带行数：
 *   版本号是一个小文件，库是另一个大文件。两者可能脱节（增量包写一半、
 *   覆盖安装换了 assets 但私有目录没换、手动替换过库），App 只信版本号就会
 *   认为「已是最新」而不更新 —— 用户看到的是「更新完题库，题反而少了」。
 *   NativeDbBridge 启动时会拿这两个数对一遍，不符就从 assets 重拷。
 *
 * 用法：
 *   node tools/write-db-version.mjs 0.5.9-20261110-0200
 *   node tools/write-db-version.mjs            # 只重算行数，版本号保持原样
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'app-assets', 'tiku_app.db');
const OUT = path.join(ROOT, 'app-assets', 'db-version.txt');

if (!fs.existsSync(DB)) {
  console.error('✗ 找不到 app-assets/tiku_app.db');
  process.exit(1);
}

const db = new DatabaseSync(DB, { readOnly: true });
const q = db.prepare('SELECT COUNT(1) n FROM questions').get().n;
const c = db.prepare('SELECT COUNT(1) n FROM question_categories').get().n;
db.close();

let ver = process.argv[2] || '';
if (!ver) {
  ver = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split(/\s+/)[0] : '';
}
if (!ver) {
  console.error('✗ 没有版本号可写，请显式传入');
  process.exit(1);
}

const line = `${ver} ${q} ${c}`;
fs.writeFileSync(OUT, line, 'utf8');
console.log('✓ db-version.txt =', line);
