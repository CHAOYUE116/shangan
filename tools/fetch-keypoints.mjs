#!/usr/bin/env node
/**
 * 按需给题打考点（keypoints）。扫 id 入库的那 5.3 万道题当时没写 question_keypoints，
 * 导致「其他」桶里的题没有任何考点可依据 —— 这个脚本回源 `GET /api/{course}/solutions?ids=`
 * 取 keypoints[] 补进库。
 *
 *   node tools/fetch-keypoints.mjs --group 判断推理 --dry
 *   node tools/fetch-keypoints.mjs --group 判断推理 --apply --conc 6
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
const GROUP = arg('group', null);
const APPLY = !!arg('apply', false);
const CONC = Number(arg('conc', '6')) || 6;
const BATCH = Number(arg('batch', '30')) || 30;
const LIMIT = Number(arg('limit', '0')) || 0;
const DB = String(arg('db', path.join(ROOT, 'app-assets/tiku_app.db')));
const COURSE_OF = { '公务员·行测': 'xingce', '事业编·职测': 'syzc', '事业编·公基': 'sydw' };
const Q = 'app=web&kav=100&av=100&hav=100&version=3.0.0.0';

const cookie = fs.readFileSync(path.join(ROOT, 'cookie.txt'), 'utf8').trim().split(/\r?\n/).filter(Boolean).join('; ');
const headers = { cookie, 'user-agent': 'Mozilla/5.0' };

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout = 30000');
const insKp = APPLY ? db.prepare('INSERT OR IGNORE INTO question_keypoints (questionId, kpName) VALUES (?, ?)') : null;
const hasKp = db.prepare('SELECT 1 FROM question_keypoints WHERE questionId = ? LIMIT 1');

const stat = { 目标: 0, 请求: 0, 返回: 0, 有考点: 0, 写入行: 0, 跳过有考点: 0 };

for (const [subject, course] of Object.entries(COURSE_OF)) {
  const where = GROUP
    ? `AND qc.category = ? AND COALESCE(qc.sub,'') = ''`
    : '';
  const args = GROUP ? [subject, GROUP] : [subject];
  let ids = db.prepare(`
    SELECT DISTINCT qc.question_id AS qid FROM question_categories qc
    WHERE qc.subject = ? ${where}`).all(...args).map((r) => r.qid);
  if (!ids.length) continue;
  const need = ids.filter((id) => !hasKp.get(id));
  stat.跳过有考点 += ids.length - need.length;
  if (LIMIT) need.length = Math.min(need.length, LIMIT);
  stat.目标 += need.length;
  console.log(`${subject}${GROUP ? ' · ' + GROUP : ''}：${ids.length} 道，待补 ${need.length} 道`);

  const chunks = [];
  for (let i = 0; i < need.length; i += BATCH) chunks.push(need.slice(i, i + BATCH));
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const ci = cursor++;
      if (ci >= chunks.length) return;
      const url = `https://tiku.fenbi.com/api/${course}/solutions?ids=${chunks[ci].join(',')}&${Q}`;
      stat.请求++;
      let arr = null;
      try {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
        const j = await r.json();
        arr = Array.isArray(j) ? j : null;
      } catch (e) { console.error('  请求失败', e.message); }
      if (!arr) continue;
      for (const s of arr) {
        if (!s) continue;
        stat.返回++;
        const kps = (s.keypoints || []).map((k) => (typeof k === 'string' ? k : k?.name)).filter(Boolean);
        if (!kps.length) continue;
        stat.有考点++;
        if (!APPLY) continue;
        for (const k of kps) { try { insKp.run(s.id, k); stat.写入行++; } catch { /* ignore */ } }
      }
      if ((stat.请求 & 20) === 0) console.log(`  ${stat.请求} 批 / 返回 ${stat.返回} / 有考点 ${stat.有考点}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, CONC) }, () => worker()));
}

console.log(JSON.stringify(stat, null, 1));
