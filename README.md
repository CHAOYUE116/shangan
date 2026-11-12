# 上岸

**把十万道真题装进手机的考公刷题 App。断网能刷，没有广告，解析不用会员。**

面向公务员考试、事业单位招聘、三支一扶的离线刷题工具，覆盖行测 / 职测 / 公基 / 申论 / 综应。题库、解析、公式图片全部内置在安装包里，跑在手机本地 SQLite 上，不联网也能做题。

| 下载 | 版本 | 体积 | 平台 |
|---|---|---|---|
| [Releases → v0.7](https://github.com/CHAOYUE116/shangan/releases/tag/v0.7) | App 0.7.2 · 题库 0.5.30 | 238 MB | Android 8.0+ |

更新记录 [CHANGELOG.md](CHANGELOG.md) · Android 壳 [shangan-app](https://github.com/CHAOYUE116/shangan-app) · 开发约定 [AGENTS.md](AGENTS.md)

| 首页 | 题库 | 模考 |
|---|---|---|
| ![首页](docs/screens/home.png) | ![题库](docs/screens/library.png) | ![模考](docs/screens/exam.png) |

| 学习统计 | 学习报告 | 答题 |
|---|---|---|
| ![学习统计](docs/screens/stats.png) | ![学习报告](docs/screens/report.png) | ![答题](docs/screens/review.png) |

---

## 这是什么

市面上的考公 App 大致两种：大厂产品题库全，但要联网、有广告，解析分免费和会员；个人整理的题库内容好，但只是 PDF 和网盘链接，没法刷——没有错题本、没有统计、在手机上翻 PDF 做五百道题是折磨。

中间那块空地很明显：**一个真正能刷题的工具，内容全、离线、没有商业干扰**。

技术上它不难，难的是三件事，这个项目的大部分工程量都花在这里：

1. 怎么把十万道题塞进一个安装包，还要保证 WebView 打开不卡
2. 怎么在题目不断新增的情况下，让更新只有几十 MB 而不是重下 600 MB
3. 怎么让题目质量过得去——答案解析不符、图丢了、公式被吞，这些比数量更劝退

---

## 题量

| 科目 | 唯一题 | 试卷 | 有解析 | 图文题 |
| --- | ---: | ---: | ---: | ---: |
| 公务员·行测 | 46,710 | 764 | 100% | 35.6% |
| 事业编·职测 | 64,675 | 271 | 99.9% | 23.4% |
| 事业编·公基 | 37,786 | 275 | 99.2% | 4.3% |
| 公务员·申论 | 4,286 | 1,152 | 69.5% | — |
| 事业编·综应 | 2,825 | 862 | 37.1% | 2.6% |
| **合计** | **156,282** | **3,620** | **97.8%** | **21.4%** |

库里 20.9 万行（同一道题被多个省卷收录时会有多行），抽题按 `questionId` 去重，不会重复出现。仍有 0.21% 的题被标成「做不了」（缺图、公式被吞、平台打码），抽题时会自动跳过。

体积：主库 784 MB（gzip 后 160 MB）+ 图片库 90.5 MB（85,248 张公式与图形）。

---

## 能做什么

**刷题**
随机刷题 / 按试卷练 / 按考点练 / 错题再练 / 限时模考；五科全覆盖；按省份、年份、卷型筛卷，卷子带难度与「未完成 N/M」角标。
支持**背题模式**（不答题，直接连题带解析往下翻）和**答对自动跳下一题**（答错停在解析页）。

**解析**
逐选项说明错在哪，正确选项标绿；考点标签可点，跳到同考点的其他题；公式与图形离线内置。

**学习统计**（看数据）
估分环、六维能力雷达（我的 vs 目标）、模块正确率带目标刻线、近 7 天趋势，支持近 7 天 / 30 天 / 全部切换。

**学习报告**（看结论）
一句话诊断（这周还没开张 / 还在打底 / 进入提分期 / 节奏稳了）→ 跟上周比 → 这周做三件事，每条都能一键直达。

**每日任务**
每天 = 到期复习 + 新题，按考试组合的科目权重分配。新题按章节能力账本抽——优先出预测正确率落在 70%–80% 的题，留 15% 给没练过的章节做探索。

**基础测评**
六模块各 6 题（2 易 3 中 1 难），共 36 题约 25 分钟；交卷出能力画像与最弱 8 个考点，结果喂给每日任务。引导页可跳过，随时在「考试 → 基础测评」补做。

**时政**
每月一组，已读置灰，可只看未读；每篇配 3 道练习题。

**AI（可选）**
用自己的 Key 直连服务商，不经过中间服务器；能做讲错题和批改申论。不配也完全不影响刷题。

---

## 装和用

1. 下载 APK 安装，打开「上岸」
2. 选方向（公务员 / 事业编 / 三支一扶）→ 选省份 → 填考试日期和每日目标
3. 第 4 步会问要不要做基础测评（36 题），跳过也行；回首页点「开始今天的 N 题」

| 想做的事 | 从哪进 |
|---|---|
| 随便练几题 | 题库 →「随机刷题，不设终点」 |
| 按模块 / 考点练 | 题库 → 勾模块，或「按考点练」 |
| 练一整套卷 | 题库 →「按试卷练习」，按地区 / 年份 / 卷型筛 |
| 重做错题 | 题库 →「错题再练」，可按模块筛 |
| 摸底考试 | 考试 → 选一套（10 / 20 / 50 题，按科目自动配时） |
| 看这周学得怎样 | 我的 → 学习统计 / 学习报告 |

默认点选项立即判对错，答对约 1.2 秒后自动进下一题，答错停在解析页。这些都能在「我的 → 阅读与练习」里改，字号也在那里调。

**更新题库**：我的 → 检查题库更新。有新题下增量（14–40 MB），跨版本太多或本地库损坏时退化成全量（160 MB），下载源走 gh-proxy 代理，国内直连。

**换手机**：我的 → 数据与备份 → 导出/导入。做题记录、错题本、设置全带过去，题库不用备份。

---

## 怎么做的

### 题库怎么塞进 238 MB

612 MB 主库 + 49.7 MB 图片库，直接放进 APK 是 660 MB。三个处理：

- **图片单独一个库**（`images.db`）：主库里只留图片 ID，渲染时才去查，统一转无损 WebP
- **APK 内的数据库压缩存储**：主库 gzip 后 141 MB，首次启动解压落盘（约 1 分钟，只有一次）
- **前端只查不改**：查询经 `NativeDbBridge` 直连 SQLite，不经过 JS 内存镜像，十几万行的分页与模糊搜索都在 50 ms 内

### 更新为什么只有几十 MB

```
旧库 0.5.14 ──┐
              ├─ diff ─→ 头行 {v:2, from, to, reset:[...]}
新库 0.5.16 ──┘           之后逐行 {"t":"q","r":{...}} / {"t":"dq","id":123}
              ↓
        gzip → 14–40 MB（取决于跨了几个版本）
```

App 端边解压边逐行 `INSERT OR REPLACE`，每 2,000 行提交一次事务，中途失败不会把库写坏。

有个不明显的坑：**哈希不能算在富文本字段上**。`contentHtml` / `analysisHtml` 是运行时副本，早期把它们算进 diff 哈希，导致大批行被判为「变更」，增量包膨胀到跟全量一样大。

### 题目质量怎么保证

每次采集完都过六道闸门，异常题写进 `q_bad` 列，出题侧四条路径统一过滤——**屏蔽不等于删除**，补齐后改回去就恢复。

| 闸门 | 抓什么 | 怎么修 |
| --- | --- | --- |
| 结构体检 | 空题干、选项缺失、没答案、下标越界 | 直接丢弃，不进库 |
| 图文体检 | 提到「如图 / 下表」但整题没图；材料缺失 | 回源站按题号或按卷重取 |
| 公式体检 | 解析里「进价为＿，而…」数字被吞 | 拉回带公式图的解析覆盖 |
| 答案一致性 | 解析写的字母与库里答案冲突 | 以官方答案为准，整段替换解析 |
| 内容打码 | 题干含 `****`（平台对未购课内容的遮挡） | 标为不可用，不出题 |
| 重复度 | 同一题被多省卷收录 | 按内容指纹去重 |

---

## 数据来源

**[粉笔题库](https://tiku.fenbi.com)** — 主体。网页端没做请求签名，带自己的登录 Cookie 就能取题。三条路径按代价从低到高：

| 接口 | 拿到什么 | 代价 |
| --- | --- | --- |
| `GET /api/{course}/questions?ids=` | 题干、材料、选项、答案、官方难度 | 纯 GET，单次 200 题 |
| `GET /api/{course}/solutions?ids=` | 解析、考点、全站正确率 | 纯 GET，单次 30 题 |
| `POST /api/{course}/exercises` + `/combine/static/solution` | 整卷题目与解析 | 吃「创建练习」额度，约 25 次/小时 |

**[linfukai186-arch/gongkao-tiku](https://github.com/linfukai186-arch/gongkao-tiku)** — 公基早期底子。作者把事业单位真题整理成静态 JSON 挂在 GitHub Pages 上，早期导入 2,722 题；后来公基主要由粉笔整卷补到两万多题。

**考点体系** 自建：粉笔给考点，我们映射到章节；公基没有考点树，用 8 个模块兜底。

仓库里 `data/` 有导出的纯文本数据（十余万题 + 卷元信息，`gzip -d` + `jq` 直接读），字段是 `qid / paper / ch / t / s / o / a / ai / d / e / m / kp`，导出脚本 `node tools/export-quality-data.mjs`。图片不在里面。

---

## 开发

```
kaogong-shuati/          前端 + 数据工程（本仓库）
├── public/next/         前端源码（app.js / style.css / lab.js 引擎）
├── public/lib/          本地查询层（local-queries.js / fenbi-tree.js）
├── public/local-api.js  /api/* 的离线实现
├── tools/               采集 / 体检 / 难度 / 打包 / 发版
├── data/                导出给他人用的题库文本
└── release/manifest.json 更新清单（App 从这里读）

shangan-app/             Android 壳（另一个仓库）
└── android/app/src/main/java/com/kaogong/app/
    NativeDbBridge.java  SQLite 桥 · UpdateManager.java 更新管理
```

```bash
# 环境：JDK 17、Android SDK、Node 22+
cd kaogong-shuati
node tools/sync-webapp.mjs                 # public/next → webapp/（含 assets）
node tools/write-db-version.mjs <题库版本>  # 写 app-assets/db-version.txt
node tools/ci.mjs                          # 语法 + 结构 + 题库冒烟

cd ../app-shangan/android
./gradlew assembleProdRelease              # 产物 app/build/outputs/apk/prod/release/
```

本地调试：`node server.mjs` → http://localhost:5173

打包 600 MB 题库资源时 `gradle.properties` 需要 `-Xmx6144m`，否则 `Java heap space`。

**发版**：App 用 `node tools/release-app.mjs --tag v0.7 --apk … --version x.y.z --code NN`，题库用 `node tools/publish-release.mjs --tag tiku-<版本> --dir <目录> --files …`，两者都只改 `release/manifest.json` 里的对应段。历史包一律保留，只在同名重传时替换。

---

## 已知限制

| 问题 | 规模 | 原因 |
| --- | --- | --- |
| 申论解析 | 覆盖 69.5% | 主观题，源站本就不带详解 |
| 综应解析 | 覆盖 25.3% | 同上 |
| 公基考点树 | 无 | 粉笔公基只有 8 个模块分组 |
| 职测试卷 | 271 / 1,111 套 | 采集额度限制，分批补 |
| 少数题目内容打码 | 百级 | 平台对未购课内容遮挡，已屏蔽 |

---

## 参考与致谢

借的是信息架构和「接口长什么样」，界面全部按本项目自己的排版体系重画，代码自己写。

- **[ERRRC/kaogong-shuati](https://github.com/ERRRC/kaogong-shuati)**（「没钱考什么公」）— 主要参考实现：Capacitor 套壳 + 本地 SQLite 题库 + 离线刷题的整体路线、AI 配置页与数据备份页的信息组织
- **[Jacqueline-Sun/fenbi-practice-data](https://github.com/Jacqueline-Sun/fenbi-practice-data)** — 最早写清「练习历史 → 取解析 → 取报告」这条链；顺着它找到 `GET /api/{course}/questions?ids=`，0.7 这轮九万道题的题干、材料、官方难度靠它补齐
- **[deckcode/BQ_Spider](https://github.com/deckcode/BQ_Spider)** — 代码没用上，但它 XPath 里那列「正确率」提醒我们粉笔每题都有全站正确率，顺着挖到 `getMeta`
- **[EricPeng1027/fenbi-crawler](https://github.com/EricPeng1027/fenbi-crawler)** — 验证了「未做过的卷要交白卷才能拿解析」，让我们确定只能走接口
- **[XUpdate](https://github.com/xuexiangjys/XUpdate) / [AppUpdate](https://github.com/azhon/AppUpdate)** — App 内更新的分层，以及 Android 10+ 安装器、13 通知权限、断点续传这些坑
- **[AnkiDroid](https://github.com/ankidroid/Anki-Android)** — 错题债务的三计数表达；界面参考还有 [Learn-N-Mobile](https://github.com/learnn/Learn-N-Mobile) 的卡片式手势

如果上面任何一位作者认为这里的使用方式越界，欢迎提 issue，我们会在 72 小时内撤掉对应部分。

---

## 免责

这是一个个人学习项目：不收费、无广告、不提供商业服务。题库与解析来自公开渠道，版权归原平台与原命题机构所有，本项目不主张任何权利；权利人提出异议会在 72 小时内删除相关内容。代码许可见 [LICENSE](LICENSE)（仅覆盖代码，不覆盖题库），其余条款见 [DISCLAIMER.md](DISCLAIMER.md)。

<sub>如果这个项目有用，欢迎 Star；问题请提 Issue。</sub>
