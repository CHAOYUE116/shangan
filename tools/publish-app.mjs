#!/usr/bin/env node
/**
 * tools/publish-app.mjs —— App 发版一条命令走完（把踩过的坑固化进顺序里）
 *
 * 以前每次发版要手工做的事，以及为什么必须按这个顺序：
 *
 *   1. bump-version        改 public/next/app.js 里的 APP_VERSION 与 android 的 versionCode
 *   2. sync-webapp         把 public/next/* 映射到 webapp/，否则装到手机上的是旧 JS
 *   3. robocopy            webapp → android/app/src/main/assets/public（/MIR 会删掉残留）
 *   4. gradlew             打出 APK
 *   5. fix-manifest        先修增量包的 sha 语义（App 是先解压再算 sha256，所以
 *                          delta.sha256 必须是 rawSha，不是 .gz 的哈希）并统一源顺序
 *   6. 补 app 段           **必须在 fix-manifest 之后**：fix-manifest 会对 app.sources
 *                          重新排序，并用 sources[0] 反推出 app.url。如果先改 app.url
 *                          再跑它，url 会被旧 APK 的文件名覆盖，结果就是
 *                          「提示更新 → 下到旧包 → sha 校验失败」
 *   7. 上传资产            同名资产会被 publish-release 自动删掉重建
 *   8. commit + push       manifest 必须进仓库，App 是从 raw.githubusercontent 读的
 *   9. 轮询 CDN            带 cache-buster 反复取，直到 app.url 里出现本次文件名。
 *                          raw 有 2–3 分钟缓存，不轮询就等于「以为发了其实没发」
 *
 * 用法：
 *   $env:GH_TOKEN='github_pat_...'
 *   node tools/publish-app.mjs --version 0.3.14 --code 84 --note "本次改了什么"
 *        [--tag tiku-0.5.16-20261110-2340]   # 默认取 manifest 里的 tiku 版本
 *        [--dir D:\rel29]                    # 默认自动找下一个空目录
 *        [--skip-build]                      # 复用已打好的 APK
 *        [--no-push]                         # 只写文件不提交（调试用）
 *        [--no-poll]                         # 不轮询 CDN
 *        [--dry]                             # 只打印计划
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APP_ROOT = path.resolve(ROOT, '../app-shangan');
const ANDROID = path.join(APP_ROOT, 'android');
const WEBAPP = path.resolve(ROOT, '../webapp');
const ASSETS = path.join(ANDROID, 'app/src/main/assets/public');
const APK = path.join(ANDROID, 'app/build/outputs/apk/release/app-release.apk');
const DIST = path.resolve(ROOT, '../dist/release');
const DIST_MANIFEST = path.join(DIST, 'manifest.json');
const REPO_MANIFEST = path.join(ROOT, 'release/manifest.json');
const PROXY = 'http://127.0.0.1:18926';

const args = process.argv.slice(2);
const arg = (k, d = '') => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const flag = (k) => args.includes('--' + k);

const VERSION = arg('version');
const CODE = Number(arg('code', '0'));
const NOTE = arg('note', '');
const SKIP_BUILD = flag('skip-build');
const NO_PUSH = flag('no-push');
const NO_POLL = flag('no-poll');
const DRY = flag('dry');
const TOKEN = process.env.GH_TOKEN || '';

if (!VERSION || !CODE) {
  console.error('用法：node tools/publish-app.mjs --version 0.3.14 --code 84 [--note "..."]');
  process.exit(1);
}

const log = (s) => console.log(s);
const step = (n, s) => console.log(`\n== ${n}. ${s}`);
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { cwd: ROOT, stdio: 'inherit', ...opts });

function robocopy(src, dst) {
  try {
    execFileSync('robocopy', [src, dst, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'ignore' });
  } catch (e) {
    // robocopy 用 0–7 表示成功（1=有文件被复制），>=8 才是真失败
    if (typeof e.status === 'number' && e.status < 8) return;
    throw e;
  }
}

function pickDir() {
  const given = arg('dir', '');
  if (given) return given;
  for (let i = 20; i < 90; i++) {
    const d = `D:\\rel${i}`;
    if (!fs.existsSync(d) || fs.readdirSync(d).length === 0) return d;
  }
  return 'D:\\rel90';
}

const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ── 0. 前置检查 ────────────────────────────────────
const appJs = fs.readFileSync(path.join(ROOT, 'public/next/app.js'), 'utf8');
const curVer = (/const APP_VERSION = '([^']+)'/.exec(appJs) || [])[1] || '';
if (curVer !== VERSION) {
  log(`public/next/app.js 里还是 ${curVer}，先跑 bump-version`);
  if (!DRY) run('node', ['tools/bump-version.mjs', VERSION, String(CODE)]);
}

const baseManifest = JSON.parse(fs.readFileSync(DIST_MANIFEST, 'utf8').replace(/^\uFEFF/, ''));
// manifest 里题库版本字段叫 tiku.dbVersion（不是 version），tag 由它拼出来
const tikuVersion = (baseManifest.tiku && (baseManifest.tiku.dbVersion || baseManifest.tiku.version)) || '';
const TAG = arg('tag', tikuVersion ? `tiku-${tikuVersion}` : '');
if (!TAG) { console.error('manifest 里没有 tiku.version，请用 --tag 指定'); process.exit(1); }
const APK_NAME = `shangan-${VERSION}-release.apk`;
const OUT_DIR = pickDir();

log(`App ${VERSION}(${CODE}) → tag ${TAG}`);
log(`APK  ${APK}`);
log(`暂存 ${OUT_DIR}`);

if (DRY) { log('\n[dry] 到此为止'); process.exit(0); }

// ── 1–4. 构建 ──────────────────────────────────────
if (!SKIP_BUILD) {
  step(2, 'sync-webapp');
  run('node', ['tools/sync-webapp.mjs']);
  step(3, 'robocopy → android assets');
  robocopy(WEBAPP, ASSETS);
  step(4, 'gradlew assembleRelease');
  run(process.platform === 'win32' ? 'cmd.exe' : 'sh',
    process.platform === 'win32' ? ['/c', path.join(ANDROID, 'gradlew.bat'), 'assembleRelease'] : [path.join(ANDROID, 'gradlew'), 'assembleRelease'],
    { cwd: ANDROID, env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME || 'D:\\dev\\jdk17' } });
} else {
  step(1, '跳过构建，复用现有 APK');
}

if (!fs.existsSync(APK)) { console.error(`找不到 APK：${APK}`); process.exit(1); }
const apkSize = fs.statSync(APK).size;
const apkSha = sha256File(APK);
log(`APK ${(apkSize / 1048576).toFixed(2)} MB  sha256=${apkSha.slice(0, 12)}`);

// ── 5. fix-manifest（必须先跑，它会把 app.url 改成 sources[0]） ──
step(5, 'fix-manifest：修 delta 的 raw sha + 源顺序');
run('node', ['tools/fix-manifest.mjs']);

// ── 6. 补 app 段（放在 fix 之后，才不会被覆盖） ────
step(6, '写 app 段（url 指本次 APK）');
const base = `https://github.com/CHAOYUE116/shangan/releases/download/${TAG}/${APK_NAME}`;
for (const p of [DIST_MANIFEST, REPO_MANIFEST]) {
  const m = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  m.app = {
    ...m.app,
    version: VERSION,
    versionCode: CODE,
    code: CODE,
    name: APK_NAME,
    size: apkSize,
    sha256: apkSha,
    url: base,
    sources: [
      { url: `https://gh-proxy.com/${base}`, kind: 'gh-proxy' },
      { url: base, kind: 'github' },
    ],
    ...(NOTE ? { note: NOTE } : {}),
  };
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n', 'utf8');
  log(`  ✓ ${p}`);
}

// 自检：url 必须指向本次文件、sha/size 一致、delta 的 sha 与 gz 不同
const chk = JSON.parse(fs.readFileSync(REPO_MANIFEST, 'utf8').replace(/^\uFEFF/, ''));
const bad = [];
if (!String(chk.app.url).endsWith(APK_NAME)) bad.push('app.url 没指向本次 APK');
if (chk.app.sha256 !== apkSha) bad.push('app.sha256 与文件不符');
if (chk.app.size !== apkSize) bad.push('app.size 与文件不符');
for (const d of (chk.tiku.delta || [])) if (!d.sha256 || d.sha256 === d.gzSha256) bad.push(`delta ${d.from} 的 sha256 还是 gz 的哈希`);
if (bad.length) { console.error('✗ 自检失败：' + bad.join('；')); process.exit(1); }
log('  ✓ 自检通过（url / sha / size / delta 语义）');

// ── 7. 暂存 + 上传 ─────────────────────────────────
step(7, `暂存到 ${OUT_DIR}`);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.copyFileSync(APK, path.join(OUT_DIR, APK_NAME));
fs.copyFileSync(REPO_MANIFEST, path.join(OUT_DIR, 'manifest.json'));
if (flag('no-upload')) {
  log('  （--no-upload：跳过上传）');
} else {
  if (!TOKEN) { console.error('缺环境变量 GH_TOKEN'); process.exit(1); }
  run('node', ['tools/publish-release.mjs', '--tag', TAG, '--name', `App ${VERSION}`, '--dir', OUT_DIR, '--files', `manifest.json,${APK_NAME}`], {
    env: { ...process.env, GH_TOKEN: TOKEN, HTTP_PROXY: process.env.HTTP_PROXY || PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY || PROXY },
  });
}

// ── 8. commit + push ───────────────────────────────
if (!NO_PUSH) {
  step(8, '提交并推送 manifest');
  try {
    run('git', ['add', 'release/manifest.json']);
    run('git', ['-c', 'user.name=dev', '-c', 'user.email=dev@local', 'commit', '-m', `release: manifest 指向 App ${VERSION}(${CODE})`]);
  } catch { log('  （没有可提交的改动）'); }
  run('git', ['-c', `http.proxy=${PROXY}`, 'push', 'origin', 'main'], { stdio: 'inherit' });
}

// ── 9. 轮询 CDN ────────────────────────────────────
if (!NO_POLL && !NO_PUSH) {
  step(9, '轮询 CDN 直到 apps.url 指向新包（raw 有 2–3 分钟缓存）');
  const url = 'https://raw.githubusercontent.com/CHAOYUE116/shangan/main/release/manifest.json';
  let ok = false;
  for (let i = 1; i <= 20; i++) {
    const ts = Date.now();
    let body = '';
    try {
      body = execFileSync('curl.exe', ['-s', '--ssl-no-revoke', '-x', PROXY, `${url}?cb=${ts}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    } catch { /* 网络抖动，下一轮 */ }
    let m = null;
    try { m = JSON.parse(body.replace(/^\uFEFF/, '')); } catch { /* ignore */ }
    if (m && m.app && String(m.app.url).endsWith(APK_NAME) && m.app.sha256 === apkSha) {
      log(`  ✓ 第 ${i} 次命中：app ${m.app.version}(${m.app.versionCode}) ${m.app.sha256.slice(0, 12)}`);
      ok = true;
      break;
    }
    log(`  第 ${i} 次仍是旧清单，20s 后重试`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
  }
  if (!ok) { console.error('✗ CDN 仍未刷新，等几分钟后用 --no-poll 重跑校验'); process.exit(1); }
}

log(`\n完成：App ${VERSION}(${CODE})  sha256=${apkSha}`);
log(`Release  https://github.com/CHAOYUE116/shangan/releases/tag/${TAG}`);
log(`回滚    把 manifest 的 app 段改回上一个 APK 即可（Release 里旧的几位 APK 可保留两版）`);
