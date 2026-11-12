#!/usr/bin/env node
/**
 * 用粉笔「旧版题目明细」接口按 id 批量拉题目详情 —— 纯 GET，不占建练习额度。
 *
 *   GET https://tiku.fenbi.com/api/{course}/questions?ids=1,2,3&app=web&kav=100&av=100&hav=100&version=3.0.0.0
 *
 * 返回数组，元素形如
 *   { id, content(HTML), material:{id,content}|null, type, difficulty,
 *     correctAnswer:{choice,type}, accessories:[{options:[...],type:101}], hasVideo }
 *
 * 这一步解决三件事：
 *   1. 拿到**粉笔官方难度**（此前我们只能靠题干结构猜，实测与真实正确率相关系数 ≈ 0）
 *   2. 补回被写成 `[object Object]` / 为空的材料
 *   3. 补回 contentHtml 为空、选项为空、答案为空
 *
 * 生成物一律写新列，不动老字段：
 *   fenbi_difficulty  粉笔难度 1~9
 *   fenbi_diff_src    'fenbi-api'
 *   fenbi_checked_at  拉取时间
 *
 * 用法：
 *   node tools/fetch-qdetail.mjs --dry --limit 200            # 看命中率
 *   node tools/fetch-qdetail.mjs --apply --subject 事业编·职测
 *   node tools/fetch-qdetail.mjs --apply                      # 全库
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'app-assets', 'tiku_app.db');

const arg = (name, def = '') => {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
};
const APPLY = arg('apply', '') === 'true';
const LIMIT = Number(arg('limit', '0')) || 0;
const BATCH = Number(arg('batch', '100')) || 100;
const GAP = Number(arg('gap', '900'));
const SUBJECT = arg('subject', '');
const COURSE = arg('course', '');
const ONLY = arg('only', 'all'); // all | difficulty | material
const DB_PATH = arg('db', DB);

const COURSE_OF = {
  '公务员·行测': 'xingce',
  '事业编·职测': 'syzc',
  '事业编·公基': 'sydw',
  '事业编·综应': 'zhyynl',
  '公务员·申论': 'zhyynl',
  '事业编·申论': 'zhyynl',
};

const cookieFile = path.join(ROOT, 'cookie.txt');
const COOKIE = fs.readFileSync(cookieFile, 'utf8').trim();
const H = {
  cookie: COOKIE,
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'application/json, text/plain, */*',
  referer: 'https://www.fenbi.com/spa/tiku',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAD_MAT = /^\s*\[object Object\]\s*$/;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 粉笔图片域归一：详情接口返回的相对/旧域链接 */
function normLinks(html) {
  if (!html) return html;
  return String(html)
    .replace(/\/\/fb\.fbstatic\.cn\/api\/planet\/accessories\/formulas\?latex=/g,
      'https://fb.fenbike.cn/api/planet/accessories/formulas?latex=')
    .replace(/https?:\/\/fb\.fbstatic\.cn\/api\/planet\/accessories\/formulas\?latex=/g,
      'https://fb.fenbike.cn/api/planet/accessories/formulas?latex=')
    .replace(/src="\/\//g, 'src="https://')
    .replace(/\s+/g, ' ')
    .trim();
}

function optionsOf(it) {
  const acc = (it.accessories || []).find((a) => a && a.type === 101);
  return acc && Array.isArray(acc.options) ? acc.options : [];
}

function answerOf(it, optCount) {
  const ca = it.correctAnswer || {};
  const choice = ca.choice;
  if (choice == null || choice === '') return null;
  const s = String(choice);
  const letters = s
    .split(/[,，\s]+/)
    .map((x) => x.trim().toUpperCase())
    .filter((x) => /^[A-Z]$/.test(x));
  if (letters.length) {
    const idx = letters.map((L) => L.charCodeAt(0) - 65).filter((i) => i >= 0 && i < Math.max(optCount, 1));
    if (!idx.length) return null;
    return letters.length === 1
      ? { answer: letters[0], answerIndex: idx[0] }
      : { answer: idx.join(','), answerIndex: -1 };
  }
  // choice 是下标（"1" => B）
  const n = Number(s);
  if (Number.isFinite(n) && n >= 0) {
    if (it.type === 3) return { answer: n === 0 ? 'A' : 'B', answerIndex: n === 0 ? 1 : 2 };
    return { answer: String.fromCharCode(65 + n), answerIndex: n + 1 };
  }
  return null;
}

async function fetchBatch(course, ids) {
  const u =
    `https://tiku.fenbi.com/api/${course}/questions?ids=${ids.join(',')}` +
    `&app=web&kav=100&av=100&hav=100&version=3.0.0.0`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(30000) });
      if (r.status === 403) {
        console.log(`  ! 403（第 ${attempt + 1} 次），等 20s`);
        await sleep(20000);
        continue;
      }
      const t = await r.text();
      const arr = JSON.parse(t);
      return Array.isArray(arr) ? arr.filter(Boolean) : [];
    } catch (e) {
      console.log(`  ! 请求失败 ${e.message}（第 ${attempt + 1} 次）`);
      await sleep(5000);
    }
  }
  return [];
}

