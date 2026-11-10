#!/usr/bin/env node
/**
 * tools/build-release-manifest.mjs — 生成题库/APP 在线更新清单
 *
 * 用途：把 app-assets 里的题库产物 + APK 打成一份 manifest.json，
 *       App 启动时拉这份清单比对版本，决定是否下载更新。
 *
 * 产物结构：
 *   dist/release/
 *     manifest.json          版本清单（App 只读这个）
 *     tiku_app.db.gz         题库压缩包（全量）
 *     tiku_app.db.delta.json 增量补丁（可选，见 --delta-from）
 *
 * manifest 结构：
 *   {
 *     "schema": 1,
 *     "app":   { "version": "0.1.11", "versionCode": 12, "url": "...", "size": 0, "sha256": "..." },
 *     "tiku":  { "dbVersion": "0.2.0-20261108", "questions": 60644,
 *                "full":  { "url": "...", "size": 0, "sha256": "...", "gz": true },
 *                "delta": [ { "from": "0.1.1-20261108-0105", "url": "...", "size": 0, "sha256": "..." } ] },
 *     "images":{ "url": "...", "size": 0, "sha256": "..." },
 *     "mirrors": ["https://cdn.jsdelivr.net/gh/USER/REPO@main/dist/release/", "..."],
 *     "note": "更新说明",
 *     "publishedAt": "2026-11-08T15:30:00Z"
 *   }
 *
 * 用法：
 *   node tools/build-release-manifest.mjs --base https://github.com/USER/REPO/releases/download/tiku-2026.11.08
 *   node tools/build-release-manifest.mjs --base ... --apk ../dist/shangan-0.1.11-release.apk --note "新增职测 370 题"
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (n) => argv.includes('--' + n);

const BASE = arg('base', '').replace(/\/$/, '');
const APK = arg('apk', '');
const NOTE = arg('note', '');
// github.com / objects.githubusercontent.com 在国内多数网络不可达（模拟器实测 connect timeout），
// Release 直链只能当兜底；主地址一律走 gh-proxy 或 jsDelivr。
const PROXY = (u) => `https://gh-proxy.com/${u}`;
// jsDelivr 只服务仓库内文件：delta 体积小、已提交到 release/ 目录，走它最稳
const JSDELIVR = (f) => `https://cdn.jsdelivr.net/gh/CHAOYUE116/shangan@main/release/${f}`;

// 候选下载源。App 端（0.1.53+）会并发测速后挑最快的那个，不是死用第一个。
// 实测差异极大：同一台机器、同一个文件，直连 release-assets.githubusercontent.com
// 能跑 8.8 MB/s，gh-proxy 在 0.15~4.8 MB/s 之间抖（公共反代，看它机房当时忙不忙）。
// 所以 url 字段保留给老版本 App 兜底，新版本看 sources。
const SOURCES = (file) => [
  { url: `${BASE}/${file}`, kind: 'github' },
  { url: PROXY(`${BASE}/${file}`), kind: 'gh-proxy' },
];
const OUT = path.resolve(ROOT, arg('out', '../dist/release'));
const ASSETS = path.resolve(ROOT, 'app-assets');

if (!BASE) {
  console.error('✗ 需要 --base <Release 下载地址前缀>，例如：');
  console.error('  --base https://github.com/你的用户名/你的仓库/releases/download/tiku-2026.11.08');
  process.exit(1);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

fs.mkdirSync(OUT, { recursive: true });

// ---------- 题库 ----------
const dbPath = path.join(ASSETS, 'tiku_app.db');
const verPath = path.join(ASSETS, 'db-version.txt');
const imgPath = path.join(ASSETS, 'images.db');
for (const p of [dbPath, verPath]) {
  if (!fs.existsSync(p)) { console.error('✗ 缺少', p, '（先跑 node build-app-assets.mjs app-assets --skip-download）'); process.exit(1); }
}

const dbBuf = fs.readFileSync(dbPath);
// db-version.txt 现在的格式是「版本号 题行数 分类行数」（App 端用它校验库内容是否被换过），
// 取第一段才是版本号；只取整行会让后面所有 delta 匹配不上。
const dbVersion = fs.readFileSync(verPath, 'utf8').trim().split(/\s+/)[0];
const dbHash = sha256(dbBuf);
console.log(`题库：${dbPath}`);
console.log(`  db-version: ${dbVersion}`);
console.log(`  原始 ${mb(dbBuf.length)}  sha256=${dbHash.slice(0, 16)}…`);

// 压缩（aapt 打包时也会压，但更新走网络，gz 省一半）
const gzName = 'tiku_app.db.gz';
const gzPath = path.join(OUT, gzName);
if (flag('gz') || true) {
  fs.writeFileSync(gzPath, zlib.gzipSync(dbBuf, { level: 9 }));
  console.log(`  压缩 ${mb(fs.statSync(gzPath).size)} → ${gzName}`);
}

// 题量统计（用于 manifest 展示）
let questions = 0;
try {
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(dbPath, { readOnly: true });
  questions = d.prepare('SELECT COUNT(DISTINCT questionId) c FROM questions').get().c;
  d.close();
} catch { /* 忽略 */ }

