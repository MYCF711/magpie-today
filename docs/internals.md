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

### 载荷上限：两条限制，按字节的那条先到

**旧文档这里写的是「约 17 万字符」，那是错的** —— 那个数字是早期在另一条路径上量到的，
按它设限会让调用方无谓地提前压缩。2026-10-26 用二分 + 重试重新量过，实测矩阵：

| 内容 | 字符数 | JSON 字节 | 结果 |
|---|---|---|---|
| ASCII | 1,000,000 | 1,000,068 | ✅ 202 |
| ASCII | 1,000,500 | 1,000,568 | ❌ 503 |
| 中文 | 348,000 | 1,044,068 | ✅ 202 |
| 中文 | 349,000 | 1,047,068 | ❌ 500 |
| 中文 | 350,000 | 1,050,068 | ❌ 413 |

两条独立限制：

1. **`body.text` ≤ 1,000,000 字符** —— 超了服务端回 **503**（不是干净的 400/413）。
   ASCII 那两行就是撞的这条：字节才 100 万，离 1 MiB 还远。
2. **整个 JSON 请求体 ≤ 1 MiB = 1,048,576 字节** —— 超了回 **413 `Payload too large`**。
   中文 3 字节/字符，所以中文场景先撞这条（约 34.9 万字）。

⚠ 边界附近 500/503 会混着出现（349,000 汉字连试 4 次都是 500），所以**别贴着上限用**。
插件按 `CONTEXT_CHARS = 300_000` 声明，给最坏情况（全中文）留约 14% 余量。

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

---

## 九、工具：为什么不能透传，以及「桥接」这个念头为什么走不通

三个想法都试过了，结论如下。

### 9.1 把 DSH 的 `tools` 透传到 wire —— 不行

`POST /v1/messages` 的两种 body schema（legacy 与 canonical）里**都没有 `tools` 字段**。
实测更直接：同一句话，带 `tools` 与不带，响应一字不差（都是 `好的`，`parts=1`）。

> 带 `tools` 的请求返回 202 且正常出答案 ⇒ **字段被静默丢弃**。
> 「没报错」在这里不等于「被采纳」。

### 9.2 「改它的工具名，桥接到 DSH」—— 它的工具是服务端固定的，改不了

问模型「你现在能直接调用哪些工具」，它吐出来的是服务端给的那套（2026-10-26）：

```
WebFetch / WebSearch / ConnectorStatus / time_calendar / time_zone / time_holiday /
time_lunar / Memory / UpdateBriefContentPreference / AgentList / SendMessageToAgent /
StopAgent / ImageView / AskUserQuestion / FileSend / Agent / TodayCopy /
user_mcp_discovery / ManageAutomation
```

这 19 个名字由服务端定义，客户端**没有**注册、改名或新增的接口。

客户端侧另有一套东西，别和上面混：设备能力（53 个 `capabilityId`，如 `fs.read`、`fs.grep`、
`script.shell`、`ghost.*`），通过 `PUT /registry/devices/<设备id>/tool-state` 上报，
但那个接口**只能按 capabilityId 开关 `enabled`**，不能新增、不能改名，
且 catalogVersion 是固定的 `sha256:8d99ad1f…` 哈希。

⇒ 所以「换个名字让它认」这条路不存在：它的世界里只有那 19 个+53 个固定名字，
DSH 的 `read_file` / `run_shell` 不在其中，改也改不出来。

### 9.3 「让它真的调工具」—— 通道存在，但它不一定走那条路

设备工具调用确实有一条真通道（`packages/socket` 里实现完整）：

```
服务端 → 客户端  { type: "invocation.request", invocationId, capabilityId, args }
客户端 → 服务端  { type: "invocation.ack", invocationId }
                { type: "invocation.result", invocationId, result }
                { type: "invocation.progress", invocationId, progress }
                { type: "invocation.cancel", … }
```

实测（注册一台测试设备、上报 `fs.read` 等能力、连上 `/ws`、然后让它读一个真实文件）：

- WS 连上了，`cloud.hello_ack` / `event.push` 都正常收到；
- 但它**没有**走 `invocation.request`，而是把这件事派成了一个**服务端任务**：
  `task.started { name: "读取 package.json 的 name 字段", taskType: "background" }`，
  另起了一个 thread；
- 我这里一帧 `invocation.request` 都没收到，最终回复是空串（它在等那个任务）。

⇒ 用户侧「设备能力」是它的一条可用通道，但**由它自己决定用不用**，
不能让调用方要求它「用某个工具」。把它当工具总线用是不可靠的。

（顺带一个观察：这也解释了为什么直接问它「读某个本地文件」会超时 —— 它去开任务了，
没人回答，它就等着。所以插件侧对这类请求的超时要有兜底。）

### 9.4 结论：工具只能走文本协议（已实现）

`toolProtocol()` 那套是唯一可靠的路子，理由见第六节。
它的定位要说清楚：**它不是「让 Today 调工具」，而是「让 Today 输出一个可解析的意图，
由调用方（DSH）自己执行」**。执行权留在调用方手里 —— 这恰好是 DSH 需要的语义。

---

## 十、系统提示词剥离（清空 Today 侧人设）

Today 的 agent 每轮都会被前置一段**服务端人设**（`GET /v1/agents/me`）：

| 字段 | 实测长度 | 是什么 |
|---|---|---|
| `agentCharacter` | 276 字符 | 人设与**格式约束**，其中明写「回复中不要使用 markdown 格式」「默认不使用 emoji」 |
| `aboutMe` | 31 字符 | 一句话自我介绍 |
| `userFacts` | 1231 字符 | agent 攒下来的关于你的记忆 |
| `agentName` | `ToBot` | 名字 |

**这段是用户可改的账号状态**：`PATCH /v1/agents/default` 接受 `{agentCharacter, aboutMe, userFacts, character}`，
实测把前两个置空后回读长度为 0，200。

- 插件在登录时问一句「人设怎么处理」，选「清空」才动，并且**先备份再改**
  （备份写在 magpie 配置目录的 `.agent-persona-backup.json`）；
- 备份写不进去就**不改** —— 不做还原不了的事；
- `tools/agent-persona.mjs --show|--strip|--restore` 可随时手动来回切；
- **不动 `userFacts`**：那是记忆，清掉是另一件事，也没有需求。

⚠ 这是账号级状态：清空之后你自己 Today 桌面端里的助手人设也会变（名字不变）。

---

## 十一、速度：实测数字与口径

同一句提示「只回复两个字：好的」，各 3~4 次，取中位。2026-10-26，本机，Windows。

**交错采样**（同一次运行里交替打两条路径，抵消时间漂移；各 6 次，取中位）：

| 路径 | 中位 | 逐次 |
|---|---|---|
| 插件完整路径 | **2.40s** | 2.29 2.32 2.45 2.25 3.01 2.40 |
| 通道地板（自己投递 + 长轮询，不经插件） | **2.54s** | 2.54 2.75 2.85 2.51 2.31 1.75 |
| ⇒ 插件自身开销 | **≈ 0** | 中位差 −0.14s（在噪声内） |

