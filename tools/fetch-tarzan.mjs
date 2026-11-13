// 收集全库 tarzan 图片 URL → 下载到 tmp-tarzan/，并记录 url → 本地文件映射
//   node tools/fetch-tarzan.mjs --scan            # 只扫描，写 report/tarzan-urls.json
//   node tools/fetch-tarzan.mjs --download --conc 10
//   node tools/fetch-tarzan.mjs --download --limit 50 --conc 4   # 试跑
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const DB = String(arg('db', path.join(ROOT, 'app-assets', 'tiku_app.db')));
const OUT = path.join(ROOT, 'tmp-tarzan');
const MAP = path.join(ROOT, 'report', 'tarzan-urls.json');
const CONC = Number(arg('conc', 10)) || 10;
const LIMIT = Number(arg('limit', 0)) || 0;

const keyOf = (url) => crypto.createHash('sha1').update(url).digest('hex').slice(0, 24);

if (arg('scan', false)) {
  const db = new DatabaseSync(DB, { readOnly: true });
  const rows = db
    .prepare(
      `SELECT questionId, contentHtml, material FROM questions
       WHERE contentHtml LIKE '%tarzan/images%' OR material LIKE '%tarzan/images%'`,
    )
    .all();
  const urls = new Map();
  const re = /(?:https?:)?\/\/[^"'\s>]*tarzan\/images[^"'\s>]*/g;
  for (const r of rows) {
    for (const html of [r.contentHtml, r.material]) {
      if (!html) continue;
      for (const m of String(html).matchAll(re)) {
        let u = m[0];
        if (u.startsWith('//')) u = 'https:' + u;
        u = u.replace(/^http:/, 'https:');
        // 统一到 fb.fenbike.cn（老域名 fbstatic 也能用，但新域名更稳）
        u = u.replace('//fb.fbstatic.cn/', '//fb.fenbike.cn/');
        if (!urls.has(u)) urls.set(u, 0);
        urls.set(u, urls.get(u) + 1);
      }
    }
  }
  const list = [...urls.entries()].map(([url, n]) => ({ url, key: keyOf(url), n }));
  fs.mkdirSync(path.dirname(MAP), { recursive: true });
  fs.writeFileSync(MAP, JSON.stringify({ count: list.length, list }, null, 0));
  const total = list.reduce((s, x) => s + x.n, 0);
  console.log(`题 ${rows.length} 道 / 唯一图 ${list.length} 张 / 引用 ${total} 次`);
  const qs = new Set(rows.map((r) => r.questionId)).size;
  console.log(`涉及唯一题 ${qs} 道`);
}

if (arg('download', false)) {
  const data = JSON.parse(fs.readFileSync(MAP, 'utf8'));
  let list = data.list;
  if (LIMIT) list = list.slice(0, LIMIT);
  fs.mkdirSync(OUT, { recursive: true });
  const exists = new Set(fs.readdirSync(OUT).map((f) => f.split('.')[0]));
  list = list.filter((x) => !exists.has(x.key));
  console.log(`待下载 ${list.length} 张（并发 ${CONC}）`);
  let ok = 0, fail = 0, bytes = 0, cursor = 0;
  const t0 = Date.now();
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      const { url, key } = list[i];
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(url, {
            signal: AbortSignal.timeout(25000),
            headers: { 'user-agent': 'Mozilla/5.0' },
          });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 200) throw new Error('too small ' + buf.length);
          const ext = /jpe?g/.test(res.headers.get('content-type') || '') ? 'jpg' : 'png';
          fs.writeFileSync(path.join(OUT, key + '.' + ext), buf);
          ok++; bytes += buf.length;
          break;
        } catch (e) {
          if (attempt === 2) { fail++; if (fail <= 10) console.log('FAIL', e.message, url.slice(0, 100)); }
          else await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
      if ((ok + fail) % 500 === 0) {
        const sec = (Date.now() - t0) / 1000;
        console.log(`  ${ok + fail}/${list.length} ok=${ok} fail=${fail} ${(bytes / 1048576).toFixed(1)}MB ${(ok / sec).toFixed(1)}/s`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  const sec = (Date.now() - t0) / 1000;
  console.log(`完成：成功 ${ok} / 失败 ${fail} / ${(bytes / 1048576).toFixed(1)} MB / ${sec.toFixed(0)} 秒`);
}
