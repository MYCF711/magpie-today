// Today for magpie · 插件入口
//
// ═══════════════════════════════════════════════════════════════════════
// 九项清单（照 magpie 插件契约，一项不缺）
// ═══════════════════════════════════════════════════════════════════════
//
//  ① config(cfg)                       声明 provider + 静态模型表
//  ② auth.methods[].authorize()        登录：手机验证码 / 粘贴 session / 桌面端导入（可选）
//  ③ auth.refresh(auth, provider)      续期
//  ④ auth.loader(getAuth, provider)    请求接管
//  ⑤ auth.usage(getAuth, provider)     额度 → 卡片进度条
//  ⑥ auth.checkin(getAuth, provider)   签到
//  ⑦ provider.models(provider,{auth})  每账号目录
//  ⑧ "chat.headers"(input, output)     每请求加头
//  ⑨ accountId / uid · auth.icon · auth.maxConcurrency
//
// ═══════════════════════════════════════════════════════════════════════
// 两条独立的前提
// ═══════════════════════════════════════════════════════════════════════
//
// **不依赖 Today 桌面端。** 登录走 Today 自己的手机验证码接口（纯 HTTP）；
//   设备身份由本插件自己生成并持久化（实测服务端不校验设备真伪，见 src/device.mjs）。
//   「从桌面端导入登录态」只是便利项，装了客户端的人可以少填一次验证码。
//
// **Today 也没有 chat/completions。** `loader` 返回的 `fetch` 把请求全截下来自己做：
//   一条 OpenAI 请求 → 压成一条 agent 消息 → POST /v1/messages → 轮询 /v2/messages
//   → 增量转成 OpenAI 的 delta / 非流式响应。`baseURL` 填什么都不影响结果。
//
// 协议取证、踩过的坑、为什么工具调用要用文本协议：见 docs/internals.md。
//
// ═══════════════════════════════════════════════════════════════════════

import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { ICON_DATA_URI } from "./src/icon.mjs"
import { readUsage, readInvite, readResets } from "./src/growth.mjs"
import {
  HOST,
  MODEL_OPTIONS,
  PROVIDER,
  PROVIDER_NAME,
  REFRESH_LEAD_MS,
  SESSION_TOKEN_HINT,
} from "./src/constants.mjs"
import { createClient, describeError, exchangeSession } from "./src/api.mjs"
import { deviceId as persistentDeviceId } from "./src/device.mjs"
import { conversationHead, coreHead, createConversationPool } from "./src/conversationpool.mjs"
import { createConversation, listConversationMessages, messageCount, sendToConversation } from "./src/conversation.mjs"
import { sendOtp, verifyOtp } from "./src/login.mjs"
import { buildPrompt, delegatedNames, extractToolCalls, streamTurn } from "./src/chat.mjs"
import { attachmentsFor } from "./src/files.mjs"
import { constrainOutput, unsupportedNotes } from "./src/params.mjs"
import { parseTemplate, templateToolNames } from "./src/template.mjs"
import { errorResponse, nonStreamResponse, streamResponse } from "./src/openai.mjs"
import { resolveOptionId, staticModels } from "./src/models.mjs"

/**
 * 每个账号当前已生效的档位，避免每个请求都发一次 PUT。
 *
 * ⚠ 档位是**账号级全局设置**，不是 per-request。并发请求切不同档位会互相干扰，
 *   所以缓一下、只在变了的时候才发 PUT。
 */
const appliedOption = new Map()

function clampPercent(n) {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(200, Math.round(n * 10) / 10))
}

/**
 * 清空 Today 侧人设（服务端系统提示词）。
 *
 * 为什么值得做：`agentCharacter` 里写着「回复中不要使用 markdown 格式」这类格式约束，
 * 当作模型用时会和调用方的系统提示词打架。实测 `PATCH /v1/agents/default` 能置空，
 * 回读长度为 0。**只动 agentCharacter 与 aboutMe，不动 userFacts**（那是记忆）。
 *
 * 备份先写、写不进去就不改 —— 不做还原不了的事。
 */
