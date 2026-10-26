// Today · agent 通道 ↔ OpenAI Chat Completions 的翻译层
//
// Today 没有 chat/completions 端点。它的模型只能这样碰：
//
//   POST /v3/conversations       → 预定一个隔离会话，拿 conversationId
//   POST /v3/messages            → 往会话里追加一条用户消息
//   GET  /v3/…/message-changes   → 长轮询（waitMs），有新东西立刻回
//   GET  /v2/messages?conversationId=  → 确认终稿（isFinal=true）
//
// ⚠ 实测（2026-10-26）：**正文不会增量到达**。50ms 极密轮询下，长度变化序列只有
//   一跳（20.3 秒处 763 字符一次给全）；WebSocket 的 `chat.presentation.updated.v1`
//   里 `turn.content.text` 恒为空数组。所以本插件只能「等终稿再发」，
//   做不到真 token 流 —— 这一点在 docs/internals.md 第十三节有数据。
//
// 本模块干三件事：把 OpenAI 的 messages 压成一条 agent 消息、把 agent 的回复
// 还原成 OpenAI 的形状、把工具调用用文本协议模拟出来。

import { POLL_INTERVAL_MS, TURN_TIMEOUT_MS } from "./constants.mjs"
import { compactParams, forcedToolName, nativeNote, splitTools, toolName } from "./toolmap.mjs"
import { itemRole, itemText, listConversationItems, listConversationMessages, messageCount, readTurn, waitForChanges } from "./conversation.mjs"
import { LONGPOLL_WAIT_MS } from "./constants.mjs"

const NL = String.fromCharCode(10)

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
      .join(NL)
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
 *
 * ⚠ 体积：这段是**每一轮**都塞进提示的常驻成本，所以参数只写压缩签名
 *   （`path(必填:string)`），不写完整 JSON Schema。
 */
export function toolProtocol(tools, toolChoice) {
  if (!Array.isArray(tools) || tools.length === 0) return ""
  const list = tools
    .map((t) => {
      const f = t?.function ?? t
      const sig = compactParams(f?.parameters)
      const name = f?.name ?? "unknown"
      return `- ${name}${sig ? `(${sig})` : ""}：${f?.description ?? ""}`
    })
    .join(NL)

  const forced =
    toolChoice === "none"
      ? `${NL}本次**禁止**调用任何工具：只输出回答正文，不要输出 JSON。`
      : toolChoice && typeof toolChoice === "object"
        ? `${NL}本次只允许调用 ${toolChoice.function?.name ?? toolChoice.name}。`
        : toolChoice === "required"
          ? `${NL}本次必须产生一次工具调用。`
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
  ].join(NL)
}

/**
 * 把对话压成一条 agent 消息。
 *
 * `only` 给定时只压 index >= only 的消息 —— 线程池复用的情形：
 * 服务端那个 thread 已经记住了前面的全部，重发等于白传。
 *
 * 注意：system 提示词与工具协议**只在建 thread 那一次**注入。实测服务端在后续轮
 * 仍然记得它们（见 docs/internals.md 第十四节），所以不必每轮重发。
 */
