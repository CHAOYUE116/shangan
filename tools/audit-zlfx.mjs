#!/usr/bin/env node
/**
 * 抽检 N 道资料分析题的材料/图表完整性。
 * 用法: node tools/audit-zlfx.mjs [N]
 */
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const N = Number(process.argv[2] || 300);

const db = new DatabaseSync(join(ROOT, "app-assets", "tiku_app.db"), { readOnly: true });
const img = new DatabaseSync(join(ROOT, "app-assets", "images.db"), { readOnly: true });

const hasImg = (s) => /<img\b/i.test(String(s || ""));
const strip = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const keysOf = (html) =>
  [...String(html || "").matchAll(/<img[^>]+src="([^"]+)"/gi)]
    .map((m) => m[1])
    .map((src) => {
      const q = /[?&]latex=([^&"]+)/.exec(src);
      return q ? q[1] : (/tarzan\/images\/([^"?]+)/.exec(src) || [])[1] || null;
    })
    .filter(Boolean);

const rows = db
  .prepare(
    `SELECT questionId AS id, source, type, chapter, content, contentHtml, material, options, answer, analysis, analysisHtml
       FROM questions
      WHERE chapter = '资料分析' AND COALESCE(q_bad,0)=0
      ORDER BY RANDOM() LIMIT ?`,
  )
  .all(N);

const hits = {};
const add = (k, r, extra) => {
  (hits[k] ||= []).push({ id: r.id, src: r.source, ...extra });
};

const EXTERNAL = /^https?:\/\/(?!(fb\.fenbike\.cn\/api\/planet\/accessories\/formulas\?latex=))/i;

for (const r of rows) {
  const mat = String(r.material || "");
  const matTxt = strip(mat);
  const stem = strip(r.content || r.contentHtml);
  const all = mat + " " + String(r.contentHtml || "");
  const keys = keysOf(all);
  const matImgs = (mat.match(/<img\b/gi) || []).length;
  const stemImgs = (String(r.contentHtml || "").match(/<img\b/gi) || []).length;

  // 1 材料空 / 只有引导语
  if (!matTxt) add("材料为空", r, { stem: stem.slice(0, 30) });
  else if (matTxt.length < 150 && /(根据|资料|材料|完成|回答)/.test(matTxt) && (matTxt.match(/\d/g) || []).length < 4)
    add("材料只剩引导语", r, { mat: matTxt.slice(0, 60) });

  // 2 提到表/图但没有图
  if (/(表\s*[1-9]|表[一二三四]|下表|见下表|下列图表|下列图形|如下图|下图所示|见图|图表|如下：|具体.*如下)/.test(matTxt + stem) && !hasImg(mat) && !hasImg(r.contentHtml))
    add("提到图表但无图", r, { mat: matTxt.slice(0, 50) });

  // 3 图是外链 / key 不在库
  const ext = keys.filter((k) => EXTERNAL.test(k));
  if (ext.length) add("图片是外链", r, { n: ext.length, sample: ext[0].slice(0, 60) });
  const miss = keys.filter((k) => !img.prepare("SELECT 1 FROM images WHERE key=? LIMIT 1").get(k));
  if (miss.length) add("图片 key 缺失", r, { n: miss.length, sample: miss[0] });
  if (/https:https:\/\//.test(all)) add("裂图(双协议头)", r, {});

  // 4 题干引用上表/下图但没图
  if (/(上表|下表|表中|上图|下图|图中|见图)/.test(stem) && !matImgs && !stemImgs)
    add("题干引用图表但无图", r, { stem: stem.slice(0, 40) });

  // 5 选项异常
  let opts = [];
  try {
    opts = JSON.parse(String(r.options || "[]"));
  } catch {}
  if (Number(r.type) !== 5) {
    if (!Array.isArray(opts) || opts.length < 2) add("没有选项", r, { type: r.type });
    else if (opts.some((o) => typeof o === "string" && !strip(o))) add("选项文本为空", r, {});
  }

  // 6 解析空
  const ana = strip(r.analysis || "");
  const anaHtml = strip(r.analysisHtml || "");
  if (ana.length < 20 && anaHtml.length < 20 && !hasImg(r.analysisHtml)) add("解析为空", r, {});

  // 7 数字过少（疑似缺数据）
  const nums = ((matTxt + " " + stem).match(/\d+(?:\.\d+)?%?/g) || []).length;
  if (nums < 3) add("数字过少(疑似缺数据)", r, { nums, mat: matTxt.slice(0, 40), stem: stem.slice(0, 40) });
}

console.log(`样本 资料分析 ${rows.length} 道`);
const order = Object.entries(hits).sort((a, b) => b[1].length - a[1].length);
for (const [k, v] of order) {
  console.log(`\n## ${k}: ${v.length}`);
  for (const x of v.slice(0, 6)) console.log("  ", JSON.stringify(x));
}
if (!order.length) console.log("无异常");
