/**
 * tools/fetch-linfukai.mjs — 下载 linfukai186-arch/gongkao-tiku 的静态题库（公开数据）
 *
 * 由来：GitHub 上搜「事业单位 题库」找到该项目，它把真题整理成静态 JSON：
 *   data/<模块>/index.json        条目清单（key 形如 "2026·xxx考试"，count=题数）
 *   data/<模块>/y<年份>.json      { "key": [ {t,s,q,o,a,e} ] }
 * 字段：t=模块/题型 s=材料 q=题干 o=选项数组 a=答案 e=解析
 *
 * 用法：
 *   node tools/fetch-linfukai.mjs --module shiyebian-gongji
 *   node tools/fetch-linfukai.mjs --module shiyebian-zongying
 *   node tools/fetch-linfukai.mjs --module all --delay 400
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://linfukai186-arch.github.io/gongkao-tiku';
const OUT = path.resolve(ROOT, '..', 'research', 'linfukai');

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const MOD = arg('module', 'all');
const DELAY = Number(arg('delay', 400));

const MODULES = MOD === 'all' ? ['shiyebian-gongji', 'shiyebian-zongying'] : [MOD];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return (await r.text()).replace(/^\uFEFF/, '');
}

/** 读缓存文件，容忍 BOM（手工用 PowerShell 保存过的副本会带 BOM） */
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
}

const report = {};

for (const m of MODULES) {
  console.log(`\n===== ${m} =====`);
  let index;
  try {
    index = JSON.parse(await get(`${BASE}/data/${m}/index.json`));
  } catch (e) {
    console.error('  index 失败:', e.message);
    continue;
  }
  fs.writeFileSync(path.join(OUT, `${m}-index.json`), JSON.stringify(index, null, 1));
  console.log(`  条目 ${index.length} 个`);

  // 提取年份
  const years = new Set();
  for (const it of index) {
    const mt = String(it.key || '').match(/(20\d{2})/);
    if (mt) years.add(mt[1]);
  }
  const list = [...years].sort();
  console.log(`  年份 ${list.length} 个: ${list[0]} … ${list[list.length - 1]}`);

  let totalQ = 0;
  let papers = 0;
  const byType = {};
  const byKey = {};

  for (const y of list) {
    const dest = path.join(OUT, `${m}-y${y}.json`);
    let data;
    if (fs.existsSync(dest)) {
      data = readJson(dest);
      console.log(`  ${y}: 已缓存`);
    } else {
      try {
        data = JSON.parse(await get(`${BASE}/data/${m}/y${y}.json`));
        fs.writeFileSync(dest, JSON.stringify(data));
        const size = (fs.statSync(dest).size / 1024).toFixed(0);
        console.log(`  ${y}: 下载 ${size} KB`);
      } catch (e) {
        console.log(`  ${y}: 失败 ${e.message}`);
        await sleep(DELAY);
        continue;
      }
      await sleep(DELAY);
    }
    for (const [key, arr] of Object.entries(data)) {
      if (!Array.isArray(arr)) continue;
      papers += 1;
      totalQ += arr.length;
      byKey[key] = (byKey[key] || 0) + arr.length;
      for (const q of arr) byType[q.t || '?'] = (byType[q.t || '?'] || 0) + 1;
    }
  }

  report[m] = { papers, totalQ, byType };
  console.log(`  ─────`);
  console.log(`  试卷 ${papers} 份，题目 ${totalQ} 道`);
  console.log('  题型分布:');
  for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`    ${String(k).padEnd(16)} ${v}`);
  }
}

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log('\n报告 → research/linfukai/report.json');
