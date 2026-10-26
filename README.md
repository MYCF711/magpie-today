# Today for magpie

**Today（todayai.cn）的模型接进 magpie，手机验证码登录，不需要桌面端。**

```
模型      2 个    DeepSeek V4.1 Flash（1×）/ GLM 5.3（4×）
登录      手机号 + 验证码，不需要桌面端
额度      套餐用量（Pro，5 个维度分项）
上下文    实测 34.8 万汉字 / 100 万 ASCII 字符（上限见下）
多轮      Today 的会话里续着走，第 2 轮起只发增量（实测中位 2.6s vs 新建 3.0s）
并发      两个不同对话可并行，实测不串线
```

**独立运行**：不依赖 Today 桌面端。登录走 Today 自己的手机验证码接口，
设备身份由插件自己生成并持久化（服务端不校验设备真伪，实测）。
装了桌面端的人可以改用「一键导入」少填一次验证码，但那是可选项。

Today 是一个 agent 产品，**没有 chat/completions 端点**。它的模型只能通过 agent 会话访问：

```
POST /v3/conversations            → 预定一个隔离会话
POST /v3/messages                 → 往会话里追加一条用户消息
GET  /v3/…/message-changes?waitMs → 长轮询，有新内容立刻回
GET  /v2/messages?conversationId= → 确认终稿
```

本插件把这条 agent 通道翻译成 OpenAI Chat Completions 形状。

非官方插件，与 TODAY AI PTE. LTD. 无关。

---

## 三条实测出来的硬约束

写在这里是因为它们**改变了这个插件的能力边界**，用户应该先知道：

**① 没有真 token 流。** Today 的 agent 不在生成过程中吐字 —— 50ms 极密轮询下正文
一次到齐（20.3 秒处 763 字符一次给全），WebSocket 的 `presentation` 事件里
`turn.content.text` 恒为空数组。所以 SSE 是**语义上**的流式（形状对、客户端能正常解析），
不是**节奏上**的流式：首字时间 ≈ 总耗时。数据见 [docs/internals.md](docs/internals.md) 第十三节。

**② 每个调用方对话会占用 Today 里一个会话。** 插件用 `POST /v3/conversations` 给每个
独立对话预定一个隔离会话，续聊只发增量。这些会话会出现在你的 Today 里，
并按 Today 的过期时间回收。

**③ 上下文上限有两条，按字节算的那条先到。**
`body.text` 最多 1,000,000 **字符**（超了给 503），整个 JSON 请求体最多 1 MiB **字节**（超了给 413）。
中文 3 字节/字符，所以中文场景先撞字节限制：实测 348,000 汉字通过、350,000 汉字 413。
插件按 300,000 字符声明（给最坏情况留余量）。

**④ 采样参数上游不收，能本地做的都做了，做不到的如实忽略。**
实测把 `temperature` / `max_tokens` / `n` / `stop` / `response_format` 放进请求体，
五个都 200 且模型行为一字不变（和 `tools` 一样被 schema 丢掉）。所以：

| 参数 | 处理 |
|---|---|
| `stop` | ✅ 插件侧截断（多序列取最早出现的） |
| `max_tokens` | ✅ 插件侧按**估算** token 截断（口径见 `src/tokens.mjs`，不是精确计数） |
| `response_format` | ✅ 转成提示（实测：加了才给裸 JSON，不加会给围栏加解释） |
| `temperature` / `top_p` / `seed` 等 | ⚠️ **无法控制，不假装生效** —— 会写进日志告诉你 |
| `n > 1` | ⚠️ 只返回 1 条 |

**⑤ 切模型是账号级操作。** `PUT /v1/pricing/model-option` 改的是账号的全局档位，
不是单个请求 —— 也就是说，在 DSH 里切到 `today/glm-5.3`，你自己 Today 桌面端里选的模型
也会跟着变。这是服务端设计，不是插件的选择。

---

## 功能

- **手机验证码登录** —— 纯 HTTP，服务器、容器、没装客户端的机器都能用
- **设备身份自持** —— 插件自己生成 UUID 并持久化，不冒充、不依赖任何客户端
- **可选的桌面端导入** —— 装了客户端的人一键带走登录态
- **流式输出** —— OpenAI 形状的 SSE（⚠ 上游不吐部分正文，见下）
- **函数调用** —— 走文本协议模拟，`tools` 透传、`tool_calls` 按 OpenAI 格式返回
- **模型切换** —— 两个档位，按请求里的 `model` 自动切（服务端是账号级设置）
- **额度准** —— 套餐用量与到期时间都来自 `/v1/pricing/status`
- **多账号** —— magpie 的多账号机制直接可用，每号一份登录态
- **输出约束** —— `stop` / `max_tokens` / `response_format` 在插件侧落实（上游不收这些字段）
- **5xx 重试** —— 幂等调用最多试 3 次；4xx 不重试

---

## 模型

| 模型 | 上下文 | 倍率 |
|---|---|---|
| `deepseek-v4.1-flash` | 声明 300,000 字符（上限：34.8 万汉字 / 100 万 ASCII） | 1× |
| `glm-5.3` | 同上 | 4× |

⚠ 模型选择是**账号级全局设置**（`PUT /v1/pricing/model-option`）。
在本插件里切模型，会把你在 Today 桌面端里选的模型一起改掉 —— 这是服务端的设计，插件改不了。

---

## 安装

不需要先装 Today 桌面端。登录用手机号 + 验证码。

### 从本地目录（现在就能用）

```bash
magpie plugin add "D:\主工作区\magpie-today-plugin"
printf '1\n' | magpie plugin login today     # 1 = 从本机 Today 桌面端导入
```

按目录装是**活链**：magpie 直接从那个目录加载，改完代码重新加载即可，不用复制产物。
实测装完立刻生效，不用重启 magpie。

### 从仓库源码（待发布）

```bash
magpie plugin add github:MYCF711/magpie-today
```

⚠ 这条要等仓库推上去之后才通。npm 上还没有包：`magpie plugin add today-for-magpie` 现在装不上。

装完确认：

```bash
magpie plugin list
# today  on
#   today (Today, 2 models)  signed in as MYCF711
```

---

## 常见问题

**提示「找不到 Today 桌面端的登录态」？** 先打开 Today 桌面端登录一次。插件读的是 `%APPDATA%\Today CN\account-credentials.slot-*`（Electron safeStorage 加密，用 Windows DPAPI 解）。

**为什么只有两个模型？** Today 账号可选的档位就这两个，其余 33 个 modelId 在 `/v1/llm/models` 里列着但账号无权选择（`PUT` 返回 400）。

**回复会不会变慢？** 比直连慢。Today 的 agent 通道是「投递 + 推送」，实测首字 3~6 秒，整段 3~10 秒。

**会不会封号？** 本插件走的是桌面端自己的接口与设备身份，没有伪造、没有绕过。风险在于「自动化调用」本身，不在协议。

---

## 参考源

| 来源 | 用在哪 |
|---|---|
| [MYCF711/magpie-plugin-template](https://github.com/MYCF711/magpie-plugin-template)（MIT） | 插件骨架、九个钩子、README 结构 |
| [MYCF711/magpie-freebuff-plugin](https://github.com/MYCF711/magpie-freebuff-plugin)（MIT） | SSE 合成、OpenAI 形状的响应改写、工具配对校验思路 |

---

> 更新记录：[`CHANGELOG.md`](./CHANGELOG.md)

## 许可

MIT。