function runWithRetry(stmt, ...args) {
  for (let i = 0; i < 8; i++) {
    try {
      return stmt.run(...args);
    } catch (e) {
      if (String(e.errstr || e.message || '').includes('locked')) {
        const wait = 1500 * (i + 1);
        console.log(`  ! 数据库被占用，${wait}ms 后重试（${i + 1}/8）`);
        const t = Date.now();
        while (Date.now() - t < wait) {}
        continue;
      }
      throw e;
    }
  }
  return null;
}

function ensureColumns(db) {
  const cols = new Set(db.prepare("PRAGMA table_info('questions')").all().map((c) => c.name));
  for (const [name, type] of [
    ['fenbi_difficulty', 'REAL'],
    ['fenbi_diff_src', 'TEXT'],
    ['fenbi_checked_at', 'TEXT'],
  ]) {
    if (!cols.has(name)) {
      db.exec(`ALTER TABLE questions ADD COLUMN ${name} ${type}`);
      console.log(`  + 新增列 ${name} ${type}`);
    }
  }
}

async function main() {
  console.log(`模式：${APPLY ? 'APPLY（写库）' : 'DRY'}`);
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 30000');
  db.exec('PRAGMA synchronous = NORMAL');
  if (APPLY) ensureColumns(db);
  const hasDiff = db.prepare("PRAGMA table_info('questions')").all().some((c) => c.name === 'fenbi_difficulty');
  const diffKey = hasDiff ? 'q.fenbi_difficulty' : '0';

  const subjects = SUBJECT ? [SUBJECT] : Object.keys(COURSE_OF);
  const summary = [];
  const now = new Date().toISOString();

  for (const subj of subjects) {
    const course = COURSE || COURSE_OF[subj];
    if (!course) continue;

    // 需要处理的题：只挑「还有缺口」的（难度未取 / 材料脏 / 正文空 / 选项空）
    const where = [
      `q.paperId IN (SELECT id FROM papers WHERE subjectName = ?)`,
    ];
    if (ONLY === 'difficulty') {
      where.push(`COALESCE(${diffKey}, 0) = 0`);
    } else if (ONLY === 'material') {
      where.push(`(q.material = '[object Object]' OR COALESCE(q.material,'') = '')`);
    } else {
      where.push(`(COALESCE(${diffKey},0) = 0 OR q.material = '[object Object]'
        OR COALESCE(q.contentHtml,'') = '' OR COALESCE(q.options,'[]') IN ('[]',''))
      `);
    }
    const sql =
      `SELECT DISTINCT q.questionId FROM questions q WHERE ${where.join(' AND ')}` +
      (LIMIT ? ` LIMIT ${LIMIT}` : '');
    let ids = db.prepare(sql).all(subj).map((r) => r.questionId);
    if (LIMIT) ids = ids.slice(0, LIMIT);
    if (!ids.length) {
      console.log(`\n${subj}(${course})：无待处理题`);
      continue;
    }
    console.log(`\n${subj}(${course})：待处理 ${ids.length} 道，每批 ${BATCH}`);

    const upd = APPLY ? db.prepare(`
      UPDATE questions SET
        fenbi_difficulty = COALESCE(?, fenbi_difficulty),
        fenbi_diff_src   = CASE WHEN ? THEN 'fenbi-api' ELSE fenbi_diff_src END,
        fenbi_checked_at = ?,
        material   = CASE WHEN ? IS NOT NULL AND (material = '[object Object]' OR COALESCE(material,'') = '') THEN ? ELSE material END,
        contentHtml= CASE WHEN ? IS NOT NULL AND (COALESCE(contentHtml,'') = '' OR COALESCE(contentHtml,'') = content) THEN ? ELSE contentHtml END,
        content    = CASE WHEN ? IS NOT NULL AND COALESCE(content,'') = '' THEN ? ELSE content END,
        options    = CASE WHEN ? IS NOT NULL AND COALESCE(options,'[]') IN ('[]','') THEN ? ELSE options END,
        answer     = CASE WHEN ? IS NOT NULL AND COALESCE(answer,'') = '' THEN ? ELSE answer END,
        answerIndex= CASE WHEN ? IS NOT NULL AND COALESCE(answerIndex,-1) < 0 AND COALESCE(answer,'') = '' THEN ? ELSE answerIndex END
      WHERE questionId = ?
    `) : null;

    let hit = 0;
    let diffN = 0;
    let matN = 0;
    let bodyN = 0;
    let optN = 0;
    let ansN = 0;
    let written = 0;

    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      const arr = await fetchBatch(course, slice);
      hit += arr.length;

      for (const it of arr) {
        const qid = it.id;
        if (qid == null) continue;
        const diff = it.difficulty == null ? null : Number(it.difficulty);
        if (diff != null && diff > 0) diffN++;

        const mat = it.material && it.material.content ? normLinks(it.material.content) : null;
        const body = it.content ? normLinks(it.content) : null;
        const opts = optionsOf(it);
        const optJson = opts.length && opts.every((o) => String(o).trim() !== '') ? JSON.stringify(opts) : null;
        const ans = answerOf(it, opts.length);

        if (mat) matN++;
        if (body && /<img/i.test(body)) bodyN++;
        if (optJson) optN++;
        if (ans) ansN++;

        if (APPLY) {
          runWithRetry(upd, 
            diff != null && diff > 0 ? diff : null,
            diff != null && diff > 0 ? 1 : 0,
            now,
            mat, mat,
            body, body,
            body, body,
            optJson, optJson,
            ans ? ans.answer : null, ans ? ans.answer : null,
            ans ? ans.answerIndex : null, ans ? ans.answerIndex : null,
            qid,
          );
          written++;
        }
      }
      process.stdout.write(
        `  ${Math.min(i + BATCH, ids.length)}/${ids.length} 命中 ${hit} 难度 ${diffN} 材料 ${matN} 图形 ${bodyN}\r`,
      );
      await sleep(GAP);
    }
    console.log('');
    summary.push({ subject: subj, course, want: ids.length, hit, diff: diffN, material: matN, imageBody: bodyN, options: optN, answer: ansN, written });
  }

  db.close();
  console.log('\n=== 汇总 ===');
  for (const s of summary) {
    console.log(
      `${s.subject}(${s.course}) 请求 ${s.want} 命中 ${s.hit}` +
        ` | 难度 ${s.diff} 材料 ${s.material} 带图正文 ${s.imageBody} 选项 ${s.options} 答案 ${s.answer}`,
    );
  }
  const out = path.join(ROOT, 'report', `qdetail-${new Date().toISOString().slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ apply: APPLY, batch: BATCH, summary }, null, 2));
  console.log('明细 →', out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
