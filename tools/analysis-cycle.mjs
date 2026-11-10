#!/usr/bin/env node
/**
 * tools/analysis-cycle.mjs — 解析补采的「一轮」：回填 → 质检 → 达标才发版
 *
 * 定时任务每 6 小时跑一次：
 *   1. backfill-from-api.mjs --apply      把新采到的解析写进 tiku.db（严格匹配，宁可少填）
 *   2. verify-analysis.mjs                四维质检（覆盖 / 答案一致 / 串题 / 空壳）
 *   3. audit-analysis-fit.mjs             字面重合度（只看客观题科目）
 *   4. 累计新增 ≥ THRESHOLD 才重建 assets / 升版本 / 打 delta / 生成 manifest / 上传 / push
 *
 * 用法：
 *   node tools/analysis-cycle.mjs              正常一轮（达标自动发版）
 *   node tools/analysis-cycle.mjs --dry        只回填+质检，不发版
 *   node tools/analysis-cycle.mjs --force      不管阈值直接发版
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APP = path.resolve(ROOT, '..');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const FORCE = argv.includes('--force');
const THRESHOLD = 3000;
const LOG = path.resolve(APP, 'research', 'analysis-cycle.log');

const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
};
const run = (cmd, args, opts = {}) => {
  log(`▶ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: opts.cwd || ROOT, encoding: 'utf8', shell: false, env: process.env });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  out.split('\n').slice(-14).forEach((l) => l && log('  ' + l));
  return { code: r.status, out };
};

const db = new DatabaseSync(path.join(ROOT, 'tiku.db'));
const emptyNow = () => db.prepare(`SELECT COUNT(1) c FROM questions WHERE analysis IS NULL OR TRIM(analysis) = ''`).get().c;
const before = emptyNow();
log(`起点：空解析 ${before} 题`);

// 1. 回填
run('node', ['tools/backfill-from-api.mjs', '--apply']);
const after = emptyNow();
const gained = before - after;
log(`回填完成：空解析 ${after} 题（本轮补 ${gained}）`);

// 2. 质检
run('node', ['tools/verify-analysis.mjs']);
run('node', ['tools/audit-analysis-fit.mjs', '--limit', '0']);

const stateFile = path.resolve(APP, 'research', 'analysis-cycle-state.json');
let state = { pending: 0 };
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
state.pending = (state.pending || 0) + gained;
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
log(`累计待发版新增：${state.pending} 题（阈值 ${THRESHOLD}）`);

if (DRY || (!FORCE && state.pending < THRESHOLD)) {
  log('未达发版条件，本轮结束');
  process.exit(0);
}

// 3. 发版
const verFile = path.join(ROOT, 'app-assets', 'db-version.txt');
const curVer = fs.readFileSync(verFile, 'utf8').trim().split(/\s+/)[0];       // 0.5.14-20261110-1450
const [semver] = curVer.split('-');
const [maj, min, patch] = semver.split('.').map(Number);
const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
const dbVer = `${maj}.${min}.${patch + 1}-${stamp}`;
log(`准备发版：${curVer} → ${dbVer}`);

const oldGz = path.join(APP, 'dist', 'release', 'tiku_app.db.gz');
const oldDb = path.join(APP, 'dist', 'release', 'tiku_app.db.old');
if (fs.existsSync(oldGz)) {
  const zlib = await import('node:zlib');
  const buf = zlib.gunzipSync(fs.readFileSync(oldGz));
  fs.writeFileSync(oldDb, buf);
  log(`旧库已解出 ${(buf.length / 1048576).toFixed(1)} MB 供 delta 用`);
}

run('node', ['build-app-assets.mjs'], { cwd: ROOT });
run('node', ['tools/write-db-version.mjs', dbVer]);

if (fs.existsSync(oldDb)) {
  run('node', ['tools/build-tiku-delta.mjs', '--old', oldDb, '--new', path.join(ROOT, 'tiku.db'), '--from', 'AUTO', '--to', dbVer, '--out', path.join(APP, 'dist', 'release')]);
}
log('assets / delta 已重建。上传与发布请人工确认 manifest 后执行 publish-release。');
