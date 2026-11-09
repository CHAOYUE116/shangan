#!/usr/bin/env node
/**
 * tools/politics-daily.mjs — 时政每日自动更新（抓取 → 校验 → 同步三份 → 提交）
 *
 * 为什么要这一步：
 *   「时政热点」是每天在变的栏目，手动跑 fetch-politics 再手动复制三份、
 *   手动 commit 太容易漏。这个脚本把整条链路串起来，配合 Windows 计划任务
 *   就能每天自动更新，App 端下次打开时政页自动拉到最新（不用发版）。
 *
 * 校验（任何一条不过就不发，保留上一版）：
 *   ① 篇数 ≥ 6
 *   ② 正文不含评论区特征（"最新评论" / "打卡" / "下载粉笔App"）
 *   ③ 正文长度 ≥ 300 字
 *   ④ 有练习题的篇目，答案数必须等于题数（错答案比没有更糟）
 *   ⑤ 日期格式 YYYY-MM-DD 且不早于两年前
 *   ⑥ 三份拷贝内容一致（写完再比 md5）
 *
 * 用法：
 *   node tools/politics-daily.mjs              跑一次完整流程
 *   node tools/politics-daily.mjs --no-push    只更新文件，不 commit/push
 *   node tools/politics-daily.mjs --limit 12   抓多少篇（默认 12）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(ROOT, '..', 'dist', 'release', 'politics.json');
const COPIES = [
  OUT,                                                  // 抓取产物
  path.resolve(ROOT, '..', 'release', 'politics.json'),  // 线上（git 跟踪）
  path.resolve(ROOT, 'public', 'app-assets', 'politics.json'), // 打进 APK
];
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LIMIT = arg('limit', '12');
const NO_PUSH = argv.includes('--no-push');

const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);

/* ---------- ① 抓取（复用 fetch-politics.mjs，--merge 保留历史篇目） ---------- */
const backup = OUT + '.bak';
if (fs.existsSync(OUT)) fs.copyFileSync(OUT, backup);

const r = spawnSync(process.execPath, [path.join(__dirname, 'fetch-politics.mjs'), '--limit', LIMIT, '--merge'], {
  cwd: ROOT, stdio: 'inherit',
});
if (r.status !== 0) {
  log('✗ 抓取失败，退出码', r.status);
  if (fs.existsSync(backup)) fs.copyFileSync(backup, OUT);
  process.exit(1);
}

/* ---------- ② 校验 ---------- */
const data = JSON.parse(fs.readFileSync(OUT, 'utf8'));
const items = data.items || [];
const fails = [];

if (items.length < 6) fails.push(`篇数不足：${items.length} < 6`);

const BAD = [/最新评论/, /打卡/, /下载粉笔App/, /用户[0-9A-Za-z]{4,}/];
let badBody = 0;
for (const it of items) {
  if (BAD.some((re) => re.test(it.text || ''))) badBody++;
}
if (badBody) fails.push(`${badBody} 篇正文含评论区残留`);

const shortBody = items.filter((it) => (it.text || '').length < 300).length;
if (shortBody) fails.push(`${shortBody} 篇正文不足 300 字`);

let badAns = 0;
let withPractice = 0;
for (const it of items) {
  const ps = it.practice || [];
  if (!ps.length) continue;
  withPractice++;
  for (const q of ps) {
    if (!q.answer || !/^[A-H]$/.test(q.answer)) badAns++;
    else if (q.options && q.options.length && q.answer.charCodeAt(0) - 65 >= q.options.length) badAns++;
  }
}
if (badAns) fails.push(`${badAns} 道练习题答案缺失或越界`);

const old = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10);
const badDate = items.filter((it) => !/^\d{4}-\d{2}-\d{2}$/.test(it.date || '') || it.date < old).length;
if (badDate) fails.push(`${badDate} 篇日期异常`);

log(`校验：${items.length} 篇 / ${withPractice} 篇带练习 / 平均 ${Math.round(items.reduce((a, b) => a + (b.text || '').length, 0) / Math.max(1, items.length))} 字`);

if (fails.length) {
  log('✗ 校验未通过，保留上一版：');
  for (const f of fails) log('   -', f);
  if (fs.existsSync(backup)) fs.copyFileSync(backup, OUT);
  process.exit(1);
}

/* ---------- ③ 同步三份（原子写） ---------- */
const buf = fs.readFileSync(OUT);
for (const dst of COPIES) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = dst + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dst);
}
const hashes = COPIES.map(md5);
if (new Set(hashes).size !== 1) {
  log('✗ 三份拷贝 md5 不一致：', hashes.join(' '));
  process.exit(1);
}
log('✓ 三份已同步', hashes[0].slice(0, 12));

/* ---------- ④ 内容没变就不提交 ---------- */
const st = spawnSync('git', ['status', '--porcelain', '--', 'release/politics.json'], { cwd: ROOT, encoding: 'utf8' });
const dirty = (st.stdout || '').trim().length > 0;
if (!dirty) {
  log('✓ 内容无变化，跳过提交');
  process.exit(0);
}
if (NO_PUSH) {
  log('✓ 文件已更新（--no-push，未提交）');
  process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
const add = spawnSync('git', ['add', 'release/politics.json'], { cwd: ROOT, stdio: 'inherit' });
if (add.status !== 0) { log('✗ git add 失败'); process.exit(1); }
const msg = `chore(politics): 时政自动更新 ${stamp}（${items.length} 篇）`;
const cm = spawnSync('git', ['-c', 'user.name=CHAOYUE116', '-c', 'user.email=chaoyue116@users.noreply.github.com', 'commit', '-m', msg], { cwd: ROOT, stdio: 'inherit' });
if (cm.status !== 0) { log('✗ git commit 失败'); process.exit(1); }
const push = spawnSync('git', ['-c', 'http.proxy=http://127.0.0.1:18926', 'push', 'origin', 'main'], { cwd: ROOT, stdio: 'inherit' });
if (push.status !== 0) { log('✗ git push 失败'); process.exit(1); }
log('✓ 已推送，raw 约 1 分钟内生效');
log(`  最新：${items[0]?.date} ${items[0]?.title}`);
