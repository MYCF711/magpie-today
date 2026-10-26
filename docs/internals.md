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

| 路径 | 中位 | 口径 |
|---|---|---|
| 每轮新会话（建 conversation + 全量提示） | **2.98s** | v3 会话池 + 长轮询，各 4 次 |
| 同一对话续用（只发增量） | **2.61s** | 同上 |
| 原生 OpenAI 兼容 provider（同机 magpie 直连上游：`officeace/deepseek-v4.1-flash`） | **0.72s** | 作为「直连 API」的对照 |

（早期版本的数字留档：轮询 700ms 时 4.42s；250ms 时 3.27s；换成长轮询后 2.98s。）

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
