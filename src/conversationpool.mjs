// Today · 会话池（每个调用方对话一个隔离的 Today conversation）
//
// 解决的问题：让「多轮对话」像原生 API 一样又快又互不串味。
//
// ── 为什么不是 thread ─────────────────────────────────────────────────
//
// 一开始我按 thread 做复用，结论是错的 —— `POST /v1/messages` 忽略 body.threadId，
// 每次投递都新建 thread。而所有 thread 都属于**同一个 conversation（账号 Main Chat）**，
// 上下文是会话级的，于是插件里两个不相关的请求会互相看见。
//
// 正确做法是 `/v3/conversations`（见 src/conversation.mjs）：每次预定一个**隔离**的会话。
//
// ── 池子怎么用 ───────────────────────────────────────────────────────
//
//   head  = 指纹(模型 + 工具清单 + 系统提示词 + 第一条用户消息)   ← 钉住"这是哪个对话"
//   sent  = 这个 Today 会话已经收到多少条消息（水位线）
//
//   命中条件：head 相同、请求比会话知道的多、且会话知道的那段消息没被改写
//   命中后：  只把多出来的那几条发过去
//
// 这样「模型调工具 → 回结果 → 再问」也能续上：那个回合的消息序列是
// [.., assistant(tool_calls), tool(result)]，比上一轮长，水位线自然推进。
//
// ⚠ 同一个会话上不能并发投递（会串线），所以每个会话一把锁。
// ⚠ 前缀必须校验：调用方可能编辑/重试/截断历史，那时只能新开一个会话。

import { createHash } from "node:crypto"

