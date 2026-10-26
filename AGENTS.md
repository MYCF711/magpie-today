# magpie-today-plugin · 项目规范

## 这是什么
把 Today（todayai.cn）的两个模型档位接进 magpie 的插件。**手机验证码登录，不依赖桌面端**，
把它的 **agent 会话通道**翻译成 OpenAI Chat Completions（含流式与工具调用）。

## 三条会改变能力的实测事实（改代码前先知道）
- **正文不增量**：上游只在终稿时一次给全，所以「流式」是形状上的，首字≈总耗时。
- **会话用 v3**：`POST /v1/messages` 的 `body.threadId` **被服务端忽略**（每次新建 thread），
  而所有 thread 共享账号的 Main Chat ⇒ 会串味。隔离靠 `POST /v3/conversations`。
  细节与踩坑见 `src/conversation.mjs` 顶部注释。
- **切模型是账号级**：`PUT /v1/pricing/model-option` 会改用户在桌面端选的模型。

## 硬规则（会改变行为的）
- **不许改 `src/constants.mjs` 里的 `toolProtocol` 措辞**而不重跑 `node tests/live.mjs tools`。
  那套「文本转换器」的口吻是工具调用能成立的原因，不是文风。
- 任何声明的数字（上下文、输出上限、延迟）**必须带口径**。没实测的写「未验证」，不许估。
- 登录态只在运行时读，**不许**把 token 写进任何文件、日志、测试快照。
- 改完必须跑：`node tests/live.mjs`（纯函数项免费，发消息项花额度）。
- `_capture/` `_probe/` `_asar/` 是勘查产物，不发布、不提交（见 .gitignore）。

## 怎么跑
```bash
node tests/live.mjs            # 全量自测（会真的发消息，消耗账号额度）
node tests/live.mjs notool     # 只跑不花钱的项
node tests/fetch.mjs           # 直接验 loader.fetch 的三种响应形状
node tests/conversation.mjs    # 会话隔离 / 增量续聊 / 水位线（3 条消息）
node tests/gateway.mjs         # 经网关的验收：多轮/工具/分流/stop/tool_choice/usage/SSE
node tools/agent-persona.mjs --show   # 看 Today 侧人设（清空后才轮到调用方的提示词说话）
node tools/read-session.mjs    # 打印本机 session token（凭据，别外传）
```

装进 magpie（**改完源码必须重新 add 一次** —— magpie 不热重载）：
```bash
magpie plugin add "D:\主工作区\magpie-today-plugin"    # 首次安装 / 每次改完源码
printf '1\n' | magpie plugin login today               # 1 = 手机验证码（不需要桌面端）
magpie plugin list | grep -A2 today
node tests/gateway.mjs                                 # 经网关验收
```

## 已知陷阱
- **PowerShell 解 DPAPI 必须先 `Add-Type -AssemblyName System.Security`**，
  否则报 `TypeNotFound`。见 `src/desktop.mjs`。
- `X-Client-Platform` 有两套值：打 API 用 `windows-client`，渲染进程发 CORS 预检也用这个；
  而 `dist/app/consts/*` 里的常量是 `web`。别照常量抄。
- **模型切换是账号级全局设置**（`PUT /v1/pricing/model-option`），不是 per-request。
  插件切档位会改掉用户在桌面端里选的模型 —— 这是服务端设计，不是 bug。
- `/v1/llm/models` 列的 34 个 modelId **一个都选不了**（PUT 全 400）。别拿它当模型表。
- **载荷上限有两条，别只记一条**：`body.text` ≤ 1,000,000 **字符**（超了 503）、
  整个 JSON 体 ≤ 1 MiB = 1,048,576 **字节**（超了 413）。中文 3 字节/字符 ⇒ 中文先撞字节这条：
  实测 348,000 汉字通过、350,000 汉字 413。旧文档的「17 万字符」是错的，已更正。
- **magpie 不热重载插件源码**：改完必须 `magpie plugin add "<插件目录>"` 重新注册再测网关，
  否则测的是旧代码。`plugin off/on <provider id>` 不行（它认包名不认 provider id）。
- **magpie 的 provider 路径永远要求流式响应**，`stream:false` 也会报 `did not stream`。
  非流式形状只在直连插件时有意义。
- 抓包的根证书用完就摘（MITM CA 留在根存储里等于给全机 HTTPS 开后门）。方法见 docs/internals.md。
- **`/v2/messages` 返回的是整个会话的全部历史**，不是本轮。一条用户消息还会引出多条
  assistant 记录（有 `"Worked on it"` 这类中间态）。只取最后一条 assistant 会把**上一轮的终稿**
  当成这一轮的答案 —— 必须按条数切水位线（`readTurn(rows, afterCount)`）。
- **长轮询的参数是 `afterSequence`**，漏了直接 400；`waitMs` 上限 25000。
- **Today 的 agent 自带 Memory 工具**，会把对话里的事实写进 account 级记忆，别的会话读得到。
  提示里的「无状态声明」是压住它的那句，措辞换过就不灵（见 docs/internals.md 第十四节）。

## 目录约定
- `src/` 一个关注点一个文件；`index.mjs` 只做九项钩子的装配，不放实现。
- `docs/internals.md` 是**证据与决策**的所在：协议取证、被否掉的方案、未验证项。
  改行为之前先读它，改完把新的证据补回去。