export function buildPrompt(messages, { tools, toolChoice, systemTag, only = 0, includeInstructions = true } = {}) {
  const parts = []
  const all = Array.isArray(messages) ? messages : []
  const tail = all.slice(Math.max(0, only))

  const system = includeInstructions
    ? all.filter((m) => m?.role === "system").map((m) => contentToText(m.content))
    : []
  const sysText = system.join(NL + NL).trim()

  // ★ 工具分流 ★
  // 一部分工具 Today 自己就能做（WebFetch / WebSearch …）—— 它们不写进协议，
  // 改写成一句「这些事你自己做」。剩下的（DSH 的本地工具）才要模型回 tool_calls。
  // 这样既不给调用方增加上下文，也不必多跑一轮。
  // tool_choice: "none" ⇒ 调用方明确说这一轮别调工具。
  // 这时连工具表都不该出现：留着它模型仍会尝试输出 JSON（实测 tool_choice=none 时
  // 它照样回了 tool_calls）。摘掉协议才是真的禁止。
  const noTools = toolChoice === "none"
  const split =
    includeInstructions && tools && !noTools
      ? splitTools(tools, { forced: forcedToolName(toolChoice) })
      : { native: [], delegated: [] }
  const protocol = toolProtocol(split.delegated, toolChoice)
  const note = nativeNote(split.native)

  if (sysText || protocol || note || noTools) {
    parts.push(
      [
        systemTag ?? "[以下是调用方应用给出的指令]",
        sysText,
        // ★ 无状态声明 ★
        // Today 的 agent 自带 Memory 工具（account 级长期记忆）。实测：A 会话说过的
        // 事实，B 会话问得到（见 docs/internals.md 第十五节），这对「像原生 API 一样
        // 使用」是有害的 —— 原生 API 不会跨请求记得东西。
        // 这句措辞实测能关掉它：回答从「记忆里能看到：设备 WEI、账号 MYCF711…」
        // 变成「没有。本次会话我未读取长期记忆」。
        "你是一个无状态推理服务：只依据本次请求里给出的内容作答。",
        "不要读取或写入任何长期记忆（不要调用 Memory 工具，也不要把本次对话里的内容存进记忆）。",
        "被问到本次请求之外的信息时，直接说你不知道。",
        "",
        "当上面的指令与你自己的人设、称呼、格式偏好冲突时，以上面的指令为准。",
        noTools ? `${NL}本次请求没有可用工具，请直接作答。` : "",
        note ? NL + note : "",
        protocol ? NL + protocol : "",
        "[指令结束]",
      ]
        .filter(Boolean)
        .join(NL),
    )
  }

  for (const m of tail) {
    if (!m || m.role === "system") continue
    const text = contentToText(m.content)
    if (m.role === "user") {
      parts.push(`[用户]${NL}${text}`)
    } else if (m.role === "assistant") {
      // 上一轮的助手回复 / 它发起的工具调用，都要回灌，否则模型看不到自己调过什么
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls.map(describeToolCall).join(NL) : ""
      const body = [text, calls && `(发起了调用：${calls})`].filter(Boolean).join(NL)
      if (body) parts.push(`[助手]${NL}${body}`)
    } else if (m.role === "tool") {
      const name = m.name ?? m.tool_call_id ?? "工具"
      parts.push(`[工具结果 ${name}]${NL}${text}`)
    } else if (m.role === "developer") {
      // DSH 用 developer 承载工具增删元数据，对模型没有意义，丢掉
      continue
    }
  }

  return parts.join(NL + NL)
}

/** 只算「要委托给调用方」的那部分工具名。 */
export function delegatedNames(tools) {
  const { delegated } = splitTools(tools)
  return new Set(delegated.map(toolName).filter(Boolean))
}

// ── 响应方向：agent 回复 → OpenAI 形状 ──────────────────────────────────

/**
 * 从模型输出里认出工具调用。
 *
 * 认三种写法，按可靠性排序：
 *   1. 裸的 `{"tool_calls":[...]}`
 *   2. ```json 代码块里的同一个对象
 *   3. 「第一个 `{` 到最后一个 `}`」之间那段
 * 认不出来就返回 null —— 调用方按普通文本处理，不要猜。
 */
