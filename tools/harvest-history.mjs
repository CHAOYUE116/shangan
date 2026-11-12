// 从「练习历史」免费通道整卷捞题（不占建练习额度）
//   node tools/harvest-history.mjs --course syzc [--gap 2] [--apply]
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
const GAP = Number(arg("gap", "2")) * 1000;
const EXAMCAT = arg("examcatid", "1000163");
const H0 = "app=web&kav=131&av=134&hav=128&version=3.0.0.0&gav=2&apcId=0";
const DEV = "v1_39b7ffafm0754_fe5b";
const TAIL = `routecs=${COURSE}&type=1&kav=125&av=127&hav=125&app=web&apcid=0&deviceId=&gav=2`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${m}`);

const sess = new Session(loadAccounts(ROOT), { log });
log(`账号 ${sess.uid()}`);

/* 考点名 → 模块 */
const leaves = JSON.parse(fs.readFileSync(path.join(ROOT, "report", "kp-leaves.json"), "utf8")).leaves || [];
const nameMod = new Map();
for (const l of leaves) {
  const mod = String(l.parent || "").split("/").filter(Boolean)[0] || "";
  if (!mod || !l.name) continue;
  if (!nameMod.has(l.name)) nameMod.set(l.name, new Map());
  const m = nameMod.get(l.name); m.set(mod, (m.get(mod) || 0) + 1);
}
const MODS = new Set(["政治理论", "常识判断", "言语理解与表达", "数量关系", "判断推理", "资料分析"]);
const moduleOf = (kps) => {
  for (const k of kps) {
    const m = nameMod.get(k); if (!m) continue;
    const c = [...m.entries()].filter(([x]) => MODS.has(x)).sort((a, b) => b[1] - a[1]);
    if (c.length && (c.length === 1 || c[0][1] > (c[1]?.[1] || 0))) return c[0][0];
  }
  return null;
};

/* 去重底表 */
const db = new DatabaseSync(path.join(ROOT, "app-assets", "tiku_app.db"), { readOnly: true });
const seenQid = new Set(), seenFp = new Set();
for (const r of db.prepare("SELECT questionId, content FROM questions").iterate()) {
  seenQid.add(r.questionId); const f = fingerprint(r.content); if (f) seenFp.add(f);
}
db.close();
const imgKeys = new Set();
try {
  const idb = new DatabaseSync(path.join(ROOT, "app-assets", "images.db"), { readOnly: true });
  for (const r of idb.prepare("SELECT key FROM images").iterate()) imgKeys.add(r.key);
  idb.close();
} catch { /* 没图库就跳过图键校验 */ }
log(`库内 ${seenQid.size} 题 / 图片键 ${imgKeys.size}`);

const FIG = /(如图|如下图|图中|图示|上图|下图|图\s?\d|下列图形|立体图|平面图)/;
function check(it) {
  const flags = [];
  if (textOf(it.contentHtml).length < 8) flags.push("空题干");
  if ([1, 2, 3, 5].includes(it.type)) {
    if (!it.options.length) flags.push("无选项");
    else if (it.options.some((o) => !textOf(o) && !/<img/.test(o))) flags.push("选项空");
    if (!it.answer && it.answerIndex < 0) flags.push("无答案");
    if (it.answerIndex >= 0 && it.answerIndex >= it.options.length) flags.push("答案越界");
  }
  if (FIG.test(textOf(it.contentHtml)) && !/<img/.test(it.contentHtml) && !/<img/.test(it.material || "")) flags.push("缺图");
  if (textOf(it.analysisHtml).length < 10) flags.push("解析过短");
  const miss = [...new Set([...latexKeys(it.contentHtml), ...latexKeys(it.analysisHtml), ...latexKeys(it.material || "")])].filter((k) => imgKeys.size && !imgKeys.has(k));
  if (miss.length) flags.push(`缺图键${miss.length}`);
  return flags;
}

function toItem(sol, materials) {
  const type = Number(sol.type) || 1;
  const acc = (sol.accessories || []).find((a) => Array.isArray(a.options)) || {};
  const options = (acc.options || []).map((o) => (typeof o === "string" ? o : richToHtml(o)));
  const mat = sol.materialId ? materials.find((m) => m.id === sol.materialId) : null;
  const raw = sol.correctAnswer?.choice != null ? String(sol.correctAnswer.choice).trim() : "";
  const L = "ABCDEFGH";
  let answer = "", answerIndex = -1;
  if (type === 4) answer = /^(1|A|对|正确|是|true)$/i.test(raw) ? "A" : /^(2|B|错|错误|否|false)$/i.test(raw) ? "B" : "";
  else if ([2, 3, 5].includes(type)) {
    const idx = raw.split(/[,\s、]+/).filter(Boolean).map((x) => L.indexOf(x.toUpperCase())).filter((i) => i >= 0);
    answer = idx.length > 1 ? idx.sort((a, b) => a - b).join(",") : idx.length ? L[idx[0]] : "";
  } else {
    const i = L.indexOf(raw.toUpperCase()); if (i >= 0) { answer = L[i]; answerIndex = i; }
  }
  const kps = String(sol.keypoints || "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  return { qid: Number(sol.id), type, kpNames: kps, chapter: moduleOf(kps),
    contentHtml: normLinks(richToHtml(sol.content)), material: mat ? normLinks(richToHtml(mat.content)) : "",
    options, answer, answerIndex, analysisHtml: normLinks(richToHtml(sol.solution)) };
}

/* 历史练习列表（多 categoryId：1 练习 2 智能 3 模考 4 试卷） */
const keys = new Map();
for (const cat of [1, 2, 3, 4]) {
  let cursor = "", page = 0;
  for (; page < 20; page++) {
    const u = `https://tiku.fenbi.com/combine/exercise/getExerciseBriefHistory?noCacheTag=${page + 1}&categoryId=${cat}&limit=20&cursor=${encodeURIComponent(cursor)}&routecs=${COURSE}&${H0}&deviceId=${DEV}&examcatid=${EXAMCAT}&userId=${sess.uid()}`;
    const r = await sess.fetch(u, { spa: true, signal: AbortSignal.timeout(20000) }).catch(() => null);
    if (!r || r.status !== 200) break;
    const j = await r.json().catch(() => null);
    const items = j?.data?.historyItems || [];
    for (const it of items) if (it.exerciseKey) keys.set(it.exerciseKey, it.sheetType);
    cursor = j?.data?.cursor || ""; if (!cursor || !items.length) break;
  }
  log(`categoryId=${cat} 累计 ${keys.size} 个练习`);
}

