# 更新记录

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
