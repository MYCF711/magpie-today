# Today for magpie

**Today（todayai.cn）的模型接进 magpie，手机验证码登录，不需要桌面端。**

```
模型      2 个    DeepSeek V4.1 Flash（1×）/ GLM 5.3（4×）
登录      手机号 + 验证码，不需要桌面端
额度      套餐用量（Pro，5 个维度分项）
上下文    实测 16 万字符以上可容纳（载荷上限 ~17 万字符）
```

**独立运行**：不依赖 Today 桌面端。登录走 Today 自己的手机验证码接口，
设备身份由插件自己生成并持久化（服务端不校验设备真伪，实测）。
装了桌面端的人可以改用「一键导入」少填一次验证码，但那是可选项。

Today 是一个 agent 产品，**没有 chat/completions 端点**。它的模型只能通过 agent 会话访问：
`POST /v1/messages` 投递 → 回复走 WebSocket（或 `GET /v2/messages` 轮询）。
本插件把这条 agent 通道翻译成 OpenAI Chat Completions 形状，包括流式与函数调用。

非官方插件，与 TODAY AI PTE. LTD. 无关。

---

## 功能

- **手机验证码登录** —— 纯 HTTP，服务器、容器、没装客户端的机器都能用
- **设备身份自持** —— 插件自己生成 UUID 并持久化，不冒充、不依赖任何客户端
- **可选的桌面端导入** —— 装了客户端的人一键带走登录态
- **流式输出** —— 轮询增量转 SSE（实测 WS 只推状态、不推正文，见 docs/internals.md）
- **函数调用** —— 走文本协议模拟，`tools` 透传、`tool_calls` 按 OpenAI 格式返回
- **模型切换** —— 两个档位，按请求里的 `model` 自动切（服务端是账号级设置）
- **额度准** —— 套餐用量与到期时间都来自 `/v1/pricing/status`
- **多账号** —— magpie 的多账号机制直接可用，每号一份登录态

---

## 模型

| 模型 | 上下文 | 倍率 |
|---|---|---|
| `deepseek-v4.1-flash` | 实测 ≥160,000 字符 | 1× |
| `glm-5.3` | 实测 ≥160,000 字符 | 4× |

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
