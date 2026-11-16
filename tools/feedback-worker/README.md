# 纠错上报中转站

App 里点「纠错」→ 选原因 → 提交 → 自动在仓库里开一条 Issue（带题目快照）。
**App 里不存 token，用户也不需要 GitHub 账号。**

## 一、建一个只有 issues 权限的 token

1. GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token
2. Repository access：只选 `chaoyue116/shangan-app`
3. Permissions → **Issues: Read and write**（其它全空）
4. 生成后复制 `github_pat_…`

## 二、部署（三分钟，免费额度够用）

```bash
cd tools/feedback-worker
npm i -g wrangler
wrangler login

wrangler secret put ISSUE_TOKEN     # 粘贴上一步的 token
wrangler secret put REPO            # chaoyue116/shangan-app
wrangler secret put LABEL           # 可选，默认「用户纠错」

wrangler deploy
```

输出里会有一行 `https://shangan-feedback.<你的子域>.workers.dev`。

## 三、接到 App 上

打开 `public/next/app.js`，把这一行的空串换成上面的地址：

```js
const FEEDBACK_API = '';   // 例：'https://shangan-feedback.xxx.workers.dev'
```

然后重新打包（`node tools/bump-version.mjs …` → `node tools/build-apk.mjs`）。

没配也能用：点提交时会**复制一段整理好的文本**，并打开 GitHub 的「新建 Issue」预填页面，用户自己点一次「Submit」即可。

## 四、自测

```bash
curl -X POST https://shangan-feedback.xxx.workers.dev/report \
  -H 'content-type: application/json' \
  -d '{"questionId":"2065320","reasons":["material","image"],"note":"材料没了","question":{"id":2065320,"chapter":"资料分析"}}'
```

返回 `{"ok":true,"issue":123,"url":"..."}` 就通了。

## 五、上报内容

- 题号、原因（材料缺失 / 图片缺失·打不开 / 选项缺失或错位 / 答案错误 / 解析错误 / 分类·模块不对 / 题干错别字 / 重复题 / 题目过时 / 其他）
- 用户补充说明、用户认为的正确答案
- 题目快照（题干、选项、答案、解析前若干字、材料长度、图片数、来源）
- 设备、App 版本、题库版本、时间

GitHub 侧建议给 `用户纠错` 这个 label 建一个 Project 视图，处理完关掉即可。
