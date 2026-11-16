#!/usr/bin/env node
/**
 * 给「未分类」的题补分类（chapter + question_categories.category）。
 * 顺序：qc.category 已有真分类 → 考点名 → 题干/解析关键词 → 卷名科目修正。
 * 用法: node tools/classify-uncategorized.mjs [--apply]
 */
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const APPLY = process.argv.includes("--apply");
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const db = new DatabaseSync(join(ROOT, "app-assets", "tiku_app.db"));
const dbv = new DatabaseSync(join(ROOT, "app-assets", "tiku_app.db"), { readOnly: true });

const MODS = ["言语理解与表达", "判断推理", "数量关系", "资料分析", "常识判断", "政治理论"];

// 考点名 → 模块
const KP2MOD = [
  [/资料|统计表|统计图|文字资料|综合资料|增长率|增长量|比重|平均数|倍数|基期|现期|拉动/, "资料分析"],
  [/对应关系|固定搭配|成语|实词|混搭|词义|片段|语句|逻辑填空|中心理解|细节|标题|排序|衔接|病句|歧义/, "言语理解与表达"],
  [/图形|定义|类比|削弱|加强|前提|推出|翻译|矛盾|真假|分析推理|归纳|论证|复言|朴素|集合|排列组合题/, "判断推理"],
  [/和差倍比|工程|行程|浓度|概率|利润|利息|年龄|容斥|抽屉|最值|计算问题|数列|数字推理|周期|植树|方阵|牛吃草|时钟|日期/, "数量关系"],
  [/习近平|二十大|全会|政治|党史|新思想|重要文件|时政|马哲|马克思主义|中国特色社会主义/, "政治理论"],
  [/法律|宪法|民法|刑法|行政|法理|劳动|公文|经济|科技|人文|地理|国情|常识|管理|公文写作/, "常识判断"],
];

// 卷名 → 科目（只补 subject，不改模块）
const PAPER_SUBJECT = [
  [/综合基础知识|公共基础知识|基本能力测试|公共知识/, "事业编·公基"],
  [/职业能力倾向|职测/, "事业编·职测"],
  [/行政职业能力|行测/, "公务员·行测"],
];

// 题干/解析关键词 → 模块（顺序敏感 + 强信号，宁可漏判也不误判）
const KW = [
  [/(依次填入|填入划横线|横线处最恰当|横线部分最恰当|这段文字|文段|作者意在|意在说明|主旨|最适合做.*标题|语序正确|病句|成语使用|词语使用)/, "言语理解与表达"],
  [/(最能削弱|最能加强|以下哪项如果为真|类比推理|图形推理|折叠|截面|关于.*定义|定义判断)/, "判断推理"],
  [/(工程队|溶液|盐水|浓度|利润率|相遇|追及|牛吃草|排列组合|等差数列|植树|方阵)/, "数量关系"],
  [/(习近平|总书记|全会|二十大)/, "政治理论"],
  [/(根据《|民法典|刑法|宪法|行政处罚法|公文|请示|通知|函|通货膨胀|财政政策|光学|化学|生物学|地理|历史|文学常识)/, "常识判断"],
];

const qcCat = new Map();
for (const r of dbv.prepare(`SELECT question_id id, MAX(category) c FROM question_categories WHERE COALESCE(category,'')<>'' GROUP BY question_id`).all()) qcCat.set(r.id, r.c);
const kpMap = new Map();
for (const r of dbv.prepare(`SELECT questionId id, GROUP_CONCAT(kpName,'|') k FROM question_keypoints GROUP BY questionId`).all()) kpMap.set(r.id, String(r.k || ""));

const rows = dbv
  .prepare(
    `SELECT questionId id, MAX(id) rid, MAX(COALESCE(source,'')) src, MAX(COALESCE(type,0)) type,
            MAX(COALESCE(content,'')) content, MAX(COALESCE(contentHtml,'')) html,
            MAX(COALESCE(analysis,'')) ana, MAX(COALESCE(paperId,0)) pid
       FROM questions WHERE chapter='未分类' GROUP BY questionId`,
  )
  .all();
const paperName = new Map();
for (const p of dbv.prepare(`SELECT id, name FROM papers`).all()) paperName.set(p.id, String(p.name || ""));

const stat = { qc: 0, kp: 0, kw: 0, none: 0, byMod: {} };
const todo = [];
for (const r of rows) {
  let mod = null;
  let why = "";
  const c = qcCat.get(r.id);
  if (c && MODS.includes(c)) {
    mod = c;
    why = "qc";
  }
  if (!mod) {
    const kp = kpMap.get(r.id) || "";
    for (const [re, m] of KP2MOD) if (re.test(kp)) { mod = m; why = "kp"; break; }
  }
  if (!mod) {
    const txt = String(r.content || r.html || "").replace(/<[^>]+>/g, " ") + " " + String(r.ana || "");
    const nums = (txt.match(/\d+(?:\.\d+)?%?/g) || []).length;
    if (/(同比|环比|比重|占比|百分点)/.test(txt) && nums >= 4 && /(年|月|季度|材料|资料|表中|图中)/.test(txt)) { mod = "资料分析"; why = "kw"; }
    if (!mod) for (const [re, m] of KW) if (re.test(txt)) { mod = m; why = "kw"; break; }
  }
  if (!mod) { stat.none++; continue; }
  stat[why] = (stat[why] || 0) + 1;
  stat.byMod[mod] = (stat.byMod[mod] || 0) + 1;
  const pname = paperName.get(r.pid) || "";
  let subject = null;
  for (const [re, s] of PAPER_SUBJECT) if (re.test(pname)) { subject = s; break; }
  todo.push({ id: r.id, mod, subject });
}

console.log(`未分类 ${rows.length} 道 → 可归类 ${todo.length}（qc ${stat.qc} / kp ${stat.kp} / kw ${stat.kw}），仍不确定 ${stat.none}`);
console.log("按模块:", JSON.stringify(stat.byMod));
console.log("按科目:", JSON.stringify(todo.reduce((a, t) => ((a[t.subject || "(不定)"] = (a[t.subject || "(不定)"] || 0) + 1), a), {})));

if (!APPLY) {
  console.log("\n（dry-run，加 --apply 才会写库）");
} else {
  const updQ = db.prepare(`UPDATE questions SET chapter=? WHERE questionId=?`);
  const updC = db.prepare(`UPDATE question_categories SET category=? WHERE question_id=?`);
  const updP = db.prepare(`UPDATE papers SET subject=?, subjectName=? WHERE id IN (SELECT paperId FROM questions WHERE questionId=?) AND ? IS NOT NULL`);
  db.exec("BEGIN");
  try {
    for (const t of todo) {
      updQ.run(t.mod, t.id);
      updC.run(t.mod, t.id);
      if (t.subject) updP.run(t.subject, t.subject, t.id, t.subject);
    }
    db.exec("COMMIT");
    console.log(`✓ 已写库 ${todo.length} 道`);
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("失败已回滚:", e.message);
    process.exit(1);
  }
  console.log("integrity:", db.prepare("PRAGMA integrity_check").get().integrity_check);
}
