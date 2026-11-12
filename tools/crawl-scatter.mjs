// 散题持续采集：两号轮换，边采边检，落 JSONL 暂存（不直接写库）
//   用法：node tools/crawl-scatter.mjs --course syzc --maxhours 8
//   产出：report/scatter/<course>-<ts>.jsonl  +  report/scatter/stats-<course>.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { loadAccounts, Session } from "./lib/fenbi.mjs";
import { richToHtml, normLinks, inlineTarzan, textOf, latexKeys, fingerprint, TEX_HOST } from "./lib/rich.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const COURSE = arg("course", "syzc");
const GAP = Number(arg("gap", "20")) * 1000;          // 两次练习间隔
const COOLDOWN = Number(arg("cooldown", "240")) * 1000;
const MAXHOURS = Number(arg("maxhours", "8"));
const BATCH = Number(arg("batch", "100"));
const DB = arg("db", path.join(ROOT, "app-assets", "tiku_app.db"));
const IMG_DB = arg("img-db", path.join(ROOT, "app-assets", "images.db"));
const OUT_DIR = path.join(ROOT, "report", "scatter");
fs.mkdirSync(OUT_DIR, { recursive: true });

const Q0 = "app=web&kav=131&av=134&hav=128&gav=2&apcid=0&deviceId=";
const ST = "key=%K&routecs=%C&type=1&kav=125&av=127&hav=125&app=web&apcid=0&deviceId=&gav=2";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });
const log = (m) => console.log(`[${stamp()}] ${m}`);

/* ---------- 账号 ---------- */
const accounts = loadAccounts(ROOT);
if (!accounts.length) { console.error("没有可用 cookie"); process.exit(1); }
const sess = new Session(accounts, { log });
log(`账号：${accounts.map((a) => `${a.file}(${a.uid})`).join(" · ")}`);

/* ---------- 考点树（用来定章节 + 轮换 keypointIds） ---------- */
const leaves = JSON.parse(fs.readFileSync(path.join(ROOT, "report", "kp-leaves.json"), "utf8")).leaves || [];
const syzcLeaves = leaves.filter((l) => String(l.parent || "").startsWith("/") && String(l.parent).split("/").filter(Boolean).length >= 1);
const nameMod = new Map();
for (const l of syzcLeaves) {
  const mod = String(l.parent || "").split("/").filter(Boolean)[0] || "";
  if (!mod || !l.name) continue;
  if (!nameMod.has(l.name)) nameMod.set(l.name, new Map());
  const m = nameMod.get(l.name);
  m.set(mod, (m.get(mod) || 0) + 1);
}
const MODS = new Set(["政治理论", "常识判断", "言语理解与表达", "数量关系", "判断推理", "资料分析"]);
function moduleOf(kpNames) {
  for (const k of kpNames) {
    const m = nameMod.get(k);
    if (!m) continue;
    const cand = [...m.entries()].filter(([mod]) => MODS.has(mod)).sort((a, b) => b[1] - a[1]);
    if (!cand.length) continue;
    if (cand.length === 1 || cand[0][1] > (cand[1]?.[1] || 0)) return cand[0][0];
  }
  return null;
}
log(`考点叶子 ${syzcLeaves.length} 个，章节映射 ${nameMod.size} 个考点名`);

/* ---------- 已知道的（去重 / 图片键） ---------- */
const db = new DatabaseSync(DB, { readOnly: true });
const seenFp = new Set();
const seenQid = new Set();
for (const r of db.prepare("SELECT questionId, content FROM questions").iterate()) {
  seenQid.add(r.questionId);
  const f = fingerprint(r.content);
  if (f) seenFp.add(f);
}
db.close();
const imgKeys = new Set();
try {
  const idb = new DatabaseSync(IMG_DB, { readOnly: true });
  for (const r of idb.prepare("SELECT key FROM images").iterate()) imgKeys.add(r.key);
  idb.close();
} catch (e) { log(`images.db 打不开：${e.message}`); }
log(`库内 ${seenQid.size} 题 / 指纹 ${seenFp.size} / 图片键 ${imgKeys.size}`);

