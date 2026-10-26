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
