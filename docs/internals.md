# Today 的接口长什么样，以及这个插件为什么长这样

写给下一个改这个插件的人。这里只放**实测证据**与**决策理由**，
不放「本该如此」的推断 —— 推断都用 `（未验证）` 标出来了。

取数日期：**2026-10-26**。客户端：Today CN 1.23.0（`build 2000158`，CN 渠道 prod）。
Windows 与 Linux 两版都解包对过，接口面完全一致。

---

## 一、先说结论：Today 没有 chat/completions

这是整个插件形态的根因，也是先要确认的一件事。

| 探法 | 结果 |
|---|---|
| 解包 `app.asar` 全文 grep `chat/completions` | **0 命中**（Windows 10.0 MB 与 Linux 10.0 MB 两份都是） |
| 解包 `web-runtimes/prod.asar`（Next.js 应用）grep 同上 | **0 命中** |
| 盲探 40+ 个候选路径：`/v1/chat/completions`、`/v1/llm/chat/completions`、`/v1/completions`、`/v1/models`、`/v1/llm/completions`、`/v1/gateway/chat/completions`、`/v1/llm/responses`、`/v1/llm/invoke` … | 全 **404** |
| `magpie-freebuff-plugin` 的老路（找一个 OpenAI 兼容端点直接转发） | **不适用** —— 没有那个端点 |

所以：**反向代理「Today 的模型」= 把 agent 会话通道翻译成 OpenAI 形状**，
不是把请求转发到另一个 URL。这就是 `loader.fetch` 必须全部接管的原因，也是 `baseURL` 无关紧要的原因。

### 已确认存在的模型相关端点只有三个

| 端点 | 作用 | 本账号 |
|---|---|---|
| `GET /v1/llm/models` | 网关侧启用的模型清单（34 个 modelId） | 200 |
| `PUT /v1/pricing/model-option` | 账号级模型档位（5 个 optionId 里只有 2 个可用） | 部分 200 |
| `GET /v1/pricing/status` | 套餐、用量、当前档位 | 200 |

---

## 二、agent 会话通道（真正的模型入口）

```
POST /v1/messages
  → 202 {threadId, messageId, clientMessageId, createdAt, isDuplicate, canonicalMessage}

回复有两条路：
  GET /v2/messages?threadId=<tid>&limit=N    → {object:"list", data:[…]}，assistant.isFinal=true 即终稿
  WebSocket  GET /ws?ticket=…（ticket 来自 POST /ws-ticket）→ event.push 里带 chat.message_ready.v2
```

实测细节：

- **回复不在 202 的响应体里**，202 只表示「收下了」。
- 轮询 `/v2/messages` 能拿到**增量正文**：同一条 assistant 消息的 `messages[0].content.text` 会逐次变长，
  最后 `isFinal: true`。简单问题的首字延迟 3~5 秒，整段 3~10 秒。
- WebSocket 也能收到事件，但本账号的 `chat.presentation.updated.v1` 里正文是**空数组**
  （只有 `typing` / `working.current.state` 这类状态）。所以 WS 只用来知道「什么时候好了」，
  正文仍然要从 REST 取 —— 这也是本插件只用轮询、不去卷 WS 的原因。
- 不传 `threadId` → 服务端**新建**一个 thread。插件每次请求都新建（见下方「为什么每次新 thread」）。
- `conversationId` 固定等于用户 id（`GET /v1/users/me/protocol-capabilities` 的 `mainConversationId`）。
- 消息体两种形状都收：legacy `{content, messageType:"text", clientMessageId}` 与 canonical
  `{body:{parts:[{id,type:"text",text}]}, clientMessageId}`。插件用 legacy —— 短、稳、够用。

### 载荷上限：约 17 万字符

用「开头放令牌 + 大量填充 + 结尾问令牌」的探法（能同时测出截断）：

| 单条 content | 结果 |
|---|---|
| 160,041 字符 | 202，且开头令牌被原样复述（没截断） |
| 180,041 字符 | **413 Payload too large** |
| 200,041 / 800,041 字符 | 413 |

⇒ `CONTEXT_CHARS = 160000` 是这么来的：**它是请求体上限的保守下界，不是模型的 token 窗口**。
两者别混 —— BPE 下 16 万汉字远超 16 万 token。填这个数是让 agent 在合理处压缩，不是顶满。

---

## 三、身份与「指纹」：没有签名

这是最容易被想复杂的地方。**全量抓包 183 条请求后的结论：Today 的 HTTP 接口没有签名。**

