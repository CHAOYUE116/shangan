import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const DAY = new Date().toISOString().slice(0, 10);
const COOKIE = fs.readFileSync("cookie.txt", "utf8").trim();
const H = { cookie: COOKIE, "user-agent": "Mozilla/5.0 Chrome/131.0", accept: "application/json" };
const V = "app=web&kav=100&av=100&hav=100&version=3.0.0.0";
const APPLY = process.argv.includes("--apply");
const LETTERS = "ABCDEFGH";

const db = new DatabaseSync("app-assets/tiku_app.db");
db.exec("PRAGMA busy_timeout = 30000");

const rows = db
  .prepare(
    `SELECT q.questionId qid, q.type, q.answer, q.analysis, q.analysisHtml, p.subjectName AS subject
     FROM questions q JOIN papers p ON p.id = q.paperId
     WHERE q.q_bad = 1 AND q.q_bad_reason LIKE '%不符%'
       AND q.id IN (SELECT MAX(id) FROM questions GROUP BY questionId)`,
  )
  .all();

const courseOf = (s) =>
  s.includes("行测") ? "xingce" : s.includes("公基") ? "sydw" : s.includes("职测") ? "syzc" : "zhyynl";
const textOf = (h) =>
  String(h || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const normLinks = (h) =>
  String(h || "")
    .replace(/\/\/fb\.fbstatic\.cn\/api\/planet\/accessories\/formulas\?latex=([A-Za-z0-9_-]+)(\?[^"'\s>]*)?/g,
      "https://fb.fenbike.cn/api/planet/accessories/formulas?latex=$1")
    .replace(/https?:\/\/fb\.fbstatic\.cn\/api\/planet\/accessories\/formulas\?latex=([A-Za-z0-9_-]+)(\?[^"'\s>]*)?/g,
      "https://fb.fenbike.cn/api/planet/accessories/formulas?latex=$1");
const sig = (t) => String(t || "").replace(/[\s\p{P}]/gu, "").slice(0, 80);

const stat = { total: rows.length, replaced: 0, same: 0, empty: 0, samples: [] };
const updAnalysis = APPLY
  ? db.prepare(`UPDATE questions SET analysis = ?, analysisHtml = ?, q_bad = 0, q_bad_reason = NULL WHERE questionId = ?`)
  : null;

for (const r of rows) {
  const cs = courseOf(String(r.subject || ""));
  let e = null;
  try {
    const res = await fetch(`https://tiku.fenbi.com/api/${cs}/solutions?ids=${r.qid}&${V}`, {
      headers: H,
      signal: AbortSignal.timeout(15000),
    });
    e = (await res.json()).filter(Boolean)[0];
  } catch {}
  const solHtml = normLinks(String(e?.solution || ""));
  const solText = textOf(solHtml);
  if (!solText) {
    stat.empty++;
    continue;
  }
  if (sig(solText) === sig(r.analysis)) {
    stat.same++;
    continue;
  }
  stat.replaced++;
  if (stat.samples.length < 5)
    stat.samples.push({ qid: r.qid, old: String(r.analysis || "").slice(0, 60), next: solText.slice(0, 60) });
  if (APPLY) updAnalysis.run(solText, solHtml, r.qid);
  await new Promise((x) => setTimeout(x, 1200));
}

db.close();
fs.writeFileSync(`report/r4-analysis-${DAY}.json`, JSON.stringify(stat, null, 2));
console.log(JSON.stringify(stat, null, 2));