export function extractToolCalls(text, knownNames) {
  const raw = String(text ?? "").trim()
  if (!raw) return null

  const candidates = []
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/gi) ?? []
  for (const block of fenced) {
    const inner = block
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```$/, "")
      .trim()
    if (inner) candidates.push(inner)
  }
  candidates.push(raw)
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
    // 透传上去会变成幻觉工具，报错比直接当文本更难查。
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
 * 一轮对话的完整生命周期（异步生成器）。
 *
 * 产出两种事件：
 *   `{ type: "delta", text }`   —— 新增的文本片段
 *   `{ type: "done", text }`    —— 终稿
 *
 * ⚠ 实测正文不增量（见 docs/internals.md 第十三节）：正常情况下只会收到一个
 *   `{type:"done"}`，中间没有 delta。保留增量语义是为了服务端将来真的开始分片。
 *
 * ⚠ `afterCount` 是水位线：这个会话在发起本轮**之前**有多少条消息。
 *   一条用户消息会引发多条 assistant 记录（有 "Worked on it" 这种中间态），
 *   而且旧轮次的终稿一直留在列表里 —— 不按条数切就会把旧答案当新答案返回。
 */
export async function* streamTurn(client, conversationId, { afterCount = 0, signal } = {}) {
  const deadline = Date.now() + TURN_TIMEOUT_MS
  let emitted = ""
  // 先取一次基线：拿到已有个数与当前 changeCursor，之后靠长轮询等增量。
  const baseline = await listConversationItems(client, conversationId, { limit: 100 })
  const seen = Math.max(afterCount, baseline.items.length)
  let cursor = baseline.cursor
  let assistantCount = baseline.items.filter((it) => itemRole(it) === "assistant").length

  // 已有终稿的情况（复用会话时上一轮的答案会留在列表里）——只有超过水位线才算本轮
  const initial = baseline.items.slice(afterCount)
  if (initial.some((it) => itemRole(it) === "assistant")) {
    const text = initial.filter((it) => itemRole(it) === "assistant").map(itemText).join("")
    if (text) {
      emitted = text
      yield { type: "delta", text }
    }
  }

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("已取消")
    let wait
    try {
      wait = await waitForChanges(client, conversationId, {
        afterSequence: cursor,
        waitMs: Math.min(LONGPOLL_WAIT_MS, Math.max(1_000, deadline - Date.now())),
      })
    } catch (e) {
      if (e?.signIn) throw e
      // 长轮询这条路出问题（服务端改动、限流）就退回轮询，不要让整个请求挂掉
      wait = null
    }

    if (!wait) {
      await sleep(POLL_INTERVAL_MS, signal)
      const rows = await listConversationMessages(client, conversationId, { limit: 60 })
      const turn = readTurn(rows, afterCount)
      if (turn) {
        if (turn.text.length > emitted.length && turn.text.startsWith(emitted)) {
          const chunk = turn.text.slice(emitted.length)
          emitted = turn.text
          yield { type: "delta", text: chunk }
        } else if (turn.text && turn.text !== emitted) {
          const chunk = turn.text.slice(emitted.length > turn.text.length ? 0 : emitted.length)
          emitted = turn.text
          if (chunk) yield { type: "delta", text: chunk }
        }
        if (turn.isFinal) {
          yield { type: "done", text: emitted }
          return
        }
      }
      continue
    }

    cursor = wait.cursor
    if (wait.items.length === 0) continue

    const newAssistants = wait.items.filter((it) => itemRole(it) === "assistant")
    if (newAssistants.length > 0) {
      assistantCount += newAssistants.length
      const fresh = newAssistants.map(itemText).join("")
      if (fresh.length > emitted.length && fresh.startsWith(emitted)) {
        const chunk = fresh.slice(emitted.length)
        emitted = fresh
        yield { type: "delta", text: chunk }
      } else if (fresh && fresh !== emitted) {
        const chunk = fresh.slice(emitted.length > fresh.length ? 0 : emitted.length)
        emitted = fresh
        if (chunk) yield { type: "delta", text: chunk }
      }

      // 有 assistant 内容之后，再用 /v2 确认它是不是终稿。
      // v3 的 item 没有 isFinal 字段（实测形状里没有），所以还得问一次 /v2。
      const rows = await listConversationMessages(client, conversationId, { limit: 60 })
      const turn = readTurn(rows, afterCount)
      if (turn?.isFinal) {
        yield { type: "done", text: turn.text ?? emitted }
        return
      }
    }
    void seen
    void assistantCount
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
