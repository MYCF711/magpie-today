// Today · 常量
//
// 全部值来自实测（2026-10-26，Today 桌面端 1.23.0，CN 渠道）：
//   · 主 API 与鉴权域名：解包 `resources/app.asar` 的 `dist/app/consts/cloud-public-config.mjs`
//   · 请求头常量：`packages/api-client/src/platform-constants.ts` 的打包产物
//   · 模型档位：`GET /v1/pricing/status` + `PUT /v1/pricing/model-option` 的 zod enum
//
// ⚠ 这些都是「会变的东西」。变了的判据是接口返回 400/403，不是猜。

export const PROVIDER = "today"
export const PROVIDER_NAME = "Today"

export const HOST = "https://api.todayai.cn"
export const AUTH_HOST = "https://auth.todayai.cn"

/** OAuth 客户端 id（prod）。客户端用它换 token，这里只用来读桌面端登录态。 */
export const OAUTH_CLIENT_ID = "Bh2VwEojzfuJw4kBGuLQf3wxGEoupUnx"

/**
 * 请求头常量。
 *
 * `X-Client-Capabilities` 是一串能力声明，服务端据此裁剪响应形状。
 * 少发不会报错，但会悄悄少拿到东西（比如卡片类消息），所以照抄全串。
 */
export const CLIENT_CAPABILITIES =
  "chat.automation_card.v1,chat.brief_card.v1,chat.browser.v1," +
  "chat.connector_automation_card.v1,chat.connector_auth_card.v1," +
  "chat.follow_up_recommendations.v1,chat.qa_single_select.immediate.v1," +
  "chat.qa_cardflow_single.v1,chat.message_reactions.unicode.v1," +
  "connectors.account_management.v1,pricing.cn_usage_locked_recovery.v1"

/** 桌面端自报的版本。服务端只做下限校验，实测 1.0.0 也能过。 */
export const APP_VERSION = "1.23.0"

/**
 * 账号可选的模型档位。
 *
 * ⚠ 这是**账号级全局设置**，不是 per-request。
 * `PUT /v1/pricing/model-option` 只接受这两个 `model.*` 值；
 * `mode.fast|balanced|power` 在本账号上返回 403（是更高套餐才有的档位）。
 * `/v1/llm/models` 列的 34 个 modelId 一个都选不了（PUT 400）——
 * 那是网关侧启用的模型清单，不是本账号可选项。
 */
export const MODEL_OPTIONS = [
  {
    optionId: "model.deepseek-v4.1-flash",
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    multiplier: 1,
  },
  {
    optionId: "model.glm-5.3",
    id: "glm-5.3",
    name: "GLM 5.3",
    multiplier: 4,
  },
]

/**
 * 上下文窗口（字符）。
 *
 * 实测口径（2026-10-26）：单条 `content` 160,041 字符 → 202 且开头令牌被原样复述；
 * 180,041 字符 → 413 Payload too large。所以窗口的**实际天花板是请求体大小**，
 * 不是模型的 token 上限 —— 这两个数字别混：BPE 下 16 万汉字远超 16 万 token。
 * 填这个数是为了让 agent 在合理的地方压缩，不是为了顶满。
 */
export const CONTEXT_CHARS = 160_000
/** 输出上限没测出来（agent 通道不回报 usage），先按保守值声明。 */
export const MAX_OUTPUT = 8_192

/** 首字延迟的观测范围（2026-10-26，本机 4 次采样，两档模型）。 */
export const LATENCY_HINT_MS = { min: 3_100, max: 8_700 }

/** token 到期前多久续期。桌面端的 access token 只有 10 分钟，留足余量。 */
export const REFRESH_LEAD_MS = 3 * 60_000

/** 从哪弄到 session token（提示文本，出现在登录界面）。 */
export const SESSION_TOKEN_HINT =
  "%APPDATA%\\Today CN\\account-credentials.slot-*（safeStorage 加密），或用本插件自带的 tools/read-session.mjs"

/** 单次会话等待上限。超了就当失败，不无限挂着。 */
export const TURN_TIMEOUT_MS = 300_000
/** 轮询兜底的间隔。WS 断掉时靠它收尾。 */
export const POLL_INTERVAL_MS = 250

/**
 * 长轮询单次挂起时长（毫秒）。
 *
 * `/v3/conversations/<id>/message-changes?waitMs=` 实测**会真的挂住**：
 * 空闲时发一个 waitMs=8000 的请求，它等满了 8086ms 才返回空。
 * 于是正文一到就能立刻回来，不用按固定间隔反复问。
 *
 * 取 20000 是折中：再长一点会更省请求，但一条请求挂太久，
 * 中途的连接抖动会拖累整轮（重连要重新算 cursor）。
 */
export const LONGPOLL_WAIT_MS = 20_000

export const USER_AGENT = "node"
