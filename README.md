# 上岸 · 考公刷题

一个离线优先的公务员 / 事业单位考试刷题 App。题库全量装在手机里，断网也能刷；联网只用于题库增量、时政和 App 更新。

> 题库数据来自公开真题与网络解析，仅供个人学习使用。

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
