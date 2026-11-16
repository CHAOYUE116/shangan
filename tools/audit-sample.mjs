#!/usr/bin/env node
/** 随机抽 300 道可用题，按「格式/内容」规则体检，输出分类计数与样本。 */
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const db = new DatabaseSync(join(ROOT, "app-assets", "tiku_app.db"), { readOnly: true });
const img = new DatabaseSync(join(ROOT, "app-assets", "images.db"), { readOnly: true });

const N = Number(process.argv[2] || 300);
const rows = db
  .prepare(
    `SELECT questionId, subject, chapter, type, content, contentHtml, material, options, answer, answerIndex, analysis, analysisHtml, optionType
     FROM (SELECT q.*, p.subject AS subject FROM questions q JOIN papers p ON p.id=q.paperId WHERE COALESCE(q.q_bad,0)=0 ORDER BY RANDOM() LIMIT ?)`,
  )
  .all(N);

const hasImgKey = img.prepare("SELECT 1 FROM images WHERE key=? LIMIT 1");
const strip = (s) => String(s || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const PLACEHOLDER = /^(缺失|略|无|暂无|见解析|答案见解析|[（(]图[)）]|如图|同上)$/;
const out = {};
const add = (k, r) => {
  out[k] = out[k] || { n: 0, ids: [] };
  out[k].n++;
  if (out[k].ids.length < 6) out[k].ids.push(r.questionId);
};

const latexKeys = (s) => [...String(s || "").matchAll(/latex=([A-Za-z0-9_-]+)/g)].map((m) => m[1]);

for (const r of rows) {
  const type = Number(r.type);
  const isObj = [1, 2, 3, 5].includes(type);
  const stem = strip(r.contentHtml) || strip(r.content);
  const ana = strip(r.analysisHtml) || strip(r.analysis);
  let opts = [];
  try {
    opts = JSON.parse(String(r.options || "[]"));
    if (!Array.isArray(opts)) opts = [];
  } catch {
    add("options_json_broken", r);
  }
  const optTexts = opts.map((o) => strip(typeof o === "string" ? o : o && o.text));
  const mat = String(r.material || "");
  const cmat = strip(mat);
  const allHtml = [r.contentHtml, r.material, r.analysisHtml].join("\n");

  // 1 题干
  if (!stem) add("stem_empty", r);
  else if (PLACEHOLDER.test(stem)) add("stem_placeholder", r);
  else if (stem.length < 8) add("stem_too_short", r);

  // 2 选项
  if (isObj) {
    if (opts.length === 0) add("options_missing", r);
    else if (opts.length < 2) add("options_less_than_2", r);
    else if (optTexts.some((t) => !t)) add("option_text_empty", r);
    else if (type === 3) {
      const ok = optTexts.every((t) => /正确|错误|对|错|是|否/.test(t));
      if (!ok) add("judge_option_weird", r);
    }
  }

  // 3 答案
  if (isObj) {
    const a = String(r.answer || "").trim();
    const ai = Number(r.answerIndex ?? -1);
    if (!a && ai < 0) add("answer_missing", r);
    else if (type !== 2 && ai >= 0 && opts.length && ai >= opts.length) add("answer_index_out_of_range", r);
    else if (type !== 2 && ai < 0 && !a) add("answer_index_neg", r);
  }

  // 4 解析
  if (!ana) add("analysis_empty", r);
  else if (ana.length < 20) add("analysis_too_short", r);

  // 5 材料提图表但无图
  if (/表\s*[1-9一二三四]|下列图表|下列图形|如下图|下图所示|见图|图表|如下表|见下表|下表/.test(cmat) && !/<img/i.test(mat) && cmat.length < 400) {
    add("material_says_table_no_img", r);
  }

  // 6 公式图 key 缺失
  for (const k of new Set(latexKeys(allHtml))) {
    if (!hasImgKey.get(k)) {
      add("img_key_missing", r);
      break;
    }
  }

  // 7 HTML 畸形
  if (/https:https:\/\//.test(allHtml)) add("double_scheme", r);
  if (/<img[^>]*$/m.test(allHtml)) add("img_tag_unclosed", r);
  if ((allHtml.match(/<[a-zA-Z]/g) || []).length > 0 && /<table/i.test(allHtml) && !/<\/table>/i.test(allHtml)) {
    add("table_unclosed", r);
  }

  // 8 判断题但选项是 ABCD
  if (type === 3 && opts.length >= 4 && optTexts.every((t) => /^[A-D]$/.test(t))) add("judge_abcd_options", r);
  if (type === 1 && opts.length >= 4 && optTexts.every((t) => /^(正确|错误)$/.test(t))) add("choice_with_judge_options", r);
}

console.log("样本:", rows.length);
const sorted = Object.entries(out).sort((a, b) => b[1].n - a[1].n);
if (!sorted.length) console.log("未发现异常");
for (const [k, v] of sorted) console.log(`${k}: ${v.n}  ${v.ids.join(",")}`);
