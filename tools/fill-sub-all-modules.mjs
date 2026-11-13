#!/usr/bin/env node
/**
 * 把每个一级模块下的「其他」（sub 为空）继续往下分，用的全是粉笔自己的二级分类名，不新增分类。
 *
 * 两段式：
 *   1) 有考点的题（question_keypoints）→ 用粉笔题型树把叶子名折成它所属的二级（准确率高）；
 *   2) 没考点的题 → 按题干措辞判（每个模块一套规则，顺序即优先级）。
 *
 *   node tools/fill-sub-all-modules.mjs --dry --show 2
 *   node tools/fill-sub-all-modules.mjs --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const APPLY = !!arg('apply', false);
const SHOW = Number(arg('show', '0')) || 0;
const SUBJECT = arg('subject', null);
const DB = String(arg('db', path.join(ROOT, 'app-assets/tiku_app.db')));

// 我们的模块名 → 粉笔树里的根名
const ROOT_OF = {
  '事业编·职测': { 政治理论: '政治理论', 常识判断: '常识判断', 言语理解与表达: '言语理解与表达', 数量关系: '数量关系', 判断推理: '判断推理', 资料分析: '资料分析' },
  '公务员·行测': { 政治理论: '政治理论', 常识判断: '常识判断', 言语理解与表达: '言语理解与表达', 数量关系: '数量关系', 判断推理: '判断推理', 资料分析: '资料分析' },
  '事业编·公基': { 政治理论: '政治', 法律常识: '法律', 经济常识: '经济', 综合常识: '管理', 公文写作: '公文', 人文常识: '人文历史', 科技常识: '科技地理', 地理国情: '科技地理' },
};
const COURSE_OF = { '事业编·职测': 'syzc', '公务员·行测': 'xingce', '事业编·公基': 'sydw' };

// ---- 题干措辞规则：模块 → [[正则, 二级名], ...]（顺序即优先级）----
const RULES = {
  言语理解与表达: [
    [/依次填入|横线处|填入.{0,8}(词语|成语|空格|括号)/, '逻辑填空'],
    [/依次填入(划横线|文中|括号)|填入(划横线|括号)部分最恰当|最恰当的一项|最恰当的是|实词填空|成语填空|混搭填空|虚词填空|固定搭配/, '逻辑填空'],
    [/(这段|本段|该段)文字|作者(意在|想要|认为)|主旨|意在说明|主要说明|主要介绍|最适合做.*标题|标题填入|概括最准确|复述最准确|下文(最可能|推断)|接下来(最可能|最有可能)/, '阅读理解'],
    [/语序(排列|正确)|重新排列|语句排序|没有语病|有语病|歧义|填入文中(第|画横线)|衔接最恰当|承上启下/, '语句表达'],
    [/根据(以下|上述)?(材料|资料)[，,]?\s*(回答|完成)|阅读以下(材料|文字)[，,]?\s*(回答|完成)/, '篇章阅读'],
    [/划线部分|文中画线|文章(中|里)|从文章中|这段文章|本文/, '阅读理解'],
  ],
  数量关系: [
    [/数列|(下一个|下一项)(是|为)|（\s*）\s*[，,]\s*\d|1[，,]\s*\d|2[，,]\s*[46]/, '数字推理'],
    [/.+/, '数学运算'],
  ],
  资料分析: [
    [/./, '__MAT__'],
  ],
  常识判断: [
    [/宪法|民法|刑法|行政法|法律|法规|条例|诉讼|处罚|合同|侵权|著作权|专利|婚姻|继承/, '法律常识'],
    [/物理|化学|生物|科技|航天|能源|材料|天文|医学|细胞|元素/, '科技常识'],
    [/历史|朝代|文学|诗词|成语|文化|节日|民俗|书法|绘画|戏曲/, '人文常识'],
    [/经济|市场|GDP|通货|财政|货币|价格|供需|税收/, '经济常识'],
    [/地理|气候|地形|河流|山脉|人口|省|高原|盆地|季风/, '地理国情'],
    [/公文|通知|报告|请示|批复|函|纪要|发文|行文/, '公文写作与处理'],
    [/管理|行政|组织|领导|决策|绩效|事业单位/, '管理常识'],
  ],
  政治理论: [
    [/习近平|新时代|二十大|中共中央|党中央|全面深化改革|中国式现代化/, '新思想'],
    [/马克思|唯物|辩证法|剩余价值|实践与认识|社会存在/, '马克思主义'],
    [/毛泽东|新民主主义|农村包围城市/, '毛中特'],
    [/邓小平|三个代表|科学发展观|社会主义初级阶段|市场经济体制/, '毛中特'],
    [/\d{4}年\d{1,2}月|日前|近日|会议审议通过/, '时事政治'],
  ],
  // 公基：模块是我们的一级，二级用粉笔 sydw 树里的名字
  法律常识: [
    [/民法典|合同|侵权|物权|婚姻|继承|人格权|民事/, '民法典'],
    [/犯罪|刑罚|刑法|故意|过失|正当防卫/, '刑法'],
    [/宪法|国家机构|公民基本权利/, '宪法'],
    [/行政诉讼|行政处罚|行政许可|行政复议|行政强制|公务员法/, '行政法与行政诉讼法'],
    [/国家赔偿/, '国家赔偿法'],
    [/公司法|证券|票据|保险|破产|合伙/, '商法'],
    [/劳动法|劳动合同|社会保险|工伤|工资/, '劳动法与社会保障法'],
    [/民事诉讼法|刑事诉讼法|仲裁|管辖|举证|诉讼程序/, '程序法'],
    [/知识产权|著作权|专利|商标/, '知识产权'],
    [/反垄断|反不正当竞争|消费者权益|产品质量|税法/, '经济法'],
    [/法理|法律效力|法律关系|法律制裁|法律责任/, '法理学'],
  ],
  政治理论_公基: [
    [/习近平|新时代|中国式现代化/, '新思想'],
    [/毛泽东|新民主主义/, '毛泽东思想概论'],
    [/邓小平|三个代表|科学发展观|中国特色/, '中国特色社会主义理论体系'],
    [/马克思|唯物|辩证法|认识论|历史唯物主义|剩余价值/, '马克思主义哲学'],
    [/党章|党的纪律|党的组织|入党|党员/, '党的基本知识'],
    [/全会|代表大会|省委|五年规划|十二五|十三五|十八大|十九大|政府工作报告|深化改革/, '中国特色社会主义理论体系'],
    [/道德|公德|职业道德|家庭美德/, '道德'],
  ],
  经济常识: [
    [/财政政策|货币政策|通货膨胀|GDP|产业(结构|比重)|能源结构|经济增长/, '宏观经济'],
    [/价值规律|剩余价值|商品|货币的本质|资本/, '马克思主义政治经济学'],
    [/市场|价格|供求|竞争|企业|消费者|垄断/, '社会主义市场经济体制'],
    [/微观|边际|成本|生产函数|弹性/, '微观经济'],
    [/GDP|国民收入|通胀|通货紧缩|财政政策|货币政策|经济增长/, '宏观经济'],
  ],
  综合常识: [
    [/计算机|网络|软件|数据库|病毒|操作系统|二进制/, '计算机基础知识'],
    [/管理|计划|组织|领导|控制|决策|激励/, '管理学的基本原理'],
    [/行政|公务员|事业单位|编制|绩效/, '行政管理'],
    [/事业单位|聘用|职称/, '事业单位相关制度'],
  ],
  公文写作: [[/公文|通知|报告|请示|批复|函|纪要|发文|行文|格式/, '公文的基本知识']],
  人文常识: [
    [/历史|朝代|战争|变法|革命|年代/, '历史常识'],
    [/文学|诗|词|小说|散文|作家|作品/, '文学常识'],
    [/文化|民俗|节日|书法|绘画|戏曲|礼仪/, '文化常识'],
  ],
  科技常识: [
    [/物理|化学|生物|医学|材料|能源|航天|信息|细胞|元素|通信|卫星/, '科技'],
    [/地理|气候|地形|河流|山脉|人口/, '地理国情'],
    [/./, '科技'],
  ],
  地理国情: [[/.+/, '地理国情']],
};

/** 建「叶子 → 二级」，按课程 + 根名分桶 */
function buildTree() {
  const byCourse = {};
  for (const [subject, course] of Object.entries(COURSE_OF)) {
    const file = path.join(ROOT, `report/cats-${course}.json`);
    if (!fs.existsSync(file)) continue;
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const roots = {};
    for (const r of d.baseKeypointVOS || []) {
      const m = new Map();
      for (const sub of r.children || []) {
        m.set(sub.name, sub.name);
        for (const leaf of sub.children || []) m.set(leaf.name, sub.name);
      }
      roots[r.name] = m;
    }
    byCourse[subject] = roots;
  }
  return byCourse;
}

