// 从「练习历史」拿已存在练习的 exerciseKey → getSolution + static（全程 GET，不建练习、不占额度）
// 用粉笔原文补齐/修正我们库里的坏题（只补不覆盖，沿用 fix-from-search 的口径）
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes("--" + k);

const DB = arg("db", path.join(ROOT, "app-assets", "tiku_app.db"));
const IMG_DB = path.join(ROOT, "app-assets", "images.db");
const APPLY = has("apply");
let began = false;
const LIMIT = Number(arg("limit", "0")) || 0;
const GAP = Number(arg("gap", "1200"));
const COURSES = (arg("courses", "syzc,sydw,xingce,zhyynl")).split(",");
const EXAMCAT = { syzc: 1000163, sydw: 1000163, xingce: 1000163, zhyynl: 1000163 };
const DEVICE = arg("device", "v1_39b7ffafm0754_fe5b");
const Q = `app=web&kav=125&av=127&hav=125&apcid=0&deviceId=${DEVICE}&gav=2`;

// ---------- 多账号 ----------
function loadCookies() {
  const files = fs.readdirSync(ROOT).filter((f) => /^cookie.*\.txt$/.test(f));
  const out = [];
  for (const f of files) {
    const c = fs.readFileSync(path.join(ROOT, f), "utf8").trim();
    const uid = (c.match(/userid=(\d+)/) || [])[1] || "?";
    if (c) out.push({ file: f, cookie: c, uid });
  }
  return out;
}
const ACCOUNTS = loadCookies();
let acc = 0;
const H = () => ({ cookie: ACCOUNTS[acc].cookie, "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36", referer: "https://www.fenbi.com/" });
const nextAcc = () => { acc = (acc + 1) % ACCOUNTS.length; console.log(`  → 切账号 ${ACCOUNTS[acc].file} uid=${ACCOUNTS[acc].uid}`); };

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: H(), signal: AbortSignal.timeout(20000) });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      if (r.status === 200 && j) return j;
      if (r.status === 403) { nextAcc(); continue; }
      return { __status: r.status, __body: t.slice(0, 200) };
    } catch (e) { if (i === tries - 1) return { __status: "ERR", __body: e.message }; }
  }
  return { __status: "ERR" };
}

// ---------- 富文本 → HTML（与 fix-from-search 一致） ----------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const FORMULA = "https://fb.fenbike.cn/api/planet/accessories/formulas?latex=";
function richToHtml(raw) {
  if (!raw) return "";
  let nodes = raw;
  if (typeof raw === "string") { try { nodes = JSON.parse(raw); } catch { return esc(raw); } }
  if (!Array.isArray(nodes)) return esc(String(raw));
  const one = (n) => {
    if (n == null) return "";
    if (typeof n === "string") return esc(n);
    const t = n.type || n.name;
    if (t === "txt" || t === "text") return esc(n.value ?? n.text ?? "");
    if (t === "tex") { const k = String(n.value || "").split("?")[0]; return k ? `<img flag="tex" src="${FORMULA}${k}">` : ""; }
    if (t === "img") return `<img src="${n.value || n.url || ""}">`;
    if (t === "br") return "<br>";
    const inner = (n.children || n.value || []).map ? (n.children || n.value).map(one).join("") : "";
    if (t === "p") return `<p>${inner}</p>`;
    if (t === "li") return `<li>${inner}</li>`;
    if (t === "ul" || t === "ol") return `<${t}>${inner}</${t}>`;
    if (t === "table") return `<table>${inner}</table>`;
    if (t === "tr") return `<tr>${inner}</tr>`;
    if (t === "td" || t === "th") return `<${t}>${inner}</${t}>`;
    if (t === "b" || t === "i" || t === "u") return `<${t}>${inner}</${t}>`;
    return inner;
  };
  return nodes.map(one).join("");
}
const hasImg = (h) => /<img/i.test(String(h || ""));
const blank = (s) => !s || !String(s).trim() || String(s).trim() === "[object Object]";
const objType = (t) => [1, 2, 3, 5].includes(Number(t));

// ---------- 取 static ----------
async function pullStatic(exKey, COURSE) {
  const gs = await getJson(`https://tiku.fenbi.com/combine/exercise/getSolution?format=json&key=${exKey}&routecs=${COURSE}&${Q}`);
  const rk = gs?.data?.switchVO?.requestKey;
  if (!rk) return { err: gs?.__body || gs?.msg || "no requestKey" };
  const st = await getJson(`https://tiku.fenbi.com/combine/static/solution?key=${rk}&routecs=${COURSE}&${Q}`);
  if (!st || !Array.isArray(st.solutions)) return { err: "no solutions" };
  return st;
}

