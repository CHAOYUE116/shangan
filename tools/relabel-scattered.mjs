// 把「考点散题」虚拟卷里的题按「题目自带考点」重新归位章节
//   - 只改 chapter / question_categories.category，不动题目本身
//   - dry-run 默认，--apply 写库
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const APPLY = args.includes("--apply");
const DB = arg("db", path.join(ROOT, "app-assets", "tiku_app.db"));
const PAPER = Number(arg("paper", "8996343"));

// 考点名 → 模块（parent 的首段）
const leaves = JSON.parse(fs.readFileSync(path.join(ROOT, "report", "kp-leaves.json"), "utf8")).leaves || [];
const byName = new Map();
for (const l of leaves) {
  const mod = String(l.parent || "").split("/").filter(Boolean)[0] || "";
  if (!mod || !l.name) continue;
  if (!byName.has(l.name)) byName.set(l.name, new Map());
  const m = byName.get(l.name);
  m.set(mod, (m.get(mod) || 0) + 1);
}
const MODS = ["政治理论", "常识判断", "言语理解与表达", "数量关系", "判断推理", "资料分析"];
const resolve = (name) => {
  const m = byName.get(name);
  if (!m) return null;
  const cand = [...m.entries()].sort((a, b) => b[1] - a[1]);
  if (cand.length === 1) return cand[0][0];
  // 多模块同名：只接受首段就是我们认识的 6 个模块之一，且不与其它模块并列
  if (cand[0][1] > (cand[1]?.[1] || 0)) return cand[0][0];
  return null;
};

const db = new DatabaseSync(DB);
const rows = db.prepare(
  `SELECT q.questionId, q.chapter,
          (SELECT GROUP_CONCAT(kpName, '|') FROM question_keypoints WHERE questionId = q.questionId) kps
     FROM questions q WHERE q.paperId = ?`
).all(PAPER);
console.log(`散题 ${rows.length} 道（虚拟卷 ${PAPER}）`);

const plan = [];
let noKp = 0, unresolved = 0, same = 0;
for (const r of rows) {
  const kps = (r.kps || "").split("|").filter(Boolean);
  if (!kps.length) { noKp++; continue; }
  let target = null;
  for (const k of kps) { const m = resolve(k); if (m) { target = m; break; } }
  if (!target) { unresolved++; continue; }
  if (target === r.chapter) { same++; continue; }
  plan.push({ questionId: r.questionId, from: r.chapter, to: target, kp: kps[0] });
}
const dist = new Map();
for (const p of plan) { const k = `${p.from || "(空)"} → ${p.to}`; dist.set(k, (dist.get(k) || 0) + 1); }
console.log(`可归位 ${plan.length} 道 · 本来就对 ${same} · 无考点 ${noKp} · 考点认不出 ${unresolved}`);
console.log("迁移方向 top：");
[...dist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([k, n]) => console.log(`  ${k}: ${n}`));

if (APPLY) {
  const upd = db.prepare("UPDATE questions SET chapter = ? WHERE questionId = ? AND paperId = ?");
  const updCat = db.prepare("UPDATE question_categories SET category = ? WHERE question_id = ?");
  db.exec("BEGIN");
  let n = 0;
  for (const p of plan) { upd.run(p.to, p.questionId, PAPER); updCat.run(p.to, p.questionId); n++; }
  db.exec("COMMIT");
  console.log(`已写库 ${n} 道`);
  const chk = db.prepare("SELECT chapter, COUNT(*) n FROM questions WHERE paperId = ? GROUP BY chapter ORDER BY n DESC").all(PAPER);
  console.log("归位后章节分布：" + chk.map((x) => `${x.chapter || "(空)"}:${x.n}`).join(" · "));
}
db.close();
