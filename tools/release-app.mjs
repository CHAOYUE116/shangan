#!/usr/bin/env node
/**
 * tools/release-app.mjs — 给「App 大版本」开一个独立 Release
 *
 * 为什么要它：题库资产（tiku_app.db.gz / images.db.gz / delta）一直挂在题库 tag 上，
 * 每发一次 App 都往同一个 Release 里塞 APK，页面越滚越长、更新说明也被覆盖。
 * 现在按大版本切：0.4.x 全部落在 v0.4 这个 Release 里，题库资产留在题库 tag，互不干扰。
 *
 * 用法：
 *   node tools/release-app.mjs --tag v0.4 --name "上岸 0.4" --body-file notes/0.4.md \
 *        --apk D:\rel32\shangan-0.4.2-release.apk [--no-push] [--no-poll]
 *
 * 做的事：
 *   1) 建 Release（已存在就复用，只更新名字/正文）
 *   2) 上传 APK，删同名旧资产
 *   3) 把 manifest 的 app 段指到新 Release（tiku/images/delta 的地址不动）
 *   4) 提交 release/manifest.json 并 push
 *   5) 轮询 CDN，确认 app.url 指向本次文件
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OWNER = 'CHAOYUE116';
const REPO = 'shangan';
const PROXY = process.env.HTTPS_PROXY || 'http://127.0.0.1:18926';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const VERSION = arg('version', '');
const flag = (k) => argv.includes('--' + k);

const TAG = arg('tag');
const NAME = arg('name', TAG);
const BODY_FILE = arg('body-file');
const APK = arg('apk');
if (!TAG || !APK) { console.error('缺 --tag 或 --apk'); process.exit(1); }
if (!fs.existsSync(APK)) { console.error('APK 不存在：' + APK); process.exit(1); }

const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) { console.error('缺环境变量 GH_TOKEN'); process.exit(1); }

function curl(args) {
  const out = execFileSync('curl.exe', ['-s', '--ssl-no-revoke', '-x', PROXY, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out;
}
const apiJson = (method, url, body) => {
  const args = ['-X', method, '-H', 'Accept: application/vnd.github+json', '-H', `Authorization: Bearer ${TOKEN}`, '-H', 'X-GitHub-Api-Version: 2022-11-28'];
  if (body) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body));
  args.push(url);
  const out = curl(args).trim();
  return out ? JSON.parse(out) : null;
};

const apkBytes = fs.statSync(APK).size;
const apkSha = crypto.createHash('sha256').update(fs.readFileSync(APK)).digest('hex');
// 上传名统一成 shangan-<版本>-release.apk：本地 gradle 产物叫 app-release.apk，
// 直接传上去 Releases 里就只有一个 app-release.apk，用户翻历史版本时分不清哪个是哪个。
const apkName = /^app-(?:[a-z]+-)?release\.apk$/i.test(path.basename(APK))
  ? `shangan-${VERSION}-release.apk`
  : path.basename(APK);
const body = BODY_FILE && fs.existsSync(BODY_FILE) ? fs.readFileSync(BODY_FILE, 'utf8') : arg('body', '');

console.log(`== 1. Release ${TAG}`);
let rel = apiJson('GET', `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(TAG)}`);
if (!rel || rel.message === 'Not Found') {
  rel = apiJson('POST', `https://api.github.com/repos/${OWNER}/${REPO}/releases`, {
    tag_name: TAG, name: NAME, body, draft: false, prerelease: false,
  });
  if (!rel || !rel.id) { console.error('建 Release 失败'); process.exit(1); }
  console.log('  已新建 id=' + rel.id);
} else {
  rel = apiJson('PATCH', `https://api.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}`, { name: NAME, body });
  console.log('  已存在 id=' + rel.id + '，更新说明');
}

console.log(`== 2. 上传 ${apkName}（${(apkBytes / 1048576).toFixed(2)} MB）`);
const assets = apiJson('GET', `https://api.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?per_page=100`) || [];
for (const a of assets) {
  // 这个大版本 Release 只保留最新一个 APK，避免页面里堆一串旧包
  // app-release.apk 是早期脚本直接传 gradle 产物留下的名字，也一起清掉
  const isOldApk =
    (/^shangan-[\d.]+-release\.apk$/.test(a.name) || /^app-(?:[a-z]+-)?release\.apk$/i.test(a.name)) && a.name !== apkName;
  if (a.name === apkName || isOldApk) {
    curl(['-X', 'DELETE', '-H', `Authorization: Bearer ${TOKEN}`, `https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/${a.id}`]);
    console.log('  删旧资产 ' + a.name);
  }
}
curl(['-X', 'POST', '--data-binary', '@' + APK, '-H', 'Content-Type: application/octet-stream',
  '-H', `Authorization: Bearer ${TOKEN}`, '-H', 'Accept: application/vnd.github+json',
  `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(apkName)}`]);
console.log('  ✓ ' + apkName);

console.log('== 3. manifest app 段 → 新 Release');
const repoManifest = path.join(ROOT, 'release', 'manifest.json');
const distManifest = path.resolve(ROOT, '..', 'dist', 'release', 'manifest.json');
const m = JSON.parse(fs.readFileSync(repoManifest, 'utf8').replace(/^\uFEFF/, ''));
const dl = `https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${apkName}`;
const code = Number(arg('code', (m.app || {}).versionCode || 0));
m.app = {
  ...(m.app || {}),
  version: arg('version', (m.app || {}).version),
  versionCode: code,
  // 老字段 code 与 versionCode 必须同步：客户端两个都读过，只改一个会出现「版本 0.4.3、code 还是上一版」
  code,
  name: apkName,
  size: apkBytes,
  sha256: apkSha,
  url: dl,
  sources: [
    { name: 'gh-proxy', url: 'https://gh-proxy.com/' + dl },
    { name: 'github', url: dl },
  ],
};
m.note = arg('note', m.note);
m.app.note = arg('note', m.app.note || m.note);
for (const f of [repoManifest, distManifest]) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(m, null, 2));
}
console.log(`  app ${m.app.version}(${m.app.versionCode}) ${apkSha.slice(0, 12)} ${(apkBytes / 1048576).toFixed(2)} MB`);
console.log('  tiku 段未改动：' + (m.tiku && m.tiku.dbVersion));

if (!flag('no-push')) {
  console.log('== 4. 提交并推送 manifest');
  try {
    execFileSync('git', ['-c', 'http.proxy=' + PROXY, 'add', 'release/manifest.json'], { cwd: ROOT });
    execFileSync('git', ['-c', 'http.proxy=' + PROXY, 'commit', '-q', '-m', `release: manifest 指向 App ${m.app.version}(${m.app.versionCode}) / ${TAG}`], { cwd: ROOT });
    execFileSync('git', ['-c', 'http.proxy=' + PROXY, 'push', 'origin', 'main'], { cwd: ROOT, stdio: 'inherit' });
  } catch (e) { console.error('  push 失败：' + e.message); }
}

if (!flag('no-poll')) {
  console.log('== 5. 轮询 CDN');
  const raw = 'https://raw.githubusercontent.com/' + OWNER + '/' + REPO + '/main/release/manifest.json';
  for (let i = 1; i <= 20; i++) {
    const txt = curl(['-H', 'Cache-Control: no-cache', raw + '?t=' + Date.now()]);
    try {
      const live = JSON.parse(txt.replace(/^\uFEFF/, ''));
      if (String(live.app?.url || '').includes(apkName)) {
        console.log(`  ✓ 第 ${i} 次命中：app ${live.app.version}(${live.app.versionCode}) ${String(live.app.sha256).slice(0, 12)}`);
        process.exit(0);
      }
    } catch { /* 缓存里还是旧内容 */ }
    console.log(`  第 ${i} 次还是旧的，等 20 秒`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
  }
  console.error('  CDN 20 次都没刷新，稍后手动确认');
  process.exit(2);
}