会话池带来的收益（同样交错采样的思路，各 5 次）：

| 情形 | 中位 | 逐次 |
|---|---|---|
| 每轮新建会话 | 2.50s | 3.27 2.28 2.58 2.50 2.13 |
| 同一会话续用（只发增量） | **2.05s** | 2.84 2.15 2.04 1.99 2.05 |
| ⇒ 续用省 | **0.46s/轮** | |

**结论：插件已经不是瓶颈了。** 剩下的时间全是 Today 的 agent turn。

⚠ 这条通道的**单次方差很大**（同一句话 1.75s ~ 9.89s 都见过），
所以任何单个数字都不可信 —— 必须多跑取中位，最好交错采样。
早期对比过原生直连 provider（`officeace/deepseek-v4.1-flash`）约 0.72s，
但那是另一个产品：Today 卖的是 agent，不是裸模型。

怎么读这三个数：

- **插件的翻译层几乎不花钱**：3.27~3.49s 对 3.31s 的地板，差在网关包装与轮询粒度上，
  量级是 0.1~0.2s。
- **慢的那 2 秒不是插件的开销，是 Today 的 agent 自己**：它每轮要起一个 agent turn，
  还可能（像 9.3 那样）把请求派成服务端任务。这个开销在**直连 Today 的 API** 时同样存在，
  桌面端也一样 —— 它不是插件引入的。
- 也就是说：**「不如原生 API」是真的，但原因不是反代**，而是 Today 卖的本来就不是裸模型，
  是一个 agent。拿它和 `officeace/deepseek-v4.1-flash` 那种直连模型比，比的是两种东西。

轮询间隔的影响（同一台机、同一句提示）：

| 轮询间隔 | 插件 fetch 中位 | TTFT 中位 |
|---|---|---|
| 700ms（初版） | 4.42s（样本方差大：3.17~6.80） | 4.45s |
| 250ms（现行） | 3.27s | 3.40s |

⇒ 粒度从 700ms 收到 250ms，首字与整体都省了约 1 秒。再往下收收益递减（通道本身的
结算节奏是秒级），代价是 4 倍的读请求量。

**另一个大概率被问到的问题**：并发。Today 的 agent 侧对并发没有公开口径，
插件 `maxConcurrency: 2` 是照模板给的保守值，**未实测**。

---

## 十二、独立运行：不依赖桌面端

最初的实现从本机 Today 桌面端读登录态（`%APPDATA%\Today CNccount-credentials.slot-*`），
在 `installation-id` 里取设备 id。那等于把插件绑在「装了并登录过桌面端」这台机器上。
改成独立的之后，两条依赖都断了 —— 下面是怎么断的。

### 12.1 登录：只有手机 OTP 一条自助路

把 better-auth 的端点逐个探过（`GET` 存在性 + 非法输入的报错形状）：

| 端点 | 结果 |
|---|---|
| `POST /api/auth/phone-number/send-otp` | **200** `{"message":"code sent"}`；号码要带国家码，`13800000000` 这种不带会被 400 `INVALID_PHONE_NUMBER` |
| `POST /api/auth/phone-number/verify` | body `{phoneNumber, code}` → **`{"token":"<session token>"}`**（就是 refresh 位要的那 32 字符） |
| `POST /api/auth/email-otp/send-verification-otp` | 端点存在，但 `sign-in` 类型走不通 |
| `POST /api/auth/sign-in/email-otp` / `sign-up/email` | **403 `auth.email_sign_in_disabled`** —— 「Email sign-in is unavailable in this region」 |
| `GET /api/auth/oauth2/authorize` | 只接受**注册过的** redirect_uri |
| `/api/auth/.well-known/openid-configuration`、`/jwks`、`/providers` | 404（没开这些） |

redirect_uri 逐个试过（这是「能不能用浏览器登录」的关键）：

```
200  today-connector://auth/callback     ← 只认这个（桌面端注册的自定义协议）
302  http://127.0.0.1:18080/callback     → todayai.cn/login?error=invalid_redirect
302  http://localhost:18080/callback     → 同上
302  https://evil.example/cb             → 同上
```

⇒ **回调落到本地端口会被拒**，所以「在浏览器里登录、把 code 接回插件」这条常规 OAuth 路走不通
（除非去抢注 `today-connector://` 协议，那是劫持别人的客户端，不做）。

所以独立登录 = 手机 OTP：

```
POST /api/auth/phone-number/send-otp   { phoneNumber }        → {"message":"code sent"}
POST /api/auth/phone-number/verify     { phoneNumber, code }  → {"token": "<session token>"}
GET  /api/auth/token   (Bearer <session token>)               → {"token": "<JWT>"}
```

第三条就是原来的续期路径，不用改。实现见 `src/login.mjs`。

### 12.2 设备身份：自己造一个就够了

实测：**服务端不校验设备真伪**。用自己造的、从未注册过的 `X-Device-Id` 发消息，
一样 202 并拿到 threadId；连空值都能过。

```
device="magpie-standalone-8f2c41"  → 202
device="magpie-probe"              → 202
device=""                          → 202
```

所以改成：插件自己生成一个 UUID，持久化在 magpie 配置目录的 `today-device.json`，
不在的时候造一个（`src/device.mjs`）。**持久化是必要的** —— 每次进程重启换新 UUID，
服务端那本设备台账就会多出一台。

### 12.3 验证「真的不依赖」

把 `APPDATA` 指向一个不存在的目录，让 `readDesktopCredential()` 恒返回 null，然后跑完整链路：

```
桌面端读取是否已失效: true
无桌面端 -> 200 content="独立"
usage 无桌面端 -> 7 条窗口, plan=Pro
```

⇒ chat 与 usage 都不碰桌面端。桌面端读取现在只出现在「一键导入」那条可选登录路径里。

⚠ 仍然**需要**的：一个 Today 账号（手机号能收短信），或者一份 session token。
这不是依赖，这是「模型从哪来」。

---

## 十三、正文不增量（所以没有真 token 流）

三个通道都测过，正文都是**一次性**到齐的：

**① REST 50ms 极密轮询**（763 字符的回答）
```
长度变化序列（ms, len, final）: [[20325, 763, true]]
```
整轮只有一次长度变化 —— 从 0 直接到 763。

**② WebSocket**：连上注册设备（`d_...`）后按 `device.hello` 握手，
盯 `chat.presentation.updated.v1` 的 `data.working.current.turn.content.text`。
一条 766 字符的回答，WS 上一共 6 个事件：

```
+0.24s  chat.message_ready.v2          state=completed   msgText=26   （回显用户消息）
+0.41s  chat.presentation.updated.v1   state=-           turnText=0
+0.59s  chat.presentation.updated.v1   state=in_progress turnText=0
+19.56s chat.presentation.updated.v1   state=completed   turnText=0
+19.71s chat.message_ready.v2          state=completed   msgText=766  （终稿一次给全）
```
中间那 19 秒里，`turn.content.text` 是**空数组**，没有任何部分正文。

