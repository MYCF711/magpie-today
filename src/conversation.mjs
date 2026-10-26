// Today · 会话（conversation）管理
//
// ⚠ 这是本项目最容易搞错的地方，先读完再改。
//
// ── 走过的弯路（都实测过，别再走一遍）────────���───────────────────────────
//
// ① 以为 `POST /v1/messages` 的 body 里带 `threadId` 就能续同一个 thread。
//    **不能**：服务端会忽略它，每次都新建一个 thread。实测两轮返回的 threadId 不同。
//
// ② 因为 ①，我一度以为「复用 thread 所以服务端记得上文」成立。
//    那个"记得"是真的，但原因不是复用 thread —— 而是**所有 thread 都属于同一个
//    conversation（账号的 Main Chat）**，上下文是**会话级**的。
//    后果很严重：插件里任何两个不相关的请求会互相看见对方的内容。
//
// ③ 正确的做法是 `POST /v3/conversations` 预定一个**全新且隔离**的 conversation：
//
//      POST /v3/conversations
//        headers: { Idempotency-Key: <唯一串> }     ← 必须
//        body:    <不发>                            ← 发了就 400
//      → 200 { data: { conversation: { conversationId, expiresAt } } }
//
//    然后往这个会话里发消息：
//
//      POST /v3/messages
//        body: { conversationId, clientMessageId, bodyType: "text", body: { text } }
//      → 200 { data: { message: { messageId, conversationId, threadId, … } } }
//
//    读回复：
//
//      GET /v2/messages?conversationId=<id>&limit=40   ← 按时间正序、含全部历史
//
// 实测（2026-10-26）：两个不同 conversation 之间互不可见（用随机串验证，
// B 明确答「没有」）；同一 conversation 内第二轮只发增量就能答对上一轮的内容。
//
// ⚠ 有一条**已知的跨会话泄漏源**，不是本模块能解决的：Today 的 agent 自带
//   `Memory` 工具，会把对话里的事实写进 account 级记忆，别的会话读得到。
//   实测：A 说「我喜欢的颜色是靛蓝」，B 能答出「靛蓝（见 about-user/preferences.md）」；
//   但换成随机串就不行。⇒ 是记忆工具，不是上下文泄漏。
//   要彻底断掉得在提示里禁止它写记忆 —— 见 docs/internals.md 第十五节。

const IDEMPOTENCY = () => `magpie-${crypto.randomUUID()}`

/**
 * 预定一个隔离的会话。
 *
 * @returns {Promise<{conversationId: string, expiresAt?: string}>}
 */
export async function createConversation(client) {
  const res = await client.request("/v3/conversations", {
    method: "POST",
    headers: { "Idempotency-Key": IDEMPOTENCY() },
    // 不要传 body：传 `{}` 也会 400（服务端把空对象当成非法入参）
    timeout: 20_000,
    // 幂等（Idempotency-Key）⇒ 可以重试。上游 5xx 是偶发的。
    retry: { attempts: 3, delayMs: 500 },
  })
  if (!res.ok) {
    const err = new Error(`创建会话失败：HTTP ${res.status} ${JSON.stringify(res.json ?? res.text).slice(0, 160)}`)
    err.status = res.status
    throw err
  }
  const conv = res.json?.data?.conversation
  if (!conv?.conversationId) {
    throw new Error("创建会话失败：响应里没有 conversationId")
  }
  return { conversationId: conv.conversationId, expiresAt: conv.expiresAt }
}

/**
 * 往指定会话追加一条用户消息。
 *
 * ⚠ 有附件时必须走 `/v1/messages`，不能用 `/v3/messages`：
 *   v3 的 body schema 是 `bodyType: enum(["text"])` + `body: { text }`，
 *   **装不下 attachments**。而 `/v1/messages` 的 schema 里同时有 `conversationId`
 *   与 `attachments` —— 实测（2026-10-26）用它投进 v3 建的会话完全可行，
 *   图片也真的被模型看见（发上红下绿的图，答「红、绿」）。
 *
 * @param {object[]} [attachments] 要随这条消息一起发出去的文件引用
 * @returns {Promise<{threadId: string, messageId: string}>}
 */
