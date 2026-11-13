import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const APPLY = process.argv.includes("--apply");
const db = new DatabaseSync("app-assets/tiku_app.db");
db.exec("PRAGMA busy_timeout = 30000");
const qids = db.prepare(`SELECT DISTINCT questionId qid FROM questions WHERE q_bad_reason LIKE '选项图丢失%'`).all().map(r => r.qid);
console.log("R8 题数：", qids.length);
const dump = [];
for (const qid of qids) {
  const rows = db.prepare("SELECT * FROM questions WHERE questionId = ?").all(qid);
  dump.push({ questionId: qid, rows });
}
if (!APPLY) { console.log("dry-run（加 --apply 执行删除）"); process.exit(0); }
fs.writeFileSync("report/quarantine-r8.json", JSON.stringify(dump));
console.log("备份已写 report/quarantine-r8.json", (fs.statSync("report/quarantine-r8.json").size / 1048576).toFixed(1), "MB");
const del = (t) => db.prepare(`DELETE FROM ${t} WHERE questionId = ?`);
db.exec("BEGIN");
try {
  let n = 0, k = 0, c = 0, m = 0;
  for (const qid of qids) {
    n += db.prepare("DELETE FROM questions WHERE questionId = ?").run(qid).changes;
    k += db.prepare("DELETE FROM question_keypoints WHERE questionId = ?").run(qid).changes;
    k += db.prepare("DELETE FROM question_keypoints_ext WHERE questionId = ?").run(qid).changes;
    c += db.prepare("DELETE FROM question_categories WHERE question_id = ?").run(qid).changes;
    m += db.prepare("DELETE FROM q_material_map WHERE question_id = ?").run(qid).changes;
  }
  db.exec("COMMIT");
  console.log(JSON.stringify({ 删除题行: n, 考点行: k, 分类行: c, 材料映射: m }));
} catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
console.log("integrity", db.prepare("PRAGMA integrity_check").get());
