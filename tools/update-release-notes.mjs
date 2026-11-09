/**
 * tools/update-release-notes.mjs —— 把 CHANGELOG.md 的对应段落写进 GitHub Release 的 body
 *
 * 背景：Release 页面默认只有标题和一堆文件名，看不到「这次改了什么」。
 * CHANGELOG.md 里已经写得很细（每条都带根因），但那是仓库里的文件，用户点进
 * Release 页面时并不会去看。这个脚本把内容同步过去。
 *
 * 用法：
 *   node tools/update-release-notes.mjs                 # 用 manifest 里的版本，自动找 Release
 *   node tools/update-release-notes.mjs --id 438403919  # 指定 release id
 *   node tools/update-release-notes.mjs --dry           # 只打印，不提交
 *
 * 环境变量：GH_TOKEN（fine-grained PAT，需 Contents: Read and write）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPO = 'CHAOYUE116/shangan';
const TOKEN = process.env.GH_TOKEN || '';
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = (n) => argv.includes('--' + n);

/* ---------- 1. 读 manifest，确定这次是哪两个版本 ---------- */

const manifestPath = path.join(ROOT, 'release', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const appVer = manifest.app?.versionName || '';
const tikuVer = manifest.tiku?.dbVersion || '';

/* ---------- 2. 从 CHANGELOG 里切出对应段落 ---------- */

const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

/**
 * 按二级标题切块，返回 { '0.1.41': '正文…', '题库 0.5.2': '正文…' }
 * 标题形如 "## 0.1.41 — 2026-11-09" 或 "## 题库 0.5.2 — 2026-11-09"
 */
function sections(md) {
  const out = {};
  const lines = md.split(/\r?\n/);
  let key = null;
  let buf = [];
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*(?:—|--|-)\s*\d{4}-\d{2}-\d{2}\s*$/.exec(line.trim());
    if (m) {
      if (key) out[key] = buf.join('\n').trim();
      key = m[1].trim();
      buf = [];
      continue;
    }
    if (key) buf.push(line);
  }
  if (key) out[key] = buf.join('\n').trim();
  return out;
}

const sec = sections(changelog);

// App 段落：版本号形如 0.1.41
const appKey = Object.keys(sec).find((k) => k === appVer);
// 题库段落：形如「题库 0.5.2」，比对前两段版本号
const tikuShort = tikuVer.split('-')[0];                 // 0.5.2
const tikuKey = Object.keys(sec).find((k) => k.replace(/^题库\s*/, '') === tikuShort);

/* ---------- 3. 拼 body ---------- */

const parts = [];

parts.push(`**App ${appVer}** · **题库 ${tikuVer}**`);
parts.push('');

if (appKey) {
  parts.push(`### App ${appVer}`);
  parts.push('');
  parts.push(sec[appKey]);
  parts.push('');
} else {
  parts.push(`### App ${appVer}`);
  parts.push('');
  parts.push('（CHANGELOG 里还没有这一版的段落，补上后重新运行本脚本）');
  parts.push('');
}

if (tikuKey) {
  parts.push(`### 题库 ${tikuShort}`);
  parts.push('');
  parts.push(sec[tikuKey].split('\n').filter((l) => !l.startsWith('**题库规模**')).join('\n').replace(/\n{3,}/g, '\n\n').trim());
  parts.push('');
}

// 资产清单（从 Release 现有 assets 拉，比手写可靠）
parts.push('### 下载');
parts.push('');

const files = [
  ['shangan-' + appVer + '-release.apk', '完整安装包（首次安装用这个）'],
  ['tiku_app.db.gz', '题库全量包（App 内「检查题库更新」自动下载）'],
  ['delta-', '题库增量包（只下载变化的部分，通常 1–3 MB）'],
  ['images.db.gz', '公式图片库'],
  ['manifest.json', '版本清单，App 靠它判断有没有新版本'],
];
for (const [name, desc] of files) {
  parts.push(`- \`${name}\`${name === 'delta-' ? ' —— ' + desc : ' —— ' + desc}`);
}
parts.push('');

parts.push('### 安装');
parts.push('');
parts.push('1. 下载上面的 APK，允许「安装未知应用」后安装；');
parts.push('2. 首次打开会走一遍配置（考什么、考哪个省、距离考试还有几天）；');
parts.push('3. 题库已经打包在 App 里，离线可用，不需要额外下载；');
parts.push('4. 以后题库有更新时，进「我的 → 检查题库更新」，只下几 MB 的增量，不用重装。');

const body = parts.join('\n');

/* ---------- 4. 提交 ---------- */

if (flag('dry')) {
  console.log(body);
  process.exit(0);
}

if (!TOKEN) {
  console.error('缺少 GH_TOKEN 环境变量');
  process.exit(1);
}

const id = arg('id') || (await findReleaseId());
async function findReleaseId() {
  const r = await fetchJson(`https://api.github.com/repos/${REPO}/releases?per_page=20`, 'GET');
  const hit = r.find((x) => (x.tag_name || '').includes(tikuShort)) || r[0];
  if (!hit) throw new Error('没找到任何 Release');
  return String(hit.id);
}

const updated = await fetchJson(`https://api.github.com/repos/${REPO}/releases/${id}`, 'PATCH', { body });
console.log(`✓ 已更新 Release ${id} 的更新日志（${body.length} 字符）`);
console.log('  ' + (updated.html_url || ''));

async function fetchJson(url, method, payload) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'shangan-release-notes',
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
