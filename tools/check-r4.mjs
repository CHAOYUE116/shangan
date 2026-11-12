import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const DAY = new Date().toISOString().slice(0, 10);
const COOKIE = fs.readFileSync("cookie.txt", "utf8").trim();
const H = {
  cookie: COOKIE,
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0",
  accept: "application/json",
  referer: "https://www.fenbi.com/spa/tiku",
};
const V = "app=web&kav=100&av=100&hav=100&version=3.0.0.0";
const APPLY = process.argv.includes("--apply");

const db = new DatabaseSync("app-assets/tiku_app.db");
db.exec("PRAGMA busy_timeout = 30000");

const rows = db
  .prepare(
    `SELECT q.questionId qid, q.type, q.answer, q.answerIndex, q.options, q.analysis,
            p.subjectName AS subject, q.chapter, q.q_bad_reason
     FROM questions q JOIN papers p ON p.id = q.paperId
     WHERE q.q_bad = 1 AND q.q_bad_reason LIKE '%不符%'
       AND q.id IN (SELECT MAX(id) FROM questions GROUP BY questionId)`,
  )
  .all();

const courseOf = (s) =>
  s.includes("行测") ? "xingce" : s.includes("公基") ? "sydw" : s.includes("职测") ? "syzc" : s.includes("综应") ? "zhyynl" : "zhyynl";

const LETTERS = "ABCDEFGH";
function mineOf(r) {
  const a = String(r.answer || "").trim();
  if (String(r.type) === "3") return [a === "A" ? "对" : "错"];
  if (/^\d/.test(a) || a.includes(",")) return a.split(",").filter(Boolean).map((i) => LETTERS[Number(i)]).sort();
  return a.replace(/[,，\s]/g, "").split("").sort();
}
function theirsOf(e) {
  const ca = e?.correctAnswer;
  if (!ca) return null;
  const ch = String(ca.choice ?? "");
  if (/^\d$/.test(ch)) return [LETTERS[Number(ch)]];
  if (/^\d(,\d)+$/.test(ch)) return ch.split(",").map((i) => LETTERS[Number(i)]).sort();
  if (ca.type === 201 || /^[A-H]$/i.test(ch)) {
    if (String(ch).length > 1 && /[A-H]{2,}/i.test(ch)) return ch.toUpperCase().split("").sort();
    return [ch.toUpperCase()];
  }
  if (/^[\d,]+$/.test(ch)) return ch.split(",").filter(Boolean).map((i) => LETTERS[Number(i)]).sort();
  return null;
}

const stat = { total: rows.length, agreeUs: 0, agreeAnalysis: 0, unknown: 0, fixed: 0, cleared: 0, samples: [] };
const updAnswer = APPLY
  ? db.prepare(`UPDATE questions SET answer = ?, answerIndex = ? WHERE questionId = ?`)
  : null;
const clearBad = APPLY
  ? db.prepare(`UPDATE questions SET q_bad = 0, q_bad_reason = NULL WHERE questionId = ?`)
  : null;
const noteBad = APPLY
  ? db.prepare(`UPDATE questions SET q_bad = 0, q_bad_reason = ? WHERE questionId = ?`)
  : null;

for (const r of rows) {
  const cs = courseOf(String(r.subject || ""));
  let arr = [];
  try {
    const res = await fetch(`https://tiku.fenbi.com/api/${cs}/solutions?ids=${r.qid}&${V}`, {
      headers: H,
      signal: AbortSignal.timeout(15000),
    });
    arr = (await res.json()).filter(Boolean);
  } catch {}
  const e = arr[0];
  const said = [];
  for (const m of String(r.analysis || "").matchAll(/(?:正确答案|答案|正确选项)(?:是|为|应选|选)\s*[:：]?\s*([A-H](?:\s*[、,，和及]\s*[A-H])*)|(?:故选|应选|答案选|本题选)\s*[:：]?\s*([A-H](?:\s*[、,，和及]\s*[A-H])*)/g)) {
    const seg = m[1] || m[2] || "";
    for (const ch of seg.match(/[A-H]/g) || []) if (!said.includes(ch)) said.push(ch);
  }
  said.sort();
  const mine = mineOf(r);
  const theirs = theirsOf(e);
  if (!theirs) {
    stat.unknown++;
    if (stat.samples.length < 6) stat.samples.push({ qid: r.qid, verdict: "粉笔无答案", said: said.join(""), mine: mine.join(""), their: "" });
    continue;
  }
  const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (eq(theirs, mine)) {
    // 我们的答案和粉笔一致 → 是解析写错了，不算坏题
    stat.agreeUs++;
    if (APPLY) noteBad.run(`解析与答案不符（答案已与粉笔核对一致：${mine.join("")}）`, r.qid);
    else stat.cleared++;
  } else if (eq(theirs, said)) {
    // 解析和粉笔一致、我们错了 → 改答案
    stat.agreeAnalysis++;
    if (APPLY) {
      const t = String(r.type);
      if (t === "3") updAnswer.run(theirs[0] === "对" ? "A" : "B", -1, r.qid);
      else if (t === "2" || t === "5") updAnswer.run(theirs.map((L) => LETTERS.indexOf(L)).join(","), -1, r.qid);
      else updAnswer.run(theirs[0], LETTERS.indexOf(theirs[0]), r.qid);
      clearBad.run(r.qid);
      stat.fixed++;
    }
  } else {
    stat.unknown++;
  }
  if (stat.samples.length < 8)
    stat.samples.push({ qid: r.qid, subject: r.subject, said: said.join("") || "-", mine: mine.join(""), their: theirs.join("") });
  await new Promise((res) => setTimeout(res, 1200));
}

db.close();
fs.writeFileSync(`report/r4-check-${DAY}.json`, JSON.stringify(stat, null, 2));
console.log(JSON.stringify({ ...stat, samples: stat.samples }, null, 2));
