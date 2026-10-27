# 更新记录

## 0.2.1

- **`AGENTS.md` 重组成「入口式」** —— 原来只有项目规范与陷阱清单，缺了「你在哪一步」和发布流程。现在顶部是阶段表 + **发布七步**（原来完全没有），原来的规范与 14 条实测陷阱一条没删，顺延成第三～九节
- **新增 `CHECKLIST.md`** —— A 表代码交付前 13 项（独立性纪律、会话 v3 隔离、水位线、两条载荷上限、attachments 五字段…），B 表发版前七步。会花钱的测试项单独标出
- **修一个坏链接**：README「参考源」指向 `deepseek-ai/magpie-plugin-template`，该仓库 **404 不存在**（实测），改为 `MYCF711/magpie-plugin-scaffold`
- **删掉 `src/self-register.mjs`，不再写 magpie 的市场缓存** —— 那是 magpie 的文件（`~/.cache/magpie/plugin-market.json`），插件按包名 merge 会把 registry 条目盖掉；另外三个 magpie 插件早前都已删掉。条目本身搬成 `registry-entry.json`（`package` / `name` / `providers` / `summary`），要上架时提交给 `registry.json`
- **卡片图标改成内联 data URL** —— 原来写的是本地路径 `assets/icon.png`，而 magpie 的卡片**只认 `https://` 或 `data:image/`**，等于一直没图标；现在内联 `icon.png`（2,370 字符）
- `package.json` 的 `files` 补上 `AGENTS.md` / `CHECKLIST.md` / `docs` —— 之前 **`docs` 不在白名单里**，真发 npm 包会缺 `internals.md`
- [README](./README.md) —— 顶部加指路三行；发布是七步，`git push` 只是第 4 步

## 0.2.0

- **思考过程**：让它把推理写进同一条 JSON，插件拆成 `reasoning_content`。上游确实没有思维链。
- **输出模板**：单一 JSON 模板替代散文式协议，实测 5/5（kind / 裸 JSON / reasoning 三项全对）。
- **重置卡与邀请链接**：`auth.usage` 报 `resets`，新增 `tools/invite.mjs`。
- **默认走工具不碰沙盒**：不再把它自己的设备能力当作执行路径；模板加三条硬约束
  （不动沙盒 / 路径必须绝对 / 回复末尾列路径）。
- **提示段序重排**：按近因效应，把输出契约压到最末；顺带修掉 `response_format`
  与契约互相打架的冲突。
- **补齐 DSH 侧两个字段**：`usage.prompt_tokens_details.cached_tokens`、
  流式 reasoning 独立成帧。
- **`maxConcurrency` 2 → 8**：实测 16 并发全部成功。
- 文档：README 按模板重写，协议取证全部移入 `docs/internals.md`。


## 0.1.0

- 首个版本：读桌面端登录态、agent 通道转 OpenAI 形状、流式、函数调用模拟、额度、双模型切换。
