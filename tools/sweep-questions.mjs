// 扫粉笔 id 空间采集题目：/api/{course}/questions?ids= 是纯 GET、不占「建练习」额度，
// 对命中题再取 /solutions 拿解析、考点、官方正确率。
//
// 用法：
//   node tools/sweep-questions.mjs --from 1 --to 4000000 --batch 200 --conc 6
//   node tools/sweep-questions.mjs --apply --state report/sweep-state.json
//
// 默认 dry-run（只统计），--apply 才写库。
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

const FROM = Number(arg("from", "1"));
const TO = Number(arg("to", "4000000"));
const BATCH = Number(arg("batch", "200"));
const CONC = Number(arg("conc", "6"));
const GAP = Number(arg("gap", "120"));
const MAXREQ = Number(arg("maxreq", "0"));
const APPLY = has("apply");
const DB = path.resolve(ROOT, arg("db", "app-assets/tiku_app.db"));
const STATE = path.resolve(ROOT, arg("state", "report/sweep-state.json"));
const COURSE = arg("course", "syzc");
const DAY = new Date().toISOString().slice(0, 10);

const cookie = fs.readFileSync(path.join(ROOT, "cookie.txt"), "utf8").trim();
const HEADERS = {
  cookie,
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  referer: "https://www.fenbi.com/",
  accept: "application/json, text/plain, */*",
};
const QAPI = "app=web&kav=100&av=100&hav=100&version=3.0.0.0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) }).catch(() => null);
    if (!r) { await sleep(600); continue; }
    if (r.status === 200) {
      const j = await r.json().catch(() => null);
      if (j && (Array.isArray(j) || Array.isArray(j.data))) return Array.isArray(j) ? j : j.data;
      return [];
    }
    if (r.status === 429 || r.status === 403) { await sleep(4000 * (i + 1)); continue; }
    await sleep(500);
  }
  return null;
}

