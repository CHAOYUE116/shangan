#!/usr/bin/env node
/**
 * tools/import-keypoints.mjs — 把「考点散题」采集结果导入题库
 *
 * 输入：research/fenbi-keypoint/<course>/*.json（tools/fenbi-keypoint-fetch.mjs 产出）
 * 输出：questions + question_keypoints + question_categories（另有 papers 一条虚拟卷）
 *
 *   node tools/import-keypoints.mjs --course syzc --dry
 *   node tools/import-keypoints.mjs --course syzc --apply
 *   node tools/import-keypoints.mjs --course syzc --apply --db tmp-copy.db   # 试算体积
 *
 * 设计要点：
 * - 散题不属于任何一份真卷，统一挂到一条虚拟卷「考点散题（粉笔考点）」上，避免 paperId NOT NULL 报错；
 * - 同一个 questionId 在多个考点下出现时只写一次题目，但把每个考点都写进 question_keypoints；
 * - 库里已有的题（整卷采过）只补考点映射，不改题干/解析，避免把已校对的文本冲掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (n) => argv.includes('--' + n);

const COURSE = arg('course', 'syzc');
const DIR = path.resolve(ROOT, '..', 'research', 'fenbi-keypoint', COURSE);
const DB = path.resolve(arg('db', path.join(ROOT, 'app-assets', 'tiku_app.db')));
const APPLY = flag('apply');
const DRY = !APPLY;

const SUBJECT = {
  syzc: '事业编·职测',
  sydw: '事业编·公基',
  zhyynl: '事业编·综应',
  xingce: '公务员·行测',
  shenlun: '公务员·申论',
}[COURSE] || '事业编·职测';

const PAPER_NAME = `考点散题（粉笔考点 · ${SUBJECT.split('·')[1] || ''}）`;
const LETTER = (i) => (i >= 0 && i < 8 ? 'ABCDEFGH'[i] : '');

function categoryOf(parent, name) {
  const seg = String(parent || '').split('/').filter(Boolean);
  // parent 形如 /言语理解与表达/逻辑填空/语境分析 → 一级模块是 seg[0]
  return seg[0] || '未分类';
}

if (!fs.existsSync(DIR)) {
  console.error(`找不到采集目录：${DIR}`);
  process.exit(1);
}
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== '_state.json');
if (!files.length) {
  console.error('采集目录里还没有考点文件');
  process.exit(1);
}

const db = new DatabaseSync(DB);
db.exec('PRAGMA journal_mode = MEMORY');

// 虚拟卷
let paperId = (() => {
  const row = db.prepare('SELECT id FROM papers WHERE name = ? LIMIT 1').get(PAPER_NAME);
  if (row) return row.id;
  if (DRY) return -1;
  const max = db.prepare('SELECT COALESCE(MAX(id), 0) m FROM papers').get().m;
  const id = max + 1;
  db.prepare('INSERT INTO papers (id, subject, subjectName, category, name, questionCount, time, difficulty, exerciseId, chapters, crawledAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, SUBJECT, SUBJECT, '考点散题', PAPER_NAME, 0, '', 0, 0, '[]', new Date().toISOString().slice(0, 19));
  return id;
})();

const seenQ = db.prepare('SELECT id FROM questions WHERE questionId = ? LIMIT 1');
const insQ = db.prepare(`INSERT INTO questions
  (questionId, paperId, chapter, type, questionType, content, contentHtml, material, options, optionType, answer, answerIndex, difficulty, source, analysis, analysisHtml, hasVideo)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insCat = db.prepare('INSERT INTO question_categories (question_id, subject, category, sub) VALUES (?,?,?,?)');
const insKp = db.prepare('INSERT OR IGNORE INTO question_keypoints (questionId, kpId, kpName, rank) VALUES (?,?,?,?)');
const hasCat = db.prepare('SELECT 1 FROM question_categories WHERE question_id = ? AND subject = ? LIMIT 1');
const hasKp = db.prepare('SELECT 1 FROM question_keypoints WHERE questionId = ? AND kpName = ? LIMIT 1');

const stat = {
  files: files.length, questions: 0, unique: 0, inserted: 0, existed: 0, noOptions: 0,
  kpRows: 0, kpSkipped: 0, catRows: 0, chars: 0, optChars: 0,
};

db.exec('BEGIN');
const byKp = new Map(); // questionId -> {chapter, kps:Set}
for (const f of files) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  } catch {
    continue;
  }
  const chapter = categoryOf(j.parent, j.name);
  const selfKp = { id: j.keypointId, name: j.name };
  for (const q of j.questions || []) {
    stat.questions += 1;
    const qid = Number(q.questionId);
    if (!qid) continue;
    const cur = byKp.get(qid) || { chapter, kps: new Map(), q };
    if (selfKp.name) cur.kps.set(selfKp.name, selfKp.id);
    for (const k of q.keypoints || []) if (k && k.name) cur.kps.set(k.name, k.id);
    if (!byKp.has(qid)) byKp.set(qid, cur);
  }
}

for (const [qid, info] of byKp) {
  stat.unique += 1;
  const q = info.q;
  const opts = Array.isArray(q.options) ? q.options : [];
  stat.chars += (q.content || '').length + (q.solution || '').length;
  stat.optChars += JSON.stringify(opts).length;
  if (!opts.length) stat.noOptions += 1;

  const exist = seenQ.get(qid);
  if (exist) {
    stat.existed += 1;
  } else {
    stat.inserted += 1;
    if (!DRY) {
      const ai = q.correctAnswer && q.correctAnswer.choice != null ? Number(q.correctAnswer.choice) : -1;
      insQ.run(
        qid, paperId, info.chapter, Number(q.type) || 1, null,
        q.content || '', '', q.material || '',
        JSON.stringify(opts), String(q.optionType || '1'),
        LETTER(ai), ai, 3, 'fenbi-keypoint',
        q.solution || '', '', 0,
      );
    }
  }

  if (!DRY) {
    if (!hasCat.get(qid, SUBJECT)) {
      insCat.run(qid, SUBJECT, info.chapter, info.kps.keys().next().value || info.chapter);
      stat.catRows += 1;
    }
    let rank = 0;
    for (const [name, id] of info.kps) {
      if (hasKp.get(qid, name)) { stat.kpSkipped += 1; continue; }
      insKp.run(qid, id || null, name, rank++);
      stat.kpRows += 1;
    }
  }
}

if (!DRY) {
  db.prepare('UPDATE papers SET questionCount = (SELECT COUNT(*) FROM questions WHERE paperId = ?) WHERE id = ?').run(paperId, paperId);
}
db.exec(DRY ? 'ROLLBACK' : 'COMMIT');

const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
const pages = db.prepare('PRAGMA page_count').get().page_count;
const psize = db.prepare('PRAGMA page_size').get().page_size;
console.log(`${DRY ? '[试算]' : '[写入]'} 考点 ${stat.files} 个 / 题 ${stat.questions} 行 / 唯一 ${stat.unique} 题`);
console.log(`  新增 ${stat.inserted} 题 · 已存在 ${stat.existed} 题（只补考点）· 无选项 ${stat.noOptions} 题`);
console.log(`  考点映射 +${stat.kpRows} 行（已存在跳过 ${stat.kpSkipped}）· 分类 +${stat.catRows} 行`);
console.log(`  文本 ${mb(stat.chars * 3)} + 选项 ${mb(stat.optChars * 3)}（按 UTF-8 三字节估）`);
console.log(`  库文件 ${mb(pages * psize)} · ${DB}`);
if (DRY) console.log('  （--dry 不会写库；加 --apply 落盘）');
