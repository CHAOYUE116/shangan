#!/usr/bin/env node
/**
 * tools/fetch-missing-images.mjs — 把题库 HTML 里引用、但 images.db 里没有的公式/图片补下来
 *
 * 背景：题目 contentHtml / analysisHtml / material 里的图是
 *   <img flag="tex" src="https://fb.fenbike.cn/api/planet/accessories/formulas?latex=KEY">
 * 客户端 hydrateImages() 只会去 images.db 按 key 找，找不到就空着。
 * fb.fenbike.cn 这个接口是公开的（不需要登录、不需要 cookie），所以可以直接补。
 *
 * 用法：
 *   node tools/fetch-missing-images.mjs            # 只扫描报告
 *   node tools/fetch-missing-images.mjs --apply    # 下载并写入 images.db
 *   node tools/fetch-missing-images.mjs --apply --limit 500 --conc 6
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const DB = path.resolve(ROOT, arg('db', 'app-assets/tiku_app.db'));
const IDB = path.resolve(ROOT, arg('images', 'app-assets/images.db'));
const APPLY = argv.includes('--apply');
const LIMIT = Number(arg('limit', 100000));
const CONC = Number(arg('conc', 6));
const BASE = 'https://fb.fenbike.cn/api/planet/accessories/formulas?latex=';

const tiku = new DatabaseSync(DB, { readOnly: true });
const im = new DatabaseSync(IDB);

const rows = tiku.prepare('SELECT contentHtml, analysisHtml, material FROM questions').all();
const need = new Set();
for (const r of rows) {
  for (const f of [r.contentHtml, r.analysisHtml, r.material]) {
    if (!f) continue;
    const re = /latex=([A-Za-z0-9_-]+)/g;
    let m;
    while ((m = re.exec(f))) need.add(m[1]);
  }
}
const has = im.prepare('SELECT COUNT(*) AS c FROM images WHERE key = ?');
const missing = [...need].filter((k) => has.get(k).c === 0);
console.log(`HTML 引用 ${need.size} 个图片键，images.db 缺 ${missing.length} 个`);

if (!APPLY || !missing.length) {
  if (missing.length) console.log('dry-run：加 --apply 才下载写入');
  tiku.close();
  im.close();
  process.exit(0);
}

const take = missing.slice(0, LIMIT);
const put = im.prepare('INSERT OR REPLACE INTO images (key, mime, blob) VALUES (?, ?, ?)');
let ok = 0, fail = 0;
let i = 0;
const worker = async () => {
  while (i < take.length) {
    const key = take[i++];
    try {
      const r = await fetch(BASE + key, { headers: { Referer: 'https://www.fenbi.com/', 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) { fail += 1; continue; }
      const mime = r.headers.get('content-type') || 'image/png';
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) { fail += 1; continue; }
      put.run(key, mime, buf);
      ok += 1;
      if (ok % 50 === 0) console.log(`  已补 ${ok}/${take.length}`);
    } catch (e) {
      fail += 1;
    }
  }
};
await Promise.all(Array.from({ length: Math.min(CONC, take.length) }, worker));
console.log(`补图完成：成功 ${ok}，失败 ${fail}（共尝试 ${take.length}）`);
console.log('images.db 现在行数：', im.prepare('SELECT COUNT(*) AS c FROM images').get().c);
tiku.close();
im.close();
