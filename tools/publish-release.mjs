// 发布一版题库 + App 到 GitHub Release
// 用法：node tools/publish-release.mjs --tag tiku-0.4.4-20261108-1915
//       --files dist/release/tiku_app.db.gz,dist/release/delta-....json.gz
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d = '') => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const TAG = arg('tag');
const REPO = arg('repo', 'ERRRC/kaogong-shuati');
const NOTES = arg('notes', '');
const GH = arg('gh', 'D:/Projects/上岸APP/research/gh/bin/gh.exe');

if (!TAG) {
  console.error('缺 --tag');
  process.exit(1);
}

const manifestPath = 'D:/Projects/上岸APP/dist/release/manifest.json';
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const dbVersion = manifest.tiku.dbVersion;

// 从 manifest 反推要上传哪些文件（体积大，逐个确认存在）
const want = [];
if (manifest.tiku?.full?.url) want.push(path.basename(manifest.tiku.full.url));
for (const d of manifest.tiku?.delta || []) if (d.url) want.push(path.basename(d.url));
if (manifest.app?.url) want.push(path.basename(manifest.app.url));
if (manifest.images?.full?.url) want.push(path.basename(manifest.images.full.url));

const releaseDir = 'D:/Projects/上岸APP/dist/release';
const files = want
  .map((n) => path.join(releaseDir, n))
  .filter((f) => {
    if (!fs.existsSync(f)) { console.log('缺文件，跳过：' + path.basename(f)); return false; }
    return true;
  });

if (!files.length) { console.error('没有可上传的文件'); process.exit(1); }

console.log(`发布 ${TAG}`);
for (const f of files) {
  console.log(`  ${(fs.statSync(f).size / 1024 / 1024).toFixed(1)} MB  ${path.basename(f)}`);
}

const notes = NOTES || [
  `题库 ${dbVersion}`,
  '',
  `- 题目 ${manifest.tiku?.counts?.questions ?? '?'} 道`,
  `- 增量包 ${(manifest.tiku?.delta || []).length} 个（从旧版升级只下几 MB）`,
  '',
  'App 打开后「我的 → 检查题库更新」即可增量升级。',
].join('\n');

const args = ['release', 'create', TAG, '--repo', REPO, '--title', TAG, '--notes', notes, ...files];

try {
  const out = execFileSync(GH, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(out.trim());
} catch (e) {
  const msg = (e.stderr || e.message || '').trim();
  if (/already exists/i.test(msg)) {
    console.log('Release 已存在，改为上传文件…');
    execFileSync(GH, ['release', 'upload', TAG, ...files, '--repo', REPO, '--clobber'], { stdio: 'inherit' });
    console.log('上传完成');
  } else {
    console.error('发布失败：' + msg);
    process.exit(1);
  }
}
