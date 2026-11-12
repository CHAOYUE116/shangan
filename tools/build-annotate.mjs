#!/usr/bin/env node
/**
 * 生成「坏题标注」网页：把指定科目的坏题导出成一个可离线打开的 HTML，
 * 图片（latex 公式图 + 内联 data URI）落地成本地 png，页面用相对路径引用。
 *
 *   node tools/build-annotate.mjs --subject 事业编·职测
 *   node tools/build-annotate.mjs --subject 公务员·行测 --out report/annotate
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const SUBJECT = arg('subject', '事业编·职测');
const OUTDIR = path.resolve(ROOT, arg('out', 'report/annotate'));
const DB = path.join(ROOT, 'app-assets', 'tiku_app.db');
const IMGDB = path.join(ROOT, 'app-assets', 'images.db');

const KEY_SLUG = { '公务员·行测': 'xingce', '公务员·申论': 'shenlun', '事业编·职测': 'syzc', '事业编·公基': 'gongji', '事业编·综应': 'zongying' }[SUBJECT] || 'subject';

const db = new DatabaseSync(DB, { readOnly: true });
const imgDb = fs.existsSync(IMGDB) ? new DatabaseSync(IMGDB, { readOnly: true }) : null;
const imgDir = path.join(OUTDIR, 'img');
fs.mkdirSync(imgDir, { recursive: true });

const rows = db.prepare(`
  SELECT q.questionId, q.chapter, q.type, q.content, q.contentHtml, q.material,
         q.options, q.answer, q.answerIndex, q.analysis, q.analysisHtml, q.q_bad_reason,
         p.name AS paperName
  FROM questions q JOIN papers p ON p.id = q.paperId
  WHERE q.id IN (SELECT MAX(id) FROM questions GROUP BY questionId)
    AND COALESCE(q.q_bad, 0) = 1
    AND p.subjectName = ?
  ORDER BY q.questionId
`).all(SUBJECT);

const TYPE_NAME = { 1: '单选', 2: '多选', 3: '不定项', 5: '判断', 4: '主观', 6: '主观' };
const kindOf = (r) => String(r.q_bad_reason || '').split('：')[0].split(':')[0] || '其他';

/* ---------- 材料兜底：库里有 17k 行 material 被写成了字符串 "[object Object]" ---------- */
// 真正的正文在 q_material_map(question_id → material_id) + q_materials(material_id → content)
const byQ = new Map();
for (const m of db.prepare('SELECT question_id, material_id FROM q_material_map').all()) byQ.set(Number(m.question_id), m.material_id);
const byId = new Map();
for (const m of db.prepare('SELECT material_id, content FROM q_materials').all()) byId.set(m.material_id, m.content);
const BAD_MAT = /^\s*\[object Object\]\s*$/;
function materialOf(r) {
  const own = String(r.material || '');
  if (own && !BAD_MAT.test(own)) return { html: own, broken: false };
  const mid = byQ.get(Number(r.questionId));
  const txt = mid != null ? byId.get(mid) : null;
  if (txt && String(txt).trim().length >= 10) return { html: txt, broken: false, recovered: true };
  return { html: '', broken: BAD_MAT.test(own) };
}

/* ---------- 图片落地 ---------- */
const fileCache = new Map();
function saveImage(buf, mime) {
  const ext = (String(mime || 'image/png').split('/')[1] || 'png').split(';')[0].replace('jpeg', 'jpg');
  const name = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '.' + ext;
  const p = path.join(imgDir, name);
  if (!fs.existsSync(p)) fs.writeFileSync(p, buf);
  return 'img/' + name;
}