/* ---------- 校验 ---------- */
const FIG = /(如图|如下图|图中|图示|上图|下图|图\s?\d|下列图形|立体图|平面图)/;
function check(it) {
  const flags = [];
  const stem = textOf(it.contentHtml);
  if (stem.length < 8) flags.push("空题干");
  const isObj = [1, 2, 3, 5].includes(it.type);
  if (isObj) {
    if (!it.options.length) flags.push("无选项");
    else if (it.options.some((o) => !textOf(o) && !/<img/.test(o))) flags.push("选项空");
    if (!it.answer && it.answerIndex == null) flags.push("无答案");
    if (it.answerIndex != null && (it.answerIndex < 0 || it.answerIndex >= it.options.length)) flags.push("答案越界");
  }
  if (FIG.test(stem) && !/<img/.test(it.contentHtml) && !/<img/.test(it.material || "")) flags.push("缺图");
  if (textOf(it.analysisHtml).length < 10) flags.push("解析过短");
  const miss = [...new Set([...latexKeys(it.contentHtml), ...latexKeys(it.analysisHtml), ...latexKeys(it.material || "")])]
    .filter((k) => imgKeys.size && !imgKeys.has(k));
  if (miss.length) flags.push(`缺图键${miss.length}`);
  const fp = fingerprint(it.contentHtml);
  if (fp && seenFp.has(fp)) flags.push("重复");
  return { flags, fp };
}

/* ---------- 拉一批 ---------- */
async function createExercise(kpId) {
  const url = `https://tiku.fenbi.com/api/${COURSE}/exercises?${Q0}&userId=${sess.uid()}`;
  const body = new URLSearchParams({ type: "2", keypointIds: kpId, count: String(BATCH), exerciseTimeMode: "2" });
  const r = await sess.fetch(url, { method: "POST", body, spa: true, signal: AbortSignal.timeout(25000) }).catch(() => null);
  if (!r) return { err: "网络失败" };
  const txt = await r.text();
  if (r.status === 403) return { err: "限流", txt };
  if (r.status !== 200) return { err: `HTTP ${r.status}`, txt };
  let j = null;
  try { j = JSON.parse(txt); } catch { /* */ }
  const key = j?.data?.key || (txt.match(/"key"\s*:\s*"([^"]+)"/) || [])[1];
  return key ? { key } : { err: "无 key", txt: txt.slice(0, 120) };
}

async function pullStatic(key) {
  await sess.fetch(`https://tiku.fenbi.com/combine/exercise/submit?key=${key}&routecs=${COURSE}&${Q0}&userId=${sess.uid()}`, {
    method: "POST", spa: true, headers: { "content-type": "application/json" }, body: "{}",
    signal: AbortSignal.timeout(20000),
  }).catch(() => null);
  const gr = await sess.fetch(`https://tiku.fenbi.com/combine/exercise/getSolution?format=json&key=${key}&routecs=${COURSE}&${Q0}&userId=${sess.uid()}`, {
    spa: true, signal: AbortSignal.timeout(20000),
  }).catch(() => null);
  if (!gr || gr.status !== 200) return { err: `getSolution ${gr?.status || 0}` };
  const gj = await gr.json().catch(() => null);
  const url = gj?.data?.staticUrl?.urls?.[0]
    || (gj?.data?.switchVO?.requestKey ? `https://tiku.fenbi.com/combine/static/solution?key=${gj.data.switchVO.requestKey}` : null);
  if (!url) return { err: "无 staticUrl" };
  const full = url + (url.includes("?") ? "&" : "?") + ST.replace("%C", COURSE);
  const st = await sess.fetch(full, { spa: true, signal: AbortSignal.timeout(30000) }).catch(() => null);
  if (!st || st.status !== 200) return { err: `static ${st?.status || 0}` };
  const sj = await st.json().catch(() => null);
  if (!sj) return { err: "static 不是 JSON" };
  return { json: sj };
}

