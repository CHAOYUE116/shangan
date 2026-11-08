// 一次性把版本号推到指定值：public/next/app.js 的 APP_VERSION + android build.gradle 的 versionCode/versionName
// 用法：node tools/bump-version.mjs 0.1.34 35
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const ver = process.argv[2];
const code = process.argv[3];
if (!ver || !code) {
  console.error('用法: node tools/bump-version.mjs <versionName> <versionCode>');
  process.exit(1);
}

const appJs = path.join(root, 'public/next/app.js');
let s = fs.readFileSync(appJs, 'utf8');
const before = s;
s = s.replace(/const APP_VERSION = '[^']*';/, `const APP_VERSION = '${ver}';`);
if (s === before) {
  console.error('app.js 里没找到 APP_VERSION 定义');
  process.exit(1);
}
fs.writeFileSync(appJs, s, 'utf8');

const gradle = path.join(root, '../app-shangan/android/app/build.gradle');
let g = fs.readFileSync(gradle, 'utf8');
const g0 = g;
g = g.replace(/versionCode\s+\d+/, `versionCode ${code}`);
g = g.replace(/versionName\s+"[^"]*"/, `versionName "${ver}"`);
if (g === g0) {
  console.error('build.gradle 里没找到 versionCode/versionName');
  process.exit(1);
}
fs.writeFileSync(gradle, g, 'utf8');

const check = fs.readFileSync(appJs, 'utf8').match(/const APP_VERSION = '([^']*)'/);
const gc = fs.readFileSync(gradle, 'utf8').match(/versionCode\s+(\d+)/);
const gn = fs.readFileSync(gradle, 'utf8').match(/versionName\s+"([^"]*)"/);
console.log(`APP_VERSION = ${check[1]}`);
console.log(`versionCode = ${gc[1]}  versionName = ${gn[1]}`);
