#!/usr/bin/env node
// 打正式包，并校验 APK 里的前端代码确实是刚同步进去的那一版。
//
// 为什么需要这个脚本：gradle 的 mergeAssets 是增量任务，robocopy 会把源文件的
// mtime 一起复制过去；如果源文件时间戳比上次合并时旧，gradle 会判定「不需要重跑」，
// 于是 APK 里塞的还是上一版的 app.js —— 装上去版本号是新的、功能却是旧的，非常难查。
// 所以这里每次先删掉 merged_assets / assets 中间产物，再打包，最后把 APK 里的
// app.js 抽出来核对 APP_VERSION。
//
// 用法：node tools/build-apk.mjs [--variant prod|lab]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ANDROID = path.resolve(ROOT, '..', 'app-shangan', 'android');
const arg = (name, def = '') => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : def;
};
const variant = arg('variant', 'prod');
const task = variant === 'lab' ? 'assembleLabRelease' : 'assembleProdRelease';
const apk = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', variant, 'release', `app-${variant}-release.apk`);

// 1. 清掉会拦住增量的中间产物
for (const dir of ['merged_assets', 'assets']) {
  fs.rmSync(path.join(ANDROID, 'app', 'build', 'intermediates', dir), { recursive: true, force: true });
}

// 2. 打包
const env = { ...process.env, JAVA_HOME: process.env.JAVA_HOME || 'D:\\dev\\jdk17' };
const out = execFileSync('cmd.exe', ['/c', 'gradlew.bat', task], {
  cwd: ANDROID,
  env,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const tail = out.trim().split(/\r?\n/).slice(-3).join('\n');
if (!/BUILD SUCCESSFUL/.test(out)) {
  console.error(tail);
  process.exit(1);
}

// 3. 从 APK 里抽 app.js 核对版本号（bsdtar 能直接读 zip）
const js = execFileSync('tar', ['-xOf', apk, 'assets/public/app.js'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const ver = (/const APP_VERSION = '([^']+)'/.exec(js) || [])[1] || '?';
const css = execFileSync('tar', ['-xOf', apk, 'assets/public/style.css'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const size = fs.statSync(apk).size;

// 4. 跟工程里的源头对一下，不一致就报错（说明同步链路断了）
const srcVer = (() => {
  try {
    return (/const APP_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'public', 'next', 'app.js'), 'utf8')) || [])[1];
  } catch { return null; }
})();

console.log(`APK     : ${path.relative(ROOT, apk)}`);
console.log(`大小    : ${size} B`);
console.log(`包内版本: ${ver}${srcVer ? `（源码 ${srcVer}）` : ''}`);
console.log(`样式字节: ${css.length}`);
if (srcVer && ver !== srcVer) {
  console.error(`✗ APK 里的 app.js 是 ${ver}，源码是 ${srcVer} —— 资源没同步进包，别发布`);
  process.exit(1);
}
console.log('✓ 资源已同步');
