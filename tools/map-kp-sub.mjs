// 把「有考点但二级为空」的题，用粉笔题型树的叶子名反推二级
// 用法：node tools/map-kp-sub.mjs [--dry] [--apply] [--show N] [--db path]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = args.indexOf('--' + n);
  return i >= 0 ? (args[i + 1] ?? true) : d;
};
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = String(arg('db', path.join(ROOT, 'app-assets', 'tiku_app.db')));
const APPLY = args.includes('--apply');
const SHOW = Number(arg('show', 6)) || 6;

// 粉笔根名 → 我们的一级模块名（按科目）
const OUR_OF_ROOT = {
  '政治理论': { '事业编·职测': '政治理论', '公务员·行测': '政治理论' },
  '常识判断': { '事业编·职测': '常识判断', '公务员·行测': '常识判断' },
  '言语理解与表达': { '事业编·职测': '言语理解与表达', '公务员·行测': '言语理解与表达' },
  '数量关系': { '事业编·职测': '数量关系', '公务员·行测': '数量关系' },
  '判断推理': { '事业编·职测': '判断推理', '公务员·行测': '判断推理' },
  '资料分析': { '事业编·职测': '资料分析', '公务员·行测': '资料分析' },
  '政治': { '事业编·公基': '政治理论' },
  '经济': { '事业编·公基': '经济常识' },
  '管理': { '事业编·公基': '综合常识' },
  '公文': { '事业编·公基': '公文写作' },
  '法律': { '事业编·公基': '法律常识' },
  '人文历史': { '事业编·公基': '人文常识' },
  '科技地理': { '事业编·公基': '地理国情' },
  '时事政治': { '事业编·公基': '政治理论' },
};

function loadTree() {
  const map = new Map(); // 任意层级考点名 → [{ root, sub }]（sub 取根的下一层）
  for (const f of ['cats-syzc.json', 'cats-xingce.json', 'cats-sydw.json']) {
    const p = path.join(ROOT, 'report', f);
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const roots = j?.data?.baseKeypointVOS || j?.baseKeypointVOS || [];
    for (const r of roots) {
      for (const s of r.children || []) {
        walk(s, r.name, s.name, map);
      }
    }
  }
  return map;
}
function walk(node, root, sub, map) {
  if (node && node.name) {
    const k = String(node.name).trim();
    add(map, k, root, sub);
    // 考点名常写成「甲-乙」，乙也单独登记一次
    const parts = k.split(/[-－]/);
    if (parts.length > 1) add(map, parts[0].trim(), root, sub);
  }
  for (const c of (node && node.children) || []) walk(c, root, sub, map);
}
function add(map, leaf, root, sub) {
  if (!leaf) return;
  const k = String(leaf).trim();
  if (!map.has(k)) map.set(k, []);
  const arr = map.get(k);
  if (!arr.some((x) => x.root === root && x.sub === sub)) arr.push({ root, sub });
}

const tree = loadTree();
const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout = 30000');

// 取所有「二级为空但有考点」的行
const rows = db
  .prepare(
    `SELECT qc.question_id AS qid, qc.subject AS subj, qc.category AS cat,
            (SELECT GROUP_CONCAT(k.kpName, '|') FROM question_keypoints k WHERE k.questionId = qc.question_id) AS kps
       FROM question_categories qc
      WHERE COALESCE(qc.sub, '') = ''
        AND EXISTS (SELECT 1 FROM question_keypoints k WHERE k.questionId = qc.question_id)`,
  )
  .all();

console.log(`待映射 ${rows.length} 道（有考点但二级为空）`);

const upd = APPLY ? db.prepare('UPDATE question_categories SET sub = ?, category = ? WHERE question_id = ? AND subject = ?') : null;
const moved = [];
const subOnly = [];
const skip = [];
let written = 0;

db.exec(APPLY ? 'BEGIN' : 'SELECT 1');
try {
  for (const r of rows) {
    const kps = String(r.kps || '')
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
    let hit = null;
    for (const k of kps) {
      const cand = tree.get(k);
      if (!cand || !cand.length) continue;
      // 优先选「根名能对到本题当前一级模块」的那条
      const ok = cand.find((c) => (OUR_OF_ROOT[c.root] || {})[r.subj] === r.cat);
      if (ok) {
        hit = { root: ok.root, sub: ok.sub, move: false };
        break;
      }
      // 否则按考点所属根名搬模块（考点是粉笔自己标的，比我们按章节猜的准）
      const movable = cand.find((c) => (OUR_OF_ROOT[c.root] || {})[r.subj]);
      if (movable && !hit) hit = { root: movable.root, sub: movable.sub, move: true };
    }
    if (!hit) {
      skip.push(r.qid);
      continue;
    }
    const newCat = hit.move ? OUR_OF_ROOT[hit.root][r.subj] : r.cat;
    if (hit.move) {
      moved.push({ qid: r.qid, from: r.cat, to: newCat, sub: hit.sub });
    } else {
      subOnly.push({ qid: r.qid, cat: r.cat, sub: hit.sub });
    }
    if (APPLY) upd.run(hit.sub, newCat, r.qid, r.subj);
    written += 1;
  }
  db.exec(APPLY ? 'COMMIT' : 'SELECT 1');
} catch (e) {
  try {
    db.exec('ROLLBACK');
  } catch {}
  throw e;
}

const top = (arr, key) => {
  const m = new Map();
  for (const x of arr) m.set(x[key], (m.get(x[key]) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, SHOW);
};
console.log(JSON.stringify({
  模式: APPLY ? 'apply' : 'dry',
  可写: written,
  仅补二级: subOnly.length,
  需要搬模块: moved.length,
  映射不到: skip.length,
}, null, 0));
console.log('仅补二级分布：', JSON.stringify(top(subOnly.map((x) => ({ ...x, k: x.cat + ' / ' + x.sub })), 'k')));
console.log('搬模块分布：', JSON.stringify(top(moved.map((x) => ({ ...x, k: x.from + ' → ' + x.to + ' / ' + x.sub })), 'k')));
if (!APPLY) console.log('样例：', JSON.stringify([...subOnly.slice(0, 3), ...moved.slice(0, 3)]));
