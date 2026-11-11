#!/usr/bin/env node
/**
 * tools/fix-manifest.mjs — 把 manifest 里两件「生成脚本总会搞错」的事修正掉
 *
 * 1) 增量包的 sha 语义：App 下载完会先解压再算 sha256，所以
 *    delta.sha256 必须是**解压后**内容的哈希（meta 里的 rawSha），
 *    gzSha256 才是 .gz 文件本身的哈希。生成脚本只会填 .gz 的，于是
 *    设备端每次都「增量包校验失败，已丢弃」。
 * 2) 下载源顺序：jsDelivr 对 release 里 20MB+ 的文件直接 403，
 *    排在前面等于每次白等一次超时，甚至把 177 字节的错误页当分块。
 *    顺序固定 gh-proxy > github > jsdelivr。
 *
 * 用法：node tools/fix-manifest.mjs [--manifest <路径>]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.resolve(ROOT, '../dist/release');
const RELEASE = path.resolve(ROOT, 'release/manifest.json');

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : dflt;
};

const manifestPath = arg('manifest', path.join(DIST, 'manifest.json'));
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const bin = (name) => path.join(DIST, name);
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const KIND_ORDER = { 'gh-proxy': 0, github: 1, jsdelivr: 2 };
function sortSources(node) {
  if (!node || !Array.isArray(node.sources)) return node;
  node.sources.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9));
  if (node.sources.length) node.url = node.sources[0].url;
  return node;
}

// 1) 增量包：按同名 .meta.json 修正 sha 语义
const deltas = Array.isArray(m.tiku?.delta) ? m.tiku.delta : [];
for (const d of deltas) {
  const metaFile = bin(d.url.split('/').pop().replace(/\.json\.gz$/, '.meta.json'));
  if (!fs.existsSync(metaFile)) { console.log(`  跳过（无 meta）：${path.basename(metaFile)}`); continue; }
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const gzFile = bin(meta.url);
  const gzSha = meta.sha256 || sha256(gzFile);
  // 解压后内容的哈希：App 是先解压再算 sha256 的
  const rawSha = meta.rawSha256 || crypto.createHash('sha256').update(zlib.gunzipSync(fs.readFileSync(gzFile))).digest('hex');
  d.sha256 = rawSha;
  d.gzSha256 = gzSha;
  d.size = meta.size;
  d.rawSize = meta.rawSize;
  console.log(`  delta ${d.from} → ${d.to}：sha256=${rawSha.slice(0, 12)} gz=${gzSha.slice(0, 12)} raw=${meta.rawSize} gz=${meta.size}`);
}

// 2) 所有下载节点统一排序
for (const key of ['app', 'tiku', 'images']) {
  if (m[key]) sortSources(m[key]);
}
for (const d of deltas) sortSources(d);

// 3) 一致性自检
const problems = [];
if (!m.app?.sha256) problems.push('app.sha256 为空');
for (const d of deltas) {
  if (!d.sha256 || d.sha256 === d.gzSha256) problems.push(`delta ${d.from} 的 sha256 仍是 .gz 的哈希`);
}
if (problems.length) {
  console.error('✗ ' + problems.join('；'));
  process.exit(1);
}

fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n', 'utf8');
fs.mkdirSync(path.dirname(RELEASE), { recursive: true });
fs.copyFileSync(manifestPath, RELEASE);
console.log(`✓ ${manifestPath}\n✓ ${RELEASE}\n  app ${m.app.version} ${m.app.sha256.slice(0, 12)} / tiku ${m.tiku.dbVersion || m.tiku.version || '?'}`);
