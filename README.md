# 上岸

> 一个把 61,768 道真题装进手机的考公刷题 App。断网能刷，没有广告，解析不用会员。

**下载** [最新版 APK](https://github.com/CHAOYUE116/shangan/releases)　·　**更新记录** [CHANGELOG.md](CHANGELOG.md)　·　**Android 壳** [shangan-app](https://github.com/CHAOYUE116/shangan-app)　·　**开发约定** [AGENTS.md](AGENTS.md)

---

清晨六点半，地铁二号线，信号两格。

你打开手机，首页只写着一行字：**距离考试还有 21 天，今天 20 题**。点进去就是题。做完一道，答错的选项下面立刻告诉你错在哪，不是「正确答案是 B」，是「B 错在把充分条件当成了必要条件」。到站前最后一道做完，进度条走满，明天见。

走出地铁站，信号恢复，App 在后台悄悄拉了一次更新：2.4 MB，新增 754 道 2026 年 10 月的联考真题。你没感觉到它发生。

这就是上岸想做的事。没有别的。

---

## 为什么要自己做

市面上的考公 App 大致两种情况。

一种是**大厂产品**：题库全，但要联网，底部三个 banner，解析分免费版和会员版，看完整解析要开会员，会员还分月卡年卡。

另一种是**个人整理的题库**：PDF、Excel、网盘链接。内容好，但不能刷——没有错题本、没有统计、手机上看 PDF 做 500 道题是折磨。

中间那块空地很明显：**一个真正能刷题的工具，内容全、离线、没有商业干扰**。

技术上它其实不难，难的是两件事：

1. **怎么把 61,768 道题塞进一个安装包**，还要保证 WebView 打开不卡
2. **怎么在题目不断新增的情况下，让更新只有几 MB 而不是重下 135 MB**

这个项目的大部分工程量都花在这两件事上。下面是它们各自的答案。

---

## 一些数字

| | |
| --- | --- |
| 真题 | **61,768** 道（去重后） |
| 试卷 | **3,042** 套，覆盖 2001–2027 |
| 考点 | **46,531** 条，关联 29,961 道题 |
| 安装包 | **135 MB**（题库 + 图片全部内置） |
| 冷启动 | **1.7 秒** |
| 题库更新 | 增量 **2.4 MB** / 全量 84 MB |
| 解析覆盖 | 行测 100%、公基 100%、职测 85.7% |

| 科目 | 题量 | 卷数 |
| --- | ---: | ---: |
| 公务员·行测 | 45,136 | 724 |
| 事业编·职测 | 7,092 | 123 |
| 公务员·申论 | 4,286 | 1,152 |
| 事业编·公基 | 2,722 | 231 |
| 事业编·综应 | 2,532 | 812 |

---

## 怎么做到的

### 题库怎么塞进去

321 MB 的 SQLite 题库，加上 73 MB 的公式图片，直接放进 APK 是 394 MB。做法是：

- **图片不放在数据库里**，单独一个 `images.db`，只存图片二进制和一张索引表。题目表里只留图片 ID，渲染时才去查。这样题库主库能从 400+ MB 压到 321 MB。
- **APK 里的数据库是压缩存储的**，安装后第一次启动解压落盘。
- **前端只查不改**，所有查询走 `NativeDbBridge` 直连 SQLite，不经过 JS 内存镜像。61,768 道题的库，模糊搜索和分页查询都在 50ms 内返回。

代价是首次安装要拷 394 MB（约 30 秒），只有一次。之后每次覆盖安装都跳过重拷，版本落后交给增量包——这是 0.1.38 修的一个大坑，之前每次覆盖安装都要白拷 394 MB。

### 更新为什么只有几 MB

题库全量 84 MB（gzip 后）。如果每次加题都重下，用户不会更新第二次。

实际做法是打**行级增量包**：

```
旧库 0.5.0  ──┐
              ├─ diff ─→ {"papers":[18条],"questions":[754新增,4458修改],"deleted":{"questions":[117]}}
新库 0.5.2  ──┘
              ↓
        gzip 压缩 → 2.4 MB
```

App 收到后在一个事务里 `INSERT OR REPLACE`，中途失败自动回滚，库不会坏。

这里有个不明显的坑：**哈希不能算在富文本字段上**。`contentHtml` 和 `analysisHtml` 是运行时按需生成的富文本副本，早期把它们算进 diff 哈希，导致 90,000 行被判定为「变更」，增量包膨胀到 40 MB，跟全量没区别。去掉之后稳定在 2.4 MB。

### 两个数据库，互不干扰

```
tiku.db     只读题库，321 MB，更新时整块替换
practice.db 用户记录，几 MB，永远不动
```

分开之后，更新题库不会碰你的做题历史、错题本、设置。反过来，清空练习记录也不影响题库。

### 为什么不用 React

整个 App 12 个页面。React + Router + 状态管理的构建链、包体积、启动时间，都不划算。

原生 JS 直接操作 DOM，`app.js` 一个文件 2,400 行，改一行刷新就见效。启动时没有框架初始化，first paint 在 400ms 内。

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
- 五科：公务员·行测、申论；事业编·职测、公基、综应
- 按省份、年份、岗位类型筛卷

**解析**
- 逐选项说明，指出每个错误选项具体错在哪
- 考点标签可点，直接跳到同考点的题
- 图形推理的公式图片离线内置
- 解析分层：先给结论，再给推理，最后给易错点

**学习数据**
- 章节正确率、近 7 天趋势
- 每周报告 + 下周建议
- 错题按遗忘曲线排队回顾

**AI（可选）**
- 用自己的 Key，直连服务商，不经过中间服务器
- 三种能力：讲错题、批改申论、生成学习计划
- 不配也完全不影响刷题

---

## 怎么用

### 第一次打开

1. 装好 APK，打开「上岸」
2. 选方向（公务员 / 事业编 / 三支一扶）→ 选省份 → 填考试日期和每日目标
3. 回首页，点「开始今天的 N 题」

AI 那一步可以直接「跳过」，之后随时在「我的 → AI 设置」里配。

### 刷题

| 想做的事 | 从哪进 |
| --- | --- |
| 随便练几题 | 题库 →「随机刷题，不设终点」 |
| 练一整套卷 | 题库 →「按试卷练习」，按省份 / 年份 / 岗位筛 |
| 专攻一个考点 | 题库 →「按考点练」 |
| 重做错题 | 题库 →「错题再练」 |
| 模拟考试 | 题库 →「模考」，限时交卷出分 |
| 看这周学得怎样 | 我的 → 学习统计 / 学习报告 |

答完题点选项就提交，不用点确认。答错自动进错题本。

**答题页怎么读**：答完之后，每个错误选项下面写明「为什么错」，正确选项标绿。考点标签可以点，跳到同考点的其他题。

### 配 AI

AI 只做三件事：讲错题、批改申论、生成计划。

1. 我的 → AI 设置
2. 选服务商（默认 DeepSeek），填 Key
3. 点「保存并测试」，看到「接通了」就行

默认参数如下，用中转或自建网关时改「接口地址」即可：

```
服务商    DeepSeek
接口地址  https://api.deepseek.com
模型      deepseek-flash
```

Key 只存本机 SQLite，请求由 App 直接发给服务商。

### 更新题库

我的 → 检查题库更新。

- 有新题：下增量（1–3 MB），几十秒应用完，页面自动重载
- 跨版本太多或本地库损坏：退化成全量（84 MB）
- 下载源走 `gh-proxy` 代理 GitHub Release，国内直连

### 换手机

我的 → 数据与备份 → 导出。新手机导入即可，做题记录、错题本、设置全带过去。题库不用备份，装完自带。

---

## 技术栈

```
前端      原生 JS 单页应用，无框架，~2400 行
壳        Capacitor 6 + Android WebView
数据      SQLite × 2（tiku.db 题库 / practice.db 记录）
桥接      NativeDbBridge.java —— WebView ⇄ SQLite 直连
更新      UpdateManager.java —— 增量下载 + 事务应用 + SHA-256 校验
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
│   ├── fenbi-fetch-solutions.mjs   真题采集（Playwright）
│   ├── import-fenbi-papers.mjs     真题 ETL 入库
│   ├── build-tiku-delta.mjs        生成增量包
│   ├── build-release-manifest.mjs  生成更新清单
│   └── normalize-categories.mjs    清洗脏模块名
├── build-app-assets.mjs   打包 DB 资源
├── server.mjs             本地开发服务器
└── release/manifest.json  更新清单（App 从这里读）

app-shangan/android/app/src/main/java/com/kaogong/app/
├── NativeDbBridge.java    SQLite 桥
├── UpdateManager.java     更新管理
└── WebViewActivity.java   WebView 容器
```

---

## 构建

```bash
# 环境：JDK 17、Android SDK、Node 18+

cd kaogong-shuati
node tools/sync-webapp.mjs            # public/next → webapp/
node build-app-assets.mjs app-assets  # tiku.db → tiku_app.db + images.db
npx cap copy android

cd ../app-shangan/android
./gradlew assembleRelease             # 产物在 app/build/outputs/apk/release/
```

本地调试：`node server.mjs` → http://localhost:5173

---

## 更新机制

题库不走应用商店，走自己的增量通道。

```
1. 本地版本 0.5.0-20261108-1955
2. 拉 release/manifest.json
3. 找 from=0.5.0 的 delta
4. 下载 2.4 MB gz
5. BEGIN → INSERT OR REPLACE → COMMIT
6. 写 tiku_app.db.ver，前端 reload
```

增量包内容：

```json
{
  "version": "0.5.2-20261109-0130",
  "papers":    [ ... ],
  "questions": [ ... ],
  "deleted":   { "questions": [], "papers": [] }
}
```

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
# 1. 采集 + 入库
node tools/fenbi-fetch-solutions.mjs --course syzc --cat 江苏 --limit 15 --pages 3
node tools/import-fenbi-papers.mjs --apply
node tools/normalize-categories.mjs --apply

# 2. 打增量包
node tools/build-tiku-delta.mjs --old tiku.db.bak --new tiku.db \
  --from 0.5.2-20261109-0130 --to 0.5.3-<新时间> --out ../dist/release

# 3. 重建内置资源
node build-app-assets.mjs app-assets
echo -n '0.5.3-<新时间>' > app-assets/db-version.txt

# 4. 生成 manifest
node tools/build-release-manifest.mjs \
  --base https://github.com/CHAOYUE116/shangan/releases/download/tiku-<tag> \
  --apk ../dist/shangan-<ver>-release.apk

# 5. 上传 Release（curl 必须加 --ssl-no-revoke，否则 Windows 证书吊销检查会掐断连接）
# 6. 同步 manifest 并提交
cp ../dist/release/manifest.json release/manifest.json

# 7. 补 CHANGELOG.md —— 写清「改了什么」和「为什么」
#    每条都要带根因，别只写结论。例如不要写「修复了更新失败」，
#    要写「sha256 对不上：App 解压后算哈希，manifest 给的却是 .gz 的哈希」

# 8. 把 CHANGELOG 的内容同步到 Release 页面
GH_TOKEN=<token> node tools/update-release-notes.mjs
```

三个容易漏的点：

- `app-assets/db-version.txt` **必须手动写**。`build-app-assets.mjs` 不生成它，但 `build-release-manifest.mjs` 靠它取 `dbVersion`。
- commit 前必须把 `dist/release/manifest.json` 拷回 `release/manifest.json`，否则仓库里还是旧地址，白等 CDN 刷新。
- **第 8 步别省**。Release 页面默认只有一堆文件名，用户点进来不知道这次改了什么。`update-release-notes.mjs` 会从 `CHANGELOG.md` 里按版本号切出对应段落，拼上下载说明和安装步骤，写进 Release 的 body。可以先 `--dry` 预览。

---

## 数据来源

**[粉笔题库](https://tiku.fenbi.com)** — 主体

行测、职测、申论、综应的真题与解析，绝大部分来自这里。粉笔的网页端没有做请求签名，带着自己的登录 Cookie 就能取到试卷列表和题目；解析要先提交一次练习，再从 `/combine/static/solution` 取回。采集脚本用 Playwright 驱动真实 Chrome 走这个流程——直接 curl 会被 WAF 返回 453。

入库的 61,768 题里，明确标记 `source='fenbi'` 的是通过这个流程新采的，其余是早期导入、未标记来源的历史数据。

**[linfukai186-arch/gongkao-tiku](https://github.com/linfukai186-arch/gongkao-tiku)** — 公基

作者把事业单位真题整理成静态 JSON 挂在 GitHub Pages 上，结构很干净：

```
data/<模块>/index.json     条目清单（key 形如 "2026·xxx考试"，count=题数）
data/<模块>/y<年份>.json   { "key": [ { t, s, q, o, a, e } ] }
```

字段 `t`=模块/题型、`s`=材料、`q`=题干、`o`=选项数组、`a`=答案、`e`=解析。导入 2,722 题，构成了「事业编·公基」的全部内容。

这个源没有难度字段，所以公基 100% 没有难度标签——App 里遇到这种情况直接不显示，而不是显示「难度 0」。

**考点体系**：自建，46,531 条映射。

## 依赖

| 项目 | 用途 |
| --- | --- |
| [Capacitor](https://capacitorjs.com/) | Android 壳，负责 WebView 容器和原生插件桥接 |
| [Playwright](https://playwright.dev/) | 驱动 Chrome 采集真题，绕不过 WAF 时的唯一办法 |
| [sharp](https://sharp.pixelplumbing.com/) | 公式图片压缩，73 MB 图片库靠它压下来 |
| [SQLite](https://sqlite.org/) | 两套数据库的底座；Node 侧用内置的 `node:sqlite`，不引第三方驱动 |

**已知缺口**

| 问题 | 规模 | 原因 |
| --- | --- | --- |
| 职测无解析 | 1,366 题（14.3%） | 源站部分卷子未提供 |
| 综应无详解 | 72% | 粉笔主观题本就不带详解 |
| 公基无难度标签 | 100% | 源数据无此字段，已改为不显示 |
| 答案-解析矛盾 | 43 条 | 待人工核对 |
| 题干重复 | 10,841 组 | 真题被多省卷重复收录；抽题按 `questionId` 去重，不会重复出现 |

---

## 免责

题库与解析来自公开渠道，版权归原作者所有。本项目仅作个人学习工具，不提供商业服务。

---

<sub>如果这个项目对你有用，点个 Star。有问题提 Issue。</sub>