async function stripPersona(api, backupDir) {
  const me = await api.request("/v1/agents/me", { timeout: 20_000 })
  if (!me.ok) return { changed: false, reason: "读不到人设" }
  const cur = me.json ?? {}
  if ((cur.agentCharacter ?? "") === "" && (cur.aboutMe ?? "") === "") {
    return { changed: false, reason: "已经是空的" }
  }
  const file = join(backupDir ?? process.cwd(), ".agent-persona-backup.json")
  try {
    writeFileSync(
      file,
      JSON.stringify(
        {
          agentName: cur.agentName,
          aboutMe: cur.aboutMe,
          agentCharacter: cur.agentCharacter,
          savedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    )
  } catch {
    return { changed: false, reason: "备份写不进去，已跳过" }
  }
  const r = await api.request("/v1/agents/default", {
    method: "PATCH",
    body: { agentCharacter: "", aboutMe: "" },
    timeout: 20_000,
  })
  return { changed: r.ok, backup: r.ok ? file : null }
}

/**
 * 每账号一个会话池：每个调用方对话对应 Today 里一个**隔离**的 conversation。
 *
 * 为什么不是 thread：`POST /v1/messages` 忽略 body.threadId（每次都新建 thread），
 * 而所有 thread 共享同一个 conversation ⇒ 请求之间会串味。
 * 正解是 `POST /v3/conversations` 预定隔离会话。踩坑全过程见 src/conversation.mjs。
 */
const pools = new Map()
function poolFor(accountKey) {
  let p = pools.get(accountKey)
  if (!p) {
    p = createConversationPool()
    pools.set(accountKey, p)
  }
  return p
}

/** 人设处理的选择项，三条登录路径共用。 */
const PERSONA_PROMPT = {
  type: "select",
  key: "persona",
  message: `${PROVIDER_NAME} 侧的人设（服务端系统提示词）怎么处理？`,
  options: [
    {
      label: "清空（推荐）",
      value: "strip",
      hint: "把 agentCharacter/aboutMe 置空，让调用方的系统提示词独占；账号级改动，可还原",
    },
    { label: "保留", value: "keep", hint: "不动你的 Today 账号" },
  ],
}

export const TodayAuthPlugin = async ({ client, directory }) => {
  const configDir = directory || process.cwd()
  const log = (message) => {
    try {
      client?.app?.log?.({ service: "today", level: "info", message })
    } catch {}
  }
  const warn = (message) => {
    try {
      client?.app?.log?.({ service: "today", level: "error", message })
    } catch {}
  }


  /** 设备身份：自己生成、持久化在 magpie 配置目录；只有显式从桌面端导入时才带上桌面端认得的那个。 */
  const deviceId = (auth) => auth?.deviceId || persistentDeviceId(configDir)

  const clientFor = (getAuth, auth) => createClient({ getAuth, deviceId: deviceId(auth) })

  /** 登录收尾：校验 session 换得到 token、可选清人设、组出 magpie 要的返回值。 */
  async function finishLogin(sessionToken, { accountId, uid, persona, source }) {
    const { accessToken, expiresAt } = await exchangeSession(sessionToken, null)
    const api = createClient({
      getAuth: async () => ({ access: accessToken }),
      deviceId: persistentDeviceId(configDir),
    })
    const probe = await api.request("/v1/users/me", { timeout: 20_000 })
    if (!probe.ok) {
      return {
        type: "failed",
        error: `${source}登录态不可用（HTTP ${probe.status}）：${describeError(probe.status, probe.json, probe.text)}`,
      }
    }
    const me = probe.json ?? {}
    let personaResult = null
    if (String(persona ?? "") === "strip") {
      personaResult = await stripPersona(api, configDir)
      if (personaResult.changed) log(`已清空 ${PROVIDER_NAME} 侧人设（备份在 ${personaResult.backup}）`)
    }
    return {
      type: "success",
      access: accessToken,
      refresh: sessionToken,
      expires: expiresAt,
      accountId: accountId || me.preferredName || uid || me.id,
      uid: uid || me.id || "",
      deviceId: persistentDeviceId(configDir),
      ...(personaResult?.changed ? { personaStrippedAt: new Date().toISOString() } : {}),
    }
  }

  return {
    // ═══ ① 声明 provider ═════════════════════════════════════════════
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        api: `${HOST}/v1`,
        models: staticModels(), // ⚠ 未登录时也必须有内容，否则显示 "0 models"
      }
    },

    auth: {
      provider: PROVIDER,
      icon: ICON_DATA_URI,
      /**
       * 并发上限。
       *
       * 实测（2026-10-26，同一账号、各自独立会话并发打）：
       *   并发 1/2/4/6/8/12/16 —— 全部成功、内容全部对得上、无 429、无串线。
       *   墙钟时间基本不随并发增长（16 并发 8.3s，最慢也是 8.3s）。
       * 所以 2 那个保守值没必要，取 8 留余量（再高收益递减，且对端是别人的服务）。
       */
      maxConcurrency: 8,
      refreshLead: REFRESH_LEAD_MS,

      // ═══ ② 登录 ══════════════════════════════════════════════════
      methods: [
        {
          type: "oauth",
          label: `${PROVIDER_NAME} 手机号 + 验证码（不需要桌面端）`,
          prompts: [
            { type: "text", key: "phone", message: "手机号（带国家码）", placeholder: "+8613800000000" },
            PERSONA_PROMPT,
          ],
          /**
           * 发码是一次 HTTP 往返（几百毫秒），但真正的等待在 callback —— 用户要看短信。
           * 这里绝不能 await 用户，否则和 magpie 双向死锁。
           */
          authorize: async (inputs) => {
            const phone = String(inputs?.phone ?? "").trim()
            const sent = await sendOtp(phone)
            if (!sent.ok) return { type: "failed", error: sent.message }
            return {
              url: "",
              method: "code",
              instructions: `验证码已发送至 ${phone}，在下面填入 6 位数字完成登录。`,
              callback: async (code) => {
                const v = await verifyOtp(phone, code)
                if (!v.ok) return { type: "failed", error: v.message }
                return finishLogin(v.sessionToken, {
                  accountId: phone,
                  persona: inputs?.persona,
                  source: "手机验证码",
                })
              },
            }
          },
        },
        {
          type: "oauth",
          label: `粘贴 ${PROVIDER_NAME} session token`,
          prompts: [
            {
              type: "password",
              key: "session",
              message: "session token（32 位）",
              placeholder: "粘贴 32 位 session token",
            },
            {
              type: "text",
              key: "note",
              message: "备注名（可选）",
              placeholder: `例如 ${PROVIDER_NAME} 小号`,
              validate: () => undefined,
            },
            PERSONA_PROMPT,
          ],
          /**
           * session token 长期有效、access token 只有 10 分钟 ——
           * 所以存 session（refresh 位），access 由 refresh 钩子按需换。
           */
          authorize: async (inputs) => {
            const session = String(inputs?.session ?? "").trim()
            if (!session) return { type: "failed", error: "请粘贴 session token" }
            const note = String(inputs?.note ?? "").trim()
            const r = await finishLogin(session, {
              accountId: note || `${PROVIDER_NAME} ${session.slice(-6)}`,
              persona: inputs?.persona,
              source: "session token",
            })
            if (r.type === "failed") r.error = `${r.error}。取法：${SESSION_TOKEN_HINT}`
            return r
          },
        },
        {
          type: "oauth",
          label: `从本机 ${PROVIDER_NAME} 桌面端导入（可选便利项）`,
          prompts: [PERSONA_PROMPT],
          /**
           * ⚠ authorize 立刻返回：这里只读一个本地文件（毫秒级），
           *   校验（要发请求）放进 callback。
           */
          authorize: async (inputs) => {
            // ⚠ 动态 import：本插件**不依赖 Today 桌面端**，只有当你真的选了
            //   「从桌面端导入」这一条路时才去加载读它的模块。
            //   顶层静态 import 会让「装了没装客户端」成为插件能否加载的前提，
            //   那是虚假依赖 —— 手机验证码那条路完全不需要它。
            const { desktopInstalled, readDesktopCredential } = await import("./src/desktop.mjs")
            const cred = readDesktopCredential()
            if (!cred) {
              return {
                type: "failed",
                error: desktopInstalled()
                  ? `本机 ${PROVIDER_NAME} 桌面端没有登录态。请打开它登录一次，或改用手机验证码。`
                  : `本机没装 ${PROVIDER_NAME} 桌面端。用「手机号 + 验证码」那条路即可，不需要客户端。`,
              }
            }
            return {
              url: "",
              method: "auto",
              instructions: `将从本机 ${PROVIDER_NAME} 桌面端导入登录态。`,
              callback: async () =>
                finishLogin(cred.refreshCredential, {
                  accountId: cred.userId,
                  uid: cred.userId,
                  persona: inputs?.persona,
                  source: "桌面端",
                }),
            }
          },
        },
      ],

      // ═══ ③ 续期 ══════════════════════════════════════════════════
      /**
       * 返回值**合并**到旧账号上（不是整体替换）。
       * session token 换 token 后不变，所以 refresh 位原样带回去。
       */
      async refresh(auth) {
        const session = auth?.refresh
        if (!session) return undefined
        try {
          const { accessToken, expiresAt } = await exchangeSession(session, deviceId(auth))
          return { access: accessToken, refresh: session, expires: expiresAt }
        } catch (e) {
          if (/401|403|invalid|expired|失效/i.test(String(e?.message))) {
            throw Object.assign(new Error("登录已失效，请重新登录"), { signIn: "expired" })
          }
          throw e
        }
      },

      // ═══ ④ 请求接管 ══════════════════════════════════════════════
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth) return {}
        const api = clientFor(getAuth, auth)

        return {
          baseURL: `${HOST}/v1`,
          apiKey: "today-agent",

          async fetch(input, init) {
            const fresh = await getAuth()
            if (!fresh) return errorResponse(401, `${PROVIDER_NAME} 未登录`, "authentication_error")

            const req = input instanceof Request ? input : null
            const rawBody =
              init?.body != null
                ? typeof init.body === "string"
                  ? init.body
                  : await new Response(init.body).text()
                : req
                  ? await req.text()
                  : ""

            let body
            try {
              body = rawBody ? JSON.parse(rawBody) : {}
            } catch {
              return errorResponse(400, "请求体不是合法 JSON", "invalid_request_error")
            }
            // 排障探针：请求里带 `[[TODAY_BODY_KEYS]]` 时，把**插件实际收到的 body 字段名**
            // 原样回给调用方。用来判断「参数是被上游剥掉了、被中间层剥掉了，还是插件没做」。
            //
            // ⚠ 必须显式开 `TODAY_PROBE=1` 才生效。默认关着 —— 它是一条绕过模型的路径，
            //   不该在正常运行时可被任意文本触发（那等于给调用方一个探针开关）。
            //   排查用法见 docs/internals.md 第 17.1 节。
            const SENTINEL = "[[TODAY_BODY_KEYS]]"
            if (process.env.TODAY_PROBE === "1" && rawBody.includes(SENTINEL)) {
              return new Response(
                JSON.stringify({
                  id: "chatcmpl-probe",
                  object: "chat.completion",
                  created: Math.floor(Date.now() / 1000),
                  model: "probe",
                  choices: [{ index: 0, message: { role: "assistant", content: `字段：${Object.keys(body).join(",")}｜tools:${JSON.stringify((body.tools ?? []).map((t) => t?.function?.name ?? t?.name ?? "?"))}` }, finish_reason: "stop" }],
                  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              )
            }

            // ── 档位切换（账号级设置，不是 per-request）──
            const wantOption = resolveOptionId(body.model)
            const acctKey = String(fresh.accountId ?? fresh.uid ?? "default")
            if (wantOption && appliedOption.get(acctKey) !== wantOption) {
              try {
                const r = await api.request("/v1/pricing/model-option", {
                  method: "PUT",
                  body: { optionId: wantOption },
                  timeout: 30_000,
                })
                if (r.ok) {
                  appliedOption.set(acctKey, wantOption)
                  log(`已切到 ${wantOption}`)
                } else if (r.status === 400 || r.status === 403) {
                  return errorResponse(
                    404,
                    `${PROVIDER_NAME} 账号不能选择模型 ${body.model}`,
                    "invalid_request_error",
                  )
                } else {
                  warn(`切换模型失败（HTTP ${r.status}），沿用当前档位`)
                }
              } catch (e) {
                warn(`切换模型失败，沿用当前档位：${String(e?.message ?? e)}`)
              }
            }

            // ── 组装并投递（线程复用）──
            const tools = Array.isArray(body.tools) ? body.tools : []
            // 排障：记下收到的工具形状（只记名字，不记内容）
            const receivedToolNames = tools.map((t) => t?.function?.name ?? t?.name ?? "?").join(",")
            // 只有「Today 自己做不了、要委托给调用方」的工具才允许出现在 tool_calls 里。
            // 网页抓取/搜索这类 Today 原生就会做，它们不进协议、也不该被当成函数返回。
            const knownNames = delegatedNames(tools)

            const messages = Array.isArray(body.messages) ? body.messages : []
            const pool = poolFor(acctKey)
            // 对话头 = 模型 + 工具清单 + 系统提示词 + 第一条用户消息。
            // 用「头 + 水位线」而不是「全史指纹」：后者会让工具结果回合漏命中，
            // 那一回合的历史比上一轮多了一条 assistant(tool_calls)。
            //
            // ★ 为什么用 coreHead 而不是 conversationHead ★
            //
            // 客户端的系统提示词里含**技能目录**（本机实测 16 个技能 ≈ 4769 字符），
            // 而这个目录会随「装一个技能」变化。用全量 system 当键 ⇒ 键变 ⇒ 换新会话 ⇒
            // **整段历史全量重发**（20 轮 × 2000 字符 = 4 万字符，白烧）。
            //
            // coreHead 把技能目录剥掉再算键：换技能不影响会话复用。
            // 折中是「技能目录的新鲜度让位」—— 模型看到的可能还是首次那版。
            // 详见 src/conversationpool.mjs 的 coreHead 注释。
            const head = coreHead(messages, { model: wantOption ?? "", tools })
            // 留一份全量键用于排障：两者不同 = 这次只差技能目录（复用照常），
            // 一样 = 核心部分也变了（该换会话）。
            const strictHead = conversationHead(messages, { model: wantOption ?? "", tools })
            if (process.env.TODAY_PROBE === "1" && head !== strictHead) {
              log("排障：技能目录变了，但核心头一致 ⇒ 继续复用会话")
            }
            // 传了但我们控制不了的参数：记一笔，日志里说清楚，不假装生效
            const ignored = unsupportedNotes(body)
            if (ignored.length) log(`本次忽略这些参数（上游 agent 通道不接受）：${ignored.join(", ")}`)

            const slot = await pool.acquire(head, messages)
            let conversationId = null
            let afterCount = 0
            let sent = 0
            // usage 估算的输入。
            //
            // ⚠ 必须是**调用方眼中的完整上下文**，不是我们实际发出去的增量：
            //   调用方用 prompt_tokens 判上下文水位、决定何时压缩。续用会话时我们只发
            //   增量，若按增量估，调用方会以为上下文几乎没长，于是永不压缩，
            //   最后撞上上游的载荷上限。所以这里按全量估。
            const fullContextText = buildPrompt(messages, { tools })
            let promptText = fullContextText

            if (slot) {
              // 续用：只发 Today 会话还不认识的那几条
              conversationId = slot.conversationId
              sent = slot.sent
              const incremental = buildPrompt(messages.slice(sent), {})
              try {
                if (incremental.trim()) {
                  const rows = await listConversationMessages(api, conversationId, { limit: 60 })
                  afterCount = messageCount(rows)
                  // 这一轮新增的消息里若有图，先上传再随消息发出去。
                  // 之前已经发过的图不会再出现（增量里没有），所以不会重复上传。
                  // 附件上传：只用这一个入口判断有没有图，别在两处各判一次
                  const atts = await attachmentsFor(api, messages.slice(sent), {
                    token: fresh.access,
                    deviceId: deviceId(fresh),
                  })
                  await sendToConversation(api, conversationId, incremental, { attachments: atts })
                }
              } catch (e) {
                // 会话可能已过期/作废：忘了它，退回新建
                pool.forgetConversation(conversationId)
                warn(`续用会话失败（${String(e?.message ?? e)}），改为新建`)
                conversationId = null
                sent = 0
              } finally {
                slot.release()
              }
            }

            if (!conversationId) {
              const prompt = buildPrompt(messages, { tools, toolChoice: body.tool_choice, responseFormat: body.response_format })
              if (!prompt.trim()) {
                return errorResponse(400, "没有可发送的内容", "invalid_request_error")
              }
              try {
                const conv = await createConversation(api)
                conversationId = conv.conversationId
                const atts = await attachmentsFor(api, messages, {
                  token: fresh.access,
                  deviceId: deviceId(fresh),
                })
                await sendToConversation(api, conversationId, prompt, { attachments: atts })
                // 新会话：上游此刻只知道这一条，水位线是 0
                afterCount = 0
              } catch (e) {
                const status = Number(e?.status) || 502
                if (status === 413) {
                  return errorResponse(
                    413,
                    "内容太大（上游限制：单条正文最多 100 万字符，且整个请求体不超过 1 MiB），请缩短后重试",
                    "invalid_request_error",
                  )
                }
                if (status === 401 || status === 403) {
                  return errorResponse(401, "登录已失效，请重新登录", "authentication_error")
                }
                return errorResponse(502, String(e?.message ?? e))
              }
            }

            // 投递成功：这个 Today 会话现在认识了 messages 的前 messages.length 条
            pool.remember(head, conversationId, messages)
            const convId = conversationId

            const modelId = resolveOptionId(body.model)
              ? String(body.model).split("/").pop()
              : MODEL_OPTIONS[0].id
            const source = () => streamTurn(api, convId, { afterCount, signal: init?.signal })

            if (body.stream === false) {
              try {
                let text = ""
                let agentToolCalls = []
                for await (const ev of source()) {
                  if (ev.type === "done") {
                    text = ev.text ?? text
                    agentToolCalls = ev.toolCalls ?? []
                  }
                }
                // ★ 模板解析 ★ 一次拿到 reasoning / content / tool_calls
                // ⚠ 必须用 delegated 名单（= 模板里列出的那批），不能用全部工具名。
                //   用全部的话，被分流走的工具（如 web_fetch）仍会被当成合法 tool_call 放过去，
                //   分流优化就白做了，还多一轮往返。
                const parsed = parseTemplate(text, knownNames)
                const calls = parsed.toolCalls ?? (knownNames.size ? extractToolCalls(text, knownNames) : null)
                const text2 = calls ? "" : constrainOutput(parsed.content || text, body)
                return nonStreamResponse({
                  modelId,
                  text: text2,
                  toolCalls: calls,
                  promptText,
                  agentToolCalls,
                  reasoning: parsed.reasoning,
                  debugTools: receivedToolNames,
                })
              } catch (e) {
                if (e?.signIn) {
                  return errorResponse(401, "登录已失效，请重新登录", "authentication_error")
                }
                return errorResponse(502, String(e?.message ?? e))
              }
            }

            // 流式：它自己的工具调用放在收尾帧（自定义字段，客户端不认识就忽略）
            let agentToolCalls = []
            return streamResponse({
              modelId,
              source: source(),
              knownNames,
              promptText,
              includeUsage: body.stream_options?.include_usage === true,
              requestBody: body,
              tools,
              receivedTools: receivedToolNames,
              onDone: (ev) => {
                agentToolCalls = ev.toolCalls ?? []
              },
            })
          },
        }
      },

      // ═══ ⑤ 额度 ══════════════════════════════════════════════════
      /**
       * 数据来自 `GET /v1/pricing/status`。
       *
       * ⚠ 每条窗口都必须有有限的 `used`：它不只画进度条，还是**路由的排序输入**。
       *   漏了会被归一成 0 = 「满额」，一个耗尽的账号反而被顶到队首。
       */
      async usage(getAuth) {
        const auth = await getAuth()
        if (!auth) return { error: "未登录", windows: [] }
        const api = clientFor(getAuth, auth)
        try {
          const r = await api.request("/v1/pricing/status", { timeout: 20_000 })
          if (r.status === 401 || r.status === 403) {
            return { error: "登录已失效，请重新登录", windows: [] }
          }
          if (!r.ok) return { error: describeError(r.status, r.json, r.text), windows: [] }

          const status = r.json?.data?.status
          const usage = status?.usage
          if (!status) return { error: "额度接口返回了预期外的形状", windows: [] }

          const windows = []
          const resetsAt = usage?.resetAt ?? undefined

          if (typeof usage?.progress === "number") {
            windows.push({
              name: "套餐用量",
              used: clampPercent(100 - usage.progress),
              display: usage.progressText || `剩余 ${100 - usage.progress}%`,
              resetsAt,
              aside: false,
            })
          }
          for (const item of usage?.breakdown?.items ?? []) {
            const used = Number(item?.usedPercent)
            if (!Number.isFinite(used)) continue
            windows.push({
              name: item?.display?.title ?? item?.key ?? "用量",
              used: clampPercent(used),
              display: item?.display?.percentText || `${used}%`,
              resetsAt,
              aside: false,
            })
          }
          if (windows.length === 0) {
            windows.push({
              name: "套餐用量",
              used: 0,
              aside: true,
              display: status.display?.title ? `${status.display.title}（用量未发布）` : "用量未发布",
            })
          }

          // ★ 重置卡 ★ magpie 的 `resets` 字段就是给它留的位置。
          //   拿不到不影响主流程（另一个接口，失败就当作没有）。
          let resets
          try {
            const rc = await readResets(api)
            if (rc?.totalCount) {
              const earliest = rc.items
                .map((x) => x.expiresAt)
                .filter(Boolean)
                .sort()[0]
              resets = {
                count: rc.totalCount,
                until: earliest,
                each: rc.items.map((x) => ({ until: x.expiresAt })),
              }
            }
          } catch {
            // 静默：重置卡是附加信息，读失败不该让整个用量面板报错
          }

          return {
            plan: status.display?.title || status.plan || undefined,
            user: auth.accountId ?? undefined,
            until: status.entitlementEndsAt ?? status.currentPeriodEndAt ?? undefined,
            renew: "auto",
            windows,
            ...(resets ? { resets } : {}),
          }
        } catch (e) {
          return { error: String(e?.message ?? e), windows: [] }
        }
      },

      // ═══ ⑥ 签到 ══════════════════════════════════════════════════
      /** Today 没有每日签到。返回 inactive，magpie 之后就不再问了。 */
      async checkin() {
        return { outcome: "inactive", message: `${PROVIDER_NAME} 无每日签到` }
      },
    },

    // ═══ ⑦ 每账号的模型目录 ═══════════════════════════════════════
    /**
     * 目录只能来自本地：可选档位是**账号级**的，服务端只在 PUT 的响应里回它。
     * 静态表就是最全的一份，所以直接返回，不发网络请求。
     */
    provider: {
      id: PROVIDER,
      async models() {
        return staticModels()
      },
    },

    // ═══ ⑧ 每请求加头 ═════════════════════════════════════════════
    /**
     * 加不了东西：请求全套被 loader 的 fetch 截住，加在 gateway 头上的到不了上游。
     * 保留钩子是为了表明「本插件不往请求上加自定义头」这个事实。
     */
    "chat.headers": async (input, output) => {
      if (input?.model?.providerID !== PROVIDER) return
      void output
    },
  }
}

export const _internal = { appliedOption, staticModels, stripPersona }