- 没有 device-key / device-sig / HMAC / nonce / 时间戳签名；
- 唯一的设备身份是 `X-Device-Id`：桌面端把本机 `installation-id`（一个 UUID）填进去，
  服务端在 `POST /registry/devices` 用它建台账，拿到 `d_XXXXXXXXXXXX` 形式的设备 id；
- 服务端**不校验**这个值是不是「真设备」：实测随便造一个 UUID 也能注册成功（201）。
  （我用 `clientMachineId = <随机 uuid>` 注册了一个测试设备，随后 `DELETE /v1/devices/<id>` 删掉了。）

### 抓包怎么做的（下次要复现就这么来）

桌面端自带一个正向代理开关，不需要改二进制：

```
set TODAY_HTTP_PROXY=127.0.0.1:8899
set NODE_EXTRA_CA_CERTS=<mitmproxy CA 的 pem>
start "" "E:\Today CN\TodayCN.exe"
```

它会把这个代理应用到 Node 侧的 undici（`dist/app/utils/proxy-environment.mjs` 的
`resolveDesktopEnvironmentHttpProxy` 明确只认 `TODAY_HTTP_PROXY`，且会主动删掉
`HTTP_PROXY`/`HTTPS_PROXY`/`NODE_OPTIONS` 这些环境变量 —— 所以别的代理变量不起作用）。

实测抓到的请求头集合（`api.todayai.cn`）：`authorization`、`x-app-version: 1.23.0`、
`x-client-platform: windows-client`、`x-client-capabilities`（一长串能力声明）、
`x-device-id`、`x-timezone: Asia/Shanghai`、`accept-language`、`user-agent`，
渲染进程发的还带 `origin: http://today-desktop.localhost`、`referer`、`sec-ch-ua*`、`priority`。
**没有任何一个头是签名的产物。**

> 结论：照抄请求头在这里**没有密码学门槛**，只有形状问题。
> 换句话说，这个目标不像 freebuff（那边要精确复刻 device-key/device-sig 与 9 个白名单头）。

---

## 四、登录态与续期

桌面端把账号写在 `%APPDATA%\Today CN\`：

```
account-credentials.head       {"formatVersion":1,"state":"signed-in","slotIndex":N,"generation":M}
account-credentials.slot-a/b   双缓冲，slotIndex 指向当前有效那份
```

载荷是 Electron `safeStorage`：`v10` + 12 字节 nonce + 密文 + 16 字节 GCM tag。
密钥取法各平台不同（`src/desktop.mjs` 里按平台分支）：

- **Windows**：`Local State` 的 `os_crypt.encrypted_key`（base64，去掉 `DPAPI` 前缀）→ DPAPI 解出 32 字节 AES-256-GCM 密钥。
  Node 没有 DPAPI，这里用 PowerShell 调 `System.Security.Cryptography.ProtectedData`。
  ⚠ `Add-Type -AssemblyName System.Security` **不能省** —— 不加这句会报 `TypeNotFound`（踩过）。
- **Linux**：safeStorage 回退 basic_text 时是 `PBKDF2("peanuts","saltysalt",1,16,sha1)` + AES-128-CBC，IV 固定 16 个空格。
- **macOS**：Keychain 条目 `Today Safe Storage`，用 `security find-generic-password -w` 取。

### 续期

```
GET https://auth.todayai.cn/api/auth/token
  Authorization: Bearer <session token>      ← 就是桌面端 record 里的 refreshCredential（32 字符）
