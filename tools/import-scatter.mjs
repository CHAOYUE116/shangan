// 把 crawl-scatter 的 JSONL 导入库（去重 + 章节归位 + 考点表）
//   node tools/import-scatter.mjs --file report/scatter/syzc-xxx.jsonl [--apply]
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { textOf, fingerprint, latexKeys } from "./lib/rich.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const APPLY = args.includes("--apply");
const DB = arg("db", path.join(ROOT, "app-assets", "tiku_app.db"));
const FILES = args.includes("--file") ? [arg("file")] : fs.readdirSync(path.join(ROOT, "report", "scatter")).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(ROOT, "report", "scatter", f));

const PAPER_OF = { syzc: { id: 8996343, name: "考点散题（粉笔考点 · 职测）", subject: "syzc", subjectName: "事业编·职测" },
  sydw: { id: 8996344, name: "考点散题（粉笔考点 · 公基）", subject: "sydw", subjectName: "事业编·公基" },
  xingce: { id: 8996345, name: "考点散题（粉笔考点 · 行测）", subject: "xingce", subjectName: "公务员·行测" } };

const db = new DatabaseSync(DB);
const seenQid = new Set();
const seenFp = new Set();
for (const r of db.prepare("SELECT questionId, content FROM questions").iterate()) {
  seenQid.add(r.questionId);
  const f = fingerprint(r.content);
  if (f) seenFp.add(f);
}
let nextId = db.prepare("SELECT MAX(id) m FROM questions").get().m + 1;

const insQ = db.prepare(`INSERT INTO questions
 (id, questionId, paperId, chapter, type, questionType, content, contentHtml, material, options, optionType, answer, answerIndex,
  difficulty, source, analysis, analysisHtml, hasVideo, q_bad, q_bad_reason)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insKp = db.prepare("INSERT OR IGNORE INTO question_keypoints (questionId, kpName) VALUES (?,?)");
const insCat = db.prepare("INSERT OR REPLACE INTO question_categories (question_id, subject, category, sub) VALUES (?,?,?,?)");
const insPaper = db.prepare("INSERT OR IGNORE INTO papers (id, subject, subjectName, category, name, questionCount, time) VALUES (?,?,?,?,?,?,?)");

const stat = { files: FILES.length, read: 0, added: 0, dupQid: 0, dupFp: 0, noChapter: 0, kpRows: 0 };
db.exec("BEGIN");
for (const f of FILES) {
  if (!fs.existsSync(f)) continue;
  const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  for (const ln of lines) {
    let it; try { it = JSON.parse(ln); } catch { continue; }
    stat.read++;
    if (!it.qid || seenQid.has(it.qid)) { stat.dupQid++; continue; }
    const fp = fingerprint(it.contentHtml);
    if (fp && seenFp.has(fp)) { stat.dupFp++; continue; }
    const course = it.course || "syzc";
    const paper = PAPER_OF[course];
    if (!paper) continue;
    const chapter = it.chapter || "未分类";
    if (!it.chapter) stat.noChapter++;
    const badFlag = (it.flags || []).find((x) => /^缺图键/.test(x)) ? "图片键缺失" : (it.flags || []).includes("缺图") ? "图丢了" : null;
    const opts = JSON.stringify(it.options || []);
    insQ.run(nextId, it.qid, paper.id, chapter, it.type || 1, null, textOf(it.contentHtml), it.contentHtml || "",
      it.material || "", opts, 0, it.answer || "", it.answerIndex == null ? -1 : it.answerIndex,
      5, "fenbi-scatter", textOf(it.analysisHtml), it.analysisHtml || "", 0,
      badFlag ? 1 : 0, badFlag);
    nextId++;
    seenQid.add(it.qid); if (fp) seenFp.add(fp);
    for (const k of it.kpNames || []) { insKp.run(it.qid, k); stat.kpRows++; }
    insCat.run(it.qid, paper.subject, chapter, "");
    stat.added++;
  }
}
const papers = [...new Set(FILES.filter((f) => fs.existsSync(f)).flatMap((f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l).course || "syzc"; } catch { return null; } }).filter(Boolean)))];
for (const c of papers) { const p = PAPER_OF[c]; if (p) insPaper.run(p.id, p.subject, p.subjectName, "考点散题", p.name, 0, ""); }
db.exec(APPLY ? "COMMIT" : "ROLLBACK");

const n = db.prepare("SELECT COUNT(*) n, COUNT(DISTINCT questionId) u FROM questions").get();
console.log(`${APPLY ? "已写库" : "dry-run"}：读 ${stat.read} · 新增 ${stat.added} · 已有题号 ${stat.dupQid} · 内容重复 ${stat.dupFp} · 无章节 ${stat.noChapter} · 考点行 ${stat.kpRows}`);
console.log(`全库现在 ${n.u} 道（${n.n} 行）`);
if (!APPLY) console.log("（dry-run 未写库，加 --apply 落地）");
db.close();