// ---------- 历史分页 ----------
async function historyKeys(COURSE) {
  const seen = new Set(); const out = [];
  let cursor = "";
  for (let page = 0; page < 200; page++) {
    const u = `https://tiku.fenbi.com/combine/exercise/getExerciseBriefHistory?noCacheTag=${page + 1}&categoryId=4&limit=20&cursor=${encodeURIComponent(cursor)}&routecs=${COURSE}&app=web&kav=131&av=134&hav=128&version=3.0.0.0&deviceId=${DEVICE}&gav=2&apcId=0&examcatid=${EXAMCAT[COURSE] || 1000163}`;
    const j = await getJson(u);
    const items = j?.data?.historyItems || [];
    if (!items.length) break;
    for (const it of items) if (it.exerciseKey && !seen.has(it.exerciseKey)) { seen.add(it.exerciseKey); out.push({ key: it.exerciseKey, name: it.sheetName, count: it.questionCount }); }
    cursor = j?.data?.cursor || "";
    if (!cursor) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  return out;
}

// ---------- 写库 ----------
const db = new DatabaseSync(DB);
const imgKeys = new Set();
try {
  const img = new DatabaseSync(IMG_DB, { readOnly: true });
  for (const r of img.prepare("SELECT key FROM images").all()) imgKeys.add(r.key);
  img.close();
} catch {}
const missingKeys = new Set();
const Q_BY_ID = new Map();
for (const r of db.prepare("SELECT id, questionId, type, chapter, content, contentHtml, material, options, answer, answerIndex, analysis, analysisHtml, q_bad FROM questions WHERE q_bad = 1").all()) {
  if (!Q_BY_ID.has(r.questionId)) Q_BY_ID.set(r.questionId, r);
}
console.log(`坏题 ${Q_BY_ID.size} 道待补；图片键 ${imgKeys.size} 个`);

function planFix(r, sol, mat) {
  const plan = {};
  if (blank(r.material) && mat && String(mat).trim().length > 20) plan.material = mat;
  const cHtml = richToHtml(sol.content);
  if ((!hasImg(r.contentHtml) || blank(r.contentHtml)) && hasImg(cHtml)) { plan.contentHtml = cHtml; plan.content = String(cHtml).replace(/<[^>]+>/g, "").slice(0, 2000); }
  const aHtml = richToHtml(sol.solution);
  const aText = String(aHtml).replace(/<[^>]+>/g, "");
  if ((blank(r.analysis) || String(r.analysis).trim().length < 20 || (!hasImg(r.analysisHtml) && hasImg(aHtml))) && aText.trim().length > 10) { plan.analysis = aText.slice(0, 4000); plan.analysisHtml = aHtml; }
  const opts = (sol.accessories || []).flatMap((a) => (a.type === 101 ? a.options || [] : []));
  if (opts.length && (r.options === "[]" || !r.options) && opts.every((o) => String(o || "").trim())) plan.options = JSON.stringify(opts);
  return plan;
}
const UPD = db.prepare("UPDATE questions SET material = COALESCE(?, material), content = COALESCE(?, content), contentHtml = COALESCE(?, contentHtml), analysis = COALESCE(?, analysis), analysisHtml = COALESCE(?, analysisHtml), options = COALESCE(?, options), q_bad = 0, q_bad_reason = NULL WHERE questionId = ? AND q_bad = 1");

for (const COURSE of COURSES) {
  const keys = await historyKeys(COURSE);
  console.log(`\n[${COURSE}] 历史练习 ${keys.length} 个`);
  let fixed = 0, files = 0;
  for (const it of keys) {
    if (LIMIT && files >= LIMIT) break;
    files++;
    const st = await pullStatic(it.key, COURSE);
    if (!st || st.err) { console.log(`  ${it.key} 跳过：${st?.err}`); await new Promise((r) => setTimeout(r, GAP)); continue; }
    const mats = new Map((st.materials || []).map((m) => [m.id, m.content]));
    let n = 0;
    if (APPLY) { db.exec("BEGIN"); began = true; }
    for (const sol of st.solutions || []) {
      const r = Q_BY_ID.get(sol.id);
      if (!r) continue;
      const mat = mats.get(sol.materialId) || "";
      const plan = planFix(r, sol, mat);
      const keys2 = Object.keys(plan);
      if (!keys2.length) continue;
      for (const h of String(plan.material || plan.contentHtml || plan.analysisHtml || "").matchAll(/latex=([A-Za-z0-9_-]+)/g)) if (!imgKeys.has(h[1])) missingKeys.add(h[1]);
      if (APPLY) UPD.run(plan.material ?? null, plan.content ?? null, plan.contentHtml ?? null, plan.analysis ?? null, plan.analysisHtml ?? null, plan.options ?? null, sol.id);
      n++;
    }
    if (APPLY) { db.exec("COMMIT"); began = false; }
    fixed += n;
    console.log(`  ${it.key} ${it.name || ""} → 命中 ${n}`);
    await new Promise((r) => setTimeout(r, GAP));
  }
  console.log(`[${COURSE}] 试了 ${files} 个练习，可补 ${fixed} 道`);
}
if (!APPLY && began) db.exec("ROLLBACK");
console.log(`\n缺图键 ${missingKeys.size} 个`);
fs.writeFileSync(path.join(ROOT, "report", "fix-from-history.json"), JSON.stringify({ at: new Date().toISOString(), missing: [...missingKeys].slice(0, 500) }, null, 1));
db.close();