export async function sendToConversation(client, conversationId, text, { attachments } = {}) {
  const clientMessageId = `tc:magpie-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
  const hasFiles = Array.isArray(attachments) && attachments.length > 0
  const res = hasFiles
    ? await client.request("/v1/messages", {
        method: "POST",
        timeout: 90_000,
        body: {
          conversationId,
          content: text,
          messageType: "text",
          clientMessageId,
          attachments,
        },
        retry: { attempts: 3, delayMs: 500 },
      })
    : await client.request("/v3/messages", {
        method: "POST",
        timeout: 60_000,
        body: { conversationId, clientMessageId, bodyType: "text", body: { text } },
        // clientMessageId 就是去重键（响应里有 isDuplicate），重发不会产生两条。
        retry: { attempts: 3, delayMs: 500 },
      })
  if (!res.ok) {
    const err = new Error(`发送失败：HTTP ${res.status} ${JSON.stringify(res.json ?? res.text).slice(0, 160)}`)
    err.status = res.status
    err.payload = res.json ?? res.text
    throw err
  }
  const msg = res.json?.data?.message
  return {
    threadId: msg?.threadId ?? res.json?.threadId ?? "",
    messageId: msg?.messageId ?? res.json?.messageId ?? "",
  }
}

/**
 * 读一个会话的全部消息（按时间正序）。
 *
 * `limit` 上限 100；超出的场景（长对话）目前不翻页 —— Today 的对话一般不会到那儿，
 * 真到了会先撞上上游的载荷上限（见 constants.mjs 的矩阵）。
 */
export async function listConversationMessages(client, conversationId, { limit = 60 } = {}) {
  const res = await client.request(
    `/v2/messages?conversationId=${encodeURIComponent(conversationId)}&limit=${limit}`,
    { timeout: 30_000, retry: { attempts: 2, delayMs: 400 } },
  )
  if (res.status === 401 || res.status === 403) {
    const err = new Error("登录已失效")
    err.signIn = "expired"
    throw err
  }
  if (!res.ok) {
    const err = new Error(`读会话失败：HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.json?.data ?? []
}

/**
 * 从一页消息里取「第 `afterCount` 条之后那一轮」的终稿。
 *
 * ⚠ 必须按**条数**切，不能只取最后一条 assistant：
 *   一条用户消息会引发多条 assistant 记录（实测有 `"Worked on it"` 这种中间态），
 *   而且上一轮的终稿一直留在列表里 —— 只看 last 会把旧答案当成新答案。
 *
 * @returns {{text: string, isFinal: boolean, count: number} | null}
 */
export function readTurn(rows, afterCount) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length <= afterCount) return null
  const tail = list.slice(afterCount)
  const hasUser = tail.some((m) => m?.role === "user")
  if (!hasUser) return null
  const assistants = tail.filter((m) => m?.role === "assistant")
  if (assistants.length === 0) return null
  // 终稿取最后一条 isFinal 的；正文只拼 `messageType === "text"` 的 part。
  //
  // ⚠ 一条 assistant 消息里除了正文还有**进度气泡**：`messageType === "turn"`，
  //   content 形如 `{"text":["Searched the web"],"toolCallStatus":"completed","toolCalls":[…]}`。
  //   把它拼进来，用户会看到 "Searching the webSearched the web1 web page3.15.2" 这种垃圾。
  //   实测（2026-10-26）：正文永远是 messageType=text，气泡永远是 turn。
  const finals = assistants.filter((m) => m.isFinal === true)
  const pick = finals.length ? finals[finals.length - 1] : assistants[assistants.length - 1]
  const parts = pick.messages ?? []
  const text = parts
    .filter((p) => (p?.messageType ?? "text") === "text")
    .map((p) => (typeof p?.content?.text === "string" ? p.content.text : ""))
    .join("")
  // ★ 它自己做过的事：把工具调用记录摘出来 ★
  //
  // ⚠ 两个容易踩错的地方（我都踩过）：
  //   1. `messageType: "turn"` 的 part 有两种，别一刀切当气泡丢掉：
  //      · 有 `toolCalls` 数组 → **真实的工具调用**，带 toolName / toolCallId / status / durationMs
  //      · 没有 → 纯进度文案（`text: ["Searched the web"]`），这种才该丢
  //   2. **工具调用是独立的一条 assistant 消息**，不和正文在同一个 `messages[]` 里。
  //      只取最后一条 assistant（正文那条）会漏掉它 —— 必须扫本轮**所有** assistant 消息。
  //
  // 直接问过它本人（2026-10-26）：「我发出的工具调用本身是结构化的 —— 工具名 + 参数（JSON 对象）」
  const toolCalls = []
  for (const m of tail) {
    if (m?.role !== "assistant") continue
    for (const p of m.messages ?? []) {
      const calls = p?.content?.toolCalls
      if (!Array.isArray(calls)) continue
      for (const c of calls) {
        if (!c?.toolName) continue
        toolCalls.push({
          toolName: String(c.toolName),
          toolCallId: c.toolCallId ? String(c.toolCallId) : undefined,
          status: c.status ? String(c.status) : undefined,
          durationMs: Number.isFinite(Number(c.durationMs)) ? Number(c.durationMs) : undefined,
        })
      }
    }
  }
  return { text, isFinal: pick.isFinal === true, count: list.length, toolCalls }
}