function rewrite(html) {
  let s = String(html || '');
  if (!s) return '';
  // 1) data URI → 本地文件
  s = s.replace(/src="data:([^;"]+);base64,([^"]+)"/g, (_m, mime, b64) => {
    const key = b64.slice(0, 40) + b64.length;
    if (!fileCache.has(key)) {
      try { fileCache.set(key, saveImage(Buffer.from(b64, 'base64'), mime)); } catch { fileCache.set(key, null); }
    }
    const f = fileCache.get(key);
    return f ? `src="${f}"` : 'src=""';
  });
  // 2) latex 公式图 → images.db 里的文件
  s = s.replace(/src="([^"]*latex=([A-Za-z0-9_-]+)[^"]*)"/g, (_m, _src, k) => {
    const hit = imgDb ? imgDb.prepare('SELECT mime, blob FROM images WHERE key = ?').get(k) : null;
    if (!hit) return `src="" data-missing-key="${k}"`;
    const p = saveImage(Buffer.from(hit.blob), hit.mime);
    return `src="${p}"`;
  });
  // 3) 协议相对 / 绝对外链 → 标注成「未落地」，避免页面离线时一直转圈
  s = s.replace(/src="(\/\/[^"]+)"/g, 'src="" data-ext="$1"');
  return s;
}

const plain = (html) => String(html || '')
  .replace(/<img\b[^>]*>/gi, '〔图〕')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const answerLetters = (r) => {
  const a = String(r.answer || '').trim();
  let idxs = [];
  if (/^[A-Da-d][,，、\s]*[A-Da-d]?/.test(a)) {
    idxs = [...a.toUpperCase().replace(/[^A-D]/g, '')].map((c) => c.charCodeAt(0) - 65);
  } else if (/^\d/.test(a)) {
    idxs = a.split(/[,，、\s]+/).map(Number).filter((n) => Number.isFinite(n));
  } else if (Number(r.answerIndex) >= 0) idxs = [Number(r.answerIndex)];
  return idxs.map((i) => String.fromCharCode(65 + i)).filter((c) => c >= 'A' && c <= 'D');
};

const items = rows.map((r) => {
  const opts = (() => { try { return JSON.parse(r.options || '[]'); } catch { return []; } })();
  const kind = kindOf(r);
  const mat = materialOf(r);
  const stemHtml = rewrite(r.contentHtml) || `<p>${String(r.content || '').replace(/</g, '&lt;')}</p>`;
  return {
    id: Number(r.questionId),
    kind,
    reason: String(r.q_bad_reason || ''),
    chapter: r.chapter || '',
    typeName: TYPE_NAME[Number(r.type)] || String(r.type || ''),
    paper: String(r.paperName || '').slice(0, 40),
    stem: plain(r.content).slice(0, 200),
    stemHtml,
    materialHtml: rewrite(mat.html),
    materialNote: mat.broken ? '材料被写坏（库里是 "[object Object]"，也没能找到原文）' : '',
    options: opts.map((o) => rewrite(String(o))),
    answer: answerLetters(r).join('') || String(r.answer || ''),
    answerLetters: answerLetters(r),
    analysisHtml: rewrite(r.analysisHtml),
  };
});

const tpl = fs.readFileSync(path.join(ROOT, 'tools', 'annotate', 'app.html'), 'utf8');
const html = tpl
  .replaceAll('__SUBJECT__', SUBJECT)
  .replace('/*__DATA__*/[]', JSON.stringify({
    subject: SUBJECT,
    subjectKey: KEY_SLUG,
    generatedAt: new Date().toISOString(),
    items,
  }))
  .replace('__IMGDIR__', 'img');

const outFile = path.join(OUTDIR, `标注-${KEY_SLUG}.html`);
fs.writeFileSync(outFile, html, 'utf8');

const byKind = {};
for (const it of items) byKind[it.kind] = (byKind[it.kind] || 0) + 1;
console.log(`科目 ${SUBJECT}：${items.length} 道坏题`);
console.log('分布：' + Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(' / '));
console.log('页面：' + path.relative(ROOT, outFile));
console.log('图片：' + path.relative(ROOT, imgDir) + `（${fs.readdirSync(imgDir).length} 个文件）`);
db.close();
if (imgDb) imgDb.close();