// ---------- 文本工具 ----------
const TEX_HOST = "https://fb.fenbike.cn/api/planet/accessories/formulas?latex=";
function normLinks(html) {
  return String(html || "")
    .replace(/\/\/(?:fb\.)?fbstatic\.cn\/api\/planet\/accessories\/formulas\?latex=([A-Za-z0-9_-]+)[^"'\s>]*/g, TEX_HOST + "$1")
    .replace(/\/\/(?:fb\.)?fbstatic\.cn\/api\/tarzan\/images\/([^"'\s>]+)/g, "https://fb.fenbike.cn/api/tarzan/images/$1");
}
function textOf(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
const MASKED = /\*{3,}/;
function fingerprint(s) {
  return String(s || "").replace(/<[^>]+>/g, "").replace(/[\s\p{P}]/gu, "").slice(0, 120);
}
const LETTERS = "ABCDEFGH";
function answerOf(ca, type, optCount) {
  const raw = ca && ca.choice != null ? String(ca.choice) : "";
  if (!raw) return { answer: "", answerIndex: -1 };
  const parts = raw.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
  const toIdx = (p) => {
    if (/^\d+$/.test(p)) return Number(p);
    const i = LETTERS.indexOf(p.toUpperCase());
    return i >= 0 ? i : -1;
  };
  if (type === 2 || type === 4) {
    const idx = parts.map(toIdx).filter((i) => i >= 0);
    if (!idx.length) return { answer: "", answerIndex: -1 };
    return { answer: idx.join(","), answerIndex: -1 };
  }
  const i = toIdx(parts[0]);
  if (i < 0 || (optCount > 0 && i >= optCount)) return { answer: "", answerIndex: -1 };
  return { answer: LETTERS[i], answerIndex: i };
}

// ---------- 科目 / 章节 ----------
function classify(src) {
  const s = String(src || "");
  if (/公共基础知识|综合基础知识|综合知识/.test(s)) return "事业编·公基";
  if (/申论/.test(s)) return "公务员·申论";
  if (/综合应用能力/.test(s)) return "事业编·综应";
  if (/行政职业能力/.test(s)) return "公务员·行测";
  if (/职业能力倾向|事业单位/.test(s)) return "事业编·职测";
  return "";
}
const SUBJECT_META = {
  "公务员·行测": { paper: 9000001, chapter: "行测" },
  "事业编·职测": { paper: 9000002, chapter: "职测" },
  "事业编·公基": { paper: 9000003, chapter: "公基" },
  "公务员·申论": { paper: 9000004, chapter: "申论" },
  "事业编·综应": { paper: 9000005, chapter: "综应" },
};

// 考点名 → 模块（用 kp-leaves.json 的 parent）
let KP2MOD = new Map();
try {
  const leaves = JSON.parse(fs.readFileSync(path.join(ROOT, "report/kp-leaves.json"), "utf8")).leaves || [];
  const votes = new Map();
  for (const l of leaves) {
    if (!l || !l.name || !l.parent) continue;
    const mod = String(l.parent).split(/[\/·]/).pop().trim();
    if (!mod) continue;
    const cur = votes.get(l.name) || new Map();
    cur.set(mod, (cur.get(mod) || 0) + 1);
    votes.set(l.name, cur);
  }
  for (const [name, m] of votes) {
    let best = "", n = -1;
    for (const [k, v] of m) if (v > n) { best = k; n = v; }
    KP2MOD.set(name, best);
  }
} catch (e) {
  console.log("kp-leaves 未加载：", e.message);
}
const MODULES = ["政治理论", "常识判断", "言语理解与表达", "数量关系", "判断推理", "资料分析", "法律常识", "经济常识", "科技常识", "人文常识", "地理国情", "公文写作", "综合常识"];
function chapterOf(keypoints, subject) {
  for (const kp of keypoints || []) {
    const name = kp && kp.name;
    if (!name) continue;
    if (subject === "事业编·公基" && MODULES.includes(name) && MODULES.indexOf(name) >= 6) return name;
    const mod = KP2MOD.get(name);
    if (mod) return mod;
    const hit = MODULES.find((m) => name.includes(m));
    if (hit && MODULES.indexOf(hit) < 6) return hit;
  }
  return subject === "事业编·公基" ? "综合常识" : "未分类";
}

// ---------- DB ----------
const db = APPLY ? new DatabaseSync(DB) : new DatabaseSync(DB, { readOnly: true });
if (APPLY) {
  db.exec("PRAGMA busy_timeout = 30000");
  db.exec("PRAGMA synchronous = NORMAL");
  const cols = new Set(db.prepare("PRAGMA table_info(questions)").all().map((r) => r.name));
  if (!cols.has("fenbi_src")) db.exec("ALTER TABLE questions ADD COLUMN fenbi_src TEXT");
  for (const [subj, meta] of Object.entries(SUBJECT_META)) {
    const exists = db.prepare("SELECT id FROM papers WHERE id = ?").get(meta.paper);
    if (!exists) {
      db.prepare("INSERT INTO papers (id, subject, subjectName, category, name, questionCount, time, crawledAt) VALUES (?,?,?,?,?,?,?,?)")
        .run(meta.paper, subj, subj, "粉笔扫描", "粉笔题库扫描导入（" + subj + "）", 0, "", new Date().toISOString());
    }
  }
}

const known = new Set();
for (const r of db.prepare("SELECT DISTINCT questionId AS q FROM questions").all()) known.add(Number(r.q));
const fpSet = new Set();
for (const r of db.prepare("SELECT content AS c FROM questions").all()) {
  const f = fingerprint(r.c);
  if (f) fpSet.add(f);
}
console.log("库内题号", known.size, "指纹", fpSet.size, "模式", APPLY ? "apply" : "dry", "范围", FROM + ".." + TO);

// ---------- 状态 ----------
let state = { cursor: FROM, req: 0, hits: 0, added: 0, skip: {}, startedAt: new Date().toISOString() };
if (fs.existsSync(STATE)) {
  try {
    const old = JSON.parse(fs.readFileSync(STATE, "utf8"));
    if (old && old.cursor != null && has("resume")) state = old;
  } catch {}
}
const saveState = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
const bump = (k, n = 1) => { state.skip[k] = (state.skip[k] || 0) + n; };

const insQ = APPLY ? db.prepare(`INSERT INTO questions
 (questionId, paperId, chapter, type, questionType, content, contentHtml, material, options, optionType,
  answer, answerIndex, difficulty, source, analysis, analysisHtml, hasVideo, q_bad, q_bad_reason,
  fenbi_difficulty, fenbi_diff_src, fenbi_checked_at, fenbi_src)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`) : null;
const insKp = APPLY ? db.prepare("INSERT OR IGNORE INTO question_keypoints (questionId, kpName) VALUES (?,?)") : null;
const insCat = APPLY ? db.prepare("INSERT OR IGNORE INTO question_categories (question_id, subject, category, sub) VALUES (?,?,?,?)") : null;

let nextId = Number(db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM questions").get().m) + 1;

function insertOne(it, sol, subject) {
  const opts = ((it.accessories && it.accessories[0] && it.accessories[0].options) || []).map((o) => normLinks(o));
  const type = Number(it.type || 1);
  const isObj = [1, 2, 3, 5].includes(type);
  const contentHtml = normLinks(it.content || "");
  const content = textOf(contentHtml);
  const matHtml = it.material && it.material.content ? normLinks(it.material.content) : "";
  const material = textOf(matHtml);
  const solHtml = sol && sol.solution ? normLinks(sol.solution) : "";
  const analysis = textOf(solHtml);
  const { answer, answerIndex } = answerOf(it.correctAnswer, type, opts.length);
  const masked = MASKED.test(content) || opts.some((o) => MASKED.test(o)) || MASKED.test(material);
  const chapter = chapterOf(sol && sol.keypoints, subject);
  const paperId = SUBJECT_META[subject].paper;
  const now = new Date().toISOString();

  if (!content || content.length < 8) { bump("空题干"); return false; }
  if (masked) { bump("打码"); return false; }
  if (isObj && opts.filter((o) => textOf(o).length > 0).length < 2) { bump("选项空"); return false; }
  if (isObj && !answer) { bump("无答案"); return false; }
  const fp = fingerprint(content);
  if (fpSet.has(fp)) { bump("重复"); return false; }

  if (APPLY) {
    insQ.run(nextId++, paperId, chapter, type, type, content, contentHtml, material,
      JSON.stringify(opts), opts.length ? "text" : "", answer, answerIndex,
      Number(it.difficulty || 5) || 5, "fenbi-sweep", analysis, solHtml, 0,
      isObj && !analysis ? 1 : 0, isObj && !analysis ? "R?解析缺失" : null,
      it.difficulty == null ? null : Number(it.difficulty), "fenbi-api", now,
      sol && sol.source ? String(sol.source) : null);
    for (const kp of (sol && sol.keypoints) || []) if (kp && kp.name) insKp.run(it.id, kp.name);
    insCat.run(it.id, subject, chapter, "");
  }
  fpSet.add(fp);
  known.add(Number(it.id));
  return true;
}

async function doBatch(start) {
  const ids = [];
  for (let i = 0; i < BATCH; i++) ids.push(start + i);
  const qs = await getJson(`https://tiku.fenbi.com/api/${COURSE}/questions?ids=${ids.join(",")}&${QAPI}`);
  state.req++;
  if (!qs) { await sleep(3000); return 0; }
  const fresh = qs.filter((x) => x && !known.has(Number(x.id)));
  if (!fresh.length) return 0;

  // 取解析（30 条一批）
  const sols = new Map();
  for (let i = 0; i < fresh.length; i += 30) {
    const part = fresh.slice(i, i + 30).map((x) => x.id);
    const arr = await getJson(`https://tiku.fenbi.com/api/${COURSE}/solutions?ids=${part.join(",")}&${QAPI}`);
    state.req++;
    for (const s of arr || []) if (s && s.id != null) sols.set(Number(s.id), s);
    if (GAP) await sleep(GAP);
  }

  let added = 0;
  if (APPLY) db.exec("BEGIN");
  try {
    for (const it of fresh) {
      state.hits++;
      const sol = sols.get(Number(it.id));
      const subject = classify(sol && sol.source) || "事业编·职测";
      if (insertOne(it, sol, subject)) added++;
    }
    if (APPLY) db.exec("COMMIT");
  } catch (e) {
    if (APPLY) db.exec("ROLLBACK");
    throw e;
  }
  state.added += added;
  return added;
}

const t0 = Date.now();
let cursor = Math.max(FROM, Number(state.cursor || FROM));
let done = 0;
const pending = [];
while (cursor + BATCH <= TO && (!MAXREQ || state.req < MAXREQ)) {
  while (pending.length >= CONC) {
    const r = await pending.shift();
    done += r;
  }
  const start = cursor;
  cursor += BATCH;
  state.cursor = cursor;
  const p = doBatch(start).then((n) => n);
  pending.push(p);
  if (state.req % 300 === 0) {
    saveState();
  }
  if (GAP) await sleep(Math.max(20, Math.floor(GAP / Math.max(1, CONC))));
}
for (const p of pending) done += await p;
saveState();

const el = ((Date.now() - t0) / 1000).toFixed(0);
console.log(JSON.stringify({ req: state.req, hits: state.hits, added: state.added, cursor: state.cursor, skip: state.skip, sec: el }, null, 1));
fs.writeFileSync(path.join(ROOT, `report/sweep-${DAY}.json`), JSON.stringify({ ...state, sec: Number(el) }, null, 1));
if (APPLY) db.close();
