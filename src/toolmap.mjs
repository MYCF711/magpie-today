// Today · 工具等价替换
//
// 这个文件解决一个问题：**哪些工具不该出现给模型看**。
//
// 起因：Today 的 agent 自带一批服务端工具（19 个：WebFetch / WebSearch / Memory /
// TimeCalendar / Agent …）。把它们注册成 DSH 的工具是错的 —— DSH 的上下文要为每个
// 工具付一段说明，而它们对 DSH 而言既不可组合也不等价于本地工具。
//
// 实测（2026-10-26）证明有更好的做法：**Today 自己就会用这些工具**，而且不需要点名。
//
//   「请用你的 WebFetch 打开 https://example.com，把正文原样贴给我」
//     → 9.1s，返回 "Example Domain / This domain is for use in documentation…"
//   「打开 https://example.com 并把正文原样贴给我」（不提工具名）
//     → 8.6s，同样拿到正文
//   「请用你的 WebSearch 查一下今天的日期」
//     → 12.4s，拿到日期（附带一句「搜索返回的多为缓存页」的自我提示）
//
// 所以对这些能力，正确做法是**从工具协议里摘掉**，让 Today 用它自己的实现就地做完，
// 最终答案直接作为文本返回 —— 既没有 tool_call，也不需要 DSH 再跑一轮。
//
// 而 DSH 的本地工具（读文件、跑命令、改代码）Today 够不到，照旧走文本协议。

/**
 * 等价能力表：DSH 的工具名 → Today 原生就有的能力。
 *
 * 判据不是"名字像"，而是**实测 Today 能自己做**。只收实测过的，别凭直觉加。
 */
export const NATIVE_EQUIVALENTS = new Map([
  // 取网页正文 —— 实测 WebFetch 可用（9.1s，正文正确）
  ["web_fetch", { today: "WebFetch", note: "取网页正文" }],
  ["webfetch", { today: "WebFetch", note: "取网页正文" }],
  ["fetch", { today: "WebFetch", note: "取网页正文" }],
  ["fetch_url", { today: "WebFetch", note: "取网页正文" }],
  ["read_url", { today: "WebFetch", note: "取网页正文" }],
  ["read_page", { today: "WebFetch", note: "取网页正文" }],
  ["browser_navigate", { today: "WebFetch", note: "取网页正文" }],

  // 联网搜索 —— 实测 WebSearch 可用（12.4s，结果质量见 docs/internals.md）
  ["web_search", { today: "WebSearch", note: "联网搜索" }],
  ["websearch", { today: "WebSearch", note: "联网搜索" }],
  ["search", { today: "WebSearch", note: "联网搜索" }],
  ["google_search", { today: "WebSearch", note: "联网搜索" }],
])

/** 取工具名（兼容 `{type,function:{name}}` 与 `{name,...}` 两种形状）。 */
export function toolName(t) {
  const n = t?.function?.name ?? t?.name
  return typeof n === "string" ? n : ""
}

/**
 * 拆工具集：哪些交给 Today 自己做，哪些要回给调用方执行。
 *
 * 返回 `{ native: [...], delegated: [...] }`。`native` 里的不写进协议、
 * 不占模型注意力；`delegated` 才是需要模型输出 `tool_calls` 的那些。
 */
export function splitTools(tools, { forced = null } = {}) {
  const native = []
  const delegated = []
  const forcedName = typeof forced === "string" ? forced.toLowerCase() : null
  for (const t of Array.isArray(tools) ? tools : []) {
    const name = toolName(t)
    if (!name) continue
    const eq = NATIVE_EQUIVALENTS.get(name.toLowerCase())
    // ⚠ 被 tool_choice 点名的工具**不能**分流走：调用方在说"这一轮必须产生对它的调用"，
    //   替它自己做等于违反了它的指令。此时按普通工具处理，交给模型输出 tool_calls。
    if (eq && name.toLowerCase() !== forcedName) native.push({ name, ...eq })
    else delegated.push(t)
  }
  return { native, delegated }
}

/** 从 `tool_choice` 里取出被点名的函数名（没有就返回 null）。 */
export function forcedToolName(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") return null
  const n = toolChoice?.function?.name ?? toolChoice?.name
  return typeof n === "string" && n ? n : null
}

/**
 * 把 JSON Schema 压成一行签名。
 *
 * 为什么压缩：`toolProtocol()` 的输出是**每一轮**都塞进提示的常驻成本。
 * 完整的 JSON Schema 对 DSH 那种十几个工具的场景能到几 KB，而模型真正需要的
 * 只有「参数名 + 类型 + 必填」。实测这个压缩保留了全部必要信息，参数仍然正确。
 *
 * 输入 `{type:"object",properties:{...},required:[...]}`，
 * 输出 `path(必填:string), limit(可选:number)`。
 */
export function compactParams(schema) {
  const props = schema?.properties
  if (!props || typeof props !== "object") return ""
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const parts = []
  for (const [key, val] of Object.entries(props)) {
    const type = schemaTypeName(val)
    parts.push(`${key}(${required.has(key) ? "必填" : "可选"}:${type})`)
  }
  return parts.join(", ")
}

function schemaTypeName(v) {
  if (!v || typeof v !== "object") return "any"
  if (Array.isArray(v.enum)) return v.enum.map((x) => JSON.stringify(x)).join("|")
  if (v.const !== undefined) return JSON.stringify(v.const)
  if (v.anyOf || v.oneOf) {
    const list = v.anyOf ?? v.oneOf
    return [...new Set(list.map(schemaTypeName))].join("|") || "any"
  }
  if (v.type === "array") return `${schemaTypeName(v.items)}[]`
  if (v.type) return v.type
  if (v.properties) return "object"
  return "any"
}

/** 给模型的一段说明：这些事你自己有工具，别回 tool_calls。 */
export function nativeNote(native) {
  if (!Array.isArray(native) || native.length === 0) return ""
  const names = [...new Set(native.map((n) => n.name))]
  const abilities = [...new Set(native.map((n) => n.note))]
  return [
    "## 你可以自己完成的动作",
    "",
    `下面这几件事你自己就有对应的工具（${abilities.join("、")}）：${names.join("、")}。`,
    "遇到这类请求，**直接自己做**然后给出结果，不要输出 tool_calls —— ",
    "调用方那边不需要为它们再跑一轮。",
  ].join("\n")
}