// ---- 「未分类」先猜它属于哪个一级模块（猜中后再用该模块的二级规则）----
const MODULE_GUESS = [
  [/所给图形|四个选项中.*填入问号|填入问号|折叠|展开图|截面|立体图形|图形推理|左图|右图所示/, '判断推理', '图形推理'],
  [/逻辑关系最为(贴近|相似|接近)|与.*在逻辑关系上/, '判断推理', '类比推理'],
  [/五个事件|按(时间|逻辑)顺序(排列|排列最)|事件排序/, '判断推理', '事件排序'],
  [/定义|属于.*的是|不属于.*的是|符合上述定义/, '判断推理', '定义判断'],
  [/最能削弱|最能加强|假设(成立|为真)|由此可以推出|以下哪项(如果为真|最能)|论证|推理正确/, '判断推理', '逻辑判断'],
  [/语序(排列|正确)|重新排列|语句排序|没有语病|有语病|歧义/, '言语理解与表达', '语句表达'],
  [/依次填入(划横线|文中|括号)|填入(划横线|括号)|最恰当的一项|最恰当的是/, '言语理解与表达', '逻辑填空'],
  [/这段文字|本段文字|作者(意在|想要)|主旨|意在说明|主要说明|最适合做.*标题|概括最准确|划线部分|文中画线|从文章中|本文/, '言语理解与表达', '阅读理解'],
  [/数列|下一项|下一个数/, '数量关系', '数字推理'],
  [/工程|行程|利润|浓度|年龄|鸡兔|排列组合|概率|几何|方程|速度|效率|植树|方阵|容斥/, '数量关系', '数学运算'],
  [/同比|环比|增长率|增长量|比重|平均|倍数|翻番|统计(表|图)|资料分析|与上年相比|占全国/, '资料分析', null],
  [/宪法|刑法|民法|行政法|诉讼|处罚|合同|侵权|著作权|专利|婚姻|继承|法条/, '常识判断', '法律常识'],
  [/物理|化学|生物|医学|航天|能源|材料|细胞|元素|科技/, '常识判断', '科技常识'],
  [/历史|朝代|文学|诗词|成语|文化|节日|民俗|书法|绘画|戏曲/, '常识判断', '人文常识'],
  [/地理|气候|地形|河流|山脉|季风|高原|盆地|人口分布/, '常识判断', '地理国情'],
  [/经济|GDP|通货|财政|货币|供需|税收|市场/, '常识判断', '经济常识'],
  [/公文|通知|报告|请示|批复|函|纪要|行文/, '常识判断', '公文写作与处理'],
  [/习近平|新时代|马克思|毛泽东|邓小平|党的|社会主义/, '政治理论', null],
];

