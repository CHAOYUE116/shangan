#!/usr/bin/env node
/**
 * tools/sync-webapp.mjs — 源码 → webapp/ 同步 + 一致性校验
 *
 * 背景：public/next/ 是前端唯一真源，webapp/ 是 Capacitor 实际 webDir，
 *       两处靠手工 Copy-Item 同步，漏一个文件就会把旧代码打进 APK
 *       （0.1.9 就是这么丢掉了 GET /search 和 POST /ai/chat）。
 *
 * 用法：
 *   node tools/sync-webapp.mjs            把清单里的文件复制到 webapp/
 *   node tools/sync-webapp.mjs --check    只校验，不一致则退出码 1（构建前用）
 *   node tools/sync-webapp.mjs --assets   连 app-assets 一起同步（排除 .gz）
 *   node tools/sync-webapp.mjs --check --assets
 *
 * 约定：webapp/legacy/（旧前端）、vendor/（第三方）、app-assets/skill-*.json
 *       （build-skill-bundle.mjs 生成）不归本脚本管。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEBAPP = path.resolve(ROOT, '..', 'webapp');

const checkOnly = process.argv.includes('--check');
// 默认连 app-assets 一起同步：漏掉它会让 APK 里一直躺着一份旧题库
// （0.3.2 之前打进包里的还是 0.5.0 的库，新装用户拿到 10 万行旧数据）。
const withAssets = !process.argv.includes('--no-assets');

/** 源（相对 kaogong-shuati/） → webapp 内的相对路径 */
const FILES = [
  ['public/next/index.html', 'index.html'],
  ['public/next/app.js', 'app.js'],
  ['public/next/style.css', 'style.css'],
  ['public/next/sw-local.js', 'sw-local.js'],
  ['public/next/qc-counts.json', 'qc-counts.json'],
  ['public/local-bootstrap.js', 'local-bootstrap.js'],
  ['public/local-api.js', 'local-api.js'],
  ['public/local-handler.js', 'local-handler.js'],
  ['public/ai-local.js', 'ai-local.js'],
  ['public/ai-agents.default.json', 'ai-agents.default.json'],
  ['public/backup.js', 'backup.js'],
  ['public/idb-store.js', 'idb-store.js'],
  ['public/sqljs-engine.js', 'sqljs-engine.js'],
  ['public/crop-math.js', 'crop-math.js'],
  ['public/lib/local-queries.js', 'lib/local-queries.js'],
  ['public/lib/custom-parser.js', 'lib/custom-parser.js'],
  ['public/lib/fenbi-tree.js', 'lib/fenbi-tree.js'],
  ['public/lib/skill-importer.js', 'lib/skill-importer.js'],
  ['public/lib/xingce-chapter-map.js', 'lib/xingce-chapter-map.js'],
];

/** 打进 APK 的离线题库资产（.gz 一律不同步，否则 Android 资源合并报 Duplicate） */
const ASSETS = [
  ['app-assets/tiku_app.db', 'app-assets/tiku_app.db'],
  ['app-assets/images.db', 'app-assets/images.db'],
  ['app-assets/db-version.txt', 'app-assets/db-version.txt'],
  ['app-assets/report.json', 'app-assets/report.json'],
  ['app-assets/politics.json', 'app-assets/politics.json'],
];

const hash = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

function walk(list) {
  const rows = [];
  for (const [srcRel, dstRel] of list) {
    const src = path.join(ROOT, srcRel);
    const dst = path.join(WEBAPP, dstRel);
    if (!fs.existsSync(src)) { rows.push({ dstRel, state: '源文件缺失', src, dst }); continue; }
    if (!fs.existsSync(dst)) { rows.push({ dstRel, state: 'webapp 缺失', src, dst }); continue; }
    const same = hash(src) === hash(dst);
    rows.push({
      dstRel,
      state: same ? 'ok' : '不一致',
      src,
      dst,
      srcSize: fs.statSync(src).size,
      dstSize: fs.statSync(dst).size,
    });
  }
  return rows;
}

function report(rows, label) {
  const bad = rows.filter((r) => r.state !== 'ok');
  console.log(`\n=== ${label}（${rows.length} 个文件）===`);
  for (const r of rows) {
    if (r.state === 'ok') continue;
    const size = r.srcSize != null ? `  ${r.srcSize} → ${r.dstSize} 字节` : '';
    console.log(`  ✗ ${r.dstRel.padEnd(28)} ${r.state}${size}`);
  }
  if (!bad.length) console.log('  ✓ 全部一致');
  return bad;
}

const jobs = withAssets ? [...FILES, ...ASSETS] : FILES;

if (checkOnly) {
  const bad = report(walk(jobs), 'webapp 一致性校验');
  if (bad.length) {
    console.log('\n处理：node tools/sync-webapp.mjs' + (withAssets ? ' --assets' : '') + '  然后重跑 --check');
    process.exit(1);
  }
  process.exit(0);
}

// ---- 同步 ----
let copied = 0;
const missing = [];
for (const [srcRel, dstRel] of jobs) {
  const src = path.join(ROOT, srcRel);
  const dst = path.join(WEBAPP, dstRel);
  if (!fs.existsSync(src)) { missing.push(srcRel); continue; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const before = fs.existsSync(dst) ? hash(dst) : null;
  const after = hash(src);
  if (before === after) continue;
  fs.copyFileSync(src, dst);
  copied += 1;
  console.log(`  → ${dstRel}  ${before ? '更新' : '新增'}`);
}
if (missing.length) {
  console.log('\n源文件不存在（跳过）：' + missing.join(', '));
  process.exit(1);
}

// 同步后清掉 webapp/app-assets 里的 .gz，避免 Duplicate resources
if (withAssets) {
  const gzDir = path.join(WEBAPP, 'app-assets');
  if (fs.existsSync(gzDir)) {
    for (const f of fs.readdirSync(gzDir).filter((n) => n.endsWith('.gz'))) {
      fs.unlinkSync(path.join(gzDir, f));
      console.log(`  → 删除 ${f}（.gz 不能进 assets）`);
    }
  }
}

console.log(`\n完成：${copied} 个文件已更新，其余已是最新。`);
console.log('下一步：cd ..\\app-shangan; npx cap copy android');
