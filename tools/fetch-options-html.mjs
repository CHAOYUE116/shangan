#!/usr/bin/env node
/**
 * 把「选项里的公式/图」补回来。
 *
 * 背景：粉笔的选项其实是富文本（`accessories[0].options` 里是 `<p>…<img flag="tex" src="…latex=KEY">…</p>`），
 * 我们入库时把它 strip 成了纯文本 —— 选项里的分数、根号、几何图就整个消失了
 * （典型：西藏题 C 项「约占全国国土总面积的 ___，是全国面积最大的省级行政区」中间的 1/8 没了）。
 *
 * 这个脚本回源取 `GET /api/{course}/questions?ids=`，把带 <img> 的选项整段 HTML 存进新列 `optionsHtml`
 * （JSON 数组，和 options 一一对应，位置对齐）。前端 renderOption() 已经支持 HTML + 图片 hydrate。
 *
 * 只写有图的那些题：没有 <img> 的选项不会占用空间。
 *
 *   node tools/fetch-options-html.mjs --dry                # 只看命中率
 *   node tools/fetch-options-html.mjs --apply --conc 6     # 写库
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const APPLY = !!arg('apply', false);
const CONC = Number(arg('conc', '6')) || 6;
const LIMIT = Number(arg('limit', '0')) || 0;
const BATCH = Number(arg('batch', '50')) || 50;
const DB = String(arg('db', path.join(ROOT, 'app-assets/tiku_app.db')));

const COURSE_OF = {
  '公务员·行测': 'xingce',
  '事业编·职测': 'syzc',
  '事业编·公基': 'sydw',
  '公务员·申论': 'zhyynl',
  '事业编·综应': 'zhyynl',
};
const Q = 'app=web&kav=131&av=134&hav=128&gav=2&apcid=0&deviceId=';

const cookie = fs.readFileSync(path.join(ROOT, 'cookie.txt'), 'utf8').trim().split(/\r?\n/).filter(Boolean).join('; ');
const headers = { cookie, 'user-agent': 'Mozilla/5.0' };

/** 粉笔给的是 //fb.fenbike.cn/... 或 //fb.fbstatic.cn/...，统一成 https + 现役域名 */
function normHtml(html) {
  return String(html || '')
    .replace(/(?:https?:)?\/\/(?:fb\.fbstatic\.cn|fb\.fenbike\.cn)\/api\/planet\/accessories\/formulas\?latex=/g,
      'https://fb.fenbike.cn/api/planet/accessories/formulas?latex=')
    .replace(/\s+flag="tex"/g, '')
    .trim();
}

const db = new DatabaseSync(DB);
const hasCol = () => db.prepare("SELECT name FROM pragma_table_info('questions') WHERE name='optionsHtml'").get();
if (APPLY && !hasCol()) {
  db.exec('ALTER TABLE questions ADD COLUMN optionsHtml TEXT');
  console.log('已加列 optionsHtml');
}

// 按科目分组（粉笔接口只认自己科目的 id，别的 course 传过去返回 null）
const plan = [];
for (const [subject, course] of Object.entries(COURSE_OF)) {
  const ids = db.prepare(`
    SELECT q.questionId FROM questions q JOIN papers p ON p.id = q.paperId
    WHERE p.subjectName = ? AND q.type IN (1,2,3,5)
    GROUP BY q.questionId`).all(subject).map((r) => r.questionId);
  if (!ids.length) continue;
  plan.push({ subject, course, ids: LIMIT ? ids.slice(0, LIMIT) : ids });
  console.log(`${subject} → ${course}：${ids.length} 道`);
}
const totalIds = plan.reduce((s, p) => s + p.ids.length, 0);
console.log(`合计 ${totalIds} 道，batch=${BATCH} conc=${CONC}${APPLY ? '' : '（dry）'}`);

const stat = { requets: 0, returned: 0, withImg: 0, rows: 0, keys: 0, noCol: 0 };
const missingKeys = new Set();

const upd = APPLY ? db.prepare('UPDATE questions SET optionsHtml = ? WHERE questionId = ?') : null;
db.exec('PRAGMA busy_timeout = 30000');

async function runOne({ subject, course, ids }) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += BATCH) chunks.push(ids.slice(i, i + BATCH));
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const ci = cursor++;
      if (ci >= chunks.length) return;
      const chunk = chunks[ci];
      const url = `https://tiku.fenbi.com/api/${course}/questions?ids=${chunk.join(',')}&${Q}&version=3.0.0.0`;
      stat.requets++;
      let arr = null;
      try {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
        const j = await r.json();
        arr = Array.isArray(j) ? j : null;
      } catch (e) {
        console.error('  请求失败', e.message);
      }
      if (!arr) return;
      for (const q of arr) {
        if (!q) continue;
        stat.returned++;
        const opts = q.accessories?.[0]?.options;
        if (!Array.isArray(opts) || !opts.length) continue;
        if (!opts.some((o) => /<img\b/i.test(String(o)))) continue;
        stat.withImg++;
        const rich = opts.map((o) => normHtml(o));
        for (const h of rich) for (const m of h.matchAll(/[?&]latex=([^&"']+)/g)) missingKeys.add(m[1]);
        if (APPLY) {
          try { upd.run(JSON.stringify(rich), q.id); stat.rows++; } catch (e) { stat.noCol++; console.error('  写入失败', e.message); }
        }
      }
      if ((stat.requets & 15) === 0) console.log(`  ${stat.requets} 批 / 返回 ${stat.returned} / 有图 ${stat.withImg} / 写 ${stat.rows}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, CONC) }, () => worker()));
}

for (const p of plan) await runOne(p);

console.log(JSON.stringify({ ...stat, latexKeys: missingKeys.size }, null, 1));
if (APPLY) {
  const n = db.prepare('SELECT COUNT(*) n FROM questions WHERE optionsHtml IS NOT NULL').get().n;
  console.log(`库内已有 optionsHtml 的行：${n}`);
  console.log('下一步：node tools/fetch-missing-images.mjs --apply 补齐这些公式图');
}
