#!/usr/bin/env node
/**
 * 生成题库增量包（题库热更新用）
 *
 *   node tools/build-tiku-delta.mjs --old <上一版 tiku_app.db> --new <新版 tiku_app.db> \
 *        --from <旧 dbVersion> --to <新 dbVersion> --out dist/release
 *
 * 输出：delta-<from>-<to>.json.gz
 *   { schema, from, to, generatedAt, papers:[...], questions:[...], deleted:{questions:[id]} }
 *
 * 设计取舍：
 *   - 按行对比而不是 sqldiff，因为 App 端只要「整行 INSERT OR REPLACE」就够，
 *     不需要处理 B 树页差异，也不依赖 SQLite 版本。
 *   - 只带「新增 + 内容有变化」的行；删除单独列 id 列表。
 *   - 解析回填是最高频的更新，所以 questions 的变化检测优先看 analysis/answer/contentHtml。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const arg = (k, d = '') => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const OLD = arg('old');
const NEW = arg('new');
const FROM = arg('from', 'unknown');
const TO = arg('to', 'unknown');
const OUT = arg('out', 'dist/release');
// 分类索引表（question_categories）来自 practice.db，打包时被合并进 tiku_app.db。
// 它不在 tiku.db 里，所以早期增量包从来没带过它 —— 新题在设备上「能搜到但进不了模块树」，
// 题库页题数也不涨。这里从新版 app-assets/tiku_app.db 读全量，随包一起下发。
const ASSETS = arg('assets', 'D:/Projects/上岸APP/kaogong-shuati/app-assets/tiku_app.db');

if (!OLD || !NEW) {
  console.error('用法: --old <旧版 db> --new <新版 db> [--from V] [--to V] [--out DIR]');
  process.exit(1);
}

const open = (p) => new DatabaseSync(p, { readOnly: true });
const oldDb = open(OLD);
const newDb = open(NEW);

const cols = (db, table) =>
  db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

/**
 * 判断一行「变没变」看这些字段。
 * 特意不含 contentHtml / analysisHtml：它们只是「带图时才存」的富文本副本，
 * 空与非空不代表内容变化（旧版全存过、后来为了省体积清空了），
 * 带上它们会让 9 万行全部被判成改动，增量就退化成全量了。
 */
const Q_HASH_FIELDS = ['content', 'options', 'answer', 'answerIndex', 'analysis', 'chapter', 'difficulty', 'type'];
const P_HASH_FIELDS = ['name', 'subjectName', 'year', 'region', 'category', 'questionCount'];

const hashOf = (row, fields) =>
  crypto.createHash('md5').update(fields.map((f) => (row[f] == null ? '\u0000' : String(row[f]))).join('\u0001')).digest('hex');

function diffTable(name, keyCol, hashFields) {
  const newCols = cols(newDb, name);
  const oldCols = cols(oldDb, name);
  // 旧库可能没有后来新增的列（例如 analysisHtml），只比两边都有的
  const qCols = newCols.filter((c) => oldCols.includes(c) || c === keyCol);
  if (!qCols.includes(keyCol)) qCols.push(keyCol);
  const sel = `SELECT ${qCols.map((c) => `"${c}"`).join(', ')} FROM ${name}`;
  // 只拿两版都有的字段算 hash，否则「新增列」会让所有行都被误判成改动
  const cmpFields = hashFields.filter((f) => qCols.includes(f));
  const oldRows = new Map();
  for (const r of oldDb.prepare(sel).all()) oldRows.set(r[keyCol], r);

  const added = [];
  const changed = [];
  const seen = new Set();
  for (const r of newDb.prepare(sel).all()) {
    seen.add(r[keyCol]);
    const o = oldRows.get(r[keyCol]);
    if (!o) { added.push(r); continue; }
    if (hashOf(o, cmpFields) !== hashOf(r, cmpFields)) changed.push(r);
  }
  const deleted = [];
  for (const k of oldRows.keys()) if (!seen.has(k)) deleted.push(k);
  return { added, changed, deleted, cols: qCols };
}

