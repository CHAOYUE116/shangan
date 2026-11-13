/**
 * 事业编试卷自动导入（职测 / 公基 / 综应）
 *
 * 背景：粉笔「历年试卷」的正文只能靠 POST /api/{course}/exercises 建一次练习才拿得到，
 * 而建练习有账号维度的频控（403「您创建练习的频率过高」）。这个脚本负责：
 *   1. 读 report/miss-<course>.json 里还缺的卷（每次都跟库对一遍，天然幂等）
 *   2. 调 fix-from-paper.mjs 批量导入，撞 403 就等一段时间再来
 *   3. 跑完一门换下一门，全部跑完退出
 *
 * 用法：
 *   node tools/auto-shiye-import.mjs [--courses syzc,sydw,zhyynl] [--gap 25000]
 *        [--limit 120] [--cooldown 720000] [--maxhours 12] [--probe-only]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const COURSES = String(arg('courses', 'syzc,sydw,zhyynl')).split(',').filter(Boolean);
const GAP = Number(arg('gap', '25000')) || 25000;
const LIMIT = Number(arg('limit', '120')) || 120;
const COOLDOWN = Number(arg('cooldown', '720000')) || 720000; // 12 分钟
const MAXHOURS = Number(arg('maxhours', '12')) || 12;
const PROBE_ONLY = process.argv.includes('--probe-only');
const DB = path.join(ROOT, 'app-assets', 'tiku_app.db');
const LOG = path.join(ROOT, 'report', 'shiye-import.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => {
  const line = `[${ts()}] ${m}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG, line + '\n');
  } catch { /* ignore */ }
};

function haveIds() {
  const db = new DatabaseSync(DB, { readOnly: true });
  const set = new Set(db.prepare('SELECT id FROM papers').all().map((r) => Number(r.id)));
  db.close();
  return set;
}

function pending(course) {
  const f = path.join(ROOT, 'report', `miss-${course}.json`);
  if (!fs.existsSync(f)) return [];
  const ids = JSON.parse(fs.readFileSync(f, 'utf8')).map(String);
  const have = haveIds();
  return ids.filter((id) => !have.has(Number(id)));
}

function runImport(course, ids) {
  return new Promise((resolve) => {
    const out = fs.openSync(LOG, 'a');
    const child = spawn(process.execPath, [
      path.join(ROOT, 'tools', 'fix-from-paper.mjs'),
      '--apply', '--augment',
      '--papers-file', path.join(ROOT, 'report', `miss-${course}.json`),
      '--course', course,
      '--gap', String(GAP),
      '--limit', String(ids),
    ], { cwd: ROOT, stdio: ['ignore', out, out] });
    child.on('exit', (code) => {
      try { fs.closeSync(out); } catch { /* ignore */ }
      resolve(code);
    });
  });
}

const started = Date.now();
log(`== 事业编试卷导入启动（课程 ${COURSES.join(',')} · gap ${GAP}ms · 冷却 ${Math.round(COOLDOWN / 60000)}min）`);
for (const c of COURSES) log(`   ${c} 待导入 ${pending(c).length} 卷`);

if (!PROBE_ONLY) {
  outer: while (Date.now() - started < MAXHOURS * 3600 * 1000) {
    let didWork = false;
    for (const course of COURSES) {
      let left = pending(course);
      if (!left.length) continue;
      log(`${course} 还剩 ${left.length} 卷，开始导入`);
      const before = left.length;
      const code = await runImport(course, Math.min(left.length, LIMIT));
      left = pending(course);
      const okCount = before - left.length;
      log(`${course} 本轮完成 ${okCount} 卷（退出码 ${code}），还剩 ${left.length}`);
      if (okCount > 0) didWork = true;
      if (okCount === 0) {
        log(`疑似额度用尽，冷却 ${Math.round(COOLDOWN / 60000)} 分钟后重试`);
        await sleep(COOLDOWN);
        continue outer;
      }
    }
    if (COURSES.every((c) => pending(c).length === 0)) {
      log('全部课程已导入完成');
      break;
    }
    if (!didWork) await sleep(COOLDOWN);
  }
}
log('== 退出');
for (const c of COURSES) log(`   ${c} 仍待导入 ${pending(c).length} 卷`);
