import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const TOKEN = process.env.GH_TOKEN;
const OWNER = 'CHAOYUE116';
const REPO = 'shangan';
const TAG = 'tiku-0.5.1-20261108-2130';
const REL = 'D:/Projects/上岸APP/dist/release';
const API = 'https://api.github.com';

const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'shangan-release',
};

async function gh(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return { ok: r.ok, status: r.status, json, text };
}

// 1. images.db.gz（manifest 指向 images.db 原始文件，但 App 端按 gz 解压逻辑走，这里两个都传）
async function gzipIfNeeded(src, dst) {
  if (fs.existsSync(dst)) return dst;
  console.log('压缩', path.basename(src), '→', path.basename(dst));
  await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 6 }), fs.createWriteStream(dst));
  return dst;
}

const imagesRaw = 'D:/Projects/上岸APP/kaogong-shuati/app-assets/images.db';
const imagesGz = await gzipIfNeeded(imagesRaw, path.join(REL, 'images.db.gz'));
console.log('images.db.gz', (fs.statSync(imagesGz).size / 1048576).toFixed(1), 'MB');

// 2. 建 / 复用 Release
let rel = await gh(`${API}/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
if (rel.status === 404) {
  console.log('创建 release', TAG);
  rel = await gh(`${API}/repos/${OWNER}/${REPO}/releases`, {
    method: 'POST',
    body: JSON.stringify({
      tag_name: TAG,
      target_commitish: 'main',
      name: `题库 ${TAG.replace(/^tiku-/, '')}`,
      body: '题库 0.5.1：职测 6,338 题（放开 2015/2016 年份窗口 +821），新增 8 省真题 898 道，回填解析 4,693 条。\n\n增量包 712 KB，全量包 83.6 MB。',
      draft: false,
      prerelease: false,
    }),
  });
  if (!rel.ok) { console.error('创建失败', rel.status, rel.text.slice(0, 300)); process.exit(1); }
} else {
  console.log('复用已有 release', rel.json.id);
}
const uploadUrl = rel.json.upload_url.replace(/\{.*\}$/, '');

// 3. 逐个上传
const manifest = JSON.parse(fs.readFileSync(path.join(REL, 'manifest.json'), 'utf8'));
const files = [
  path.join(REL, 'tiku_app.db.gz'),
  imagesGz,
  path.join(REL, 'manifest.json'),
  'D:/Projects/上岸APP/dist/shangan-0.1.32-release.apk',
  path.join(REL, 'delta-0.4.4-20261108-1915-0.5.0-20261108-1955.json.gz'),
];

for (const f of files) {
  if (!fs.existsSync(f)) { console.log('跳过（不存在）', f); continue; }
  const name = path.basename(f);
  const buf = fs.readFileSync(f);
  const mb = (buf.length / 1048576).toFixed(1);
  process.stdout.write(`上传 ${name} (${mb} MB) … `);
  const r = await fetch(`${uploadUrl}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) },
    body: buf,
  });
  if (r.ok) console.log('✓');
  else console.log('✗', r.status, (await r.text()).slice(0, 200));
}

const final = await gh(`${API}/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
console.log('\nRelease:', final.json.html_url);
final.json.assets.forEach((a) => console.log(' ', a.name, (a.size / 1048576).toFixed(2), 'MB'));
