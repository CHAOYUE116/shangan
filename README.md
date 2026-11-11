# 上岸

> 一个把 9 万道真题装进手机的考公刷题 App。断网能刷，没有广告，解析不用会员。

**一句话**：面向**公务员考试**、**事业单位招聘**、**三支一扶**的离线刷题 App（Android），覆盖**行测 / 职测 / 公基 / 申论 / 综应**。9 万道去重真题、3600+ 套历年真题卷、计时模考与成绩单、错题本与 Leitner 间隔复习，全部跑在手机本地 SQLite 上，不联网也能做题。

**关键词**：考公 · 考编 · 公考 · 公务员 · 国考 · 省考 · 事业单位 · 事业编 · 三支一扶 · 行测 · 职测 · 职业能力倾向测验 · 公基 · 公共基础知识 · 申论 · 综合应用能力 · 综应 · 时政 · 刷题 · 题库 · 真题 · 历年真题 · 模考 · 错题本 · 离线 · 无广告 · Android · Capacitor · SQLite

| 首页 | 题库 | 模考 |
|---|---|---|
| ![首页](docs/screens/home.png) | ![题库](docs/screens/library.png) | ![模考](docs/screens/exam.png) |

| 回顾（错题） | 时政 |
|---|---|
| ![回顾](docs/screens/review.png) | ![时政](docs/screens/politics.png) |

> **声明**　本项目是个人学习项目，不收费、无广告、不对外提供商业服务。
> 题库内容来自公开网络的采集整理，**版权归原平台与原命题机构所有**，本项目不主张任何权利；
> 权利人提出异议会在 72 小时内删除相关内容。
> 详细条款见 [DISCLAIMER.md](DISCLAIMER.md)，代码许可见 [LICENSE](LICENSE)（仅覆盖代码，不覆盖题库）。

