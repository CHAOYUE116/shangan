#!/usr/bin/env node
/**
 * tools/fix-misaligned-analysis.mjs — 修掉「按位置对齐」错填的解析
 *
 * 背景：backfill 早期版本先用「卷内位置」对齐，位置一旦与粉笔解析数组错位就会把
 * A 题的解析写进 B 题（实测 0.58% 冲突，抽查证实确有错配）。
 *
 * 本脚本按「题干前 60 字严格相等」重算一遍，只处理**我们有解析文件的卷**：
 *   - 现有分析文本 ≈ 当初按位置写入的那段（前 40 字相同）→ 认定是我们写的
 *   - 严格匹配给出正确文本 → 覆盖
 *   - 严格匹配无结果 → 清空（回退成"无解析"，好过错配）
 *
 * 用法：node tools/fix-misaligned-analysis.mjs [--apply]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOLUTIONS = path.resolve(ROOT, '..', 'research', 'fenbi-solutions');
const APPLY = process.argv.includes('--apply');

function richToText(raw) {
  if (!raw) return '';
  let node = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s.startsWith('{') && !s.startsWith('[')) return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    try { node = JSON.parse(s); } catch { return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
  }
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.name === 'txt' && typeof n.value === 'string') { out.push(n.value); return; }
    if (n.name === 'img') { out.push('[图]'); return; }
    if (Array.isArray(n.children)) n.children.forEach(walk);
    if (['p', 'div', 'li', 'tr', 'br'].includes(n.name)) out.push('\n');
  };
  walk(node);
  return out.join('').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

const strictHead = (s) => String(s || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/[\s\u3000]+/g, '')
  .replace(/[，。、；：？！“”‘’（）()《》〈〉·\-—…\[\]【】]/g, '')
  .replace(/^\d+[、.]/, '')
  .slice(0, 60);
const head40 = (s) => String(s || '').replace(/\s+/g, '').slice(0, 40);

const db = new DatabaseSync(path.resolve(ROOT, 'tiku.db'));
const pick = db.prepare('SELECT id, content, analysis FROM questions WHERE paperId = ? ORDER BY id');
const upd = db.prepare('UPDATE questions SET analysis = ? WHERE id = ?');

let stat = { papers: 0, restored: 0, cleared: 0, kept: 0, untouched: 0 };
const courses = fs.readdirSync(SOLUTIONS).filter((d) => fs.statSync(path.join(SOLUTIONS, d)).isDirectory());

for (const course of courses) {
  const dir = path.join(SOLUTIONS, course);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.includes('.meta.') && !x.includes('.side.'))) {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const pid = rec.paperId || Number(f.replace('.json', ''));
    const sols = rec.solutions || [];
    if (!sols.length) continue;
    const rows = pick.all(pid);
    if (!rows.length) continue;
    stat.papers += 1;

    const solTexts = sols.map((s) => ({ head: strictHead(richToText(s.content)), text: richToText(s.solution) }));
    const byHead = new Map();
    solTexts.forEach((s, i) => { if (s.head) byHead.set(s.head, i); });

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const cur = String(r.analysis || '').trim();
      if (!cur) continue;
      const posText = solTexts[i] ? solTexts[i].text : '';
      // 只处理「当初按位置写入」的题：现有文本与位置解析开头一致
      if (!posText || head40(cur) !== head40(posText)) { stat.untouched += 1; continue; }
      const head = strictHead(r.content);
      const idx = head ? byHead.get(head) : null;
      const right = idx != null ? solTexts[idx].text : '';
      if (right && head40(right) === head40(cur)) { stat.kept += 1; continue; }
      if (right) {
        if (APPLY) upd.run(right, r.id);
        stat.restored += 1;
      } else {
        if (APPLY) upd.run(null, r.id);
        stat.cleared += 1;
      }
    }
  }
}

console.log(`${APPLY ? '已修复' : 'dry run'}  卷 ${stat.papers} / 按位置写入 ${stat.kept + stat.restored + stat.cleared} 题`);
console.log(`  对齐正确保留 ${stat.kept}`);
console.log(`  错位但能找到正确解析 ${stat.restored}（覆盖）`);
console.log(`  错位且找不到 ${stat.cleared}（清空，回退成"无解析"）`);
console.log(`  不是我们写的 ${stat.untouched}`);