**③ 结论**：Today 的 agent 不在生成过程中吐字。所以本插件只能「等终稿再发」——
流式是**语义上的**（OpenAI 形状的 SSE），不是**节奏上的**（首字即尾字）。

⇒ 这也是 TTFT 与总耗时基本相等的原因（实测 3.40s vs 3.40s）。任何「把 TTFT 降下来」
的期待在这条通道上都不成立，除非 Today 改服务端。

---

## 十四、会话：`threadId` 是假的，`conversationId` 才是真的

这一节记录的是**我犯过的错**，因为它的表象极具欺骗性。

### 14.1 先犯的错

`POST /v1/messages` 的请求体里有个 `threadId` 字段（schema 里有，`min(1).optional()`）。
我把「带着 threadId 再发一条」当成「续同一个 thread」，并据此做了线程池。

实测打脸：

```
轮1 返回 threadId: 01a1774a-ead7-74ed-…a970
轮2 请求带 threadId: 01a1774a-ead7-74ed-…a970
轮2 返回 threadId: 01a1774b-0372-7181-…5960   ← 不一样！
```

**服务端忽略 `body.threadId`，每次都新建 thread。**

### 14.2 为什么当时误判为「复用成功」

因为那些「复用它还记得上文」的测试**确实通过了**：同一 threadId 第二轮只发增量，
它能答出第一轮让它记的数字。

真实原因：**所有 thread 都属于同一个 conversation（账号的 Main Chat），上下文是会话级的。**
thread 只是「一次投递」，conversation 才是上下文的边界。

所以那个测试测到的不是「thread 复用」，而是「同一账号的对话天然连着」。
这个误判的代价很实在：插件里两个不相关的请求会互相看见对方的内容。

### 14.3 正确的形态

`POST /v3/conversations` 可以**预定一个隔离的会话**：

```
POST /v3/conversations
  headers: { Idempotency-Key: <唯一串> }        ← 必须，缺了 400
  body:    <不发>                              ← 发了 `{}` 也 400
→ 200 {"data":{"conversation":{"conversationId":"01a1774d-…","expiresAt":"…"}}}
```

发送、读取：

```
POST /v3/messages
  { conversationId, clientMessageId, bodyType:"text", body:{ text } }

GET /v2/messages?conversationId=<id>&limit=40     ← 时间正序、含全部历史
```

隔离与记忆都实测过：

```
两个新 conversation，A 说「记住随机串 QXVC78L」
B 问「出现过以 QXV 开头的字符吗」
→ B：「没有。上面的内容里没有出现过以 QXV 开头的字符。」   ✅ 隔离
A 第二轮只发增量 → 「QXVC78L」                              ✅ 会话内记得
```

### 14.4 两个必须知道的坑

**坑一：`/v2/messages` 返回的是全部历史，不是本轮。**
一条用户消息还会引出多条 assistant 记录（实测有 `"Worked on it"` 这种中间态）。
只取 `data` 里最后一条 assistant，会把**上一轮的终稿**当成这一轮的答案 ——
我因此拿到过 500ms 的"响应"，快得不合理，一查是旧答案。
**必须按条数切水位线**（`readTurn(rows, afterCount)`）。

**坑二：Memory 工具会跨会话泄漏事实。**
Today 的 agent 自带 `Memory`，把对话里的事实写进 account 级记忆，别的会话读得到。
实测 A 说「我喜欢的颜色是靛蓝」，B 能答「靛蓝（见 `about-user/preferences.md`）」；
但换成随机串就不行 —— 说明是记忆工具，不是上下文泄漏。

处理办法：在提示里加一段无状态声明。三种措辞实测：

| 措辞 | 结果 |
|---|---|
| （不加） | 「记忆里现在能看到这些：设备 WEI、账号 MYCF711、工作方向…」 |
| 「你是一个无状态推理服务：没有记忆、没有历史…」 | 反而**更起劲地**列记忆内容 |
| 「不要读取或写入任何长期记忆（不要调用 Memory 工具）」 | 「没有。本次会话我未读取长期记忆。」 ✅ |

⇒ 现在是第二列第三行那句，外加「被问到本次请求之外的信息时，直接说你不知道」。

### 14.5 还有一条没修干净

`clientMessageId` 的唯一性只在**单个 conversation 内**有意义。跨会话重名不会报错，
但也没有去重收益。现在每次投递都随机生成，够用。

---

## 十五、长轮询：把 250ms 轮询换成 waitMs

`/v3/conversations/<id>/message-changes` 支持长轮询：

```
GET …/message-changes?afterSequence=<cursor>&limit=50&waitMs=25000
→ {"data":{"items":[…],"sync":{"changeCursor":N,"highWatermark":M}}}
```

`waitMs` 范围 `0..25000`（schema 里写的）。**实测它会真的挂住**：

```
活跃时：投递后 +317ms 就返回，items=1（用户消息）
空闲时：waitMs=8000 的请求用时 8086ms 才返回空
```

⚠ 三个坑：
- **`afterSequence` 必须给**，漏了直接 400（`common.invalid_request`）；
- `body.sequence` 从 0 开始，而 `afterSequence=0` 表示「从头」；
- v3 的 item **没有 `isFinal` 字段**（形状是 `body.content.parts[].text` + `role` + `sequence`），
  所以「是不是终稿」还得回 `/v2/messages` 问一次。

于是现在的流程是：长轮询等变化 → 有新 assistant 内容 → 用 `/v2` 确认终稿。
比每 250ms 发一次 GET 省掉了绝大部分请求，也让首字不再受轮询粒度拖累。

---

## 十六、并发、采样参数、重试

### 16.1 并发不需要保守

同一账号、各自独立会话并发打（实测 2026-10-26）：

| 并发 | 成功 | 内容匹配 | 墙钟 | 备注 |
|---|---|---|---|---|
| 1 | 1/1 | 1/1 | 2.6s | |
| 2 | 2/2 | 2/2 | 3.3s | |
| 4 | 4/4 | 4/4 | 3.0s | |
| 6 | 6/6 | 6/6 | 4.2s | |
| 8 | 8/8 | 8/8 | 5.0s | |
| 12 | 12/12 | 12/12 | 3.9s | |
| 16 | 16/16 | 16/16 | 8.3s | 最慢也是 8.3s |

**无 429、无串线、内容全部对得上。** 所以 `maxConcurrency` 从 2 提到 **8**。
再高收益递减，而且对端是别人的服务，不做压力测试式的占用。

### 16.2 采样参数：五个全被丢，能本地做的都做了

把 `temperature` / `max_tokens` / `n` / `stop` / `response_format` 放进 `/v1/messages`
的请求体，五个都 200、模型行为一字不变 —— 和 `tools` 一样被 schema 丢掉
（`sendMessageRequestSchema` 里没有这些字段，见第九节）。

分两类处理：

**能本地做到的**（插件侧实现，调用方看到的行为与原生一致）：