/** 会话空闲多久后回收。回收只是忘掉映射；Today 那边的会话过期时间见 expiresAt。 */
const IDLE_MS = 30 * 60_000
/** 最多留多少个对话。多了按最久未用淘汰。 */
const MAX_ENTRIES = 32

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`
}

/** 一条消息在指纹里的形状 —— 只取影响服务端理解的字段。 */
function messageShape(m) {
  const content = typeof m?.content === "string" ? m.content : canonical(m?.content ?? "")
  return {
    role: String(m?.role ?? ""),
    content,
    ...(Array.isArray(m?.tool_calls)
      ? {
          calls: m.tool_calls.map((c) => ({
            name: c?.function?.name ?? c?.name ?? "",
            args:
              typeof c?.function?.arguments === "string"
                ? c.function.arguments
                : canonical(c?.function?.arguments ?? c?.arguments ?? ""),
          })),
        }
      : {}),
    ...(m?.tool_call_id ? { callId: String(m.tool_call_id) } : {}),
    ...(m?.name ? { name: String(m.name) } : {}),
  }
}

function digest(items) {
  return createHash("sha1").update(canonical(items)).digest("hex")
}

/** 任意消息序列的指纹（测试与调试用）。 */
export function historyFingerprint(messages) {
  return digest((messages ?? []).map(messageShape))
}

/**
 * 对话头：模型 + 工具清单 + 系统提示词 + 第一条用户消息。
 *
 * 这四个都掺进来是因为它们任一改变，Today 那边会话的语义就不对了：
 * 换了模型或工具表，历史对话里的"约定"可能不再适用。
 */
export function conversationHead(messages, { model = "", tools = [] } = {}) {
  const list = Array.isArray(messages) ? messages : []
  const sys = list
    .filter((m) => m?.role === "system")
    .map((m) => messageShape(m).content)
    .join("\n")
  const firstUser = list.find((m) => m?.role === "user")
  return digest([
    { model: String(model) },
    { tools: (Array.isArray(tools) ? tools : []).map((t) => t?.function?.name ?? t?.name ?? "").sort() },
    { sys },
    firstUser ? messageShape(firstUser) : null,
  ])
}

export function createConversationPool({ idleMs = IDLE_MS, max = MAX_ENTRIES } = {}) {
  /** head → { conversationId, sent, prefixHash, usedAt } */
  const entries = new Map()
  /** conversationId → 队尾 promise */
  const locks = new Map()
  const now = () => Date.now()

  function evict() {
    if (entries.size <= max) return
    const sorted = [...entries.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)
    for (const [k] of sorted.slice(0, entries.size - max)) entries.delete(k)
  }

  /**
   * 找一个能续用的 Today 会话。
   *
   * 返回 `{ conversationId, sent, release }`，或 null（需要新建）。
   */
  async function acquire(head, messages) {
    const e = entries.get(head)
    if (!e) return null
    if (now() - e.usedAt > idleMs) {
      entries.delete(head)
      return null
    }
    const list = Array.isArray(messages) ? messages : []
    if (list.length <= e.sent) return null
    // 前缀必须原样：调用方可能编辑/重试/截断过历史
    if (digest(list.slice(0, e.sent).map(messageShape)) !== e.prefixHash) {
      entries.delete(head)
      return null
    }

    const cid = e.conversationId
    const prev = locks.get(cid) ?? Promise.resolve()
    let release
    const gate = new Promise((r) => (release = r))
    locks.set(
      cid,
      prev.then(() => gate).catch(() => gate),
    )
    await prev.catch(() => {})
    e.usedAt = now()
    let done = false
    return {
      conversationId: cid,
      sent: e.sent,
      release: () => {
        if (done) return
        done = true
        release()
        locks.delete(cid)
      },
    }
  }

  /**
   * 登记水位线。**只在投递成功之后调用** —— 失败时服务端没收到，不能算它知道。
   */
  function remember(head, conversationId, messages) {
    const list = Array.isArray(messages) ? messages : []
    const entry = entries.get(head)
    if (entry && entry.conversationId === conversationId && list.length <= entry.sent) {
      entry.usedAt = now()
      return
    }
    entries.set(head, {
      conversationId,
      sent: list.length,
      prefixHash: digest(list.map(messageShape)),
      usedAt: now(),
    })
    evict()
  }

  /** 一个会话废了（超时/报错/过期）—— 把所有指向它的映射删掉。 */
  function forgetConversation(conversationId) {
    for (const [k, v] of [...entries.entries()]) {
      if (v.conversationId === conversationId) entries.delete(k)
    }
  }

  return {
    acquire,
    remember,
    forgetConversation,
    find: (head) => entries.get(head) ?? null,
    get size() {
      return entries.size
    },
    _entries: entries,
  }
}
/**
 * 和 `conversationHead` 同形状的「核心头」：**只含 persona + 规则，不含技能目录**。
 *
 * 为什么需要它：`conversationHead` 把整个 system 拼进键里。而客户端每次注入的系统提示词
 * 含**技能目录**（本机实测 16 个技能 ≈ 4769 字符），装一个技能它就会变 ⇒ 键变 ⇒
 * 会话被判定为不匹配 ⇒ **换新会话、整段历史全量重发**（20 轮 × 2000 字符 = 4 万字符白烧）。
 *
 * 所以会话复用改用这个键：技能目录变化不影响复用，历史照旧续着走。
 *
 * ⚠ 代价：技能目录不同时也可能复用同一个会话，于是模型看到的技能目录是**第一次那版**。
 *   这对「文档工作流」影响很小（技能只是流程提示），但要知道这个折中：
 *   **复用优先，技能目录的新鲜度让位。** 真要换技能目录生效，重启会话即可。
 */
export function coreHead(messages, { model = "", tools = [] } = {}) {
  const list = Array.isArray(messages) ? messages : []
  const sys = list
    .filter((m) => m?.role === "system")
    .map((m) => stripSkillSection(messageShape(m).content))
    .join("\n")
  const firstUser = list.find((m) => m?.role === "user")
  return digest([
    { model: String(model) },
    { tools: (Array.isArray(tools) ? tools : []).map((t) => t?.function?.name ?? t?.name ?? "").sort() },
    { sys },
    firstUser ? messageShape(firstUser) : null,
  ])
}

/**
 * 从系统提示词里剥掉「技能目录」那一段。
 *
 * 认两类形状（客户端常见写法）：
 *   · `## 技能` / `# Skills` 起头的那一节，删到下一个同级或更高级标题为止
 *   · `<skills>…</skills>` 这类标签包起来的块
 *
 * ⚠ 剥不掉就原样返回 —— 宁可键不稳（回到旧行为），也不要误删规则段落。
 */
export function stripSkillSection(text) {
  const s = typeof text === "string" ? text : ""
  if (!s) return s

  // 标签形式
  let out = s.replace(/<(skills?|available_skills)>[\s\S]*?<\/\1>/gi, "")

  // 标题形式：找含「技能」或 Skills 的标题，删到下一个同级或更高级标题
  const lines = out.split("\n")
  const kept = []
  let skipping = false
  let skipLevel = 0
  for (const line of lines) {
    const m = /^(#{1,3})\s+(.*)$/.exec(line)
    if (m) {
      const level = m[1].length
      if (skipping && level <= skipLevel) skipping = false
      if (/技能|skills?\b/i.test(m[2])) {
        skipping = true
        skipLevel = level
        continue
      }
    }
    if (!skipping) kept.push(line)
  }
  return kept.join("\n")
}