/** 消息条数（用于记水位线）。 */
export function messageCount(rows) {
  return Array.isArray(rows) ? rows.length : 0
}

/**
 * 长轮询等新消息（`waitMs` 实测会真的挂住 —— 空闲 8 秒的请求确实等满了 8 秒）。
 *
 * 这条是替代「每 250ms 发一次 GET」的关键：一次请求挂 20 秒，
 * 上游一有变化就立刻回来，没有变化就等到超时再发下一次。
 *
 * 返回 `{ items, cursor, highWatermark }`。`items` 里的东西**不是** /v2/messages 的形状：
 * 是 v3 的 canonical item（`body.content.parts[].text`、`role`、`sequence`）。
 *
 * ⚠ 参数名是 `afterSequence`，从 0 开始。漏掉它直接 400。
 */
export async function waitForChanges(client, conversationId, { afterSequence = 0, waitMs = 25_000, limit = 50 } = {}) {
  const res = await client.request(
    `/v3/conversations/${encodeURIComponent(conversationId)}/message-changes` +
      `?afterSequence=${afterSequence}&limit=${limit}&waitMs=${waitMs}`,
    // 长轮询本来就要挂 waitMs，重试一次最多再加一个 waitMs；给 2 次而不是 3 次，
    // 免得一次抖动把整轮拖到分钟级。streamTurn 里还有"失败就退回普通轮询"的兜底。
    { timeout: waitMs + 15_000, retry: { attempts: 2, delayMs: 300 } },
  )
  if (res.status === 401 || res.status === 403) {
    const err = new Error("登录已失效")
    err.signIn = "expired"
    throw err
  }
  if (!res.ok) {
    const err = new Error(`长轮询失败：HTTP ${res.status} ${JSON.stringify(res.json ?? res.text).slice(0, 160)}`)
    err.status = res.status
    throw err
  }
  const data = res.json?.data ?? {}
  return {
    items: Array.isArray(data.items) ? data.items : [],
    cursor: Number(data.sync?.changeCursor ?? afterSequence),
    highWatermark: Number(data.sync?.highWatermark ?? 0),
  }
}

/**
 * v3 item 的正文。
 *
 * ⚠ 只取 `type === "text"` 的 part：其余（`structured` 之类的反应/气泡）不是正文。
 * 实测 v3 会把进度气泡整条过滤掉（直接不出现），但正文仍要按 type 判。
 */
export function itemText(item) {
  const parts = item?.body?.content?.parts
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((p) => (p?.type ?? "text") === "text")
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("")
}

/** v3 item 的角色。 */
export function itemRole(item) {
  const r = item?.body?.content?.role ?? item?.role
  return typeof r === "string" ? r : ""
}

/** v3 的列表接口（`/messages`、`/message-changes`）的分页形状，转成和 /v2 一致的用法。 */
export async function listConversationItems(client, conversationId, { limit = 50 } = {}) {
  const res = await client.request(
    `/v3/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}`,
    { timeout: 30_000 },
  )
  if (!res.ok) {
    const err = new Error(`读会话失败：HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  const data = res.json?.data ?? {}
  return {
    items: Array.isArray(data.items) ? data.items : [],
    cursor: Number(data.sync?.changeCursor ?? 0),
  }
}
