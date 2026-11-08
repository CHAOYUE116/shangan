#!/usr/bin/env node
/**
 * tools/backfill-paper-meta.mjs — 给已采试卷补 .meta.json（不重新采集）
 * 之后可用 tools/import-fenbi-papers.mjs 把 category / year / region 写进 papers 表
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'D:/Projects/上岸APP/research/fenbi-solutions';
const PROVINCES = ['北京', '天津', '上海', '广东', '重庆', '福建', '海南', '广西', '贵州', '甘肃', '河北', '河南', '安徽', '黑龙江', '西藏', '湖北', '湖南', '吉林', '江苏', '江西', '辽宁', '内蒙古', '宁夏', '青海', '山东', '山西', '陕西', '四川', '新疆', '云南', '浙江'];

function inferMeta(name) {
  const s = String(name || '');
  const out = { name: s, category: '其他', region: '', year: null, month: null, day: null, subject: '' };
  const cat = s.match(/联考\s*([A-E])\s*类/);
  if (cat) out.category = `联考${cat[1]}类`;
  else if (/模拟/.test(s)) out.category = '模拟题';
  else if (/辅警/.test(s)) out.category = '辅警';
  const provs = PROVINCES.filter((p) => s.includes(p));
  if (provs.length) { out.region = provs.slice(0, 3).join('/'); if (out.category === '其他') out.category = provs[0]; }
  const d = s.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (d) { out.year = Number(d[1]); out.month = Number(d[2]); out.day = Number(d[3]); }
  const t = s.match(/《([^》]+)》/);
  if (t) out.subject = t[1];
  return out;
}

let n = 0;
const stat = new Map();
for (const d of fs.readdirSync(SRC, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const dir = path.join(SRC, d.name);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.includes('.side') || f.includes('.meta')) continue;
    const key = f.replace(/\.json$/, '');
    const metaPath = path.join(dir, key + '.meta.json');
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const meta = inferMeta(j.name);
    meta.exerciseKey = j.exerciseKey || key;
    meta.course = d.name;
    meta.questionCount = (j.solutions || []).length;
    meta.kpCount = (j.solutions || []).filter((s) => (s.keypoints || []).length).length;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 1));
    n++;
    stat.set(meta.category, (stat.get(meta.category) || 0) + 1);
  }
}
console.log(`写入 meta ${n} 份`);
for (const [k, v] of [...stat].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
