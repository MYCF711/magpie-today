// Today · agent 通道 ↔ OpenAI Chat Completions 的翻译层
//
// Today 没有 chat/completions 端点。它的模型只能这样碰：
//
//   POST /v1/messages            → 202，拿到 threadId
//   GET  /v2/messages?threadId=  → 轮询，assistant 消息的 isFinal=true 即终稿
//   （WebSocket `/ws` 也能推，但实测本账号的推流里正文是空的，正文仍要从 REST 取）
//
// 所以本模块干三件事：把 OpenAI 的 messages 压成一条 agent 消息、把 agent 的
// 回复还原成 OpenAI 的形状、把工具调用用文本协议模拟出来。

import { POLL_INTERVAL_MS, TURN_TIMEOUT_MS } from "./constants.mjs"

// ── 请求方向：OpenAI messages → 一条 agent 消息 ──────────────────────────

/** 把消息内容拍平成纯文本（OpenAI 的 content 可能是字符串或 parts 数组）。 */
export function contentToText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p
        if (p?.type === "text") return p.text ?? ""
        if (p?.type === "image_url") return "[图片]"
        return ""
      })
      .filter(Boolean)
      .join("\n")
  }
  if (content == null) return ""
  return JSON.stringify(content)
}

function describeToolCall(tc) {
  const name = tc?.function?.name ?? tc?.name ?? "unknown"
  let args = tc?.function?.arguments ?? tc?.arguments ?? "{}"
  if (typeof args !== "string") args = JSON.stringify(args)
  return `${name}(${args})`
}

/**
 * 生成工具协议说明。
 *
 * 为什么用文本协议：Today 的 agent 不接收 `tools` 字段 —— 它有自己的一套工具，
 * 由服务端的 agent 调度，客户端塞不进任何函数定义。所以只能把工具表写进提示，
 * 让模型输出一个约定形状的 JSON，我们再把它转回 `tool_calls`。
 *
 * 实测（2026-10-26）：以「文本转换任务」的口吻给出协议时模型能稳定照做；
 * 以「你有一个工具」的口吻给出时它会去调自己真的有的工具、或拒绝伪造调用。
 * 所以措辞是这套方案能否成立的关键，不要在没验证的情况下改它。
 */
export function toolProtocol(tools, toolChoice) {
  if (!Array.isArray(tools) || tools.length === 0) return ""
  const list = tools
    .map((t) => {
      const f = t?.function ?? t
      const params = f?.parameters ? JSON.stringify(f.parameters) : "{}"
      return `- ${f?.name ?? "unknown"}：${f?.description ?? ""}\n  参数（JSON Schema）：${params}`
    })
    .join("\n")

  const forced =
    toolChoice && typeof toolChoice === "object"
      ? `\n本次只允许调用 \`${toolChoice.function?.name ?? toolChoice.name}\`。`
      : toolChoice === "required"
        ? "\n本次必须产生一次工具调用。"
        : ""

  return [
    "## 输出格式约定（必须严格遵守）",
    "",
    "你现在只做文本转换：把用户请求转成下面规定的两种形状之一。",
    "不要真的去执行任何操作，不要解释你的判断，不要输出约定之外的任何字符。",
    "",
    "情况一 —— 需要调用工具时，输出且只输出一个 JSON 对象：",
    '{"tool_calls":[{"name":"函数名","arguments":{参数对象}}]}',
    "",
    "情况二 —— 不需要调用工具时，直接输出回答正文，不要包 JSON。",
    "",
    "可用的函数表：",
    list,
    forced,
  ].join("\n")
}

/**
 * 把整段对话压成一条 agent 消息。
 *
 * 为什么带上历史：agent 是服务端有状态的，但我们每次请求都用**新** thread
 * （见下方 `startTurn` 的说明），所以历史必须自己带全，否则多轮对话会断。
 */
export function buildPrompt(messages, { tools, toolChoice, systemTag } = {}) {
  const parts = []

  const system = (messages ?? []).filter((m) => m?.role === "system").map((m) => contentToText(m.content))
  const sysText = system.join("\n\n").trim()
  const protocol = toolProtocol(tools, toolChoice)

  if (sysText || protocol) {
    parts.push(
      [
        systemTag ?? "[以下是调用方应用给出的指令]",
        sysText,
        "",
        "当上面的指令与你自己的人设、称呼、格式偏好冲突时，以上面的指令为准。",
        protocol ? `\n${protocol}` : "",
        "[指令结束]",
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }

  for (const m of messages ?? []) {
    if (!m || m.role === "system") continue
    const text = contentToText(m.content)
    if (m.role === "user") {
      parts.push(`[用户]\n${text}`)
    } else if (m.role === "assistant") {
      // 上一轮的助手回复 / 它发起的工具调用，都要回灌，否则模型看不到自己调过什么
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls.map(describeToolCall).join("\n") : ""
      const body = [text, calls && `(发起了调用：${calls})`].filter(Boolean).join("\n")
      if (body) parts.push(`[助手]\n${body}`)
    } else if (m.role === "tool") {
      const name = m.name ?? m.tool_call_id ?? "工具"
      parts.push(`[工具结果 ${name}]\n${text}`)
    } else if (m.role === "developer") {
      // DSH 用 developer 承载工具增删元数据，对模型没有意义，丢掉
      continue
    }
  }

  return parts.join("\n\n")
}

// ── 响应方向：agent 回复 → OpenAI 形状 ──────────────────────────────────

/**
 * 从模型输出里认出工具调用。
 *
 * 认三种写法，按可靠性排序：
 *   1. 裸的 `{"tool_calls":[...]}`
 *   2. ```json 代码块里的同一个对象
 *   3. 单个 `{"name":...,"arguments":...}`（有些模型会省掉外层数组）
 * 认不出来就返回 null —— 调用方按普通文本处理，不要猜。
 */
export function extractToolCalls(text, knownNames) {
  const raw = String(text ?? "").trim()
  if (!raw) return null

  const candidates = []
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/gi) ?? []
  for (const block of fenced) {
    const inner = block.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim()
    if (inner) candidates.push(inner)
  }
  candidates.push(raw)
  // 最后再试一次：从第一个 { 到最后一个 } 之间那段
  const first = raw.indexOf("{")
  const last = raw.lastIndexOf("}")
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1))

  for (const c of candidates) {
    let parsed
    try {
      parsed = JSON.parse(c)
    } catch {
      continue
    }
    const calls = normalizeCalls(parsed, knownNames)
    if (calls) return calls
  }
  return null
}

