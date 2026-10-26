# magpie-today-plugin · 当前状态

> 更新于 2026-10-26 15:26

## 用户原话
> 参考之前的反代项目经验，freebuff的cli，jet hub。反代这个软件的模型，要求你完全遵从模板仓库做magpie的插件，我已经登录了一个号，你可以获取这个号的本地凭证
>
> 停一下，为什么不能像WB的反代一样呢？逆向这个软件，获取完整请求头。身份识别和指纹等。这部分参考freebuff的逆向反代…然后还有linux端，如果win的不好弄，可以试试linux
>
> 软件只有v4.1f和glm5.3f，我选的是v4.1f

## 已建成（附证据）
- **插件跑通并装进 magpie**：`magpie providers` 里出现 `Today  today  today  ● signed in as tsVPPKJZXVovvBCYfUXeR4VF8yMGDoMY  2 of 2 models`。
- **网关端到端可用**：`POST http://127.0.0.1:3425/v1/chat/completions` 用 `today/deepseek-v4.1-flash` 与
  `today/glm-5.3` 都拿到了 200 + 正确形状；`stream:true` 出 3 帧 SSE（role / content / stop）+ `[DONE]`。
- **自测 9/9 通过**：`node tests/live.mjs`（login / refresh / usage / models / config / notool / toolparse / chat / tools）。
- **loader.fetch 三种形状实测**：非流式 `chat.completion`、流式 SSE、工具调用 `finish_reason=tool_calls` + `content=null`。
- **逆向证据**：完整请求头抓包（744 条已脱敏，留在 `_capture/flows-redacted.json`）；
  Windows 与 Linux 两版 asar 都解包对过，接口面一致（357 个 URL 路径，无 LLM 端点）。

## 未完成 / 阻塞
- **没有 GitHub 远端**：仓库只在本机 `D:\主工作区\magpie-today-plugin`，尚未 init/commit，也没有 push。
  要发 npm 或让别人 `magpie plugin add github:...` 需要先做这一步。
- **在用户的 magpie 路由里没有 group**：`providers.json` 的 `groups` 是用户自己管的（`noAutoGroups: true`）。
  直连模型 id 能路由，但要让 DSH 之类的 agent 用上，需要在 DSH 的 provider 配置（或 magpie 的组）里加一条。
- **未验证项**列在 `docs/internals.md` 第八节（输出上限、并发、长会话、Linux safeStorage、风控口径）。

## 下一步（唯一的下一动作）
把仓库 init + commit，然后问主人要不要建 GitHub 远端（`MYCF711/magpie-today`）并推上去 ——
推上去之后 `magpie plugin add github:MYCF711/magpie-today` 这条路才算通。

## 我自己纠正过的误判
- 一开始以为要做「像 freebuff 那样的协议复刻」。**实测推翻了**：Today 的 HTTP 接口没有任何签名头，
  唯一的设备身份是一个不校验的 UUID。工作量不在协议，在于「它根本没有 chat/completions」。
- 曾按 `dist/app/consts/account.js` 里的常量发 `X-Client-Platform: web`；抓包显示真实客户端发的是
  `windows-client`。常量是给渲染进程用的，别照抄。
- 曾以为模型可以从 `/v1/llm/models` 里挑。逐个 PUT 之后确认：34 个全 400，只有两个 `model.*` 能选。
