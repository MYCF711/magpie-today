# CHECKLIST —— 两张表，两个交付门

> 给 `magpie-today-plugin`。`scripts/check.mjs`（在脚手架仓库里）只查**能自动查的那部分**；
> 下面这些查不到，但漏了照样出事，而且通常**不报错**。
>
> 逐条勾，勾不上就是还没好。

---

## A 表 · 代码交付前

```
□ 1. 插件运行时不依赖 Today 桌面端
      判据：node tests/independent.mjs 绿；src/desktop.mjs 只有动态 import，无顶层静态引用
      出处：AGENTS.md 五、独立性纪律

□ 2. 设备身份自持
      判据：src/device.mjs 自己生成 UUID 并持久化，没去读桌面端的 installation-id
      出处：同上

□ 3. toolProtocol 措辞没被随手改
      判据：改了就重跑过 node tests/live.mjs tools
      出处：AGENTS.md 六、硬规则

□ 4. 会话隔离用 v3
      判据：POST /v3/conversations；没有依赖 body.threadId（服务端忽略它）
      出处：AGENTS.md 四

□ 5. 会话读数是按条数切水位线
      判据：readTurn(rows, afterCount)；不会把上一轮终稿当成本轮答案
      出处：AGENTS.md 八（/v2/messages 返回整个会话历史）

□ 6. 长轮询带 afterSequence
      判据：不带就是 400；waitMs ≤ 25000
      出处：AGENTS.md 八

□ 7. 图片走上传且五个字段齐全
      判据：attachments 有 type/storagePath/filename/mimeType/size；缺 size 会 400
      另外 attachmentsFor() 两种输入形状都吃（messages 与 content 数组）
      出处：AGENTS.md 八

□ 8. 两条载荷上限都验过
      判据：body.text ≤ 1,000,000 字符；整个 JSON ≤ 1 MiB 字节（中文先撞字节这条）
      出处：AGENTS.md 八

□ 9. 没有把登录态写进文件 / 日志 / 测试快照
      判据：grep 一遍 token/session 的落盘点
      出处：AGENTS.md 六

□ 10. 声明的数字都带口径
      判据：上下文、输出上限、延迟都有实测来源；没测的写「未验证」
      出处：AGENTS.md 六

□ 11. 改完源码重新 add 过
      判据：magpie plugin add "<插件目录>"（magpie 不热重载；plugin off/on 认包名不认 provider id）
      出处：AGENTS.md 八

□ 12. _capture / _probe / _asar 没被提交
      判据：git status 干净，勘查产物在 .gitignore 里
      出处：AGENTS.md 六

□ 13. node ../magpie-plugin-scaffold/scripts/check.mjs . 退出码 = 0
```

⚠ 会花钱的测试项（`tests/live.mjs` 的发消息项、`tests/image.mjs`、`tests/conversation.mjs`）
跑之前想清楚，跑完在 CHANGELOG 或 commit 里说明跑过哪些。

---

## B 表 · 发版前（七步，一步不能少）

> ⚠ **`git push` 只是第 4 步。** 本插件目前**只走 git 源**（npm 上没有 `today-for-magpie`），
> 所以第 5 步可以跳过；但 tag / Release / 验证一条都不能少。

```
□ 第 0 步 · 写 CHANGELOG（一条一行）
□ 第 1 步 · bump version
      判据：package.json 的 version 变了
□ 第 2 步 · npm pack --dry-run
      判据：清单里有 README.md / CHANGELOG.md / docs / AGENTS.md / CHECKLIST.md
□ 第 3 步 · 提交并推功能分支（不是 main）
□ 第 4 步 · PR 的 rules 全绿后合并（禁止直接推 main；本机 live 测试另按 AGENTS 跑）
□ 第 5 步 · npm publish —— **本插件不走 npm，跳过**（哪天要走，先 `npm view today-for-magpie version` 查撞名）
□ 第 6 步 · tag + Release
      命令：git tag v<version> && git push origin v<version>
      本仓库**没有** .github/workflows ⇒ Release 手工建：
        POST /repos/MYCF711/magpie-today/releases
      判据：tag 与 version 一致；Release 不是 draft
□ 第 7 步 · 四条验证
      ① 不适用（无 npm）
      ② 不适用
      ③ magpie plugin list           → today 的 commit 变了
      ④ GET /releases/tags/v<version> → 200 且 draft=false
```