const tiku = {
  dbVersion,
  questions,
  full: {
    url: PROXY(`${BASE}/${gzName}`),
    mirrors: [`${BASE}/${gzName}`],
    sources: SOURCES(gzName),
    size: fs.statSync(gzPath).size,
    // 同理：App 对 .gz 解压后校验 → 给 raw db 的 sha256
    sha256: dbHash,
    gzSha256: sha256(fs.readFileSync(gzPath)),
    gz: true,
    rawSize: dbBuf.length,
  },
  delta: [],
};

// ---------- 增量补丁 ----------
// 扫 dist/release 里已有的 delta-*.meta.json，自动登记到 manifest。
// 生成方式：node tools/build-tiku-delta.mjs --old <旧库> --new app-assets/tiku_app.db --from <旧版本> --to <新版本>
for (const f of fs.readdirSync(OUT)) {
  if (!f.endsWith('.meta.json') || !f.startsWith('delta-')) continue;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    if (!m.to || m.to !== dbVersion) continue;   // 只登记指向当前版本的增量
    const file = f.replace(/\.meta\.json$/, '.json.gz');
    if (!fs.existsSync(path.join(OUT, file))) continue;
    // App 端 download() 对 .gz 会自动解压，校验的是解压后的内容 → 这里必须给 raw 的 sha256
    const rawBuf = zlib.gunzipSync(fs.readFileSync(path.join(OUT, file)));
    tiku.delta.push({
      from: m.from,
      to: m.to,
      url: PROXY(`${BASE}/${file}`),
      mirrors: [JSDELIVR(file), `${BASE}/${file}`],
      sources: [{ url: JSDELIVR(file), kind: 'jsdelivr' }, ...SOURCES(file)],
      size: m.size,
      sha256: sha256(rawBuf),
      gzSha256: m.sha256,
      rawSize: m.rawSize,
      counts: m.counts,
    });
    console.log(`  增量 ${m.from} → ${m.to}  ${mb(m.size)}  ${file}`);
  } catch { /* 坏文件跳过 */ }
}
if (tiku.delta.length) console.log(`  共 ${tiku.delta.length} 个增量包可下发`);

// ---------- images.db ----------
let images = null;
if (fs.existsSync(imgPath)) {
  const b = fs.readFileSync(imgPath);
  images = { url: PROXY(`${BASE}/images.db.gz`), mirrors: [`${BASE}/images.db.gz`], sources: SOURCES('images.db.gz'), size: b.length, sha256: sha256(b), gz: true };
}

// ---------- APK ----------
let app = null;
if (APK && fs.existsSync(APK)) {
  const b = fs.readFileSync(APK);
  const gradle = fs.readFileSync(path.join(ROOT, '..', 'app-shangan', 'android', 'app', 'build.gradle'), 'utf8');
  const vc = Number((gradle.match(/versionCode\s+(\d+)/) || [])[1] || 0);
  const vn = (gradle.match(/versionName\s+"([^"]+)"/) || [])[1] || '';
  const apkName = path.basename(APK);
  app = { version: vn, versionCode: vc, url: `${BASE}/${apkName}`, sources: SOURCES(apkName), size: b.length, sha256: sha256(b) };
  console.log(`\nAPK：${path.basename(APK)}  v${vn}(${vc})  ${mb(b.length)}`);
}

const manifest = {
  schema: 1,
  publishedAt: new Date().toISOString(),
  app,
  tiku,
  images,
  mirrors: [],
  note: NOTE || `题库 ${dbVersion}，${questions} 题`,
};

const mPath = path.join(OUT, 'manifest.json');
fs.writeFileSync(mPath, JSON.stringify(manifest, null, 2));
console.log(`\n✓ manifest → ${mPath}`);
console.log(JSON.stringify(manifest, null, 2).slice(0, 700));
console.log('\n下一步：把 manifest.json + tiku_app.db.gz 传到 GitHub Release，');
console.log('        再把 manifest.json 提交到仓库（App 用 raw/jsDelivr 地址读它）。');
