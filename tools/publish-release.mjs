/**
 * tools/publish-release.mjs —— 建 Release + 上传资产 + 写更新日志
 *
 * 用 curl.exe 走本地代理（Node 的 fetch 不读 http_proxy，本机也没装 undici）。
 *
 * 用法：
 *   $env:GH_TOKEN='github_pat_...'
 *   node tools/publish-release.mjs --tag tiku-0.5.3-20261109-1019 \
 *        --name "题库 0.5.3 / App 0.1.42" --dir D:\rel2 \
 *        --files "tiku_app.db.gz,images.db.gz,delta-xxx.json.gz,manifest.json,shangan-0.1.42-release.apk" \
 *        --body-file RELEASE_NOTES.md [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OWNER = 'CHAOYUE116';
const REPO = 'shangan';

const args = process.argv.slice(2);
const arg = (k, d = '') => {
  const i = args.indexOf('--' + k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const flag = (k) => args.includes('--' + k);

const TAG = arg('tag');
const NAME = arg('name', TAG);
const DIR = arg('dir', 'D:\\rel2');
const FILES = arg('files', '').split(',').map((s) => s.trim()).filter(Boolean);
const BODY_FILE = arg('body-file', '');
const PROXY = arg('proxy', 'http://127.0.0.1:18926');
const TOKEN = process.env.GH_TOKEN || '';
const DRY = flag('dry');

if (!TAG) { console.error('缺 --tag'); process.exit(1); }
if (!TOKEN) { console.error('缺环境变量 GH_TOKEN'); process.exit(1); }

function curl(argv, { binary = false } = {}) {
  const full = ['-s', '--ssl-no-revoke', '-x', PROXY, ...argv];
  const out = execFileSync('curl.exe', full, {
    maxBuffer: 64 * 1024 * 1024,
    encoding: binary ? 'buffer' : 'utf8',
  });
  return out;
}

function apiGet(url) {
  const t = curl(['-H', `Authorization: Bearer ${TOKEN}`, '-H', 'Accept: application/vnd.github+json', url]);
  try { return JSON.parse(t); } catch { return null; }
}

function apiJson(method, url, body) {
  const t = curl([
    '-X', method, url,
    '-H', `Authorization: Bearer ${TOKEN}`,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'Content-Type: application/json',
    '--data-binary', '@-',
  ], {});
  return t;
}

// ── 1. 找或建 Release ─────────────────────────────
let rel = apiGet(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(TAG)}`);
if (rel && rel.id) {
  console.log(`已存在 Release id=${rel.id}`);
} else {
  let body = '';
  if (BODY_FILE && fs.existsSync(BODY_FILE)) body = fs.readFileSync(BODY_FILE, 'utf8');
  const payloadFile = path.join(process.env.TEMP || '.', 'rel-payload.json');
  fs.writeFileSync(payloadFile, JSON.stringify({
    tag_name: TAG, name: NAME, body, draft: false, prerelease: false,
  }), 'utf8');
  if (DRY) {
    console.log('[dry] 将创建 Release', TAG, '| body', body.length, '字符');
  } else {
    const t = curl([
      '-X', 'POST', `https://api.github.com/repos/${OWNER}/${REPO}/releases`,
      '-H', `Authorization: Bearer ${TOKEN}`,
      '-H', 'Accept: application/vnd.github+json',
      '-H', 'Content-Type: application/json',
      '--data-binary', `@${payloadFile}`,
    ]);
    try { rel = JSON.parse(t); } catch { }
    if (!rel || !rel.id) { console.error('建 Release 失败:', String(t).slice(0, 400)); process.exit(1); }
    console.log(`✓ 新建 Release id=${rel.id}`);
  }
}

if (DRY) { console.log('[dry] 结束'); process.exit(0); }

// ── 2. 传资产（同名先删） ──────────────────────────
const list = apiGet(`https://api.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?per_page=100`) || [];
const existing = new Map(list.map((a) => [a.name, a.id]));

for (const f of FILES) {
  const p = path.join(DIR, f);
  if (!fs.existsSync(p)) { console.log(`跳过（不存在）${f}`); continue; }
  if (existing.has(f)) {
    curl(['-X', 'DELETE', `https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/${existing.get(f)}`,
      '-H', `Authorization: Bearer ${TOKEN}`]);
    console.log(`  删旧 ${f}`);
  }
  const size = fs.statSync(p).size;
  const t = curl([
    '-X', 'POST',
    `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(f)}`,
    '-H', `Authorization: Bearer ${TOKEN}`,
    '-H', 'Content-Type: application/octet-stream',
    '--data-binary', `@${p}`,
  ]);
  if (String(t).includes('"state":"uploaded"')) {
    console.log(`✓ ${f}  ${(size / 1048576).toFixed(2)} MB`);
  } else {
    console.error(`✗ ${f}  ${String(t).slice(0, 200)}`);
  }
}

// ── 3. 回写 Release body（详细更新日志） ───────────
if (BODY_FILE && fs.existsSync(BODY_FILE)) {
  const body = fs.readFileSync(BODY_FILE, 'utf8');
  const payloadFile = path.join(process.env.TEMP || '.', 'rel-body.json');
  fs.writeFileSync(payloadFile, JSON.stringify({ body }), 'utf8');
  const t = curl([
    '-X', 'PATCH', `https://api.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}`,
    '-H', `Authorization: Bearer ${TOKEN}`,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'Content-Type: application/json',
    '--data-binary', `@${payloadFile}`,
  ]);
  if (String(t).includes('"id"')) console.log(`✓ Release 日志已写入（${body.length} 字符）`);
  else console.error('✗ 写日志失败', String(t).slice(0, 200));
}

console.log(`\nhttps://github.com/${OWNER}/${REPO}/releases/tag/${TAG}`);
