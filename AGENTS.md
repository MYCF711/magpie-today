# magpie-today-plugin · 项目规范

## 这是什么
把 Today（todayai.cn）的两个模型档位接进 magpie 的插件。用本机 Today 桌面端已登录的账号，
把它的 **agent 会话通道**翻译成 OpenAI Chat Completions（含流式与工具调用）。

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
node tools/read-session.mjs    # 打印本机 session token（凭据，别外传）
```

装进 magpie（会立即生效，不用重启）：
```bash
magpie plugin add "D:\主工作区\magpie-today-plugin"
printf '1\n' | magpie plugin login today     # 1 = 从本机桌面端导入
magpie plugin list | grep -A2 today
```

## 已知陷阱
- **PowerShell 解 DPAPI 必须先 `Add-Type -AssemblyName System.Security`**，
  否则报 `TypeNotFound`。见 `src/desktop.mjs`。
- `X-Client-Platform` 有两套值：打 API 用 `windows-client`，渲染进程发 CORS 预检也用这个；
  而 `dist/app/consts/*` 里的常量是 `web`。别照常量抄。
- **模型切换是账号级全局设置**（`PUT /v1/pricing/model-option`），不是 per-request。
  插件切档位会改掉用户在桌面端里选的模型 —— 这是服务端设计，不是 bug。
- `/v1/llm/models` 列的 34 个 modelId **一个都选不了**（PUT 全 400）。别拿它当模型表。
- 单条消息上限约 17 万字符，超了是 413 而不是截断。
- 抓包的根证书用完就摘（MITM CA 留在根存储里等于给全机 HTTPS 开后门）。方法见 docs/internals.md。

## 目录约定
- `src/` 一个关注点一个文件；`index.mjs` 只做九项钩子的装配，不放实现。
- `docs/internals.md` 是**证据与决策**的所在：协议取证、被否掉的方案、未验证项。
  改行为之前先读它，改完把新的证据补回去。
