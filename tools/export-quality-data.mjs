// 导出「有质量的题」为可入库的压缩数据：data/tiku-quality.jsonl.gz + data/papers.jsonl.gz
// 质量口径：题干非空 + 选项非空（JSON 数组且长度>0）+ 解析非空 + 答案非空
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = 'D:/Projects/上岸APP/kaogong-shuati';
const OUT = path.join(ROOT, 'data');
fs.mkdirSync(OUT, { recursive: true });

// 用 app-assets/tiku_app.db：它是自包含的（questions + papers + question_categories + question_keypoints）
const DB = path.join(ROOT, 'app-assets', 'tiku_app.db');
const db = new DatabaseSync(DB, { readOnly: true });
const hasTable = (name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0;
const num = (x) => (x == null ? null : Number(x));

// 先拿 kp / sub 映射
const kp = new Map();
if (hasTable('question_keypoints')) {
  for (const r of db.prepare('SELECT questionId, kpName FROM question_keypoints ORDER BY rank').all()) {
    if (!kp.has(r.questionId)) kp.set(r.questionId, r.kpName);
  }
}
const sub = new Map();
if (hasTable('question_categories')) {
  for (const r of db.prepare("SELECT question_id, sub FROM question_categories WHERE sub IS NOT NULL AND sub <> ''").all()) {
    if (!sub.has(r.question_id)) sub.set(r.question_id, r.sub);
  }
}

const rows = db
  .prepare(
    `SELECT q.id, q.questionId, q.paperId, q.chapter, q.type, q.questionType, q.content, q.options,
            q.answer, q.answerIndex, q.difficulty, q.source, q.analysis, q.material, p.name AS paperName
       FROM questions q JOIN papers p ON p.id = q.paperId
      WHERE ifnull(q.content,'') <> ''
        AND ifnull(q.options,'') NOT IN ('', '[]')
        AND ifnull(q.analysis,'') <> ''
        AND ifnull(q.answer,'') <> ''
      ORDER BY q.id`
  )
  .all();

const qf = path.join(OUT, 'tiku-quality.jsonl.gz');
const gz = zlib.createGzip({ level: 9 });
const ws = fs.createWriteStream(qf);
gz.pipe(ws);
let raw = 0;
let n = 0;
for (const r of rows) {
  const line =
    JSON.stringify({
      id: r.id,
      qid: r.questionId,
      pid: r.paperId,
      paper: r.paperName,
      ch: r.chapter,
      t: r.type,
      qt: r.questionType,
      s: r.content,
      o: r.options,
      a: r.answer,
      ai: num(r.answerIndex),
      d: r.difficulty == null ? null : Number(r.difficulty),
      src: r.source,
      e: r.analysis,
      m: r.material || null,
      kp: kp.get(r.id) || sub.get(r.id) || null,
    }) + '\n';
  raw += Buffer.byteLength(line);
  n += 1;
  if (!gz.write(line)) await new Promise((res) => gz.once('drain', res));
}
await new Promise((res) => {
  gz.end(res);
});
await new Promise((res) => ws.once('close', res));
const qSize = fs.statSync(qf).size;

// papers
const pf = path.join(OUT, 'papers.jsonl.gz');
const gz2 = zlib.createGzip({ level: 9 });
const ws2 = fs.createWriteStream(pf);
gz2.pipe(ws2);
let praw = 0;
const papers = db
  .prepare(
    `SELECT p.id, p.name, p.subject, p.subjectName, p.category, p.questionCount, p.difficulty
       FROM papers p WHERE p.questionCount > 0 ORDER BY p.id`
  )
  .all();
for (const p of papers) {
  const y = (/(20\d{2})/.exec(p.name || '') || [])[1];
  const line =
    JSON.stringify({
      id: p.id,
      name: p.name,
      subj: p.subjectName || p.subject,
      cat: p.category,
      y: y ? Number(y) : null,
      n: p.questionCount == null ? null : Number(p.questionCount),
      d: p.difficulty == null ? null : Number(p.difficulty),
    }) + '\n';
  praw += Buffer.byteLength(line);
  if (!gz2.write(line)) await new Promise((res) => gz2.once('drain', res));
}
await new Promise((res) => {
  gz2.end(res);
});
await new Promise((res) => ws2.once('close', res));
const pSize = fs.statSync(pf).size;

const mb = (b) => (b / 1024 / 1024).toFixed(2) + ' MB';
console.log(
  JSON.stringify(
    {
      题数: n,
      'raw(未压缩)': mb(raw),
      'tiku-quality.jsonl.gz': mb(qSize),
      卷数: papers.length,
      'papers raw': mb(praw),
      'papers.jsonl.gz': mb(pSize),
      合计压缩: mb(qSize + pSize),
    },
    null,
    1
  )
);
db.close();
