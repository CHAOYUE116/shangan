/**
 * 把大文件切成 npm 包分片，发布到 npm 公共 registry，
 * 客户端从 npmmirror（阿里云 CDN）的文件直链下载。
 *
 * 背景：gh-proxy 这类公共反代对单连接限速 0.36 MB/s，135 MB 的 APK 要 6 分钟。
 *       npmmirror 实测单流 4-10 MB/s，快 12-28 倍，国内稳定。
 *
 * 用法：
 *   node tools/publish-npm-parts.mjs --file <路径> --prefix shangan-apk [--chunk 15] [--publish]
 *
 * 不加 --publish 只切分并打印清单（dry run）。
 *
 * 产物：D:\npm-parts\<pkg>\package.json + data.bin
 * 输出：parts.json（每个分片的 name / version / url / size / sha256），供 build-release-manifest 用
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const arg = (k, d = '') => {
  const i = process.argv.indexOf('--' + k);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
};
const flag = (k) => process.argv.includes('--' + k);

const FILE = arg('file');
const PREFIX = arg('prefix');
const CHUNK_MB = Number(arg('chunk', '15'));
const VERSION = arg('version', '1.0.0');
const OUT_ROOT = arg('out', 'D:/npm-parts');
const PUBLISH = flag('publish');

if (!FILE || !PREFIX) {
  console.error('必须给 --file 和 --prefix');
  process.exit(1);
}
if (!fs.existsSync(FILE)) {
  console.error('文件不存在: ' + FILE);
  process.exit(1);
}

const buf = fs.readFileSync(FILE);
const chunkSize = CHUNK_MB * 1024 * 1024;
const total = Math.ceil(buf.length / chunkSize);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

console.log(`源文件 ${path.basename(FILE)}  ${(buf.length / 1024 / 1024).toFixed(2)} MB → ${total} 片 × ${CHUNK_MB} MB`);

const parts = [];
for (let i = 0; i < total; i++) {
  const from = i * chunkSize;
  const to = Math.min(buf.length, from + chunkSize);
  const slice = buf.subarray(from, to);
  const name = `${PREFIX}-p${i + 1}`;
  const dir = path.join(OUT_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'data.bin'), slice);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name,
    version: VERSION,
    description: `上岸 ${PREFIX} 分片 ${i + 1}/${total}`,
    files: ['data.bin'],
    license: 'MIT',
  }, null, 2));

  const sha = sha256(slice);
  parts.push({
    index: i + 1,
    total,
    package: name,
    version: VERSION,
    offset: from,
    size: slice.length,
    sha256: sha,
    // npmmirror 的文件直链：单流实测 4 MB/s，比 tarball 好解析（不用解 tar）
    url: `https://registry.npmmirror.com/${name}/${VERSION}/files/data.bin`,
    tarball: `https://registry.npmmirror.com/${name}/-/${name}-${VERSION}.tgz`,
  });
  console.log(`  ${name}  offset=${from}  ${(slice.length / 1024 / 1024).toFixed(2)} MB  ${sha.slice(0, 12)}…`);
}

const manifestParts = {
  file: path.basename(FILE),
  size: buf.length,
  sha256: sha256(buf),
  chunkSize,
  parts,
};
const outFile = path.join(OUT_ROOT, `${PREFIX}-parts.json`);
fs.writeFileSync(outFile, JSON.stringify(manifestParts, null, 2));
console.log(`\n清单 → ${outFile}`);

if (!PUBLISH) {
  console.log('\n（dry run。加 --publish 才会真的发到 npm，需要先 npm login 或设 NPM_TOKEN）');
  process.exit(0);
}

const token = process.env.NPM_TOKEN || '';
const npmrc = path.join(OUT_ROOT, '.npmrc');
fs.writeFileSync(npmrc, token
  ? `//registry.npmjs.org/:_authToken=${token}\n`
  : '');

for (const p of parts) {
  const dir = path.join(OUT_ROOT, p.package);
  try {
    execFileSync('npm', ['publish', '--registry', 'https://registry.npmjs.org', '--access', 'public'], {
      cwd: dir,
      stdio: 'inherit',
      env: { ...process.env, npm_config_userconfig: npmrc },
      shell: true,
    });
    console.log(`  ✓ 已发布 ${p.package}@${VERSION}`);
  } catch (e) {
    console.error(`  发布 ${p.package} 失败：` + e.message);
  }
}
console.log('\n全部分片发布完成。npmmirror 同步通常 1-5 分钟。');
