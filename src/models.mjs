// Today · 模型表与档位切换
//
// 两个来源，别混：
//   `GET /v1/llm/models`  —— 网关侧启用的模型清单（34 个），**本账号一个都选不了**
//   `PUT /v1/pricing/model-option` —— 本账号真正能切的档位（2 个）
//
// 插件只用后者。前者读出来放进 `listError` 之外的日志里，方便排障对照。

import { CONTEXT_CHARS, MAX_OUTPUT, MODEL_OPTIONS } from "./constants.mjs"

/** 静态模型表：未登录 / 拉取失败时的兜底，必须有内容，否则卡片显示 0 models。 */
export function staticModels() {
  const out = {}
  for (const m of MODEL_OPTIONS) {
    out[m.id] = {
      id: m.id,
      name: m.multiplier > 1 ? `${m.name}（${m.multiplier}×）` : m.name,
      api: { id: m.id, url: "https://api.todayai.cn", npm: "@ai-sdk/openai-compatible" },
      status: "active",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: CONTEXT_CHARS, output: MAX_OUTPUT },
      capabilities: {
        temperature: false, // agent 通道不接受 temperature，传了也没用
        reasoning: false,
        toolcall: true, // 文本协议模拟，实测可用
        attachment: false,
        input: { text: true, image: false },
        output: { text: true },
      },
    }
  }
  return out
}

const OPTION_BY_ID = new Map(MODEL_OPTIONS.map((m) => [m.id, m.optionId]))
const OPTION_BY_OPTION_ID = new Map(MODEL_OPTIONS.map((m) => [m.optionId, m.optionId]))

/** 把请求里的 model 字段（可能带 provider 前缀）映射成 optionId。 */
export function resolveOptionId(model) {
  if (typeof model !== "string" || !model) return null
  const bare = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model
  return OPTION_BY_ID.get(bare) ?? OPTION_BY_OPTION_ID.get(bare) ?? null
}

/**
 * 读服务端当前的档位。
 *
 * `GET /v1/pricing/status` 里只有发布过 modelOptions 的响应才带这一块；
 * 没见过就当未知（返回 null），不要瞎猜。
 */
export function readSelectedOption(statusJson) {
  const mo = statusJson?.data?.status?.modelOptions
  const id = mo?.selectedOptionId
  return typeof id === "string" ? id : null
}

/** 从 status 里读额度。 */
export function readUsage(statusJson) {
  const status = statusJson?.data?.status
  if (!status) return null
  const usage = status.usage ?? null
  const display = status.display ?? {}
  const items = usage?.breakdown?.items ?? []
  return {
    plan: display.title || status.plan || "",
    until: status.entitlementEndsAt ?? status.currentPeriodEndAt ?? null,
    resetsAt: usage?.resetAt ?? null,
    progress: typeof usage?.progress === "number" ? usage.progress : null,
    progressText: usage?.progressText ?? "",
    items: items.map((i) => ({
      key: i?.key ?? "",
      title: i?.display?.title ?? i?.key ?? "",
      usedPercent: typeof i?.usedPercent === "number" ? i.usedPercent : 0,
      percentText: i?.display?.percentText ?? "",
    })),
  }
}
