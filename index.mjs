// Today for magpie · 插件入口
//
// ═══════════════════════════════════════════════════════════════════════
// 九项清单（照 magpie 插件契约，一项不缺）
// ═══════════════════════════════════════════════════════════════════════
//
//  钩子（magpie 会调）
//   ① config(cfg)                       声明 provider + 静态模型表
//   ② auth.methods[].authorize()        登录（两条：桌面端导入 / 粘贴 session）
//   ③ auth.refresh(auth, provider)      续期
//   ④ auth.loader(getAuth, provider)    请求接管
//   ⑤ auth.usage(getAuth, provider)     额度 → 卡片进度条
//   ⑥ auth.checkin(getAuth, provider)   签到
//   ⑦ provider.models(provider,{auth})  每账号目录
//   ⑧ "chat.headers"(input, output)     每请求加头
//
//  数据字段
//   ⑨ accountId / uid · auth.icon / auth.maxConcurrency
//
// ═══════════════════════════════════════════════════════════════════════
// 这个 provider 的形态：不是 httpx，是翻译层
// ═══════════════════════════════════════════════════════════════════════
//
// Today **没有** chat/completions 端点。`loader` 返回的 `fetch` 把请求全截下来自己做：
//   一条 OpenAI 请求 → 压成一条 agent 消息 → POST /v1/messages → 轮询 /v2/messages
//   → 增量转成 OpenAI 的 delta / 非流式响应
// 所以 `baseURL` 填什么都不影响结果，它只决定 AI SDK 拼出来的 URL 长什么样。
//
// 协议取证、踩过的坑、为什么工具调用要用文本协议：见 docs/internals.md。
//
// ═══════════════════════════════════════════════════════════════════════

import { startSelfRegister } from "./src/self-register.mjs"
import { ICON_DATA_URI } from "./src/icon.mjs"
import {
  HOST,
  MODEL_OPTIONS,
  PROVIDER,
  PROVIDER_NAME,
  REFRESH_LEAD_MS,
  SESSION_TOKEN_HINT,
} from "./src/constants.mjs"
import { createClient, describeError, exchangeSession } from "./src/api.mjs"
import { desktopDeviceId, desktopInstalled, readDesktopCredential } from "./src/desktop.mjs"
import { buildPrompt, extractToolCalls, startTurn, streamTurn } from "./src/chat.mjs"
import { errorResponse, nonStreamResponse, streamResponse } from "./src/openai.mjs"
import { resolveOptionId, staticModels } from "./src/models.mjs"

const REGISTRY_ENTRY = {
  package: "today-for-magpie",
  name: "Today",
  providers: [PROVIDER],
  community: true,
  summary: {
    en: "Today's (todayai.cn) two model tiers through the desktop client's own sign-in, with streaming and tool calls.",
    zh: "把 Today（todayai.cn）的两个模型档位接进 magpie，用桌面端自己的登录态，支持流式与工具调用。",
  },
}

/**
 * 设备身份。
 *
 * 实测（2026-10-26 全量抓包）：Today 的 HTTP 接口没有签名头，唯一的设备身份就是
 * `X-Device-Id` —— 桌面端把本机的 installation-id 填进去，服务端据此建台账。
 * 复用它能让服务端看到的是同一台设备，而不是每装一次插件就多一台。
 * 读不到桌面端就按账号派生一个稳定的，别每进程随机一个（那才是真的指纹异常）。
 */
let deviceIdCache = null
function deviceIdFor(auth) {
  if (deviceIdCache) return deviceIdCache
  const fromDesktop = desktopDeviceId()
  if (fromDesktop) {
    deviceIdCache = fromDesktop
    return deviceIdCache
  }
  const seed = String(auth?.accountId ?? auth?.uid ?? "today")
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  deviceIdCache = `magpie-${h.toString(16).padStart(8, "0")}`
  return deviceIdCache
}

function clampPercent(n) {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(200, Math.round(n * 10) / 10))
}

/** 每个账号当前已生效的档位，避免每个请求都发一次 PUT。 */
const appliedOption = new Map()

