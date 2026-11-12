#!/usr/bin/env node
/**
 * 用粉笔「解析」接口按 id 批量拉解析 —— 纯 GET，不占建练习额度。
 *
 *   GET https://tiku.fenbi.com/api/{course}/solutions?ids=1,2,3&app=web&kav=100&av=100&hav=100&version=3.0.0.0
 *
 * 返回数组，元素含：
 *   id, content(题干), material, type, difficulty, solution(解析 HTML), source,
 *   keypoints[], accessories, solutionAccessories, correctAnswer, questionMeta, flags
 *
 * 这是 `questions` 接口缺的那一半：那边只有题干/选项/答案/难度，没有解析。
 *
 * 补三类：
 *   1. 解析（我们空、太短、或我们的解析没图而它有图）
 *   2. 考点（question_keypoints 为空的题）
 *   3. 全站统计（question_meta：correctRatio / totalCount / mostWrong）
 * 并在解析与答案冲突时只记日志，不改答案。
 *
 * 用法：
 *   node tools/fetch-qsolution.mjs --dry --limit 200
 *   node tools/fetch-qsolution.mjs --apply --only bad
 *   node tools/fetch-qsolution.mjs --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const arg = (n, d = '') => {
  const i = process.argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
};
const APPLY = arg('apply', '') === 'true';
const LIMIT = Number(arg('limit', '0')) || 0;
const BATCH = Number(arg('batch', '30')) || 30;
const GAP = Number(arg('gap', '900'));
const SUBJECT = arg('subject', '');
const ONLY = arg('only', 'all'); // all | bad | noanalysis | nokp
const DB = arg('db', path.join(ROOT, 'app-assets', 'tiku_app.db'));

const COURSE_OF = {
  '公务员·行测': 'xingce',
  '事业编·职测': 'syzc',
  '事业编·公基': 'sydw',
  '事业编·综应': 'zhyynl',
  '公务员·申论': 'zhyynl',
};
const COOKIE = fs.readFileSync(path.join(ROOT, 'cookie.txt'), 'utf8').trim();
const H = {
  cookie: COOKIE,
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'application/json, text/plain, */*',
  referer: 'https://www.fenbi.com/spa/tiku',
};
const V = 'app=web&kav=100&av=100&hav=100&version=3.0.0.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONC = Number(arg('conc', '1')) || 1;

const normLinks = (html) =>
  !html
    ? html
    : String(html)
        .replace(/(?:https?:)?\/\/fb\.fbstatic\.cn\/api\/planet\/accessories\/formulas\?latex=/g,
          'https://fb.fenbike.cn/api/planet/accessories/formulas?latex=')
        .replace(/src="\/\//g, 'src="https://')
        .trim();

const textOf = (html) =>
  String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

async function fetchBatch(course, ids) {
  const u = `https://tiku.fenbi.com/api/${course}/solutions?ids=${ids.join(',')}&${V}`;
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(30000) });
      if (r.status === 403) {
        console.log(`  ! 403（${a + 1}/4）等 20s`);
        await sleep(20000);
        continue;
      }
      const t = await r.text();
      const arr = JSON.parse(t);
      return Array.isArray(arr) ? arr.filter(Boolean) : [];
    } catch (e) {
      console.log(`  ! ${e.message}（${a + 1}/4）`);
      await sleep(4000);
    }
  }
  return [];
}

