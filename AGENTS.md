# 开发约定

这些规矩写给接手这个仓库的人（包括 AI）。

---

## 一、动手之前先去看别人怎么做的

**任何非平凡改动，先花十分钟调研，再写一行代码。**

我们想到的功能，GitHub 上基本都有人做过一遍甚至十遍。别人踩过的坑写在 issue 里、写进 README 的「注意事项」里，读一遍能省掉几小时试错。上面那批更新模块的 bug 就是这么找出来的 —— 三个库的注释里都写着「Android 10 限制后台启动 Activity」，我们当时没看，就踩了。

### 怎么看

搜索入口，按这个顺序：

1. **GitHub 搜索**，用限定语法缩小范围
   - `android update app in:name,description stars:>500`
   - `topic:updater language:Java`
   - 找到仓库后**必看两处**：README 的注意事项段、open/closed 的 issue 里带 `bug` 标签的
2. **Awesome 列表**：`awesome-android`、`awesome-selfhosted`、`awesome-<领域>`，比自己翻快
3. **搜报错原文**：把异常类名粘进搜索框，一般能直接落到某个 issue 的解决方案
4. **看别人怎么被骂**：issue 里 `wontfix` 和 `duplicate` 的标签，往往就是「我们也会遇到但没人告诉你」的坑

### 怎么判断值不值得抄

| 看什么 | 好的信号 | 坏的信号 |
|---|---|---|
| Star | 上千 | 两位数且没 fork |
| 最近提交 | 半年内有 | 三年前，README 还在写 Android 9 |
| 适配声明 | 写明支持到 API 34/35 | 只写到 28 |
| 代码量 | 单一职责，一个库解决一件事 | 什么都做，几千行一个类 |
| 注释 | 写「为什么这么绕」 | 只有「TODO」 |

### 抄什么，不抄什么

- **抄思路和坑，不抄代码。** 我们不用第三方依赖（理由见 README「技术栈」），所有逻辑自己写，但设计可以照搬。
- 照着别人改，要在 commit message 里留一句：`参考 XUpdate 的 IUpdatePrompter 分层，因为……`
- 如果决定**不**照做，也写下来为什么：`AutoUpdateProject 用 12 种弹窗样式，我们只要 2 种，不做`

### 已经调研过的

| 领域 | 参考 | 结论 |
|---|---|---|
| App 内更新 | [XUpdate](https://github.com/xuexiangjys/XUpdate) / [AppUpdate](https://github.com/azhon/AppUpdate) / [AutoUpdateProject](https://github.com/MZCretin/AutoUpdateProject) | 抄了：安装走通知（Android 10 限制后台启动 Activity）、同版本只下一次、安装权限引导、manifest 多源。没抄：分层接口、12 种弹窗样式 |
| 增量更新 | bsdiff / bsdiff-java | 没用 bsdiff（要 C 编译产物）。自己做行级 diff，只传变更行 |
| 前端框架 | [htmx](https://github.com/bigskysoftware/htmx) | 抄理念：能不上框架就不上。整个前端是手写 JS + 字符串模板 |
| 界面节奏 | Things 3 / Bear | 抄「一屏只回答一个问题」，不抄视觉 |
| 题库数据 | 粉笔 [tiku.fenbi.com](https://tiku.fenbi.com) / [gongkao-tiku](https://github.com/linfukai186-arch/gongkao-tiku) | 数据源 |

---

## 二、改数据之前先备份

`tiku.db` 是唯一的真源，所有采集、清洗、补解析都在它上面操作。

```powershell
Copy-Item tiku.db "tiku.db.bak-<这次改什么>-$(Get-Date -Format yyyyMMdd-HHmm)"
```

写库脚本一律支持 `--apply`，默认 dry run。先跑一遍看统计，数字对了再加 `--apply`。

---

## 三、发版是一条固定流水线，不能跳步

顺序错了会出现「本地是最新的、线上还是旧的」这种查半天的问题。

```
1. bump-version            node tools/bump-version.mjs <ver> <code>
2. sync-webapp             node tools/sync-webapp.mjs
3. 拷进 android            robocopy D:\Projects\上岸APP\webapp ...\assets\public /MIR
4. 打包                    cd app-shangan\android; .\gradlew.bat assembleRelease
5. 重建 manifest           node tools/build-release-manifest.mjs --base <url> --apk <path>
   ↑ 跑完必须回读 dist/release/manifest.json 核对 app 段，脚本偶尔会读到上一版
6. 上传资产                node tools/publish-release.mjs --tag <tag> --files ...
7. 同步 manifest 进仓库     Copy-Item dist\release\manifest.json release\manifest.json
8. commit + push           （漏了这步，CDN 永远刷新不到新版）
9. 轮询 CDN                到 versionCode 对上为止，raw 约 1~5 分钟
10. 补 CHANGELOG           写根因，不写「优化了体验」
```

---

## 四、写 CHANGELOG 要写「为什么」

不写：`修复了更新失败的问题`

要写：

> 下载完成后直接 startActivity，Android 10 起禁止后台启动 Activity，
> 安装器根本弹不出来，用户看到的是「下载完了什么都没发生」。
> 改成落通知，用户点了才装。

一年后回来看，只有第二种能让你想起当时发生了什么。同一个 bug 也不会犯第二次。

---

## 五、PowerShell 的几个坑（踩过很多次）

- **含中文路径、反引号、`$`、正则的脚本，一律写成 `.mjs` 用 node 跑。** `node -e "..."` 里的 `${}` 和反引号会被 PowerShell 先吃掉，报 `SyntaxError` 或者静默改错。
- `.ps1` 文件如果是 UTF-8 无 BOM，PowerShell 5.1 会按 GBK 解析，中文路径变乱码（`上岸` → `涓婂哺`）。要用就存成带 BOM 的。
- `Get-Content` 读 UTF-8 中文文件会显示乱码，但**文件本身没问题**，用编辑器或 `read` 工具看是正常的。别被它骗了。
- `git push` 必须带 `-c http.proxy=http://127.0.0.1:18926`。
- `curl` 必须加 `--ssl-no-revoke`，否则 Windows Schannel 做证书吊销检查失败会直接放弃连接。

---

## 六、不要提交的东西

- `android/keystore-pass.txt`、`*.keystore`、`*.jks` —— 仓库是公开的，泄漏签名私钥等于别人能签出「同签名的新版本」骗过所有用户
- `android/app/src/main/assets/public/` —— 从 `public/` 拷过去的构建产物，含两个 300+ MB 的数据库
- `tiku.db.bak-*`、`dist/`、`node_modules/`