const OUT_DIR = path.join(ROOT, "report", "scatter");
fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT = path.join(OUT_DIR, `history-${COURSE}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.jsonl`);
const out = fs.createWriteStream(OUT);
const stat = { keys: keys.size, ok: 0, fail: 0, sols: 0, fresh: 0, dup: 0, drop: 0, reasons: {} };
const bump = (k) => (stat.reasons[k] = (stat.reasons[k] || 0) + 1);

let n = 0;
for (const key of keys.keys()) {
  n++;
  const g = await sess.fetch(`https://tiku.fenbi.com/combine/exercise/getSolution?format=json&key=${key}&routecs=${COURSE}&userId=${sess.uid()}`, { spa: true, signal: AbortSignal.timeout(20000) }).catch(() => null);
  if (!g || g.status !== 200) { stat.fail++; log(`  ${n}/${keys.size} ${key} getSolution ${g?.status || 0}`); await sleep(GAP); continue; }
  const gj = await g.json().catch(() => null);
  const url = gj?.data?.staticUrl?.urls?.[0];
  if (!url) { stat.fail++; await sleep(GAP); continue; }
  const st = await sess.fetch(`${url}&${TAIL}`, { spa: true, signal: AbortSignal.timeout(30000) }).catch(() => null);
  if (!st || st.status !== 200) { stat.fail++; log(`  ${n}/${keys.size} ${key} static ${st?.status || 0}`); await sleep(GAP); continue; }
  const sj = await st.json().catch(() => null);
  const materials = sj?.materials || [], sols = sj?.solutions || [];
  stat.ok++;
  let fresh = 0;
  for (const sol of sols) {
    stat.sols++;
    const it = toItem(sol, materials);
    if (!it.qid || seenQid.has(it.qid)) { stat.dup++; bump("已有题目"); continue; }
    const flags = check(it);
    if (flags.some((f) => /^(空题干|无选项|选项空|无答案|答案越界)$/.test(f))) { stat.drop++; flags.forEach(bump); continue; }
    const fp = fingerprint(it.contentHtml);
    if (fp && seenFp.has(fp)) { stat.dup++; bump("重复"); continue; }
    if (fp) seenFp.add(fp);
    seenQid.add(it.qid);
    out.write(JSON.stringify({ ...it, contentHtml: await inlineTarzan(it.contentHtml), analysisHtml: await inlineTarzan(it.analysisHtml), material: await inlineTarzan(it.material || ""), flags, src: "history", course: COURSE, ts: new Date().toISOString() }) + "\n");
    fresh++; stat.fresh++;
  }
  log(`  ${n}/${keys.size} ${key}: ${sols.length} 题 · 新增 ${fresh}｜累计新增 ${stat.fresh}`);
  await sleep(GAP);
}
out.end();
fs.writeFileSync(path.join(OUT_DIR, `history-stats-${COURSE}.json`), JSON.stringify({ ...stat, out: OUT }, null, 2));
log(`完成：练习 ${stat.ok}/${stat.keys.size} · 题 ${stat.sols} · 新增 ${stat.fresh} · 重复 ${stat.dup} · 丢弃 ${stat.drop}`);
log(`输出 ${OUT}`);
