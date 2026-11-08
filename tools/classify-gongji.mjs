// 公基细分类：把「常识判断」2894 题按题干/解析/选项关键词分成 7 个模块
// 写入：tiku.db questions.chapter  +  practice.db question_categories.category/sub
// 用法：node tools/classify-gongji.mjs [--apply] [--show 20]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { GONGJI_TREE } from '../lib/fenbi-tree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const SHOW = (() => {
  const i = process.argv.indexOf('--show');
  return i > 0 ? Number(process.argv[i + 1]) || 10 : 10;
})();

const GROUPS = GONGJI_TREE.filter((g) => g.group !== '综合常识').map((g) => g.group);

// 关键词权重：命中 1 次计 1 分；高置信词计 2 分
const RULES = {
  法律常识: [
    [2, /宪法|民法|刑法|行政法|诉讼法|民法典|劳动合同法|专利法|著作权法|商标法/g],
    [1, /法条|违法|犯罪|刑罚|判处|有期徒刑|赔偿|判决|起诉|诉讼|法院|检察院|公安机关|辩护|监护人|继承|婚姻|合同|条例|规定|权利义务|行政处罚|行政复议|侵权|著作权|专利权|商标权|公证|仲裁/g],
  ],
  经济常识: [
    [2, /GDP|CPI|恩格尔系数|通货膨胀|通货紧缩|财政政策|货币政策|供求关系|边际效用|机会成本|基尼系数|汇率|存款准备金/g],
    [1, /经济|市场|价格|货币|银行|金融|财政|税收|利率|成本|利润|企业|产业|贸易|投资|消费|收入|分配|保险|股票|债券|商品|需求|供给|垄断|竞争/g],
  ],
  科技常识: [
    [2, /DNA|RNA|细胞|基因|病毒|细菌|光合作用|牛顿|爱因斯坦|欧姆定律|元素周期|化学反应|物理变化|航天器|卫星|核能|半导体|月蚀|日食|超声波|激光/g],
    [1, /科技|物理|化学|生物|医学|人体|血液|器官|营养|计算机|互联网|人工智能|能源|材料|发明|实验|原子|分子|电|磁|光|热|温度|气压|力学|速度|重量|疾病|药物|疫苗|生态|植物|动物|颜色|波长|频率|声波/g],
  ],
  人文常识: [
    [2, /《[^》]{2,20}》|唐宋八大家|四大名著|诗经|楚辞|唐诗|宋词|元曲|明清小说|文艺复兴|启蒙运动/g],
    [1, /文学|诗词|诗人|作家|小说|散文|戏曲|绘画|书法|音乐|美术|雕塑|历史|朝代|先秦|汉代|唐代|宋代|明代|清代|古代|文物|考古|哲学|思想家|儒家|道家|佛家|宗教|成语|典故|节日|民俗|世界遗产|神话/g],
  ],
  地理国情: [
    [2, /季风|高原|盆地|平原|丘陵|喀斯特|板块|经纬度|时区|国土面积|人口普查|少数民族|日期变更线|极昼|极夜/g],
    [1, /地理|气候|天气|地形|山脉|河流|湖泊|海洋|海峡|省|自治区|直辖市|城市|国家|首都|人口|民族|资源|矿产|环境|生态|沙漠|草原|湿地|台风|地震|火山|纬线|经线|昼夜/g],
  ],
  公文写作: [
    [2, /主送机关|抄送机关|发文字号|成文日期|公文格式|行文规则|会议纪要|请示|批复/g],
    [1, /公文|通知|通报|报告|函|决定|通告|公告|命令|议案|决议|启事|讣告|讲话稿|演讲稿|倡议书|附件|标题|正文/g],
  ],
  政治理论: [
    [2, /马克思主义|毛泽东思想|邓小平理论|三个代表|科学发展观|习近平新时代中国特色社会主义思想|中国特色社会主义|全面从严治党|两个维护/g],
    [1, /党|政府|社会主义|理论|制度|改革|人民|国家治理|民主|法治|现代化|共同富裕|乡村振兴|生态文明|一国两制|外交/g],
  ],
};

const norm = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// 硬门槛：组内必须先命中 gate，否则整组不计分（防止「报告」「通知」等泛词误命中资料分析题）
const GATE = {
  公文写作: /公文|主送|抄送|发文字号|请示|批复|会议纪要|通报|通告|公告|议案|决议|启事|讣告|讲话稿|演讲稿|倡议书|行文规则/,
};