/** 资料分析的二级按材料形态判 */
function materialSub(material) {
  const m = String(material || '');
  if (/<table/i.test(m)) return '统计表';
  if (/<img|formulas|tarzan/i.test(m) && /(图|%|趋势)/.test(m.replace(/<[^>]+>/g, ''))) return '统计图';
  if (m.replace(/<[^>]+>/g, '').trim().length > 40) return '文字资料';
  return '综合资料';
}

const TREE = buildTree();
const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout = 30000');

const rows = db.prepare(`
  SELECT DISTINCT qc.subject AS subject, qc.category AS category, qc.question_id AS qid,
         q.content AS content, q.material AS material
  FROM question_categories qc JOIN questions q ON q.questionId = qc.question_id
  WHERE COALESCE(qc.sub,'') = '' GROUP BY qc.subject, qc.category, qc.question_id`).all();

const stat = { 候选: 0, 考点命中: 0, 措辞命中: 0, 谜模块: 0, 拆桶: 0, 兜底: 0, 未命中: 0, 明细: {}, 未明细: {}, 样例: {} };
const staged = [];

for (const r of rows) {
  if (SUBJECT && r.subject !== SUBJECT) continue;
  stat.候选++;
  const roots = TREE[r.subject];
  if (!roots) { stat.未命中++; continue; }
  const rootName = (ROOT_OF[r.subject] || {})[r.category];
  const map = rootName ? roots[rootName] : null;

  // 1) 考点优先
  if (map) {
    const kps = db.prepare('SELECT kpName FROM question_keypoints WHERE questionId = ?').all(r.qid).map((x) => x.kpName);
    const hit = kps.map((n) => map.get(n)).filter(Boolean)[0];
    if (hit) {
      stat.考点命中++;
      stat.明细[`${r.category}|${hit}`] = (stat.明细[`${r.category}|${hit}`] || 0) + 1;
      staged.push([hit, r.qid, r.category, null]);
      continue;
    }
  }

  // 2) 题干措辞
  const text = String(r.content || '').replace(/<[^>]+>/g, ' ') + ' ' + String(r.material || '').replace(/<[^>]+>/g, ' ').slice(0, 600);
  const rulesFor = r.category === '综合常识' ? null : (RULES[`${r.category}_公基`] || RULES[r.category]);
  if (rulesFor) {
    const found = rulesFor.find(([re]) => re.test(text));
    if (found) {
      const sub = found[1] === '__MAT__' ? materialSub(r.material) : found[1];
      stat.措辞命中++;
      stat.明细[`${r.category}|${sub}`] = (stat.明细[`${r.category}|${sub}`] || 0) + 1;
      const key = `${r.category}|${sub}`;
      if (SHOW && (!stat.样例[key] || stat.样例[key].length < SHOW)) {
        stat.样例[key] = stat.样例[key] || [];
        stat.样例[key].push(text.replace(/\s+/g, ' ').slice(0, 40));
      }
      staged.push([sub, r.qid, r.category, null]);
      continue;
    }
  }

  // 3) 「综合常识」是个混合桶（实测里面是法律/经济/科技题），按内容拆回粉笔的模块
  if (r.category === '综合常识') {
    const SPLIT_OUT = [
      [/法律|宪法|刑法|民法|诉讼|处罚|合同|立法|司法|行政法/, '法律常识'],
      [/经济|GDP|外汇|货币|财政|税收|市场|通货/, '经济常识'],
      [/科技|物理|化学|生物|元素|通信|卫星|4G|实验/, '科技常识'],
      [/历史|文学|文化|诗词|成语|朝代/, '人文常识'],
      [/地理|气候|地形|河流|山脉|人口/, '地理国情'],
      [/公文|通知|印发|请示|批复|函/, '公文写作'],
      [/管理|行政|事业单位|决策|领导/, '综合常识'],
      [/汽车|召回|排放|污染|环境|能源|食品|安全|标准/, '科技常识'],
      [/孟子|孔子|老子|君子|诗|赋|典故/, '人文常识'],
      [/地貌|岩|江|海|山|气候|海拔/, '地理国情'],
    ];
    const hit3 = SPLIT_OUT.find(([re]) => re.test(text));
    if (hit3) {
      const [, mod] = hit3;
      let sub = null;
      let newCat = r.category;
      if (mod === '综合常识') sub = '管理学的基本原理';
      else {
        const rl = RULES[`${mod}_公基`] || RULES[mod];
        const h = rl ? rl.find(([re]) => re.test(text)) : null;
        sub = h ? h[1] : { 法律常识: '其他（法律）', 人文常识: '其他（人文历史）', 科技常识: '科技', 地理国情: '地理国情', 公文写作: '公文的基本知识', 经济常识: '社会主义市场经济体制' }[mod] || null;
        newCat = mod;
      }
      if (sub) {
        stat.拆桶++;
        stat.明细[`综合常识→${newCat}|${sub}`] = (stat.明细[`综合常识→${newCat}|${sub}`] || 0) + 1;
        staged.push([sub, r.qid, r.category, newCat === r.category ? null : newCat]);
        continue;
      }
    }
  }

  // 4) 「未分类」：先猜一级模块，再套该模块的二级规则
  if (r.category === '未分类') {
    const g = MODULE_GUESS.find(([re]) => re.test(text));
    if (g) {
      const [, mod, guessSub] = g;
      let sub = guessSub;
      if (!sub) {
        const m = (ROOT_OF[r.subject] || {})[mod];
        const rl = RULES[`${mod}_公基`] || RULES[mod];
        const hit2 = rl ? rl.find(([re]) => re.test(text)) : null;
        sub = hit2 ? hit2[1] : (mod === '资料分析' ? materialSub(r.material) : mod === '政治理论' ? '新思想' : null);
      }
      if (sub) {
        stat.谜模块++;
        stat.明细[`未分类→${mod}|${sub}`] = (stat.明细[`未分类→${mod}|${sub}`] || 0) + 1;
        staged.push([sub, r.qid, r.category, mod]);
        continue;
      }
    }
  }

  // 4) 兜底：该模块自己就有「其他」类二级的，落到「其他（xx）」
  const FALLBACK = { 法律常识: '其他（法律）', 人文常识: '其他（人文历史）', 数量关系: '数学运算', 地理国情: '地理国情', 资料分析: null, 公文写作: '公文的基本知识' };
  const fb = FALLBACK[r.category];
  if (fb) {
    stat.兜底++;
    stat.明细[`${r.category}|${fb}`] = (stat.明细[`${r.category}|${fb}`] || 0) + 1;
    staged.push([fb, r.qid, r.category, null]);
    continue;
  }
  stat.未命中++;
  stat.未明细[r.category] = (stat.未明细[r.category] || 0) + 1;
}

