// 修正 id 扫描导入（source='fenbi-sweep'）的章节与科目：
// 用粉笔考点树把「考点名 / 二级分类名」映射回一级模块，再写回 questions.chapter 与 papers 科目。
// 默认 dry-run，--apply 才写库。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const arg = (k, d) => {
  const i = process.argv.indexOf("--" + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes("--" + k);

const APPLY = has("apply");
const DB = path.resolve(ROOT, arg("db", "app-assets/tiku_app.db"));
const RAW = path.resolve(ROOT, arg("raw", "report/categories-raw.json"));

// 粉笔公基（sydw）一级模块 → 我们库里用的公基章节名
const SYDW_MAP = {
  时事政治: "政治理论",
  政治: "政治理论",
  经济: "经济常识",
  管理: "综合常识",
  公文: "公文写作",
  法律: "法律常识",
  人文历史: "人文常识",
  科技地理: "科技常识",
  其他: "综合常识",
};
const GONGJI = new Set(["政治理论", "法律常识", "经济常识", "科技常识", "人文常识", "地理国情", "公文写作", "综合常识"]);

const raw = JSON.parse(fs.readFileSync(RAW, "utf8"));
const nameToMod = new Map();
function walk(node, mod) {
  if (!node || !node.name) return;
  if (!nameToMod.has(node.name)) nameToMod.set(node.name, mod);
  for (const k of node.children || []) walk(k, mod);
}
for (const course of Object.keys(raw)) {
  const tops = (raw[course] && raw[course].baseKeypointVOS) || [];
  for (const top of tops) {
    let mod = String(top.name || "").trim();
    if (course === "sydw") mod = SYDW_MAP[mod] || "综合常识";
    if (!nameToMod.has(mod)) nameToMod.set(mod, mod);
    walk(top, mod);
  }
}
console.log("映射表", nameToMod.size, "条");

const db = new DatabaseSync(DB, APPLY ? {} : { readOnly: true });
if (APPLY) db.exec("PRAGMA busy_timeout = 30000");
if (APPLY) db.exec("PRAGMA synchronous = NORMAL");

const rows = db
  .prepare("SELECT id, questionId, chapter, paperId, fenbi_src FROM questions WHERE source='fenbi-sweep'")
  .all();
const kpStmt = db.prepare("SELECT kpName FROM question_keypoints WHERE questionId = ?");
const updCh = APPLY ? db.prepare("UPDATE questions SET chapter = ? WHERE id = ?") : null;
const updSub = APPLY ? db.prepare("UPDATE papers SET subject = ?, subjectName = ? WHERE id = ?") : null;
const paperSub = db.prepare("SELECT subject FROM papers WHERE id = ?");

const stat = { total: rows.length, changedCh: 0, sameCh: 0, unknown: 0, chToGj: 0 };
const byFrom = new Map();
const paperFix = new Map();
const VALID = new Set(["政治理论", "常识判断", "言语理解与表达", "数量关系", "判断推理", "资料分析", ...GONGJI]);

if (APPLY) db.exec("BEGIN");
try {
  for (const r of rows) {
    const kps = kpStmt.all(r.questionId).map((x) => x.kpName);
    let mod = "";
    for (const name of kps) {
      const m = nameToMod.get(name);
      if (m) { mod = m; break; }
    }
    if (!mod && VALID.has(String(r.chapter || ""))) mod = String(r.chapter);
    if (!mod) {
      // 章节名本身可能是二级分类名
      mod = nameToMod.get(String(r.chapter || "")) || "";
    }
    if (!mod) { stat.unknown++; continue; }
    const from = String(r.chapter || "");
    if (from === mod) stat.sameCh++;
    else {
      stat.changedCh++;
      const key = from + " → " + mod;
      byFrom.set(key, (byFrom.get(key) || 0) + 1);
      if (APPLY) updCh.run(mod, r.id);
    }
    // 科目：只有公基专属章节（政治理论两边都有，不动）才归到事业编·公基
    const GJ_ONLY = new Set(["法律常识", "经济常识", "科技常识", "人文常识", "地理国情", "公文写作", "综合常识"]);
    let wantSub = null;
    if (GJ_ONLY.has(mod)) wantSub = "事业编·公基";
    if (wantSub) {
      const cur = String(paperSub.get(r.paperId)?.subject || "");
      if (cur !== wantSub) {
        stat.chToGj++;
        paperFix.set(r.paperId, wantSub);
      }
    }
  }
  if (APPLY) db.exec("COMMIT");
} catch (e) {
  if (APPLY) db.exec("ROLLBACK");
  throw e;
}
if (APPLY) {
  for (const [pid, subj] of paperFix) updSub.run(subj, subj, pid);
  console.log("题库科目修正的虚拟卷", paperFix.size);
}
db.close();

const top = [...byFrom.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log(JSON.stringify({ ...stat, mode: APPLY ? "apply" : "dry" }, null, 1));
console.log("迁移 top：");
for (const [k, v] of top) console.log("  " + k + "  " + v);