function classify(text) {
  const scores = {};
  for (const g of GROUPS) scores[g] = 0;
  for (const [g, rules] of Object.entries(RULES)) {
    if (!(g in scores)) continue;
    if (GATE[g] && !GATE[g].test(text)) continue;
    for (const [w, re] of rules) {
      const m = text.match(re);
      if (m) scores[g] += m.length * w;
    }
  }
  let best = null;
  let bestScore = 0;
  // 按 GONGJI_TREE 顺序取最高分，平局取前者
  for (const g of GROUPS) {
    if (scores[g] > bestScore) { best = g; bestScore = scores[g]; }
  }
  return { group: best, score: bestScore, scores };
}

const tdb = new DatabaseSync(path.join(ROOT, 'tiku.db'), { timeout: 15000 });
const pdb = new DatabaseSync(path.join(ROOT, 'practice.db'), { timeout: 15000 });

const rows = tdb.prepare(`
  SELECT q.questionId, q.chapter, q.content, q.options, q.analysis
  FROM questions q JOIN papers p ON p.id = q.paperId
  WHERE p.subjectName = '事业编·公基'
  GROUP BY q.questionId
`).all();

console.log(`公基唯一题 ${rows.length} 条，GONGJI_TREE 组: ${GROUPS.join(' / ')}\n`);

const dist = new Map();
const samples = new Map();
const lowConf = [];
for (const r of rows) {
  const text = norm(r.content) + ' ' + norm(r.analysis) + ' ' + norm(r.options);
  const { group, score, scores } = classify(text);
  const g = group || '综合常识';
  dist.set(g, (dist.get(g) || 0) + 1);
  if (!samples.has(g)) samples.set(g, []);
  if (samples.get(g).length < 2) samples.get(g).push(`${r.questionId} ${norm(r.content).slice(0, 44)}`);
  if (!group || score <= 2) lowConf.push({ id: r.questionId, group: g, score, text: norm(r.content).slice(0, 60), scores });
}

console.log('分类分布:');
const ordered = [...GROUPS, '综合常识'];
let total = 0;
for (const g of ordered) {
  const n = dist.get(g) || 0;
  total += n;
  if (!n) continue;
  const pct = ((n / rows.length) * 100).toFixed(1);
  console.log(`  ${g.padEnd(8)} ${String(n).padStart(6)}  ${pct.padStart(5)}%`);
  for (const s of samples.get(g) || []) console.log(`             · ${s}`);
}
console.log(`  合计 ${total}`);

console.log(`\n低置信度（得分<=2 或无命中）: ${lowConf.length} 条 (${((lowConf.length / rows.length) * 100).toFixed(1)}%)`);
for (const r of lowConf.slice(0, SHOW)) console.log(`  ${r.id} → ${r.group} (${r.score}) ${r.text}`);

if (!APPLY) {
  console.log('\n[干跑] 加 --apply 写入 tiku.db questions.chapter 与 practice.db question_categories');
} else {
  const updT = tdb.prepare('UPDATE questions SET chapter = ? WHERE questionId = ? AND chapter <> ?');
  const updP = pdb.prepare("UPDATE question_categories SET category = ?, sub = '', updated_at = ? WHERE question_id = ? AND subject = '事业编·公基'");
  const now = new Date().toISOString();
  let nt = 0;
  let np = 0;
  tdb.exec('BEGIN');
  pdb.exec('BEGIN');
  try {
    for (const r of rows) {
      const text = norm(r.content) + ' ' + norm(r.analysis) + ' ' + norm(r.options);
      const { group } = classify(text);
      const g = group || '综合常识';
      if (g === r.chapter) continue;
      nt += Number(updT.run(g, r.questionId, g).changes) || 0;
      np += Number(updP.run(g, now, r.questionId).changes) || 0;
    }
    tdb.exec('COMMIT');
    pdb.exec('COMMIT');
  } catch (e) {
    tdb.exec('ROLLBACK');
    pdb.exec('ROLLBACK');
    throw e;
  }
  console.log(`\n已写入：questions.chapter ${nt} 行，question_categories ${np} 行`);
}

tdb.close();
pdb.close();