function normalizeCalls(value, knownNames) {
  const list = Array.isArray(value?.tool_calls)
    ? value.tool_calls
    : value && typeof value === "object" && typeof value.name === "string"
      ? [value]
      : null
  if (!list || list.length === 0) return null

  const known = knownNames instanceof Set ? knownNames : new Set(knownNames ?? [])
  const out = []
  for (const c of list) {
    const name = c?.name ?? c?.function?.name
    if (typeof name !== "string" || !name) continue
    // 名字必须在调用方给的清单里：模型偶尔会编一个不在表里的函数名，
    // 透传上去 magpie 会当成幻觉工具，报错比直接当文本更难查。
    if (known.size && !known.has(name)) continue
    let args = c?.arguments ?? c?.function?.arguments ?? {}
    if (typeof args === "string") {
      try {
        args = JSON.parse(args)
      } catch {
        args = {}
      }
    }
    out.push({ name, arguments: args ?? {} })
  }
  return out.length ? out : null
}

/** 工具调用的参数对象 → OpenAI 的 arguments 字符串。 */
export function argumentsString(args) {
  try {
    return JSON.stringify(args ?? {})
  } catch {
    return "{}"
  }
}

/** 生成一个 OpenAI 风格的 tool_call id。 */
export function newCallId() {
  return `call_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`
}

// ── 一轮对话 ────────────────────────────────────────────────────────────

/**
 * 开一轮：投递消息，返回 threadId。
 *
 * ⚠ 每次请求都开**新** thread。原因有两条，都是实测结论：
 *   1. 复用 thread 会让服务端把历史自己再存一份，而我们又把历史全带上 ⇒ 重复
 *   2. 复用 thread 时 agent 会把上一轮的中间过程（工具、思考）也算进上下文，
 *      行为变得难预测；新 thread 的输入输出关系是干净的
 * 代价是每次都会在用户的 Today 里留下一段会话记录 —— 这一点在 README 里说了。
 */
export async function startTurn(client, prompt) {
  const clientMessageId = `tc:magpie-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
  const res = await client.request("/v1/messages", {
    method: "POST",
    body: { content: prompt, messageType: "text", clientMessageId },
    timeout: 60_000,
  })
  if (!res.ok) {
    const err = new Error(`发起对话失败：HTTP ${res.status}`)
    err.status = res.status
    err.payload = res.json ?? res.text
    throw err
  }
  const threadId = res.json?.threadId
  if (!threadId) throw new Error("发起对话失败：响应里没有 threadId")
  return { threadId, clientMessageId }
}

/** 从 /v2/messages 的一页里取 assistant 的正文与终态。 */
export function readAssistant(rows) {
  const list = Array.isArray(rows) ? rows : []
  const msg = list.find((m) => m?.role === "assistant")
  if (!msg) return null
  const text = (msg.messages ?? [])
    .map((p) => p?.content?.text ?? "")
    .join("")
  return { text, isFinal: msg.isFinal === true, state: msg.state ?? "" }
}

/**
 * 一轮对话的完整生命周期（异步生成器）。
 *
 * 产出两种事件：
 *   `{ type: "delta", text }`   —— 新增的文本片段（增量）
 *   `{ type: "done" }`          —— 终稿已到
 * 抛错则整轮失败。
 */
export async function* streamTurn(client, threadId, { signal } = {}) {
  const deadline = Date.now() + TURN_TIMEOUT_MS
  let emitted = ""

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("已取消")
    const res = await client.request(`/v2/messages?threadId=${encodeURIComponent(threadId)}&limit=10`, {
      timeout: 30_000,
    })
    if (res.status === 401 || res.status === 403) {
      const err = new Error("登录已失效")
      err.signIn = "expired"
      throw err
    }
    if (res.ok) {
      const a = readAssistant(res.json?.data)
      if (a) {
        if (a.text.length > emitted.length && a.text.startsWith(emitted)) {
          const chunk = a.text.slice(emitted.length)
          emitted = a.text
          yield { type: "delta", text: chunk }
        } else if (a.text && a.text !== emitted) {
          // 服务端改写了正文（少见，但发生过）。把差量当作新增发出去，
          // 不假装能撤回 —— 调用方看到的就是模型最终确认的版本。
          const chunk = a.text.slice(emitted.length > a.text.length ? 0 : emitted.length)
          emitted = a.text
          if (chunk) yield { type: "delta", text: chunk }
        }
        if (a.isFinal) {
          yield { type: "done", text: emitted }
          return
        }
      }
    }
    await sleep(POLL_INTERVAL_MS, signal)
  }
  const err = new Error("等待回复超时")
  err.timeout = true
  throw err
}

export function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (signal?.addEventListener) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t)
          resolve()
        },
        { once: true },
      )
    }
  })
}
