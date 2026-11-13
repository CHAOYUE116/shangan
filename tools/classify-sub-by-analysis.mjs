#!/usr/bin/env node
/**
 * 用「解析文本」给判断推理里没二级的题定二级（不新增分类，全部取自粉笔题型树）。
 *
 * 背景：扫 id 入库的 5.3 万道题没写 question_keypoints（脚本 bug），粉笔侧又已下架，
 * 考点补不回来。但这批题的解析是完整的、而且粉笔解析的写法极有规律：
 *   定义判断 → 「第一步：判断题干中的关键词」「定义要点」
 *   逻辑判断 → 「削弱」「加强」「前提」「由此可以推出」
 *   图形推理 → 「图形」「折叠」「截面」「对称轴」「封闭区域」
 *   类比推理 → 「词项」「近义/反义」「种属」「组成关系」
 *   事件排序 → 「先后顺序」「时间顺序」
 * 于是按解析措辞判，优先级从强到弱，命中即停。
 *
 * 用法：node tools/classify-sub-by-analysis.mjs [--dry|--apply] [--show 0]
 */
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (k, d = "") => { const i = argv.indexOf("--" + k); return i >= 0 ? (argv[i + 1] || "true") : d; };
const APPLY = argv.includes("--apply");
const SHOW = Number(arg("show", "0"));
const DB = path.resolve(arg("db", path.join(ROOT, "app-assets", "tiku_app.db")));

/** 优先级从强到弱：图形/定义/逻辑/事件 的信号都很专一，类比最泛（放最后） */
const RULES = [
  ["图形推理", /图形推理|所给图形|九宫格|折叠|截面|对称轴|封闭区域|一笔画|立体图形|展开图|图形规律|黑白|阴影部分|线条数|交点数|样式规律|位置规律|数量规律/],
  ["定义判断", /定义要点|定义的关键|题干中的关键词|不符合定义|符合定义|被定义项|定义项|根据上述定义|下列.{0,6}属于|下列.{0,6}不属于/],
  ["事件排序", /先后顺序|时间顺序|逻辑顺序|正确排序|排列顺序/],
  ["逻辑判断", /削弱|加强|前提|假设|可以推出|无法推出|不能推出|矛盾|真假话|三段论|充分条件|必要条件|论点|论据|论证|翻译题干|抓住题干主要信息|抓住题干关键信息|推理方式|日常结论|组合排列|代入法|分析题干|不等式/],
  ["类比推理", /词项|近义关系|反义关系|种属关系|组成关系|并列关系|对应关系|语法关系|造句|逻辑关系最为贴近|最为相似/],
];

/** 题干特别短、又没有论证类措辞的，基本就是类比推理（「A：B」这种） */
const looksLikeAnalogy = (stem) => {
  const s = String(stem || "").replace(/<[^>]+>/g, "").replace(/\s+/g, "");
  if (!s) return false;
  if (s.length > 45) return false;
  return !/根据|下列|如果|由此|以下|最能|上述|推出/.test(s);
};

const db = new DatabaseSync(DB, { readOnly: !APPLY });
db.exec("PRAGMA busy_timeout = 15000");

const base = `(SELECT q.* FROM questions q JOIN (SELECT questionId, MAX(id) mid FROM questions GROUP BY questionId) t ON t.mid=q.id)`;
const rows = db.prepare(`
  SELECT q.questionId AS qid, q.chapter AS ch, q.analysis AS a, q.content AS c, q.options AS o
  FROM ${base} q
  WHERE q.chapter IN ('判断推理','判断推理能力','逻辑推理','图形推理')
    AND NOT EXISTS (
      SELECT 1 FROM question_categories c2
      WHERE c2.question_id = q.questionId AND COALESCE(TRIM(c2.sub),'') <> ''
    )
`).all();

const text = (r) => String(r.a || "").replace(/<[^>]+>/g, " ") + " " + String(r.c || "").replace(/<[^>]+>/g, " ");

const hit = new Map();
const counts = new Map();
const none = [];
for (const r of rows) {
  const t = text(r);
  let sub = "";
  for (const [name, re] of RULES) { if (re.test(t)) { sub = name; break; } }
  if (!sub) {
    // 兜底：极短题干（「A：B」）且没有论证措辞 → 类比推理；剩下的留给人工
    if (looksLikeAnalogy(r.c)) sub = "类比推理";
  }
  if (!sub) { none.push(r); continue; }
  hit.set(r.qid, sub);
  counts.set(sub, (counts.get(sub) || 0) + 1);
}

console.log(`候选（判断推理里没二级的题）：${rows.length}`);
for (const [name] of RULES) console.log(`  ${name}: ${counts.get(name) || 0}`);
console.log(`  仍判不出: ${none.length}`);
if (SHOW > 0) {
  for (const r of none.slice(0, SHOW)) {
    console.log(`  ? ${r.qid} | ${String(r.a || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").slice(0, 90)}`);
  }
}

if (!APPLY) {
  console.log("\n[dry] 加 --apply 才会写库");
  process.exit(0);
}

const upd = db.prepare(`
  UPDATE question_categories SET sub = ?
  WHERE question_id = ? AND COALESCE(TRIM(sub),'') = ''
`);
let changed = 0;
db.exec("BEGIN");
try {
  for (const [qid, sub] of hit) { const r = upd.run(sub, qid); changed += Number(r.changes || 0); }
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); throw e; }
console.log(`写入 ${changed} 行（${hit.size} 道题）`);

const left = db.prepare(`
  SELECT COUNT(*) n FROM ${base} q
  WHERE q.chapter IN ('判断推理','判断推理能力','逻辑推理','图形推理')
    AND NOT EXISTS (SELECT 1 FROM question_categories c2 WHERE c2.question_id=q.questionId AND COALESCE(TRIM(c2.sub),'')<>'')
`).get();
console.log(`判断推理仍无二级：${left.n}`);
fs.writeFileSync(path.join(ROOT, "report", "sub-by-analysis.json"), JSON.stringify({ appliedAt: new Date().toISOString(), rows: rows.length, counts: Object.fromEntries(counts), unmatched: none.length, changed }, null, 1));