async function main() {
  console.log(`模式 ${APPLY ? 'APPLY' : 'DRY'} / only=${ONLY} / batch=${BATCH}`);
  const db = new DatabaseSync(DB);
  db.exec('PRAGMA busy_timeout = 30000');
  const cols = new Set(db.prepare("PRAGMA table_info('questions')").all().map((c) => c.name));
  if (APPLY && !cols.has('fenbi_sol_at')) db.exec('ALTER TABLE questions ADD COLUMN fenbi_sol_at TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS question_meta (
    questionId INTEGER PRIMARY KEY, correctRatio REAL, totalCount INTEGER,
    mostWrong TEXT, src TEXT, updatedAt TEXT)`);

  const subjects = SUBJECT ? [SUBJECT] : Object.keys(COURSE_OF);
  const report = [];
  const now = new Date().toISOString();

  for (const subj of subjects) {
    const course = COURSE_OF[subj];
    if (!course) continue;
    const where = [`q.paperId IN (SELECT id FROM papers WHERE subjectName = ?)`];
    if (ONLY === 'bad') where.push(`q.q_bad = 1`);
    else if (ONLY === 'noanalysis')
      where.push(`LENGTH(COALESCE(q.analysis,'')) < 20`);
    else if (ONLY === 'nokp')
      where.push(`NOT EXISTS (SELECT 1 FROM question_keypoints k WHERE k.questionId = q.questionId)`);
    else
      where.push(`(q.q_bad = 1 OR LENGTH(COALESCE(q.analysis,'')) < 20
        OR NOT EXISTS (SELECT 1 FROM question_keypoints k WHERE k.questionId = q.questionId))`);
    let ids = db
      .prepare(`SELECT DISTINCT q.questionId id FROM questions q WHERE ${where.join(' AND ')}`)
      .all(subj)
      .map((r) => r.id);
    if (LIMIT) ids = ids.slice(0, LIMIT);
    if (!ids.length) {
      console.log(`\n${subj}：无待处理题`);
      continue;
    }
    console.log(`\n${subj}(${course})：待处理 ${ids.length} 道`);

    const curStmt = db.prepare(`SELECT analysis, analysisHtml, answer FROM questions WHERE questionId = ?`);
    const updSol = APPLY
      ? db.prepare(`UPDATE questions SET analysis = ?, analysisHtml = ?, fenbi_sol_at = ? WHERE questionId = ?`)
      : null;
    const updMeta = APPLY
      ? db.prepare(`INSERT INTO question_meta (questionId, correctRatio, totalCount, mostWrong, src, updatedAt)
         VALUES (?, ?, ?, ?, 'fenbi-api', ?)
         ON CONFLICT(questionId) DO UPDATE SET correctRatio=excluded.correctRatio,
           totalCount=excluded.totalCount, mostWrong=excluded.mostWrong, src='fenbi-api', updatedAt=excluded.updatedAt`)
      : null;
    const insKp = APPLY
      ? db.prepare(`INSERT OR IGNORE INTO question_keypoints (questionId, kpName) VALUES (?, ?)`)
      : null;

    let hit = 0, solN = 0, kpN = 0, metaN = 0, conflict = 0;
    const kpNames = new Set();

    const batches = [];
    for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));
    let nextBatch = 0;
    let processed = 0;
    const worker = async () => {
      for (;;) {
        const bi = nextBatch++;
        if (bi >= batches.length) return;
        const arr = await fetchBatch(course, batches[bi]);
        hit += arr.length;
        for (const it of arr) {
          const qid = it.id;
          const solHtml = normLinks(it.solution || '');
          const solTxt = textOf(solHtml);
          if (solTxt.length >= 10) solN++;

          if (APPLY) {
            const old = curStmt.all(qid)[0];
            const oldTxt = String(old?.analysis || '');
            const oldHasImg = /<img/i.test(String(old?.analysisHtml || ''));
            const newHasImg = /<img/i.test(solHtml);
            const better =
              solTxt.length >= 10 &&
              (oldTxt.length < 20 || (newHasImg && !oldHasImg) || solTxt.length > oldTxt.length * 1.5);
            if (better) updSol.run(solTxt, solHtml, now, qid);

            const kps = Array.isArray(it.keypoints) ? it.keypoints : [];
            for (const k of kps) {
              const name = typeof k === 'string' ? k : k?.name || k?.kpName;
              if (!name) continue;
              insKp.run(qid, name);
              kpNames.add(name);
              kpN++;
            }

            const meta = it.questionMeta || null;
            if (meta && meta.correctRatio != null) {
              updMeta.run(
                qid,
                Number(meta.correctRatio),
                meta.totalCount == null ? null : Number(meta.totalCount),
                meta.mostWrongAnswer ? JSON.stringify(meta.mostWrongAnswer) : null,
                now,
              );
              metaN++;
            }

            const ca = it.correctAnswer;
            if (old?.answer && ca && String(ca.choice ?? '') !== '' && String(ca.choice) !== String(old.answer)) {
              conflict++;
            }
          }
        }
        processed += batches[bi].length;
        process.stdout.write(`  ${Math.min(processed, ids.length)}/${ids.length} 命中 ${hit} 解析 ${solN} 考点 ${kpN} meta ${metaN}\r`);
        if (GAP > 0) await sleep(Math.max(40, Math.floor(GAP / Math.max(1, CONC))));
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, CONC) }, () => worker()));
    console.log('');
    report.push({ subject: subj, course, want: ids.length, hit, solution: solN, keypoints: kpN, meta: metaN, conflict });
  }

  db.close();
  console.log('\n=== 汇总 ===');
  for (const r of report)
    console.log(`${r.subject}(${r.course}) 请求 ${r.want} 命中 ${r.hit} | 解析 ${r.solution} 考点 ${r.keypoints} meta ${r.meta}`);
  const out = path.join(ROOT, 'report', `qsolution-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(out, JSON.stringify({ apply: APPLY, only: ONLY, report }, null, 2));
  console.log('明细 →', out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