console.log(JSON.stringify({ 候选: stat.候选, 考点命中: stat.考点命中, 措辞命中: stat.措辞命中, 猜模块: stat.谜模块, 拆桶: stat.拆桶, 兜底: stat.兜底, 未命中: stat.未命中 }, null, 1));
console.log('未命中按模块：', JSON.stringify(Object.entries(stat.未明细).sort((a,b)=>b[1]-a[1]).slice(0,12)));
const top = Object.entries(stat.明细).sort((a, b) => b[1] - a[1]).slice(0, 40);
for (const [k, v] of top) console.log(String(v).padStart(6), k);
if (SHOW) {
  for (const [k, arr] of Object.entries(stat.样例)) console.log(`\n[${k}]\n  ` + arr.join('\n  '));
}

if (APPLY) {
  const upd = db.prepare(`UPDATE question_categories SET sub = ? WHERE question_id = ? AND category = ?`);
  const mov = db.prepare(`UPDATE question_categories SET sub = ?, category = ? WHERE question_id = ? AND category = ?`);
  db.exec('BEGIN');
  try { for (const [sub, qid, cat, mod] of staged) { if (mod) mov.run(sub, mod, qid, cat); else upd.run(sub, qid, cat); } db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  const left = db.prepare(`SELECT COUNT(*) n FROM question_categories WHERE COALESCE(sub,'') = ''`).get().n;
  console.log(`已写入 ${staged.length} 条；全库空 sub 行剩余：${left}`);
}
