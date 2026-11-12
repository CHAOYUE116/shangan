// 抓粉笔「全站正确率」等题目统计（getMeta），存新表 question_meta
//   node tools/fetch-qmeta.mjs --course syzc [--apply] [--gap 1]
// 来源：练习历史里的 exerciseKey（免费重读，不占建练习额度）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { loadAccounts, Session } from "./lib/fenbi.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const APPLY = args.includes("--apply");
const COURSE = arg("course", "syzc");
const GAP = Number(arg("gap", "1")) * 1000;
const EXAMCAT = arg("examcatid", "1000163");
const H0 = "app=web&kav=131&av=134&hav=128&version=3.0.0.0&gav=2&apcId=0";
const DEV = "v1_39b7ffafm0754_fe5b";
const DB = path.join(ROOT, "app-assets", "tiku_app.db");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${m}`);

const sess = new Session(loadAccounts(ROOT), { log });
log(`账号 ${sess.uid()} course=${COURSE}`);

const db = new DatabaseSync(DB);
db.exec(`CREATE TABLE IF NOT EXISTS question_meta (
  questionId INTEGER PRIMARY KEY,
  correctRatio REAL,
  totalCount INTEGER,
  mostWrong TEXT,
  src TEXT,
  updatedAt TEXT
)`);

/* 历史练习 key */
const keys = new Map();
for (const cat of [1, 2, 3, 4]) {
  let cursor = "", page = 0;
  for (; page < 20; page++) {
    const u = `https://tiku.fenbi.com/combine/exercise/getExerciseBriefHistory?noCacheTag=${page + 1}&categoryId=${cat}&limit=20&cursor=${encodeURIComponent(cursor)}&routecs=${COURSE}&${H0}&deviceId=${DEV}&examcatid=${EXAMCAT}&userId=${sess.uid()}`;
    const r = await sess.fetch(u, { spa: true, signal: AbortSignal.timeout(20000) }).catch(() => null);
    if (!r || r.status !== 200) break;
    const j = await r.json().catch(() => null);
    const items = j?.data?.historyItems || [];
    for (const it of items) if (it.exerciseKey) keys.set(it.exerciseKey, it.sheetName);
    cursor = j?.data?.cursor || ""; if (!cursor || !items.length) break;
  }
}
log(`练习历史 ${keys.size} 个`);

const up = db.prepare(`INSERT INTO question_meta (questionId, correctRatio, totalCount, mostWrong, src, updatedAt)
  VALUES (?,?,?,?,?,?)
  ON CONFLICT(questionId) DO UPDATE SET correctRatio=excluded.correctRatio, totalCount=excluded.totalCount,
  mostWrong=excluded.mostWrong, src=excluded.src, updatedAt=excluded.updatedAt`);

let n = 0, got = 0, fail = 0;
db.exec("BEGIN");
for (const [key, name] of keys) {
  n++;
  const g = await sess.fetch(`https://tiku.fenbi.com/combine/exercise/getSolution?format=json&key=${key}&routecs=${COURSE}&userId=${sess.uid()}`, { spa: true, signal: AbortSignal.timeout(20000) }).catch(() => null);
  const gj = g && g.status === 200 ? await g.json().catch(() => null) : null;
  const rk = gj?.data?.switchVO?.requestKey;
  if (!rk) { fail++; log(`  ${n}/${keys.size} ${key} 无 requestKey`); await sleep(GAP); continue; }
  const m = await sess.fetch(`https://tiku.fenbi.com/combine/question/getMeta?requestKey=${rk}&routecs=${COURSE}&kav=125&av=127&hav=125&app=web&apcid=0&deviceId=&gav=2&userId=${sess.uid()}`, { spa: true, signal: AbortSignal.timeout(20000) }).catch(() => null);
  const mj = m && m.status === 200 ? await m.json().catch(() => null) : null;
  const d = mj?.data || {};
  const ids = Object.keys(d);
  if (!ids.length) { fail++; log(`  ${n}/${keys.size} ${key} meta 空（${m?.status || 0}）`); await sleep(GAP); continue; }
  for (const k of ids) {
    const it = d[k];
    if (!it?.id) continue;
    up.run(it.id, it.correctRatio ?? null, it.totalCount ?? null, JSON.stringify(it.mostWrongAnswer || null), "fenbi-meta", new Date().toISOString());
    got++;
  }
  log(`  ${n}/${keys.size} ${key}：${ids.length} 题｜累计 ${got}`);
  await sleep(GAP);
}
db.exec(APPLY ? "COMMIT" : "ROLLBACK");
const cnt = db.prepare("SELECT COUNT(*) n FROM question_meta").get().n;
const inDb = db.prepare("SELECT COUNT(*) n FROM question_meta m WHERE EXISTS (SELECT 1 FROM questions q WHERE q.questionId = m.questionId)").get().n;
console.log(`${APPLY ? "已写库" : "dry-run"}：练习 ${keys.size} · 命中 ${got} 条 · 失败 ${fail}｜question_meta 现有 ${cnt} 条，与库内题交集 ${inDb}`);
db.close();
fs.writeFileSync(path.join(ROOT, "report", `qmeta-${COURSE}.json`), JSON.stringify({ course: COURSE, keys: keys.size, got, fail }, null, 2));