**下载** [最新版 APK（Releases → v0.6）](https://github.com/CHAOYUE116/shangan/releases/tag/v0.6)　·　**更新记录** [CHANGELOG.md](CHANGELOG.md)　·　**Android 壳** [shangan-app](https://github.com/CHAOYUE116/shangan-app)　·　**开发约定** [AGENTS.md](AGENTS.md)

当前版本：**App 0.6.1**（`shangan-0.6.1-release.apk`，151.5 MB，Android 8.0+）· 题库 **0.5.18-20261112-0700**（156,121 行 / 103,128 道去重真题）

### 仓库与发布是怎么分工的

项目只有两个仓库，各管一件事：

| 仓库 | 内容 | 谁看 |
|---|---|---|
| [`CHAOYUE116/shangan`](https://github.com/CHAOYUE116/shangan)（当前仓库） | Web 前端、构建脚本、题库导出数据、**发布的 APK 与题库资产** | 使用者从这里下载 |
| [`CHAOYUE116/shangan-app`](https://github.com/CHAOYUE116/shangan-app) | Android 壳：Capacitor 容器、原生下载/题库桥、签名配置 | 开发者 |

Releases 按**大版本**建 tag，一个 tag 只放一版 APK（新版本上传后旧的自动删掉），所以 Releases 列表里不会堆一长串安装包：

| Tag | 放什么 | 例 |
|---|---|---|
| `v0.4` / `v0.5` / `v0.6` … | **App 安装包**，一个大版本一个 | `shangan-0.6.1-release.apk` |
| `tiku-<题库版本>` | **题库资产**：`tiku_app.db.gz`、`images.db.gz`、增量包 | `tiku-0.5.18-20261112-0700` |

App 通过仓库根目录的 [`release/manifest.json`](release/manifest.json) 找更新：里面 `app.url` 指向 `v0.6` 那个 APK，`tiku.sources` 指向题库 tag 里的 `tiku_app.db.gz`。所以发版只需要改这一个 JSON，客户端查到的就是最新地址。

---

清晨六点半，地铁二号线，信号两格。

打开 App，首页只有一行字：**距离考试还有 21 天，今天 20 题**。点进去就是题。做完一道，答错的选项下面立刻说明错在哪，不是「正确答案是 B」，而是「B 错在把充分条件当成了必要条件」。到站前最后一道做完，进度条走满，明天继续。

走出地铁站，信号恢复，App 在后台悄悄拉了一次更新：18 MB，新增了几百道这个月的联考真题。整个过程没有感知。

这就是上岸想做的事。没有别的。

---

## 为什么要自己做

市面上的考公 App 大致两种情况。

一种是**大厂产品**：题库全，但要联网，底部三个 banner，解析分免费版和会员版，看完整解析要开会员，会员还分月卡年卡。

另一种是**个人整理的题库**：PDF、Excel、网盘链接。内容好，但不能刷——没有错题本、没有统计、手机上看 PDF 做 500 道题是折磨。

中间那块空地很明显：**一个真正能刷题的工具，内容全、离线、没有商业干扰**。

技术上它其实不难，难的是两件事：

1. **怎么把 9 万道题（14 万行）塞进一个安装包**，还要保证 WebView 打开不卡
2. **怎么在题目不断新增的情况下，让更新只有几十 MB 而不是重下 110 MB**

这个项目的大部分工程量都花在这两件事上。下面是它们各自的答案。

---

## 一些数字

| | |
| --- | --- |
| 真题 | **103,128** 道（去重后；库里 156,121 行含跨省重复收录） |
| 试卷 | **3,615** 套，覆盖 2001–2027 |
| 考点 | **46,531** 条 |
| 安装包 | **143 MB**（题库 + 公式图片全部内置） |
| 题库体积 | 主库 393 MB + 图片库 40 MB |
| 题库更新 | 增量 **14–30 MB** / 全量 110 MB（gzip） |

| 科目 | 题行 | 唯一题 | 卷数 | 有解析 |
| --- | ---: | ---: | ---: | ---: |
| 公务员·行测 | 82,544 | 45,136 | 724 | 100% |
| 事业编·职测 | 30,989 | 16,521 | 370 | 92.6% |
| 事业编·公基 | 23,910 | 23,053 | 506 | 95.8% |
| 公务员·申论 | 4,501 | 4,286 | 1,152 | 70.9% |
| 事业编·综应 | 2,697 | 2,670 | 862 | 26.0% |

---

## 怎么做到的

### 题库怎么塞进去

393 MB 的 SQLite 题库，加上 40 MB 的公式图片，直接放进 APK 是 433 MB。做法是：

- **图片不放在数据库里**，单独一个 `images.db`，只存图片二进制和一张索引表。题目表里只留图片 ID，渲染时才去查。图片统一转成无损 WebP（55,837 张，76.9 MB → 40 MB）。
- **APK 里的数据库是压缩存储的**（主库 gzip 后 110 MB），安装后第一次启动解压落盘。
- **前端只查不改**，所有查询走 `NativeDbBridge` 直连 SQLite，不经过 JS 内存镜像。14 万行的库，模糊搜索和分页查询都在 50ms 内返回。

代价是首次安装要解压 433 MB（约 30 秒），只有一次。之后每次覆盖安装都跳过重拷，版本落后交给增量包——之前每次覆盖安装都要白拷一遍，这是 0.1.38 修掉的坑。

### 更新为什么只有几十 MB

题库全量 110 MB（gzip 后）。如果每次加题都重下，用户不会更新第二次。

实际做法是打**行级增量包**（v2 NDJSON，逐行流式应用，不整包进内存）：

```
旧库 0.5.14 ──┐
              ├─ diff ─→ 头行 {v:2, from, to, reset:[...]}
新库 0.5.16 ──┘           之后逐行 {"t":"q","r":{...}} / {"t":"d q","id":123}
              ↓
        gzip 压缩 → 14–30 MB（取决于跨了几个版本）
```

App 端边解压边逐行 `INSERT OR REPLACE`，每 2,000 行提交一次事务，中途失败不会把库写坏，也不会像老版本那样因为整包读进 `ByteArrayOutputStream` 而 OOM。

这里有个不明显的坑：**哈希不能算在富文本字段上**。`contentHtml` 和 `analysisHtml` 是运行时的富文本副本，早期把它们算进 diff 哈希，导致 9 万行被判定为「变更」，增量包膨胀到 40 MB，跟全量没区别。

### 两个数据库，互不干扰

```
tiku.db     只读题库，393 MB，更新时整块替换
images.db   公式与图形图片，40 MB，独立更新
practice.db 用户记录，几 MB，永远不动
```

分开之后，更新题库不会动到做题历史、错题本和设置。反过来，清空练习记录也不影响题库。

### 为什么不用 React

整个 App 十几个页面。React + Router + 状态管理的构建链、包体积、启动时间，都不划算。

原生 JS 直接操作 DOM，`app.js` 一个文件 4,300 行，改一行刷新就见效。启动时没有框架初始化，first paint 在 400ms 内。

代价是可维护性——所以每个页面都遵守同一条规矩：**只回答一个问题，只留一个主按钮**。

| 页面 | 回答的问题 | 主按钮 |
| --- | --- | --- |
| 首页 | 今天做什么 | 开始今天的 N 题 |
| 答题页 | 我为什么错了 | 下一题 |
| 结算页 | 进步了吗，下一步去哪 | 看错题 / 再来一组 |
| 题库 | 练哪个方向 | 进入练习 |
| 回顾 | 错在哪、忘了什么 | 开始回顾 |

这条规矩比任何组件抽象都有用。加功能时先问「它回答哪个问题」，答不上来的就不加。

---

## 功能

**刷题**
- 随机刷题 / 按试卷练 / 按考点练 / 错题再练 / 限时模考
- **背题模式**：不答题，直接连题带解析往下翻
- **答对自动跳下一题**（答错停在解析页，留时间看完）
- 五科：公务员·行测、申论；事业编·职测、公基、综应
- 按省份、年份、卷型（真题 / 模拟）筛卷，卷子带难度与「未完成 N/M」角标

**解析**
- 逐选项说明，指出每个错误选项具体错在哪
- 考点标签可点，直接跳到同考点的题
- 图形推理的公式图片离线内置（无损 WebP，55,837 张）
- 解析分层：先给结论，再给推理，最后给易错点

**学习数据**
- 章节正确率、近 7 天趋势、每周报告 + 下周建议
- 错题本支持**按模块筛选**、**做对自动移出**
- 每题反馈带该考点的历史正确率与本题易错项（界面文案：「你在这个考点的正确率」「易错项」）
- 模考成绩单：分数 / 用时 / 每题均时 / 模块得分下钻到**考点**、逐题复盘、历史成绩可回看

**每日任务**
- 每天 = 到期复习 + 新题，按「考试组合」的科目权重分配
- 新题**按薄弱考点抽**：每科取最弱的 3 个考点，70% 的题从这里出，剩下 30% 随机
- 难度跟着正确率走：考点正确率低于 40% 先出易题，高于 80% 换难题
- 首页显示「今日重点」，点进去看能力画像

**基础测评**
- 六个模块各 6 题（2 易 3 中 1 难），共 36 题，约 25 分钟
- 交卷出能力画像：总体正确率、模块红/黄/绿条、最弱 8 个考点（点一下直接练）
- 结果喂给每日任务；不作为分数预测
- 引导页第 4 步可做可跳（跳过后随时在「考试 → 基础测评」补做）
- 测评作答进做题记录，但不进错题本、不计入今日任务

**时政**
- 每月一组，条与条之间有分割线与序号，已读置灰，可只看未读
- 每篇配 3 道练习题

**AI（可选）**
- 用自己的 Key，直连服务商，不经过中间服务器
- 三种能力：讲错题、批改申论、生成学习计划
- 不配也完全不影响刷题

---

## 怎么用

### 第一次打开

1. 装好 APK，打开「上岸」
2. 选方向（公务员 / 事业编 / 三支一扶）→ 选省份 → 填考试日期和每日目标
3. 第 4 步会问要不要做「基础测评」（36 题、约 25 分钟），跳过也行，随时能补
4. 回首页，点「开始今天的 N 题」

AI 那一步可以直接「跳过」，之后随时在「我的 → AI 设置」里配。

基础测评不配 AI 也能做——它是本地统计，不调用模型。

### 刷题

| 想做的事 | 从哪进 |
| --- | --- |
| 随便练几题 | 题库 →「随机刷题，不设终点」 |
| 按模块练 | 题库 → 勾模块（每个模块显示「已做 / 总数」） |
| 练一整套卷 | 题库 →「按试卷练习」，按地区 / 年份 / 卷型筛 |
| 专攻一个考点 | 题库 →「按考点练」 |
| 重做错题 | 题库 →「错题再练」，可按模块筛 |
| 摸底考试 | 考试 → 选一套（10 / 20 / 50 题，按科目自动配时） |
| 看这周学得怎样 | 我的 → 学习统计 / 学习报告 |

默认点选项立即判对错；答对约 1.2 秒后自动进入下一题，答错停在解析页。也可以在「我的 → 练习偏好」里关掉自动跳题、打开背题模式。

**答题页怎么读**：答完之后，每个错误选项下面写明「为什么错」，正确选项标绿。考点标签可以点，跳到同考点的其他题。

### 配 AI

AI 只做三件事：讲错题、批改申论、生成计划。

1. 我的 → AI 助手
2. 点一个配置，选服务商（默认 DeepSeek），填 Key
3. 点「试一句」，看到它答上来就行

默认参数如下，用中转或自建网关时改「接口地址」即可：

```
服务商    DeepSeek
接口地址  https://api.deepseek.com
模型      deepseek-flash
```

Key 只存本机 SQLite，请求由 App 直接发给服务商。

### 更新题库

我的 → 检查题库更新。

- 有新题：下增量（14–30 MB），一分多钟应用完，页面自动重载
- 跨版本太多或本地库损坏：退化成全量（110 MB）
- 下载源走 `gh-proxy` 代理 GitHub Release，国内直连

### 换手机

我的 → 数据与备份 → 导出。新手机导入即可，做题记录、错题本、设置全带过去。题库不用备份，装完自带。

---

## 技术栈

```
前端      原生 JS 单页应用，无框架，~4300 行
壳        Capacitor 6 + Android WebView
数据      SQLite × 3（tiku.db 题库 / images.db 图片 / practice.db 记录）
桥接      NativeDbBridge.java —— WebView ⇄ SQLite 直连
更新      UpdateManager.java —— 分块下载 + NDJSON 流式应用 + SHA-256 校验
数据工程  Node.js（采集、ETL、diff、打包）
```

`kaogong-shuati/` 是源码与数据工程，[`app-shangan/`](https://github.com/CHAOYUE116/shangan-app) 是 Android 壳（单独一个仓库，见它自己的 README）。

```
kaogong-shuati/
├── public/
│   ├── next/              前端源码（app.js / style.css）← 改这里
│   ├── lib/               本地查询层（local-queries.js / fenbi-tree.js）
│   ├── local-api.js       /api/* 的离线实现
│   └── local-bootstrap.js 启动装配：SQLite → 路由 → AI
├── tools/                 数据工程
│   ├── fenbi-keypoint-fetch.mjs    考点散题采集（Playwright）
│   ├── fenbi-fetch-all.mjs         整卷采集
│   ├── import-raw-papers.mjs       原始卷 ETL 入库
│   ├── build-tiku-delta.mjs        生成增量包（v2 NDJSON）
│   ├── export-quality-data.mjs     导出仓库用 data/*.jsonl.gz
│   └── publish-app.mjs             一条命令发版
├── data/                  导出的题库数据（供他人直接使用）
├── server.mjs             本地开发服务器
└── release/manifest.json  更新清单（App 从这里读）

app-shangan/android/app/src/main/java/com/kaogong/app/
├── NativeDbBridge.java    SQLite 桥
├── UpdateManager.java     更新管理
├── DownloadService.java   前台下载通知
└── WebViewActivity.java   WebView 容器
```

---

## 构建

```bash
# 环境：JDK 17、Android SDK、Node 18+

cd kaogong-shuati
node tools/sync-webapp.mjs              # public/next → webapp/（默认连 assets 一起同步）
node tools/write-db-version.mjs <题库版本>  # 写 app-assets/db-version.txt
npx cap copy android

cd ../app-shangan/android
./gradlew assembleRelease               # 产物在 app/build/outputs/apk/release/
```

本地调试：`node server.mjs` → http://localhost:5173

---

## 更新机制

题库不走应用商店，走自己的增量通道。

```
1. 本地版本 0.5.14-20261110-1450
2. 拉 release/manifest.json
3. 找 from=0.5.14 的 delta（没有就退化全量）
4. 下载 14–30 MB gz，边解压边逐行应用
5. BEGIN → INSERT OR REPLACE（每 2,000 行提交一次）→ COMMIT
6. 写 tiku_app.db.ver，前端 reload
```

增量包是 v2 NDJSON，头行给元信息，之后一行一条记录：

```json
{"v":2,"from":"0.5.14-…","to":"0.5.16-…","reset":["question_categories"],"counts":{…}}
{"t":"q","r":{ ... 一道题 ... }}
{"t":"p","r":{ ... 一套卷 ... }}
{"t":"dq","id":123456}
```

老版本用单个 JSON 对象 + 整包读进内存，85 MB 的包会让手机 OOM；现在边解压边写库，峰值内存只有一个读缓冲。

清单地址三个镜像按序试，第一个通的就用：

```
1. gh-proxy.com/https://raw.githubusercontent.com/...  国内可达
2. raw.githubusercontent.com/...                       直连
3. cdn.jsdelivr.net/gh/...@main/...                    CDN 兜底
```

> jsDelivr 对 `@main` 分支别名整体缓存约 12 小时，加 `?t=` 也绕不过去，只能放最后。

**两套版本号，各自独立**

| | 格式 | 举例 | 什么时候变 |
| --- | --- | --- | --- |
| App | `0.1.x(N)` | `0.1.41(42)` | 前端或原生代码改了，要重装 APK |
| 题库 | `0.5.x-日期-时刻` | `0.5.2-20261109-0130` | 只加题、改题，走增量包 |

改题库不动 App 版本，改 App 不重下题库。两个都改了才同时发。

**发版流程**

```bash
# 1. 采集 + 入库（整卷走 fenbi-fetch-all，考点散题走 fenbi-keypoint-fetch）
node tools/fenbi-keypoint-fetch.mjs --course syzc --gap 8
node tools/import-raw-papers.mjs --apply
node tools/classify-gongji.mjs --apply        # 公基按 8 个模块分组
node tools/backfill-from-api.mjs --apply      # 补解析

# 2. 打增量包（v2 NDJSON，流式写入）
node tools/build-tiku-delta.mjs --old tmp-old.db --new app-assets/tiku_app.db \
  --from 0.5.15-<旧时间> --to 0.5.16-<新时间>

# 3. 写题库版本号
node tools/write-db-version.mjs 0.5.16-<新时间>

# 4. 出 APK + manifest + 上传 + push + 轮询 CDN，一条命令全包
node tools/publish-app.mjs --version 0.4.1 --code 86 --note "本次改了什么"
```

`publish-app.mjs` 内部按固定顺序做九件事：比对版本号（不一致自动 bump）→ `sync-webapp` → `robocopy` 到 android assets → `gradlew assembleRelease` → `fix-manifest` → 补 `app` 段 → 自检（url/sha/size/delta 哈希）→ 上传 Release → commit + push → 轮询 CDN 直到命中新版本。

顺序不能颠倒：**`fix-manifest` 会按 `sources[0]` 覆写 `app.url`**，先写 app 段再跑 fix，就等于把新下载地址改回旧包。

还要记得补 `CHANGELOG.md`，写清「改了什么」和「为什么」。每条都要带根因，别只写结论。例如不要写「修复了更新失败」，要写「sha256 对不上：App 解压后算哈希，manifest 给的却是 .gz 的哈希」。

---

## 数据来源

**[粉笔题库](https://tiku.fenbi.com)** — 主体

行测、职测、申论、综应的真题与解析，绝大部分来自这里。粉笔的网页端没有做请求签名，带着自己的登录 Cookie 就能取到试卷列表和题目；解析要先提交一次练习，再从 `/combine/static/solution` 取回。采集脚本用 Playwright 驱动真实 Chrome 走这个流程——直接 curl 会被 WAF 返回 453。

入库的 144,641 行里，绝大多数是通过这个流程采的（整卷接口给题，`/combine/static/solution` 给解析），另有约 2,722 题来自下面的公基静态源。

**[linfukai186-arch/gongkao-tiku](https://github.com/linfukai186-arch/gongkao-tiku)** — 公基早期底子

作者把事业单位真题整理成静态 JSON 挂在 GitHub Pages 上，结构很干净：

```
data/<模块>/index.json     条目清单（key 形如 "2026·xxx考试"，count=题数）
data/<模块>/y<年份>.json   { "key": [ { t, s, q, o, a, e } ] }
```

字段 `t`=模块/题型、`s`=材料、`q`=题干、`o`=选项数组、`a`=答案、`e`=解析。早期导入 2,722 题；后来公基主要由粉笔整卷补到 23,053 题（506 套卷）。

这个源没有难度字段，所以这批早期公基题没有难度标签——App 里遇到这种情况直接不显示，而不是显示「难度 0」。

**考点体系**：自建，46,531 条映射（`question_keypoints`），另有 `question_categories` 的章节分组兜底。

---

## 仓库里的数据

`data/` 下是两个导出文件，内容是「题干净、有答案、有解析」的那部分，直接用 `gzip -d` + `jq` 就能读，不需要装 App：

| 文件 | 内容 | 大小 |
| --- | --- | ---: |
| `data/tiku-quality.jsonl.gz` | **126,875 题**，每行一个 JSON 对象 | 54.6 MB |
| `data/papers.jsonl.gz` | 3,615 套卷的元信息（卷名 / 科目 / 分类 / 年份 / 题数 / 难度） | 62 KB |

题目字段：

```json
{"id":123,"qid":"…","pid":45,"paper":"2026年4月25日浙江省事业单位统考《职测》",
 "ch":"言语理解与表达","t":"单选题","qt":"1","s":"题干","o":["A 选项","B 选项"],
 "a":"C","ai":2,"d":4,"src":"（2026·浙江）","e":"解析原文","m":"材料","kp":"中心理解题"}
```

导出脚本：`node tools/export-quality-data.mjs`（从内置库导出，改完题重跑一遍即可）。

> 这套数据只是「题目 + 解析」的文本，没有图片（图片在 `images.db`，不进仓库）；解析与题目版权归原平台与原命题机构所有，见 [DISCLAIMER.md](DISCLAIMER.md)。

## 依赖

| 项目 | 用途 |
| --- | --- |
| [Capacitor](https://capacitorjs.com/) | Android 壳，负责 WebView 容器和原生插件桥接 |
| [Playwright](https://playwright.dev/) | 驱动 Chrome 采集真题，绕不过 WAF 时的唯一办法 |
| [Pillow](https://python-pillow.org/) | 公式图片转无损 WebP：55,837 张，76.9 MB → 40 MB |
| [SQLite](https://sqlite.org/) | 两套数据库的底座；Node 侧用内置的 `node:sqlite`，不引第三方驱动 |

**已知缺口**

| 问题 | 规模 | 原因 |
| --- | --- | --- |
| 职测无解析 | 2,307 题（7.4%） | 这些题在粉笔同卷里找不到对应题，接口不给 |
| 公基无解析 | 1,005 题（4.2%） | 同上，早期静态源那批 |
| 申论无解析 | 1,310 题（29.1%） | 主观题，源站本就不带详解 |
| 综应无详解 | 1,995 题（74.0%） | 同上 |
| 答案-解析矛盾 | 7 条 | 已人工核对，待逐条修 |
| 公基无考点标签 | 100% | 粉笔公基没有考点树，只有 8 个模块分组 |
| 职测考点覆盖 | 约 29% | 其余用章节 `sub` 兜底 |
| 跨卷重复收录 | 156,121 行 → 103,128 题 | 同一题被多省卷收录；抽题按 `questionId` 去重，不会重复出现 |

---

## 设计参考

界面上的几处交互不是凭空想出来的，看过这些项目：

| 参考 | 借了什么 |
| --- | --- |
| [ERRRC/kaogong-shuati](https://github.com/ERRRC/kaogong-shuati)（中文名「没钱考什么公」） | **主要参考实现**。这个项目先做了一版同样的东西：Capacitor 套壳 + 本地 SQLite 题库 + 离线刷题 + 错题本 + AI 解析。本项目的整体技术路线（Capacitor/WebView 而非纯原生、题库随包内置而非联网拉取、用 `node:sqlite` 做数据管线）以及一批页面的信息组织方式（AI 配置页要填哪些字段、数据备份页包含哪些数据、错题本的编排）都参考了它的实现方式与部分代码，之后按本项目的设计语言和数据规模重写、扩展 |
| [xuexiangjys/XUpdate](https://github.com/xuexiangjys/XUpdate)、[azhon/AppUpdate](https://github.com/azhon/AppUpdate)、[MZCretin/AutoUpdateProject](https://github.com/MZCretin/AutoUpdateProject) | App 内更新的分层（检查 / 解析 / 提示 / 下载）与几个必须处理的坑：Android 10+ 后台不能直接起安装器要发通知、Android 13 通知权限、下载完成复用已下好的包、断点续传 |
| [AnkiDroid](https://github.com/ankidroid/Anki-Android) | 三计数（待复习 / 已排期 / 已掌握）的错题债务表达 |
| [Learn-N-Mobile](https://github.com/learnn/Learn-N-Mobile) | 卡片式刷题、左右滑动判对错的手势位 |
| 粉笔题库 | 数据源；题目页的「考点 / 秒杀 / 陷阱」三段结构 |

原则是借信息架构，不搬界面：所有页面按本项目的排版体系（圆角卡、`.opt-row`、底部 sheet）重新画过，字号、间距、配色、文案都另起。

如果上面任何一位作者认为这里的使用方式越界，提个 issue，我会在 72 小时内撤掉对应部分。

---

## 免责

题库与解析来自公开渠道，版权归原作者所有。本项目仅作个人学习工具，不提供商业服务。

---

<sub>如果这个项目有用，欢迎 Star；问题请提 Issue。</sub>