function toItem(sol, materials) {
  const type = Number(sol.type) || 1;
  const acc = (sol.accessories || []).find((a) => Array.isArray(a.options)) || {};
  const options = (acc.options || []).map((o) => (typeof o === "string" ? o : richToHtml(o)));
  const mat = sol.materialId ? materials.find((m) => m.id === sol.materialId) : null;
  const ca = sol.correctAnswer || {};
  const rawAns = ca.choice != null ? String(ca.choice).trim() : "";
  const LETTERS = "ABCDEFGH";
  let answer = "", answerIndex = -1;
  if (type === 4) { // 判断
    answer = /^(1|A|对|正确|是|true)$/i.test(rawAns) ? "A" : /^(2|B|错|错误|否|false)$/i.test(rawAns) ? "B" : "";
  } else if (type === 2 || type === 3 || type === 5) {
    const idx = rawAns.split(/[,\s、]+/).filter(Boolean).map((x) => LETTERS.indexOf(String(x).toUpperCase())).filter((i) => i >= 0);
    answer = idx.length > 1 ? idx.sort((a, b) => a - b).join(",") : idx.length ? LETTERS[idx[0]] : "";
  } else {
    const i = LETTERS.indexOf(rawAns.toUpperCase());
    if (i >= 0) { answer = LETTERS[i]; answerIndex = i; }
  }
  const kps = String(sol.keypoints || "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  return {
    qid: Number(sol.id),
    type,
    kpNames: kps,
    chapter: moduleOf(kps),
    contentHtml: normLinks(richToHtml(sol.content)),
    material: mat ? normLinks(richToHtml(mat.content)) : "",
    options,
    answer,
    answerIndex,
    analysisHtml: normLinks(richToHtml(sol.solution)),
    rawAnswer: rawAns,
  };
}

/* ---------- 主循环 ---------- */
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = path.join(OUT_DIR, `${COURSE}-${ts}.jsonl`);
const out = fs.createWriteStream(OUT, { flags: "a" });
const stat = { course: COURSE, rounds: 0, limit403: 0, fetched: 0, fresh: 0, skipped: 0, dropped: 0, reasons: {}, startedAt: new Date().toISOString() };
const bump = (k) => { stat.reasons[k] = (stat.reasons[k] || 0) + 1; };

let kpIdx = 0;
const deadline = Date.now() + MAXHOURS * 3600 * 1000;
const writeStat = () => fs.writeFileSync(path.join(OUT_DIR, `stats-${COURSE}.json`), JSON.stringify(stat, null, 2));

process.on("SIGINT", () => { writeStat(); out.end(); log(`中断，已写 ${OUT}`); process.exit(0); });

log(`开始：course=${COURSE} gap=${GAP / 1000}s cooldown=${COOLDOWN / 1000}s 输出 ${OUT}`);
while (Date.now() < deadline) {
  const kp = syzcLeaves[kpIdx++ % syzcLeaves.length];
  const created = await createExercise(kp.id);
  if (created.err) {
    if (created.err === "限流") {
      stat.limit403++;
      writeStat();
      const cd = Math.min(COOLDOWN * (1 + Math.floor(stat.limit403 / 6)), COOLDOWN * 5);
      log(`限流（${kp.name}）→ 冷却 ${Math.round(cd / 1000)}s，已连续 ${stat.limit403} 次`);
      await sleep(cd);
      continue;
    }
    log(`建练习失败：${created.err} ${String(created.txt || "").slice(0, 80)}`);
    await sleep(5000);
    continue;
  }
  const st = await pullStatic(created.key);
  if (st.err) { log(`取正文失败：${st.err}`); await sleep(5000); continue; }

  const materials = st.json.materials || [];
  const sols = st.json.solutions || [];
  stat.rounds++;
  let fresh = 0, dup = 0, drop = 0;
  for (const sol of sols) {
    const it = toItem(sol, materials);
    stat.fetched++;
    if (!it.qid || seenQid.has(it.qid)) { dup++; bump("已有题目"); continue; }
    const { flags, fp } = check(it);
    const fatal = flags.filter((f) => /^(空题干|无选项|选项空|无答案|答案越界)$/.test(f));
    if (fatal.length) { flags.forEach(bump); drop++; stat.dropped++; continue; }
    // 非致命：缺图/解析过短 —— 仍收，但打标，导入时要人工口径
    if (fp) { seenFp.add(fp); seenQid.add(it.qid); }
    const html = {
      ...it,
      contentHtml: await inlineTarzan(it.contentHtml),
      analysisHtml: await inlineTarzan(it.analysisHtml),
      material: await inlineTarzan(it.material || ""),
    };
    out.write(JSON.stringify({ ...html, flags, src: "scatter", course: COURSE, kpFile: kp.name, ts: new Date().toISOString() }) + "\n");
    fresh++; stat.fresh++;
  }
  stat.skipped += dup;
  log(`第 ${stat.rounds} 轮（${kp.name}）：拿到 ${sols.length} 题 · 新增 ${fresh} · 已有 ${dup} · 丢弃 ${drop}｜累计新增 ${stat.fresh}`);
  writeStat();
  await sleep(GAP);
}
writeStat(); out.end();
log(`到达时限，收工：新增 ${stat.fresh} 题 → ${OUT}`);