export const TodayAuthPlugin = async ({ client, directory }) => {
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

  startSelfRegister(REGISTRY_ENTRY, { configDir: directory, log })

  const clientFor = (getAuth, auth) =>
    createClient({ getAuth, deviceId: deviceIdFor(auth) })

  return {
    // ═══ ① 声明 provider ═════════════════════════════════════════════
    config: async (cfg) => {
      cfg.provider ??= {}
      // ⚠ 用 ??= ，不覆盖用户在 plugins.json 里配的
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
      maxConcurrency: 2,
      refreshLead: REFRESH_LEAD_MS,

      // ═══ ② 登录 ══════════════════════════════════════════════════
      methods: [
        {
          type: "oauth",
          label: `从本机 ${PROVIDER_NAME} 桌面端导入`,
          /**
           * ⚠ authorize 必须立刻返回：真正的活儿在 callback 里。
           *   在这里 await 用户（或发一次慢请求）会和 magpie 双向死锁
           *   —— 它开着登录窗口等你的 url，你等它的网络回来。
           * 读盘是毫秒级的，但校验要发请求，所以校验也放进 callback。
           */
          authorize: async () => {
            const cred = readDesktopCredential()
            if (!cred) {
              return {
                type: "failed",
                error: desktopInstalled()
                  ? `本机 ${PROVIDER_NAME} 桌面端没有登录态。请打开 ${PROVIDER_NAME} 登录一次，然后重试。`
                  : `本机没有找到 ${PROVIDER_NAME} 桌面端。请先安装并登录，或改用「粘贴 session token」。`,
              }
            }
            return {
              url: "",
              method: "auto",
              instructions: `将从本机 ${PROVIDER_NAME} 桌面端导入登录态。`,
              callback: async () => {
                // 一次校验：拉得通 users/me 才算这份 session 是活的
                try {
                  const { accessToken, expiresAt } = await exchangeSession(
                    cred.refreshCredential,
                    deviceIdFor(cred),
                  )
                  const probe = await fetch(`${HOST}/v1/users/me`, {
                    headers: {
                      accept: "application/json",
                      authorization: `Bearer ${accessToken}`,
                      "x-app-version": "1.23.0",
                      "x-client-platform": "windows-client",
                      "x-device-id": deviceIdFor(cred),
                      "user-agent": "node",
                    },
                  })
                  if (!probe.ok) throw new Error(`HTTP ${probe.status}`)
                  // 卡片上显示的名字优先用厂商那边的人名，退回到 user id。
                  // accountId 是显示名，uid 才是身份 —— 同名账号靠 uid 区分（issue #413）。
                  let me = null
                  try {
                    me = await probe.json()
                  } catch {}
                  return {
                    type: "success",
                    access: accessToken,
                    refresh: cred.refreshCredential,
                    expires: expiresAt,
                    accountId: me?.preferredName ?? cred.userId,
                    uid: cred.userId,
                  }
                } catch (e) {
                  return {
                    type: "failed",
                    error: `桌面端登录态已失效（${String(e?.message ?? e)}）：请在 ${PROVIDER_NAME} 里重新登录后重试。`,
                  }
                }
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
          ],
          /**
           * session token 长期有效，access token 只有 10 分钟 ——
           * 所以存 session（refresh 位），access 由 refresh 钩子按需换。
           * 拿到 token 的地方见 constants.mjs 的 SESSION_TOKEN_HINT。
           */
          authorize: async (inputs) => {
            const session = String(inputs?.session ?? "").trim()
            if (!session) return { type: "failed", error: "请粘贴 session token" }
            try {
              const { accessToken, expiresAt } = await exchangeSession(session, null)
              const note = String(inputs?.note ?? "").trim()
              return {
                type: "success",
                access: accessToken,
                refresh: session,
                expires: expiresAt,
                accountId: note || `${PROVIDER_NAME} ${session.slice(-6)}`,
              }
            } catch (e) {
              return {
                type: "failed",
                error: `session token 无效（${String(e?.message ?? e)}）。取法：${SESSION_TOKEN_HINT}`,
              }
            }
          },
        },
      ],

      // ═══ ③ 续期 ══════════════════════════════════════════════════
      /**
       * 返回值**合并**到旧账号上（与 client.auth.set 的整体替换不同）。
       *
       * 桌面端的 session token 换 token 后不变，所以 refresh 位原样带回去 ——
       * 这也是为什么这里能安全地反复续期。
       */
      async refresh(auth) {
        const session = auth?.refresh
        if (!session) return undefined
        try {
          const { accessToken, expiresAt } = await exchangeSession(session, deviceIdFor(auth))
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
            // ⚠ 每次重新读 auth —— 可能刚被 refresh 更新过
            const fresh = await getAuth()
            if (!fresh) return errorResponse(401, "Today 未登录", "authentication_error")

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
                  // 这个账号不允许这个档位。明确报出去，别静默换一个模型回答。
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

            // ── 组装并投递 ──
            const tools = Array.isArray(body.tools) ? body.tools : []
            const knownNames = new Set(
              tools.map((t) => t?.function?.name ?? t?.name).filter((n) => typeof n === "string"),
            )
            const prompt = buildPrompt(body.messages, { tools, toolChoice: body.tool_choice })
            if (!prompt.trim()) {
              return errorResponse(400, "没有可发送的内容", "invalid_request_error")
            }

            let turn
            try {
              turn = await startTurn(api, prompt)
            } catch (e) {
              const status = Number(e?.status) || 502
              if (status === 413) {
                return errorResponse(
                  413,
                  "内容太大（单条消息上限约 17 万字符），请缩短后重试",
                  "invalid_request_error",
                )
              }
              if (status === 401 || status === 403) {
                return errorResponse(401, "登录已失效，请重新登录", "authentication_error")
              }
              return errorResponse(502, String(e?.message ?? e))
            }

            const modelId = resolveOptionId(body.model) ? String(body.model).split("/").pop() : MODEL_OPTIONS[0].id
            const source = () => streamTurn(api, turn.threadId, { signal: init?.signal })

            // 非流式：跑完再一次性返回
            if (body.stream === false) {
              try {
                let text = ""
                for await (const ev of source()) {
                  if (ev.type === "done") text = ev.text ?? text
                }
                const calls = knownNames.size ? extractToolCalls(text, knownNames) : null
                return nonStreamResponse({
                  modelId,
                  text: calls ? "" : text,
                  toolCalls: calls,
                })
              } catch (e) {
                if (e?.signIn) return errorResponse(401, "登录已失效，请重新登录", "authentication_error")
                return errorResponse(502, String(e?.message ?? e))
              }
            }

            return streamResponse({ modelId, source: source(), knownNames })
          },
        }
      },

      // ═══ ⑤ 额度 ══════════════════════════════════════════════════
      /**
       * 数据来自 `GET /v1/pricing/status`。
       *
       * ⚠ 每条窗口都必须有有限的 `used`：它不只画进度条，还是**路由的排序输入**。
       *   漏了会被归一成 0 = 「满额」，一个耗尽的账号反而被顶到队首（HOOKS.md 第十一节）。
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

          // 总量：服务端给「剩余百分比」，换算成 used
          if (typeof usage?.progress === "number") {
            windows.push({
              name: "套餐用量",
              used: clampPercent(100 - usage.progress),
              display: usage.progressText || `剩余 ${100 - usage.progress}%`,
              resetsAt,
              aside: false,
            })
          }

          // 分项：服务端已按「已用百分比」给出，直接用
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

          // 一条窗口都没有 ⇒ 这个账号没发布用量。给一条 aside 占位，
          // 让路由明确知道「这里没有参与排序的额度窗口」，而不是当成满额。
          if (windows.length === 0) {
            windows.push({
              name: "套餐用量",
              used: 0,
              aside: true,
              display: status.display?.title ? `${status.display.title}（用量未发布）` : "用量未发布",
            })
          }

          return {
            plan: status.display?.title || status.plan || undefined,
            user: auth.accountId ?? undefined,
            until: status.entitlementEndsAt ?? status.currentPeriodEndAt ?? undefined,
            renew: "auto",
            windows,
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
     * 这里加不了东西：请求全套被 loader 的 fetch 截住，加在 gateway 头上的到不了上游。
     * 保留钩子是为了确认它不会被别的插件污染 —— 我们不往外发 headers。
     */
    "chat.headers": async (input, output) => {
      if (input?.model?.providerID !== PROVIDER) return
      void output
    },
  }
}

export const _internal = { REGISTRY_ENTRY, appliedOption, staticModels }