| 参数 | 实现 | 实测 |
|---|---|---|
| `stop` | 正文里首次出现任一停止序列就截断，序列本身不保留 | `stop:["5"]` → `"1 2 3 4 "` ✅ |
| `max_tokens` | 按**估算** token 截断（口径见 src/tokens.mjs） | `max_tokens:3` → 8 字符（20 字符被截） ✅ |
| `response_format` | 转成一句提示 | 不加 → 给 \`\`\`json 围栏 + 一段解释；加了 → 裸 JSON ✅ |

**本地做不到的**（如实忽略，**不假装生效**）：

- `temperature` / `top_p` / `top_k` / `seed` / 惩罚项 —— agent 侧不接受，我们也不谎称控制了它；
  被要求时写进日志。
- `n > 1` —— 一次调用只产生一条回复。要 n 条就得发 n 轮，费钱且慢，不做。

「不假装生效」是刻意的：如果调用方以为 `temperature=0` 就得到了确定性输出，
它会据此做出错误的工程假设。宁可让它知道这个参数在这条通道上无效。

### 16.3 5xx 重试

上游 500/503 会偶发（正常尺寸下也零星出现）。只给**幂等**调用开重试：

| 调用 | 去重依据 |
|---|---|
| `POST /v3/conversations` | `Idempotency-Key` 头 |
| `POST /v3/messages` | `clientMessageId`（响应里有 `isDuplicate`） |
| `GET /v2/messages`、长轮询 | 天然幂等 |

4xx 不重试（参数/权限错了，重发还是错）。次数有上限，用尽后如实返回最后一次的状态码。

---

## 十七、magpie 永远要流式（以及由此引出的截断 bug）

### 17.1 现象

经网关发 `stream: false` 的请求，拿到的却是 magpie 的报错：

```
Today did not stream: unexpected reply: {"id":"chatcmpl-…","object":"chat.completion",…}
```

**magpie 的 provider 路径永远期望插件返回流式响应**，即使调用方写的是 `stream: false`。
非流式形状只在「直接调插件」（比如 `tests/fetch.mjs`）时才有意义。

顺带这个报错本身很好用 —— 它会把插件返回的响应体原样带出来，
所以我在插件里留了一条「哨兵探针」：请求里出现 `[[TODAY_BODY_KEYS]]` 时，
插件直接把**它实际收到的 body 字段名**作为响应返回。

⚠ 它需要显式开 `TODAY_PROBE=1` 才生效，默认关着 —— 否则等于给调用方一个
可被任意文本触发的探针开关（一条绕过模型的路径）。用完记得关掉这个环境变量。

### 17.2 它查出了什么

发一条带全套参数的请求，回显是：

```
收到的字段：max_tokens, messages, model, response_format, stop, stream, stream_options, temperature
```

结论：
- `stop` / `max_tokens` / `reply_format` / `temperature` **都真的到达了插件** —— 不是被 magpie 剥掉的；
  之前 `stop` 经网关不生效，原因在插件自己（见下）。
- **`n` 不在列表里** —— 被 magpie 自己消费掉了（它按 n 去发多次）。
- 所以「参数没生效」要分两种情况查：上游丢弃（Today 的 schema）vs 中间层剥掉（magpie）vs 插件没做。

### 17.3 由此发现的真 bug

`streamResponse` 原来是**边收边发**：收到一个 delta 就立刻 `frame({content})` 发出去，
最后才做 `constrainOutput`。但正文已经流出去了，截断就成了空话 ——
明明 `stop` 已经到达插件，用户却看到完整正文。

修法：**先攒、后发**。上游本来也不吐增量（第十三节），所以「攒着」在当前通道上零损失；
等它将来真开始分片，再按停止序列边界做增量截断。

修完实测：

| 路径 | `stop:["5"]` 的结果 |
|---|---|
| 直连插件（非流式） | `"1 2 3 4 "` ✅ |
| 插件流式 | `"1 2 3 4 "` ✅（修之前是完整的 `1 2 3 4 5 6 7 8 9 10`） |
| 经 magpie 网关 | `"1 2 3 4 "` ✅ |

### 17.4 一条操作教训

**magpie 不热重载插件源码。** 我改了代码、直接打网关，测出来一直是旧行为 ——
排查了很久才想到看进程启动时间：`magpie-windows-amd64.exe` 从 16:46 起来后就没重启过，
后面所有改动都没进内存。

重新加载的办法（不必重启整个 magpie）：

```bash
magpie plugin add "D:\主工作区\magpie-today-plugin"   # 重新注册 = 重新 import
```

`plugin off/on today` **不行** —— 它认的是插件包名（`D:\主工作区\magpie-today-plugin`），
不是 provider id（`today`），会报 `no plugin "today"`。

⚠ 这条对以后的验证很关键：**改完源码，必须 `plugin add` 一次再测网关**。
否则测的是旧代码，一切结论都不可信。

---

## 十八、能不能把 DSH 的系统提示词塞进 agentCharacter？（不能）

`agentCharacter` 是账号级人设，能改（见第十节）。一个自然的想法是：
把 DSH 的整段系统提示词（含工具协议）写进去，此后每次请求只发对话本身。

**实测结论：它是指令通道，但装不下工具协议。**

### 18.1 先证明它是指令通道

放一条古怪但无冲突的指令：

```
agentCharacter = "你会先说菠萝，不多说别的。"
→ 问「1+1 等于几」→ 回「菠萝。

1+1 = 2。」
```

✅ 生效。所以人设位**不是摆设**，模型确实读它。

### 18.2 但工具协议放进去就不生效

三组对照，只改「指令放哪里」这一个变量（其余全同）：

| 指令位置 | 耗时 | 结果 |
|---|---|---|
| 指令段原样进 `agentCharacter`，消息只发用户话 | 33.5s | ❌ 无 tool_calls，它自己去读文件了 |
| 同上，去掉 `[以下是调用方应用给出的指令]` 框架 | 48.5s | ❌ 无 tool_calls |
| **同一段放消息里（现状）** | **3.1s** | ✅ `read_file{"path":"E:/demo.txt"}` |

### 18.3 为什么

不是「框架」的问题（去掉框架也一样失败），是**优先级**：

- 它把 agentCharacter 当**人设**读 —— 「先说菠萝」是风格，不冲突，照做。
- 而工具协议的实质是「**别真的动手，只输出 JSON 让我执行**」，
  这与服务端自己的 agent 规则（「你有真工具，去用」）**正面冲突**。
  人设位压不过服务端规则，于是它选择动手。

同一段文字放进消息里就能压过 —— 因为消息是**调用方在那一轮下的指令**，
在层次上高于人设。（这也解释了第九节为什么措辞是承重点。）

### 18.4 还有一个结构性理由

就算人设位装得下，也不该用：**`agentCharacter` 是账号级的一个值**，
而 DSH 的系统提示词是**每个会话一份**（persona、技能目录、AGENTS.md、工作区各不相同）。
一个槽装不下一组值 —— 谁后登录谁覆盖谁。

### 18.5 那「只发一次」这个目标本身呢？已经做到了

工具协议**不必每轮重发**。实测（会话池 + 增量）：

```
第 1 轮：发全量（指令段 + 工具表 + 用户话）     → tool_calls ✅
第 2 轮：只发 65 字符（工具结果）                → 正常回答 ✅
第 3 轮：只发 53 字符（新的用户话）              → 仍然出 tool_calls ✅
```

指令段只在**每个会话的第一轮**出现。所以「只发一次」是现成行为，
差别只是：这一次必须在**消息**里，不能在**人设**里。

---

## 十九、设备工具：权限怎么开、开了之后它能干什么

Today 的 agent 除了服务端那 19 个工具，还有一套**设备工具**（53 个 capabilityId），
由桌面端在本机执行。默认只开 `windows_other_files`（用户主目录），
`script.shell` 与 `ghost.*` 全在排除表里。

### 19.1 权限存在哪、怎么改

存在桌面端的 userData：

```
%APPDATA%\Today CN	ool-authorizations-v2\<sha256(environment + accountId)>.json
```

结构（v2）：

```json
{ "version": 2,
  "authorization": { "connectorIds": [...], "excludedToolIds": [...],
                     "fileRoots": [...], "committed": true },
  "effectiveAuthorization": { ...同上... } }
