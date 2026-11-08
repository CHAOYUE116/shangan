#!/usr/bin/env node
/**
 * tools/normalize-categories.mjs — 把 question_categories 的 category/sub 归一化到 FENBI_TREE 词表
 *
 * 背景：/api/chapters 的模块题量 = subs.reduce(...)，而 subs 的题数来自
 *       `idxMap.get(`${g.group}|${sub.name}`)` —— 必须和 FENBI_TREE 的固定词表完全一致。
 *       我们导入粉笔时写的是原始考点名（"对应关系"/"和差倍比问题"…），对不上就丢数字。
 *
 * FENBI_TREE 词表（6 组 / 22 sub）：
 *   政治理论: 马克思主义 新思想 时事政治 毛中特
 *   常识判断: 经济常识 法律常识 科技常识 人文常识 地理国情
 *   言语理解与表达: 逻辑填空 片段阅读 语句表达
 *   数量关系: 数学运算
 *   判断推理: 图形推理 定义判断 类比推理 逻辑判断
 *   资料分析: 增长 比重 平均数 倍数 综合
 *
 * 用法：
 *   node tools/normalize-categories.mjs --dry-run
 *   node tools/normalize-categories.mjs --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const SUBJECT = (() => { const i = process.argv.indexOf('--subject'); return i >= 0 ? process.argv[i + 1] : '事业编·职测'; })();

/**
 * 粉笔考点名 → (FENBI_TREE group, sub)
 * 顺序：先具体后宽泛，避免"增长量比较"被"量"之类宽词吞掉
 */
function normalize(chapter, sub) {
  const t = `${chapter || ''}|${sub || ''}`;

  // ---- 判断推理 ----
  if (/图形推理|图形/.test(t)) return ['判断推理', '图形推理'];
  if (/定义判断|定义/.test(t)) return ['判断推理', '定义判断'];
  if (/类比推理|类比/.test(t)) return ['判断推理', '类比推理'];
  if (/逻辑判断|逻辑推理|削弱|加强|论证|翻译|排列|真假|推理形式|逻辑错误|原因解释|日常结论|前提|评价|解释型|结论型/.test(t)) return ['判断推理', '逻辑判断'];
  if (/判断推理/.test(t)) return ['判断推理', '逻辑判断'];

  // ---- 言语理解与表达 ----
  if (/逻辑填空|实词|成语|虚词|混搭|固定搭配|语境/.test(t)) return ['言语理解与表达', '逻辑填空'];
  if (/片段阅读|中心理解|细节|标题|态度|词句理解|主旨|意图|常规主观|特殊问法/.test(t)) return ['言语理解与表达', '片段阅读'];
  if (/语句表达|语句排序|语句填空|接语|下文推断|行文逻辑|捆绑/.test(t)) return ['言语理解与表达', '语句表达'];
  if (/言语理解|言语运用|言语应用|阅读理解/.test(t)) return ['言语理解与表达', '片段阅读'];

  // ---- 数量关系 ----
  if (/数量|数学运算|工程|行程|利润|排列组合|概率|几何|容斥|年龄|钟表|溶液|数列|最值|计算问题|和差倍比|浓度|方阵|牛吃草|统筹|日期|星期|比例|方程|赋值|枚举|抽屉|植树|鸡兔|经济利润|计数/.test(t)) return ['数量关系', '数学运算'];
  if (/数量分析/.test(t)) return ['数量关系', '数学运算'];

  // ---- 资料分析（先具体指标，再综合）----
  if (/增长|增速|增量/.test(t)) return ['资料分析', '增长'];
  if (/比重|占比/.test(t)) return ['资料分析', '比重'];
  if (/平均|均值/.test(t)) return ['资料分析', '平均数'];
  if (/倍数|翻番/.test(t)) return ['资料分析', '倍数'];
  if (/资料分析|统计|综合资料|文字资料|表格|图形资料|正误判断/.test(t)) return ['资料分析', '综合'];

  // ---- 常识判断 ----
  if (/法律|法规|宪法|民法|刑法|行政法|诉讼法/.test(t)) return ['常识判断', '法律常识'];
  if (/经济|金融|货币|财政/.test(t)) return ['常识判断', '经济常识'];
  if (/科技|物理|化学|生物|生活常识|医学|能源|航天|信息/.test(t)) return ['常识判断', '科技常识'];
  if (/人文|历史|文学|文化|艺术|哲学|思想/.test(t)) return ['常识判断', '人文常识'];
  if (/地理|国情|区域|气候|环境/.test(t)) return ['常识判断', '地理国情'];
  if (/常识/.test(t)) return ['常识判断', '人文常识'];

  // ---- 政治理论 ----
  if (/时事|时政/.test(t)) return ['政治理论', '时事政治'];
  if (/马克思|哲学|唯物|辩证法/.test(t)) return ['政治理论', '马克思主义'];
  if (/毛|中特|党史|党的|革命|改革/.test(t)) return ['政治理论', '毛中特'];
  if (/新思想|习近平|五位一体|党建|政治建设|生态文明|重要文件|重要会议/.test(t)) return ['政治理论', '新思想'];
  if (/政治理论|政治/.test(t)) return ['政治理论', '新思想'];

  return null;
}