console.time('diff');
/**
 * questions 必须按主键 id 做行键，不能按 questionId。
 * 同一道真题被多份卷收录时 questionId 重复（全库 105,293 行只对应 65,198 个 questionId），
 * 按 questionId 建 Map 会让重复行只剩最后一条，增量包里就漏掉其余副本 ——
 * 设备上 questions 行数永远补不齐（实测差 628 行）。
 */
const q = diffTable('questions', 'id', Q_HASH_FIELDS);
let p = { added: [], changed: [], deleted: [], cols: [] };
try { p = diffTable('papers', 'id', P_HASH_FIELDS); } catch { /* 表结构不同就跳过 */ }
console.timeEnd('diff');

// 删除仍按 questionId：一道题的所有卷副本要一起删，不能只删某一行
let qDeleted = [];
try {
  const oldIds = new Set(oldDb.prepare('SELECT DISTINCT questionId v FROM questions').all().map((r) => r.v));
  for (const r of newDb.prepare('SELECT DISTINCT questionId v FROM questions').all()) oldIds.delete(r.v);
  qDeleted = [...oldIds];
} catch { /* ignore */ }

/**
 * 分类索引全量。这张表不在 tiku.db 里，没法做行级 diff，只能整表下发。
 * 客户端先 DELETE 再批量 INSERT，所以是幂等的。
 * 63,796 行 / 原始约 5 MB / gz 约 1 MB —— 这点体积换「新题能进模块树」，值。
 */
let qc = [];
let qcCols = [];
try {
  const adb = new DatabaseSync(ASSETS, { readOnly: true });
  qcCols = cols(adb, 'question_categories');
  qc = adb.prepare(`SELECT ${qcCols.map((c) => `"${c}"`).join(', ')} FROM question_categories`).all();
  adb.close();
  console.log(`  question_categories 全量 ${qc.length} 行（${qcCols.join(' / ')}）`);
} catch (e) {
  console.warn(`  ! 读不到 ${ASSETS} 的 question_categories：${e.message}`);
  console.warn('    增量包里不会带分类索引，新题将无法出现在模块树里。');
}

const payload = {
  schema: 1,
  from: FROM,
  to: TO,
  generatedAt: new Date().toISOString(),
  papers: [...p.added, ...p.changed],
  questions: [...q.added, ...q.changed],
  deleted: { questions: qDeleted, papers: p.deleted },
  question_categories: qc,
};

const raw = Buffer.from(JSON.stringify(payload), 'utf8');
const gz = zlib.gzipSync(raw, { level: 9 });

fs.mkdirSync(OUT, { recursive: true });
const safe = (s) => String(s).replace(/[^\w.\-]/g, '_');
const file = path.join(OUT, `delta-${safe(FROM)}-${safe(TO)}.json.gz`);
fs.writeFileSync(file, gz);

const sha256 = crypto.createHash('sha256').update(gz).digest('hex');

console.log(`\n题库增量: ${FROM} → ${TO}`);
console.log(`  papers    新增 ${p.added.length} / 改动 ${p.changed.length} / 删除 ${p.deleted.length}`);
console.log(`  questions 新增 ${q.added.length} / 改动 ${q.changed.length} / 删除题号 ${qDeleted.length}`);
console.log(`  question_categories ${qc.length} 行（全量）`);
console.log(`  原始 ${(raw.length / 1048576).toFixed(2)} MB → 压缩 ${(gz.length / 1048576).toFixed(2)} MB`);
console.log(`  输出 ${file}`);
console.log(`  sha256 ${sha256}`);
console.log(`\nmanifest 里这样写：`);
console.log(JSON.stringify({
  from: FROM,
  to: TO,
  url: `https://github.com/ERRRC/kaogong-shuati/releases/download/tiku-${TO}/${path.basename(file)}`,
  size: gz.length,
  sha256,
  rawSize: raw.length,
}, null, 2));

fs.writeFileSync(file.replace(/\.json\.gz$/, '.meta.json'), JSON.stringify({
  from: FROM, to: TO, url: path.basename(file), size: gz.length, sha256, rawSize: raw.length,
  counts: {
    papersAdded: p.added.length, papersChanged: p.changed.length,
    questionsAdded: q.added.length, questionsChanged: q.changed.length,
    questionsDeleted: qDeleted.length,
    questionCategories: qc.length,
  },
}, null, 2), 'utf8');
