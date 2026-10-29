# AGENTS.md —— 给 AI 执行者的入口

> 人类请看 [README](./README.md)。这份只回答两件事：**你现在该读哪一份**、
> **忘了哪一条会静默出错**。
>
> 第三节往下是本仓库原有的项目规范与实测陷阱，一条没删 —— 本次只是把它组织进
> 「按阶段取用」的结构，并补上原来缺的**发布七步**。

---

## 零、magpie 升级时：只看稳定版

**判断「要不要跟着 magpie 改这个插件」看稳定渠道，不看每版本渠道。**
magpie 设置里有「更新渠道：每个版本 / 稳定版」，用户默认跑后者，插件要跟的也是后者。

```bash
curl -s "https://usemagpie.ai/api/latest?channel=stable" | grep -o '"version":"[^"]*"'
```

实测（2026-10-28）：两档差 **400 多个版本**（每版本 0.1.1763 / 稳定版 0.1.1327），
但把两边内嵌契约都提取出来逐字段比对后 —— **插件相关的字段一条不差**。
多出来的段是 GUI 历史，不是插件契约。⇒ 追每版本几乎全是白跑。

**稳定版版本号变了**，才需要重提取契约（脚手架的 `extract-contract.py`）→
跑 `contract-diff.mjs` → 看差集里有没有「不写会关掉某个能力」的字段。
完整判据见脚手架的
[HOOKS.md](https://github.com/MYCF711/magpie-plugin-scaffold/blob/main/HOOKS.md) 顶部
与 [UPDATING.md](https://github.com/MYCF711/magpie-plugin-scaffold/blob/main/UPDATING.md) 第七节。

---

## 一、先定位你在哪一步

| 你在做什么 | 必读 | 做完的判据 |
|---|---|---|
| **第一次碰这个仓库** | 下面第三节「这是什么」+ 第四节「三条会改变能力的实测事实」 | 能说清「流式是形状上的」与「会话必须用 v3 隔离」 |
| **改登录 / 设备身份** | 第五节「独立性纪律」 | `node tests/independent.mjs` 绿；把 `TodayCN.exe` 全停也能发消息 |
| **改协议 / 会话 / 工具调用** | 第六节「硬规则」+ 第八节「已知陷阱」 | 对应测试跑过（会长额度的项要说明） |
| **改完源码要装进 magpie** | 第七节「怎么跑」里的 `magpie plugin add` | magpie **不热重载**，必须重新 add |
| **代码写完，准备交付** | [CHECKLIST.md](./CHECKLIST.md) 的 **A 表** | A 表全勾 + check 脚本退出 0 |
| **要发版本** | 第二节（发布七步） | CHECKLIST B 表全勾 + 四条验证 |

---

## 二、要发版本：功能分支 + PR 门禁

> ⚠ **禁止直接推 main。** 本插件走 git 源，用户跟随默认分支 HEAD；未验证提交会直接抵达用户。

```
第 0 步  从最新 main 起功能分支
第 1 步  写 CHANGELOG + bump version
第 2 步  合规检查 + 本机测试 + npm pack --dry-run
第 3 步  提交并推功能分支
第 4 步  PR 的 rules 检查全绿后合并（本机 live 测试按 AGENTS 要求另跑）
第 5 步  回到与 origin/main 一致的提交；本插件不走 npm
第 6 步  给已合并提交打 tag 并建 Release
第 7 步  验证 magpie commit 与 Release；若日后发 npm，再验版本与 tarball
```

完整规矩（含 magpie 怎么发现新版本、npm 源与 git 源的区别）见
[脚手架 UPDATING.md](https://github.com/MYCF711/magpie-plugin-scaffold/blob/main/UPDATING.md)。

---

## 三、这是什么

把 Today（todayai.cn）的两个模型档位接进 magpie 的插件。**手机验证码登录，不依赖桌面端**，
把它的 **agent 会话通道**翻译成 OpenAI Chat Completions（含流式与工具调用）。

## 四、三条会改变能力的实测事实（改代码前先知道）

- **正文不增量**：上游只在终稿时一次给全，所以「流式」是形状上的，首字≈总耗时。
- **会话用 v3**：`POST /v1/messages` 的 `body.threadId` **被服务端忽略**（每次新建 thread），
  而所有 thread 共享账号的 Main Chat ⇒ 会串味。隔离靠 `POST /v3/conversations`。
  细节与踩坑见 `src/conversation.mjs` 顶部注释。
- **切模型是账号级**：`PUT /v1/pricing/model-option` 会改用户在桌面端选的模型。

## 五、独立性纪律（改代码前先读）

- **插件运行时不许依赖 Today 桌面端。** `src/desktop.mjs` 只能**动态 import**
  （在「从桌面端导入」那条可选登录路径里），不许有顶层静态引用 —— 那条被
  `tests/independent.mjs` 静态检查拦着。
- **设备身份自持**：`src/device.mjs` 自己生成 UUID 并持久化，不许去读桌面端的
  `installation-id`。同样是 `tests/independent.mjs` 在拦。
- **测试的凭据入口是 `tests/auth.mjs`**：`TODAY_SESSION` 环境变量 → magpie 的
  `plugin-auth.json` → 桌面端（兜底）。别在测试里直接读桌面端。
- 改完跑一次 `node tests/independent.mjs`；要最强证据就把 `TodayCN.exe` 全停掉再跑。

## 六、硬规则（会改变行为的）

- **不许改 `src/constants.mjs` 里的 `toolProtocol` 措辞**而不重跑 `node tests/live.mjs tools`。
  那套「文本转换器」的口吻是工具调用能成立的原因，不是文风。
- 任何声明的数字（上下文、输出上限、延迟）**必须带口径**。没实测的写「未验证」，不许估。
- 登录态只在运行时读，**不许**把 token 写进任何文件、日志、测试快照。
- 改完必须跑：`node tests/live.mjs`（纯函数项免费，发消息项花额度）。
- `_capture/` `_probe/` `_asar/` 是勘查产物，不发布、不提交（见 .gitignore）。

## 七、怎么跑

```bash
node tests/live.mjs            # 全量自测（会真的发消息，消耗账号额度）
node tests/live.mjs notool     # 只跑不花钱的项
node tests/fetch.mjs           # 直接验 loader.fetch 的三种响应形状
node tests/conversation.mjs    # 会话隔离 / 增量续聊 / 水位线（3 条消息）
node tests/gateway.mjs         # 经网关的验收：多轮/工具/分流/stop/tool_choice/usage/SSE
node tests/independent.mjs     # 独立性自测：不依赖 Today 桌面端（静态检查 + 无客户端时发消息）
node tests/image.mjs           # 图像输入：上传 → attachments → 模型真能看见（1 条消息）
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

## 八、已知陷阱

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
- **图片必须走上传**：`attachments: [{type,storagePath,filename,mimeType,size}]`，
  **五个字段缺一不可**（缺 `size` 就 400）。`images` 字段不是这么用的（data URL/http URL 都 400）。
  另外 `attachmentsFor()` 两种输入形状都吃（messages 或 content 数组）—— 曾经因为只吃后者、
  调用方传了前者而静默丢图，模型只看到 `[图片]` 占位符。
- **Today 的 agent 自带 Memory 工具**，account 级，跨会话可见。**默认已放开**（按主人指示，
  记忆是它的既有能力，压制等于砍功能）。要恢复压制：设 `TODAY_NO_MEMORY=1`。
  那条压制语句的措辞是实测过的，换法就不灵（见 docs/internals.md 第十四节）。

## 九、目录约定

- `src/` 一个关注点一个文件；`index.mjs` 只做九项钩子的装配，不放实现。
- `docs/internals.md` 是**证据与决策**的所在：协议取证、被否掉的方案、未验证项。
  改行为之前先读它，改完把新的证据补回去。

## 十、这份文件的维护规矩

1. 任何一次「不报错、要几小时才找到」的坑，收工前加进第八节（症状 → 判据 → 出处）。
2. 判据要能当场验证（命令、字段、界面现象），写不成判据的是感想。
3. 新增一份文档，在第一节的「必读」里给它一个位置。