const pdb = new DatabaseSync(path.join(ROOT, 'practice.db'), { timeout: 10000 });

const rows = pdb.prepare(`
  SELECT question_id, category, sub FROM question_categories WHERE subject = ?
`).all(SUBJECT);
console.log(`目标：${SUBJECT}  共 ${rows.length} 条分类记录\n`);

const plan = [];
const unmapped = new Map();
for (const r of rows) {
  const n = normalize(r.category, r.sub);
  if (!n) {
    const k = `${r.category}|${r.sub}`;
    unmapped.set(k, (unmapped.get(k) || 0) + 1);
    continue;
  }
  if (n[0] === r.category && n[1] === r.sub) continue;   // 已经规范
  plan.push({ id: r.question_id, from: `${r.category}|${r.sub}`, to: `${n[0]}|${n[1]}` });
}

console.log(`需要更新：${plan.length} 条`);
const byTarget = {};
for (const p of plan) byTarget[p.to] = (byTarget[p.to] || 0) + 1;
console.log('归一化目标分布：');
for (const [k, v] of Object.entries(byTarget).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${v}`);

if (unmapped.size) {
  const total = [...unmapped.values()].reduce((a, b) => a + b, 0);
  console.log(`\n无法映射 ${total} 条（${unmapped.size} 种）：`);
  for (const [k, v] of [...unmapped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${k.padEnd(30)} ${v}`);
}

// 归一化后的模块题量预估（去重）
console.log('\n归一化后各模块题量（预估，去重）：');
const after = new Map();
for (const r of pdb.prepare(`
  SELECT question_id, category, sub FROM question_categories WHERE subject = ?
`).all(SUBJECT)) {
  const n = normalize(r.category, r.sub) || [r.category, r.sub];
  const k = `${n[0]}|${n[1]}`;
  if (!after.has(k)) after.set(k, new Set());
  after.get(k).add(r.question_id);
}
const byGroup = {};
for (const [k, set] of after) {
  const g = k.split('|')[0];
  byGroup[g] = (byGroup[g] || 0) + set.size;
}
for (const [g, n] of Object.entries(byGroup).sort((a, b) => b[1] - a[1])) console.log(`  ${g.padEnd(16)} ${n}`);
console.log(`  合计 ${Object.values(byGroup).reduce((a, b) => a + b, 0)}`);

if (!APPLY) { console.log('\n[dry-run] 未写入。确认后加 --apply。'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
fs.copyFileSync(path.join(ROOT, 'practice.db'), path.join(ROOT, `practice.db.bak-cat-${stamp}`));
const upd = pdb.prepare('UPDATE question_categories SET category = ?, sub = ? WHERE question_id = ? AND subject = ?');
pdb.exec('BEGIN');
let n = 0;
try {
  for (const p of plan) {
    const [c, s] = p.to.split('|');
    n += upd.run(c, s, p.id, SUBJECT).changes;
  }
  pdb.exec('COMMIT');
} catch (e) { pdb.exec('ROLLBACK'); console.error('失败：', e.message); process.exit(1); }
console.log(`\n✓ 更新 ${n} 条`);
pdb.close();
