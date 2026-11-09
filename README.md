# 上岸 · 考公刷题

一个离线优先的公务员 / 事业单位考试刷题 App。题库全量装在手机里，断网也能刷；联网只用于题库增量、时政和 App 更新。

> 题库数据来自公开真题与网络解析，仅供个人学习使用。

**下载**：[最新版 APK](https://github.com/CHAOYUE116/shangan/releases) · **更新记录**：[CHANGELOG.md](CHANGELOG.md)

---

## 它解决什么问题

市面上的刷题 App 有两个毛病：**要网**、**有广告且解析要付费**。

上岸的做法反过来：

- **离线全量**：61,000+ 道题、3,000+ 套卷、46,000+ 条考点，全部打进安装包，一次装好，坐地铁、进考场候场都能刷。
- **一道题讲透**：每道题除了正确答案，还有逐项解析、考点标签、易错点提示。
- **首页只问一件事**：今天做什么。打开就知道还剩几天、今天该刷多少、上次卡在哪。
- **更新不装 App**：题库改了只下发几 MB 的增量，30 秒应用完，不用重新下载 135 MB 的安装包。

---

## 界面

每个页面只回答一个问题，只留一个主按钮。

| 页面 | 回答的问题 | 主按钮 |
|---|---|---|
| 首页 | 今天做什么 | 开始今天的 N 题 |
| 答题页 | 我为什么错了 | 下一题 |
| 结算页 | 进步了吗，下一步去哪 | 看错题 / 再来一组 |
| 题库 | 练哪个方向 | 进入练习 |
| 回顾 | 错在哪、忘了什么 | 开始回顾 |

---

## 功能

**刷题**
- 随机刷题、按试卷练、按考点练
- 错题再练、模考（限时交卷评分）
- 五科覆盖：公务员·行测 / 申论、事业编·职测 / 公基 / 综应
- 按省份、年份、岗位类型筛卷

**解析**
- 逐选项解析，标出每个错误选项错在哪
- 考点标签，直接跳到同考点的题
- 图形推理题的公式图片离线内置

**学习数据**
- 章节正确率、近 7 天趋势
- 每周学习报告 + 下周建议
- 错题自动归档，按遗忘曲线安排回顾

**自定义**
- 考试日期倒计时、每日目标题数
- 日间白 / 夜间墨 / 跟随系统

---

## 怎么用

### 第一次打开

1. 装好 APK，打开「上岸」，看到「距离考试还有 N 天」。
2. 点「我的 → 你的备考空间 > 编辑」，把考试名称、考试日期、每日题数填上。首页的倒计时和每日进度都跟着它变。
3. 回首页，点「开始今天的 N 题」。做完自动出解析。
4. 不想配 AI 也能用，所有题目自带的解析都是离线的。

### 刷题

| 想做的事 | 从哪进 |
| --- | --- |
| 随便练几题 | 题库 → 「随机刷题，不设终点」 |
| 练一整套卷 | 题库 → 「按试卷练习」，按省份 / 年份 / 岗位筛 |
| 专攻一个考点 | 题库 → 「按考点练」 |
| 重做错题 | 题库 → 「错题再练」，按遗忘曲线排队 |
| 模拟考试 | 题库 → 「模考」，限时交卷、出分数 |
| 看这周学得怎样 | 我的 → 学习统计 / 学习报告 |

答完题点选项就提交，不用点确认。做错了会自动进错题本。

**答题页怎么读**：答完之后，每个错误选项下面会写明「为什么错」，正确选项标绿。考点标签可以点，直接跳到同考点的其他题。

### 配 AI（可选）

AI 只用来做三件事：讲错题、批改申论、生成学习计划。不配也不影响刷题。

1. 我的 → AI 设置。
2. 选服务商（默认 DeepSeek），填 API Key，模型默认 `deepseek-chat`。
3. 点「保存并测试」，看到「接通了」就成。连不上也可以「先跳过」，之后随时回来配。

**接口地址**默认为所选服务商的官方地址（DeepSeek 是 `https://api.deepseek.com/v1`），用中转或自建网关时改成自己的即可。

**为什么 Key 在手机上**：Key 只存本机 SQLite，请求由 App 直连服务商，不经过任何中间服务器。

### 更新题库

我的 → 检查题库更新。

- 有新题时只下增量（通常 1–3 MB），几十秒应用完，页面自动重载。
- 跨版本太多或本地库损坏时会退化成全量（80 MB 左右）。
- 下载源走 `gh-proxy` 代理 GitHub Release，国内可直连。

### 换手机 / 备份

我的 → 数据与备份 → 导出。生成一个备份文件，新手机导入即可，做题记录、错题本、设置全部带过去。题库本身不用备份，装完 App 自带。

---

## 技术栈

```
前端     原生 JS 单页应用（无框架），~2000 行
壳       Capacitor 6 + Android WebView
数据     SQLite × 2（tiku.db 题库 / practice.db 练习记录）
桥接     NativeDbBridge.java（WebView ⇄ SQLite 直连）
更新     UpdateManager.java（增量下载 + 事务应用 + 校验）
```

**为什么不用框架**：整个 App 就十几个页面，引入 React/Vue 带来的构建复杂度和包体积不划算。原生 JS 直接操作 DOM，启动更快，改起来也快。

**为什么两套数据库**：`tiku.db` 是只读的题库（317 MB），更新时整块替换；`practice.db` 存用户记录（几 MB），永远不动。分开之后，更新题库不会影响做题历史。

---

## 目录结构

```
kaogong-shuati/          源码与数据工程
├── public/
│   ├── next/            前端源码（app.js / style.css）← 改这里
│   ├── lib/             本地查询层（local-queries.js）
│   └── local-api.js     /api/* 路由的离线实现
├── tools/               数据工程脚本
│   ├── import-fenbi-papers.mjs      真题 ETL 入库
│   ├── fenbi-fetch-solutions.mjs    真题解析采集（Playwright）
│   ├── build-tiku-delta.mjs         生成增量包
│   ├── build-release-manifest.mjs   生成更新清单
│   └── normalize-categories.mjs     清洗脏模块名
├── build-app-assets.mjs 打包 DB 资源
├── server.mjs           本地开发服务器
└── release/manifest.json 更新清单（App 从这里读）

app-shangan/             Android 工程
└── android/app/src/main/java/com/kaogong/app/
    ├── NativeDbBridge.java   SQLite 桥
    ├── UpdateManager.java    更新管理
    └── WebViewActivity.java  WebView 容器
```

---

## 构建

**环境**

```
JDK 17          D:\dev\jdk17
Android SDK     D:\dev\android
Node 18+
```

**出 APK**

```bash
cd kaogong-shuati
node tools/sync-webapp.mjs          # public/next → webapp/
node build-app-assets.mjs app-assets # 打包 tiku.db → tiku_app.db
npx cap copy android                 # 同步到 Android 工程

cd ../app-shangan/android
./gradlew assembleRelease            # 产物在 app/build/outputs/apk/release/
```

**本地调试**

```bash
node server.mjs                      # http://localhost:5173
```

---

## 更新机制

题库改动不走应用商店，走自己的增量通道。

```
1. 本地版本 0.4.4-20261108-1915
2. 拉 release/manifest.json
3. 找到 from=0.4.4 的 delta
4. 下载 696 KB 的 gz 包
5. BEGIN → INSERT OR REPLACE → COMMIT
6. 写 tiku_app.db.ver，前端 reload
```

**增量包里有什么**

```json
{
  "version": "0.5.0-20261108-1955",
  "papers":    [ ... ],   // 新增/修改的试卷
  "questions": [ ... ],   // 新增/修改的题目
  "deleted":   { "questions": [], "papers": [] }
}
```

只包含变化的行，全量 87 MB 的更新被压缩到几百 KB。

**清单地址**

App 按顺序试三个镜像，第一个成功的就用：

```
1. gh-proxy.com/https://raw.githubusercontent.com/...  国内可达，无缓存
2. raw.githubusercontent.com/...                       直连
3. cdn.jsdelivr.net/gh/...@main/...                    CDN 兜底
```

> jsDelivr 对 `@main` 分支别名整体缓存约 12 小时，加 `?t=` 时间戳也绕不过去，所以只能放最后兜底。

**两套版本号，各自独立**

| | 格式 | 举例 | 什么时候变 |
| --- | --- | --- | --- |
| App 版本 | `0.1.x(N)` | `0.1.41(42)` | 前端代码或原生代码改了，要重装 APK |
| 题库版本 | `0.5.x-日期-时刻` | `0.5.2-20261109-0130` | 只加了题 / 改了题，走增量包 |

题库更新不会动 App 版本，App 更新也不会重下题库。两个都改了才需要同时发。

**发一次版的完整流程**

```bash
# 1. 采集 + 入库
node tools/fenbi-fetch-solutions.mjs --course syzc --cat 江苏 --limit 15 --pages 3
node tools/import-fenbi-papers.mjs --apply
node tools/normalize-categories.mjs --apply

# 2. 打增量包
node tools/build-tiku-delta.mjs --old tiku.db.bak --new tiku.db \
  --from 0.5.2-20261109-0130 --to 0.5.3-<新时间> --out ../dist/release

# 3. 重建 App 内置资源
node build-app-assets.mjs app-assets
echo -n '0.5.3-<新时间>' > app-assets/db-version.txt

# 4. 生成 manifest
node tools/build-release-manifest.mjs --base https://github.com/CHAOYUE116/shangan/releases/download/tiku-<tag> --apk ../dist/shangan-<ver>-release.apk

# 5. 上传 Release（gh-proxy + --ssl-no-revoke）
# 6. 把 manifest 同步进仓库并提交
cp ../dist/release/manifest.json release/manifest.json

# 7. 补 CHANGELOG.md
```

`app-assets/db-version.txt` 必须手动写 —— `build-app-assets.mjs` 不生成它，但 `build-release-manifest.mjs` 靠它取 `dbVersion`。

---

## 数据来源

- 真题试卷与解析：粉笔公开题库
- 公基题目：公开整理版本
- 考点体系：自建，46,000+ 条考点映射

**数据现状**

| 科目 | 题量 | 备注 |
|---|---|---|
| 公务员·行测 | 45,253 | 解析较完整 |
| 事业编·职测 | 6,288 | 约 1,100 题缺解析 |
| 公务员·申论 | 4,286 | 主观题，无标准答案 |
| 事业编·公基 | 2,722 | 源数据无难度字段 |
| 事业编·综应 | 2,532 | 主观题，72% 无详解 |

---

## 免责

题库与解析均来自公开渠道，版权归原作者所有。本项目仅作个人学习工具，不提供任何商业服务。