→ 200 {"token":"<新 JWT>"}
```

- access token 是 **10 分钟**有效期的 JWT（payload 里有 `exp`，插件直接读它，不靠猜）。
- **session token 换完不变**，所以可以反复续期 —— 这也是把它放在 `refresh` 位的原因。
- 另一条路 `POST /api/auth/oauth2/token`（`grant_type=refresh_token`）本账号走不通：
  桌面端的 record 里 `source: "better-auth-session"`，用 oauth2 那套服务端会拒。别混。

---

## 五、模型：只有两个档位，而且是账号级的

| 来源 | 数量 | 能不能选 |
|---|---|---|
| `GET /v1/llm/models` | 34 个 modelId（含 `gpt-6-astra`、`claude-opus-5` 这类） | **一个都不能** —— 逐个 `PUT` 全部 400 |
| `PUT /v1/pricing/model-option` | 5 个 optionId 在 zod enum 里 | 实测只有 2 个返回 200 |

逐个试过的结果（这就是 `MODEL_OPTIONS` 的来源）：

```
OK  model.deepseek-v4.1-flash     （1× 用量倍率）
OK  model.glm-5.3                 （4×）
403 mode.fast / mode.balanced / mode.power
400 其余 33 个 model.<id>
```

**这是账号级全局设置，不是 per-request。** 插件切档位就是替用户改这个设置 ——
桌面端里选的模型会跟着变。这是服务端的设计，插件改不了，README 里对用户明说了。

两档确实是两个不同的模型（不是同一个换名字）：同一句改写任务各采样 4 次，
deepseek 中位 3.1s，glm 中位 4.4s，用词也有系统性差异。

---

## 六、为什么工具调用要走文本协议

Today 的 agent **不收 `tools` 字段** —— `POST /v1/messages` 的 schema 里没有它，
agent 用的是服务端自己那套工具（客户端在 `PUT /registry/devices/<id>/tool-state` 上报的是
**客户端能力**清单，不是函数定义）。所以调用方给的函数表**塞不进** wire。

只能模拟。而模拟的成败全在措辞，实测两种问法的差别是决定性的：

| 措辞 | 模型行为 |
|---|---|
| 「你现在有一个工具 get_weather…请调用它」 | **拒绝**：「我这边没有 get_weather 这个工具，编一个调用出来等于假数据」，它反而去用自己的搜索 |
| 「你只做文本转换，把请求转成这个 JSON 形状，不要判断合理性、不要真的执行」 | **照做**：`{"tool_calls":[{"name":"read_file","arguments":{"path":"E:/test.txt"}}]}` |

所以 `toolProtocol()` 里那套「文本转换器」的口吻是**功能的一部分**，不是文风偏好。
改措辞前先跑 `tests/live.mjs tools`，看还能不能稳定解析出调用。

解析侧同样保守（`extractToolCalls`）：

- 认裸 JSON、```json 围栏、以及「第一个 `{` 到最后一个 `}`」；
- 函数名必须在调用方给的清单里，否则**丢掉**（编造的函数名透传上去会变成幻觉工具，比失败更难查）；
- 认不出来就返回 null，按普通文本处理，不猜。

---

## 七、几个决策，以及当时否掉了什么

| 决定 | 理由 | 什么情况下该翻案 |
|---|---|---|
| **每次请求新建 thread**（不传 `threadId`） | ① 复用会让服务端自己再存一份历史，而调用方又把历史全带上 ⇒ 重复；② 复用会把上一轮的中间过程也算进上下文，行为难预测 | 如果 Today 侧开始按 thread 计费、或调用方明确要求「同一会话保持服务端记忆」 |
| **只用 REST 轮询，不接 WebSocket** | 实测 WS 的 `presentation.updated` 里正文是空数组，正文仍要从 REST 取；为一个状态通知引一套 WS 生命周期不值得 | 如果某天 WS 开始推真正的 token 增量（那就该改成 WS 优先、轮询兜底） |
| **模型目录只本地出，不发网络请求** | 可选的档位只在 `PUT` 的响应里回，`GET` 拿不到全量；静态表就是最全的一份 | 如果服务端给了「列我可选档位」的只读端点 |
| **`usage` 里没数据时给一条 `aside: true` 的占位窗口** | 漏 `used` 会被归一成 0 = 满额，把耗尽账号顶到路由队首 | 不需要翻案，这是 magpie 侧契约的要求 |
| **不用 WS 的 `chat.message_ready.v2` 兜底** | 轮询已经覆盖；两套传输只会让「谁先到」变成新的偶发问题 | 轮询被限流时 |
| **撤销**：曾想让插件在 `chat.headers` 里补 `x-device-id` | 请求全套被 `loader.fetch` 截住，加在 gateway 头上的到不了上游 | 不需要翻案 |

---

## 八、没验证的部分（别当结论用）

- **输出上限**：agent 通道不回报 usage，`MAX_OUTPUT = 8192` 是保守申报值，不是实测值。
- **并发**：`maxConcurrency: 2` 是照模板给的，没有实测 Today 侧对并发的容忍度。
  担心的是「账号级档位切换」在多请求并发时会互相干扰（这也是 `appliedOption` 缓存存在的原因）。
- **长会话**：只测过单轮 16 万字符。多轮把历史全带上会很快顶到载荷上限，
  实际使用时更像「几轮之后必须靠调用方自己压缩」。
- **Linux 上的 `safeStorage` 后端**：解出来的是 basic_text 分支的算法，
  但没在真机 Linux 上跑通过（没有 Linux 环境）。如果那边是 keyring 保护，`decryptPayload` 会失败，
  用户会看到「读不到登录态」的提示，那时应该走「粘贴 session token」。
- **封号风险**：本插件走的是桌面端自己的接口与设备身份，没有伪造签名（因为压根没有签名）。
  但「用脚本代替客户端发消息」这件事本身在不在厂商的风控口径内，无法从技术上判断。