```

**两个字段都要改**（`authorization` 与 `effectiveAuthorization`），否则生效的仍是旧的。
改完必须重启桌面端 —— 它启动时读这个文件，运行中不重读。

Windows 侧共 18 个连接器可用：`windows_desktop` / `_documents` / `_downloads` / `_other_files`、
`_clipboard` / `_screen` / `_battery` / `_calendar` / `_contacts` / `_reminders` / `_notes` /
`_mail` / `_outlook` / `_location` / `_ghost` / `_shell` / `_system` / `_device`。

### 19.2 「文件根」只有四个，别盘符天生进不去

`ToolFileRoot` 的枚举就四个：`desktop` / `documents` / `downloads` / `other_files`
（`other_files` = 用户主目录，且排除前三个）。

⇒ 把 18 个连接器全开、`fileRoots` 填满这四项，**`E:` `D:` 这类独立盘符依然读不到**。
实测：让它读 `E:/__probe/perf.txt`，答「文件读取只授权了四个根目录…」。

### 19.3 但 `script.shell` 能绕过它

放开 `windows_shell`（capabilityId `script.shell`）之后，它可以在本机跑任意命令。
实测三条全过：

| 任务 | 结果 | 耗时 |
|---|---|---|
| `dir D:\主工作区` | ✅ 返回真实目录列表（并自己处理了 GBK 乱码，用 UTF-8 重跑一次） | 16.1s |
| `echo hello_from_shell` | ✅ 原样回显 | 5.8s |
| 写文件再读回 | ✅ 写入 `%USERPROFILE%\__probe_write.txt` 并读回 | 12.3s |

⇒ **「完全放开」的实质是 `script.shell`，不是文件根。** 只要它开着，
整台机器都能碰（包括文件根之外），文件根那四个枚举值就只是「直读」的快捷方式。

⚠ 这是真实的安全面：开 `script.shell` = 让 Today 的 agent 在你的账户下执行任意命令。
主人明确要求全开，做了；备份留在
`tool-authorizations-v2/*.json.bak-before-open-*`，要收回就还原那个文件并重启桌面端。

### 19.4 摘出来的能力清单（Windows）

| 连接器 | 能力 |
|---|---|
| `windows_{desktop,documents,downloads,other_files}` | `fs.read` `fs.list` `fs.stat` |
| `windows_clipboard` | `clipboard.read` `clipboard.write` |
| `windows_screen` | `screen.capture` `screen.get` `screen.elements.find` |
| `windows_shell` | `script.shell` |
| `windows_ghost` | `ghost.context` `ghost.click`（另有 30 个 `ghost.*` 在工具表里） |
| `windows_calendar` / `_contacts` / `_reminders` / `_notes` / `_mail` / `_outlook` | 各自的 list/read/create |
| `windows_battery` / `_system` / `_device` / `_location` | `battery.get` `system.get` `system.apps.list` `location.get` |

### 19.5 一条判据教训

我第一次测「shell 能不能读到 D: 盘」时判的是 `text.slice(0, 130)` 里有没有目录名，
得出「❌ 没读到」——**是假的**。它把输出放在回复中段，前 130 字符是解释。
**验证长输出时要查全文，不能截断后判。**

---

## 二十、上下文窗口：实测到 110 万字仍记得（但有个陷阱）

### 20.1 两层限制，别混

| 层 | 限制 | 超了会怎样 |
|---|---|---|
| **单条消息** | JSON 体 ≤ 1 MiB = 1,048,576 **字节**（中文约 34.7 万字）；`body.text` ≤ 1,000,000 字符 | 413 `Payload too large` / v3 的 `common.payload_too_large` |
| **累积上下文** | **实测 110 万字仍正确** | 尚未找到上限 |

v3 端点（`POST /v3/messages`）和 v1 是同一条上限。二分实测（中文，用 v3）：

```
200,000 字 = 0.57 MiB -> ✅      300,000 字 = 0.86 MiB -> ✅
400,000 字 = 1.14 MiB -> ❌ common.payload_too_large
346,875 字 = 0.99 MiB -> ✅      350,000 字 = 1.00 MiB -> ❌
```

ASCII 35 万字只有 0.33 MiB、照样通过 ⇒ **按字节算，不按字符**。

### 20.2 累积上下文：一批批灌，标记还在

每批 11 万字（0.31 MiB，安全），分批投进**同一个会话**，最后回问最开始给的标记：

| 累积 | 结果 |
|---|---|
| 20 万字 | ✅ 记得 |
| 40 万字 | ✅ 记得 |
| 60 万字 | ✅ 记得 |
| 80 万字 | ✅ 记得 |
| 110 万字 | ✅ 记得（10.0s） |

⇒ `CONTEXT_CHARS = 1_000_000` 这个声明有依据；实际还更高，但没必要往上报。

### 20.3 ⚠ 陷阱：Memory 会伪造「遗忘」

第一轮测的时候，累积到 30~60 万字就开始「忘」，但**关掉 Memory 之后 20/40/60 万字全部记得**。

原因：它从 account 级 Memory 里翻出**别的会话里我早期测试用的标记**来回答 ——
实测答出 `ALPHA-ONE`、`SEA-LANTERN-77`、`4729`、`BIWZS`，全是旧会话残留。
所以看起来「没答对本轮标记」= 判成遗忘了，实际是**被污染的记忆抢答**。

⇒ 量上下文窗口必须 `TODAY_NO_MEMORY=1`，否则测的是记忆检索而不是上下文保持。
这也说明：**放开 Memory 之后，跨会话的事实确实会互相影响** —— 主人要的能力，有它的代价。

### 20.4 我还犯过一个判据错

第一版探针用 `readTurn(rows, 0)`，每轮都从第 0 条开始扫，
于是第二轮立刻看见上一轮的终稿、0.3 秒就"答"出来 —— 读数是假的。
必须像插件那样**发送前先记 `afterCount`**。这条错误在 tests/image.mjs 里也埋过一次，已修。

---

## 二十一、接进 DSH 的实际配置（能跑起来的那份）

插件装好后，DSH 侧在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里加一个 provider：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      today:
        displayName: Today (反代)
        apiKey: local
        api: openai-completions
        baseURL: http://127.0.0.1:3425/v1     # magpie 网关
        models:
          - id: today/deepseek-v4.1-flash
            name: DeepSeek V4.1 Flash (Today 反代)
            contextWindow: 1000000
            maxTokens: 8192
            input: [text, image]
          - id: today/glm-5.3
            name: GLM 5.3 (Today 反代, 4x)
            contextWindow: 1000000
            maxTokens: 8192
            input: [text, image]
```

要点：

- **模型是手写的，不来自 `/v1/models`。** 网关的 `/v1/models` 只暴露路由组
  `group/deepseek-v4.1-flash1017` 一个 id；DSH 显示的是这里手写的条目。
  两者都可用（实测 `today/deepseek-v4.1-flash` 与 `group/deepseek-v4.1-flash1017` 都返回 200）。
- `contextWindow: 1000000` 有实测依据（第二十节：累积 110 万字仍记得）。
- `maxTokens: 8192` 有实测依据（1500 行 / 6392 字符内联输出无截断；要 4000 行它自己分批）。
- `input: [text, image]` —— 图像已支持（第十九节之后那节：走 `/v1/files` 上传 + `attachments`）。
- **DSH 有配置热重载**：改完这个文件不用重启（bundle 里的 `refresh()`：
  「a hot-reload of a live app must never take the process down」）。
  实测：进程 10:58 启动、配置 18:18 改，界面里已经能看到 `Today` 条目。

⚠ 改这个文件前先备份（我在每次改前都留了 `cordis.patch.yml.bak-*`）。
YAML 解析失败时 DSH 会保留上一棵可用的树 —— 不会崩，但你的改动也不生效。

---

## 二十二、没有思考过程可拿

DSH 界面上那条「深度求索中…」是 DSH 自己的活动指示，不是上游吐的思维链。

查证（三处都空）：

| 查的地方 | 结果 |
|---|---|
| assistant 消息的 `messages[]` part 类型 | 只有 `messageType: "text"` |
| v3 item 的 `body.content.parts[].type` 全集 | 只有 `text` |
| 客户端 bundle 里的 `reasoning` | **0 处** |

账号设置里确实有 `thinkingEnabled`（`PATCH /v1/users/me/settings`，实测能存能回读），
但那只是**服务端内部的思考开关**，开了之后前端也拿不到思维链 —— 返回仍是纯 text。

⚠ 网关 `/v1/models` 里那个 `reasoning: true` / `reasoning_levels: ["max"]`
是 **magpie 自己的标注**（它按组声明的），不是 Today 的能力。别据此以为能拿思维链。

⇒ 本插件不做 reasoning 转发。DSH 侧如果显示「深度求索中」，那是它自己的状态。

---

## 二十三、思考过程：上游不给，我们自己造一个

### 23.1 上游真的没有（三处都查过）

见第二十二节。这里只补一句：`presentation.updated` 事件里那个 `typing: {speechId, startedAt, expiresAt}`
是**打字指示器**，不含任何思考内容。WS 我在一次 8.3 秒的推理里只收到 4 个事件，
assistant 消息一出现就带 `state: "completed"`，**没有 `in_progress` 阶段可抓**。

### 23.2 于是走「模板 + 解析」这条路

让模型把推理写进**同一条 JSON 输出**里，插件拆成 `reasoning_content`。DSH 认这个字段：

```js
const OPENAI_COMPLETIONS_REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text"]
```

模板（唯一允许的形状）：

```json
{"kind":"answer|tool_call","reasoning":"<1-3 句推理>", ...分支字段}
```

**为什么模板比散文式指令好**（实测，2026-10-26）：

| 指令形态 | kind 正确 | 整段裸 JSON | 带 reasoning |
|---|---|---|---|
| 散文式「情况一/情况二」 | 15/18 | — | 无法在 tool_call 里带 |
| **严格 JSON 模板** | **5/5** | **5/5** | **5/5** |

散文式还有个结构性缺陷：它只能二选一（要么正文、要么调用），
而模板能让 `reasoning` 和 `tool_calls` 出现在**同一条输出**里 —— 这正是 DSH 想要的。

### 23.3 ⚠ 它是什么、不是什么

**是**：模型自己写出来的推理摘要，能看见它这一步在想什么。
**不是**：底层模型的思维链。真思维链是处理过程中自然产生的，这个是"要求它把想法写出来"。
它的局限是可能写得简略、也可能事后合理化。**别在调试时把两者当一回事。**

质量举例（实测原样）：

> 「调用方指令说 web_fetch 是原生工具、不应通过 tool_calls 请求，但本轮实际可用工具只有
> read_file，没有 web_fetch。我可以用 WebFetch 直接抓取该页面正文」

这条推理直接暴露了我实现里的一个 bug（见下），所以它不只是好看，是**真能用来排障**。

### 23.4 顺带抓出的 bug：分流与解析名单不一致

`parseTemplate` 原来用**全部**工具名当白名单，而模板里只列**分流后**的工具。
后果：模型请求 `web_fetch`（被分流走、不在模板里）时，仍被当成合法 `tool_call` 透传，
DSH 又执行一遍 —— 分流优化白做，还多一轮往返。

修法两处：
1. `parseTemplate` 改用 `delegatedNames`（与模板一致）；
2. `nativeNote` 的措辞从"不要输出 tool_calls"改成
   **"它们故意没有出现在模板里 —— 直接自己做，把结果写进 content"**，并说明原因（会白多一轮）。

修完实测：`tool_calls: []`、正文正常返回、reasoning 里它自己解释了"web_fetch 不在模板里但我有原生 WebFetch"。

---

## 二十四、提示的段序：最重要的放最末

### 24.1 为什么排序（近因效应）

模型对靠近末尾的指令遵从度更高。而这段提示是**每一轮都重发的常驻成本**，
所以「不能不遵守」的那条必须压在最后，不能被别的段落挤到中间去。

### 24.2 现在的段序（低 → 高）

```
1. 调用方的系统提示词              背景，可以长
2. 冲突裁决                        短，只在需要时起作用
3. 关于正文内容（response_format）  条件性要求，仅当调用方给了
4. 你自己就能做的事                减少往返的优化提示
5+6. 工具表 → 输出契约 ★ 最重要 ★  工具表在前是因为契约里说"照上面的形状"，
                                   两者必须相邻；契约收尾
```

**为什么工具表和契约要绑在一起**：契约里写「照上面的形状」，工具表就是那个形状的输入。
拆开会让中间插入的段落把最重要的一条推到中间 —— 这正是修之前的 bug。

### 24.3 修掉的一处冲突

旧版 `response_format` 会吐一段「**只输出一个 JSON 对象**，不要输出 JSON 之外的任何字符」，
而末尾契约允许 `kind="answer"` 时输出纯文本正文 —— **两段直接打架**。

改成约束「**content 字段的内容**」而不是整段输出：

> 本次调用方要求 JSON 输出。放正文时，content 字段的值必须是一个合法的 JSON 对象字符串。

形状归契约管，内容归 response_format 管。各管一层，不再冲突。

### 24.4 从 DSH 源码里补齐的两处

读 DSH bundle 里的 openai-completions 解析器，发现两个我们漏报的字段：

**① usage 的 details 层**：DSH 读 `prompt_tokens_details.cached_tokens` 算缓存成本。
   我们一直只给三个顶层数字。字段缺失会被当成「未提供」而不是「没命中」，现在补齐
   （值仍是 0，因为 Today 不回报缓存）。

**② 流式 reasoning 必须是独立帧**：DSH 把 thinking 当**独立 content block**
   （`thinking_start` → `thinking_delta` → `thinking_end`），从 `delta.reasoning_content` 读。
   和正文混在同一帧会被当正文。

实测帧序列（修完）：

```
[0] delta={"role":"assistant","content":""}
[1] delta={"reasoning_content":"这是简单算术，不需要工具。"}   ← 独立
[2] delta={"content":"1+1 等于 2。"}
[3] finish_reason="stop"
[4] usage={…, prompt_tokens_details:{cached_tokens:0}, completion_tokens_details:{reasoning_tokens:0}}
```

### 24.5 一次多工具并发的验证

DSH 的 `delta.tool_calls` 支持分片累积（按 `index` 合并）。实测两个并发调用：

```
index=0 id=call_xxx name=read  args={"path":"D:/a.txt"}
index=1 id=call_yyy name=bash  args={"command":"npm test"}
finish_reason="tool_calls"
```


---

## 附：README 里搬过来的协议说明

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

**⑤ 图像输入已支持（走上传，不是 URL）。**
OpenAI 的 `image_url`（data URL 或 http(s) 都行）会被插件先上传到 `/v1/files`，
再用返回的 `attachments` 引用随消息发出去 —— 这是唯一能让模型真看到图的路。

```
POST /v1/files (multipart)  → { file: { id, storagePath, type, size, … } }
POST /v1/messages { conversationId, content, attachments: [{type,storagePath,filename,mimeType,size}] }
```

实测：发一张「上红下绿」的 64×64 图，问「有哪些颜色」——直连插件与经网关都答「红色，绿色」。
`images` 那个字段**不是**这么用的（data URL / http URL 都给 400），别照它写。
同一张图按内容哈希缓存，多轮重发历史不会重复上传。

**⑥ 切模型是账号级操作。** `PUT /v1/pricing/model-option` 改的是账号的全局档位，
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

## 与 DSH 的兼容性

| 能力 | 状态 |
|---|---|
| Standard 模式（逐工具呈现） | ✅ 支持，实测 8/8（`tests/gateway.mjs`） |
| 思考过程（`reasoning_content`） | ✅ 支持（模型自写推理摘要，见下） |
| 图像输入 | ✅ 支持（`/v1/files` 上传 + `attachments`） |
| 多轮 / 会话隔离 | ✅ 支持（`POST /v3/conversations`） |
| **PTC 模式（`run_code` + 生成式 SDK）** | ❌ **不支持**，见下 |

### 为什么不支持 PTC

DSH 的 PTC 模式把工具收进一段 TypeScript SDK，模型只输出 `run_code({code, description})`。
在这条通道上实测 **1/5**（5 道题：单工具 / 并发 / 循环 / 条件 / 纯回答），失败原因两类：

1. **它优先用自己的原生工具。** 有 2 题直接跑 `DeviceList` / `DeviceInvoke` / `Bash` 自己干完了，
   压根没进模板分支（连 `reasoning` 都没给）。
2. **写出来的 `code` 不是要的东西。** 单工具那题写成了 `tools.bash({command:"echo check"})` 这种无意义内容；
   循环题只 `glob` 了一下，没有循环。

根因是结构性的：Today 的 agent **手上真能干活的工具**（Bash / DeviceInvoke / WebFetch），
优先级高于「只写代码不执行」的指令。PTC 要求它**写程序**而不是**调一次工具**，
冲突比 Standard 模式更激烈 —— 模型自然会想「我直接做不就行了」。

**这不是客户端问题**，是这条通道的性质。所以插件声明里写明「只支持原生（逐工具）呈现」。

⚠ 在 DSH 里请用 **Standard 模式**；选 PTC 会拿到 1/5 那种结果。

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
magpie plugin add "<本仓库目录>"
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

### 默认行为：走工具，不碰沙盒

插件**默认不使用 Today 的原生能力**（沙盒 / 设备能力 / 连接器）去做事，所有文件操作与命令
都通过文本协议交给调用方执行。理由：调用方在用户的机器上，能审计、能出卡片、能落盘。

模板里有三条硬约束（实测都生效）：

1. **不要动你自己的沙盒** —— 实测它不再调用 `Bash`/`DeviceInvoke`
2. **路径必须完整** —— 绝对路径；实测连用户给的相对路径它都会自己补成绝对路径
3. **回复末尾列出涉及的文件路径** —— 因为 DSH 的「打开所在地」卡片插件给不了（见下）

要恢复「让它用自己的原生能力」（能省一轮往返，但会跑到别的机器上），设 `TODAY_NATIVE_SPLIT=1`。

### 关于 DSH 的文件卡片

DSH 渲染「可直接打开所在地」的卡片，判据是消息 content 里有：

```ts
{ type: 'file', attachment: { attachmentId, name, bytes } }
```

`attachmentId` 必须是 DSH 浏览器端 `dsh-client-ui-attachment` 服务**登记过的内部 ID**，
由用户上传或 DSH 自己的工具产生。**插件在网关后面，够不到那个服务** —— 所以卡片这条路走不通。

替代方案就是上面第 3 条硬约束：让它把路径写进正文，人自己去找。

---

## 二十五、成长体系：额度、邀请、重置卡

### 25.1 三个端点（都是用户级，不需要 admin）

```
GET /v1/pricing/status              → 套餐 + 用量（6 个分项）+ 周期
GET /v1/growth/invitations/me/link  → 邀请链接 + 里程碑
GET /v1/pricing/resets              → 重置卡（每张 resetId + expiresAt）
```

`/v1/growth/*` 在整个 bundle 里**只有这一个端点**，`/v1/pricing/*` 有 11 个（见下），
没有 checkin、没有 daily-reward。

### 25.2 额度是月额度，按注册日重置

实测值（2026-10-26）：

```
period            monthly
currentPeriodEnd  2026-11-26T06:06:00.365Z
entitlementEnds   2027-01-26T06:06:00.365Z
账号 createdAt     2026-10-26T06:06:00.365Z   ← 与 currentPeriodEnd 同月同日同时刻
```

**周期锚点是账号注册的那一刻**，不是自然月 1 号。`entitlementEndsAt` 是 Pro 权益到期，
和额度重置是两个字段，别混。

六个分项（各自独立，不是单一池）：

```
任务 / 对话 / 定时任务 / 每日简报 / 记忆更新 / 云电脑
```

`progress: 75` 是加权总览，`breakdown.items[]` 是分项。实测各分项 `resetAt` 为空
（继承顶层 `usage.resetAt`）。

### 25.3 邀请链接

```json
{
  "invitationLink": { "utmId": "I0OC5sEjmPKB",
                      "link": "https://todayai.cn/login?utm_source=invitation&utm_id=<utmId>" },
  "successfulInviteCount": 1,
  "rewardMilestones": [
    { "requiredInviteCount": 1, "cumulativeResetCount": 1, "reached": true },
    { "requiredInviteCount": 3, "cumulativeResetCount": 2, "reached": false },
    { "requiredInviteCount": 7, "cumulativeResetCount": 3, "reached": false }
  ],
  "rewards": { "qualifiedInviteCount": 1, "grantedResetCount": 1, "pendingResetCount": ... }
}
```

`utm_id` 就是邀请码。第二个号用这个链接注册即计入邀请。

⚠ **`POST` 同路径会重新生成链接**，但会不让旧链接失效，服务端没说。
所以插件**只读不写**，`regenerateInvite()` 单独导出、不自动调。

### 25.4 重置卡

```json
{ "items": [ { "resetId": "3eb3d91d-…", "expiresAt": "2199-12-31T15:59:59Z" }, … ],
  "totalCount": 2, "observedAt": "2026-10-26T14:38:49.121629Z" }
```

`expiresAt` 是 2199 年 = 实际永不过期。

**用掉是不可逆的**（额度恢复到 100%），所以 `useReset()` 需要 `Idempotency-Key`，
且**不接进任何自动流程** —— 只由 `tools/invite.mjs --use` 这类显式动作触发。

### 25.5 没有每日签到

找遍了两组端点，没有 checkin / daily-reward / sign-in-reward。
客户端日志里的 `app_daily_active` 是**埋点事件**（去重状态机、上报用），不计任何额度。

所以 `auth.checkin` 返回 `inactive` 是**诚实的结果**，不是没实现。

### 25.6 `auth.checkin` 与 `auth.usage` 的接线

- `usage` 报 6 个分项窗口 + `resets: {count, until, each[]}`（magpie 的字段）
- `checkin` → `inactive`
- 重置卡读取失败**静默**：它是附加信息，不该让整个用量面板报错

---

## 二十六、普适化：提示词不绑定任何产品

### 26.1 判据

这段提示词是**发给任意调用方**的（DSH、OpenCode、别的客户端）。它里面只能出现
「调用方能看到的概念」，不能出现本插件自己那侧的实现细节。

实测：改之前模板里写着「你有云端 Linux 沙盒、设备能力、连接器」—— 那是 **Today 的**能力，
换个客户端就读到不存在的概念。改成「不管你能接触到什么（云端沙盒、设备、连接器、内部工具）」。

### 26.2 已固化进测试

`tests/live.mjs` 的「提示词不含任何产品名（普适化）」：

```
禁用词：DSH / DeepSeek Harness / Today / todayai / magpie / 桌面端 / DeviceInvoke / script.shell
断言：生成的提示词里一个都不许出现
```

**工具表也必须随调用方变化** —— 同一个测试里用两套完全不同的工具集验证：
工具集 A（alpha）只列 alpha，工具集 B（beta+gamma）只列 beta+gamma。

### 26.3 什么该保留「Today」

| 位置 | 保留 | 理由 |
|---|---|---|
| `PROVIDER_NAME` / `name` / `summary` | ✅ Today | 插件就是给 Today 用的，改名等于撒谎 |
| 错误信息 `未登录` | 用 `PROVIDER_NAME` 变量 | 不写字面量，改名时不用到处改 |
| 桌面端路径（`Today CN`） | ✅ 字面量 | 那是别人 App 的固定目录名，不是我们的选择 |
| **发给模型的提示词** | ❌ 一律不许 | 见 26.1 |

### 26.4 一个尚未验证的点

`POST /v1/growth/invitations/me/link`（重新生成邀请链接）**没实测** ——
担心旧链接失效而影响已分享出去的码。代码里 `regenerateInvite()` 单独导出，
**不接任何自动流程**。要验的话得先接受「旧链接可能失效」这个风险。

---

## 二十七、系统提示词 / 技能目录 / 工具表：怎么拼进提示

### 27.1 现状：已经全都在用，不是「接不接」的问题

`buildPrompt()` 会把调用方传来的**所有** `role: "system"` 消息拼成一整段。实测：

```
system #1  你是鲸鱼娘…（persona）        ✅ 保留
system #2  ## 规则 - 不许虚报              ✅ 保留
system #3  ## 技能 - ui-preview-workflow…  ✅ 保留
user       帮我改个按钮颜色
```

段序（低 → 高，见第二十四节）：

```
调用方全部 system（persona + 规则 + 技能目录 + 记忆）
→ user / assistant / tool 消息
→ 工具表
→ 输出契约 ★最末★
```

工具表**完全由调用方 `tools` 实时生成**，一个名字都不写死（第二十六节有测试）。

### 27.2 但有个坑：技能目录会毁掉会话复用

`conversationHead` 把**整个 system** 当会话复用的键的一部分。而技能目录会变：

```
本机实测：16 个技能的目录清单 ≈ 4769 字符
装一个技能 → system 变 → 键变 → 判定不匹配 → 换新会话 → 整段历史全量重发
实测代价：20 轮 × 2000 字符 = 4 万字符白烧（每次装技能之后的第一轮）
```

### 27.3 修法：`coreHead` —— 键里剥掉技能目录

新增 `coreHead()`：先用 `stripSkillSection()` 把技能段从 system 里剥掉，再算键。

剥离规则（认两类形状）：

- `<skills>…</skills>` / `<available_skills>…</available_skills>` 标签块
- `## 技能` / `# Skills` 起头的标题节，删到下一个**同级或更高级**标题为止

**只剥技能段，规则段与 persona 一律保留**（有测试：`不许虚报`、`你是鲸鱼娘` 必须还在）。

实测：

```
coreHead  相同: true   ← 技能从 v1 变 v2，仍复用会话
strictHead 相同: false ← 旧行为会换会话
```

### 27.4 折中要说清楚

**复用优先，技能目录的新鲜度让位。** 装了新技能后，同一会话里模型看到的可能还是首次那版目录。

判断依据：技能只是流程提示，不是运行时事实；而换会话的代价（几万字符重发、丢上下文）
远大于「目录晚一轮生效」。真要立刻生效，重启会话即可。

`TODAY_PROBE=1` 时会在两者不一致时打一行日志，便于排障。

### 27.5 邀请链接重新生成：已确认不失效

主人确认「邀请链接不会失效」⇒ `POST /v1/growth/invitations/me/link` 可以放心用。
`regenerateInvite()` 已导出，但仍**不接自动流程**（用户没理由自动换链接）。
