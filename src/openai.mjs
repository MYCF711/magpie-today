// Today · 把一轮 agent 回复写成 OpenAI 的两种形状
//
// magpie 只要求插件返回一个 Response；形状对不对由 `@ai-sdk/openai-compatible` 决定。
// 非流式要 chat.completion，流式要 SSE（每行 `data: {...}`，结尾 `data: [DONE]`）。
//
// ⚠ 流式的分帧要自己造：Today 只在终稿时才给完整正文（实测见 docs/internals.md
//   第十三节），中间态不携带文本。所以这里把拿到的增量直接转成 OpenAI 的 delta，
//   不攒批、不重排 —— 服务端将来真开始分片时不用改这里。
//
// ⚠ usage 是**估算**（上游不回报 token）。见 src/tokens.mjs 的口径说明。

import { argumentsString, extractToolCalls, newCallId } from "./chat.mjs"
import { constrainOutput } from "./params.mjs"
import { parseTemplate, templateToolNames } from "./template.mjs"
import { estimateUsage } from "./tokens.mjs"

/**
 * 把估算用量包装成 OpenAI 的完整形状。
 *
 * DSH 会读 `prompt_tokens_details.cached_tokens`（`getMistralCachedPromptTokens` 那一族函数），
 * 用来算缓存命中的成本。我们报 0 是对的 —— Today 的通道不回报缓存命中，
 * 但**字段必须在**，否则 DSH 那边会当成"未提供"而不是"没命中"。
 */
function fullUsage(u) {
  return {
    ...u,
    prompt_tokens_details: u.prompt_tokens_details ?? { cached_tokens: 0 },
    completion_tokens_details: u.completion_tokens_details ?? { reasoning_tokens: 0 },
  }
}

function id() {
  return `chatcmpl-${Math.random().toString(36).slice(2, 12)}`
}

/** 工具调用 → OpenAI 的 tool_calls 数组。 */
function toOpenAIToolCalls(calls) {
  return calls.map((c) => ({
    id: newCallId(),
    type: "function",
    function: { name: c.name, arguments: argumentsString(c.arguments) },
  }))
}

/** 非流式响应。 */
export function nonStreamResponse({ modelId, text, toolCalls, created, promptText, usage, agentToolCalls, reasoning, debugTools }) {
  const hasTools = Array.isArray(toolCalls) && toolCalls.length > 0
  const content = hasTools ? (text ? text : null) : (text ?? "")
  const payload = {
    id: id(),
    object: "chat.completion",
    created: created ?? Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          // 纯工具调用时 content 必须是 null（OpenAI 规范），不能是空串
          content,
          // ★ 思考过程 ★ DSH 认这三个字段之一（推理见 src/reasoning.mjs 顶部注释）
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(hasTools ? { tool_calls: toOpenAIToolCalls(toolCalls) } : {}),
        },
        finish_reason: hasTools ? "tool_calls" : "stop",
      },
    ],
    usage: fullUsage(usage ?? estimateUsage({ promptText, completionText: content ?? "" })),
    ...(debugTools !== undefined ? { today_debug_tools: debugTools } : {}),
    // ★ 它自己执行过的工具调用（不是"请求你执行"）★
    //
    // 别和 `message.tool_calls` 混：那个的语义是「调用方去执行，然后把结果回灌」。
    // 这里的调用**已经在服务端跑完了**，调用方只需展示，不需要执行。
    // 混用会让 DSH 以为要它去跑一个已经跑完的工具，那是错误的行为。
    ...(Array.isArray(agentToolCalls) && agentToolCalls.length
      ? { today_agent_tool_calls: agentToolCalls }
      : {}),
  }
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

/** SSE 响应。`source` 是一个异步生成器，产出 `{type:"delta",text}` / `{type:"done",text}`。 */
export function streamResponse({ modelId, source, knownNames, promptText, includeUsage = false, requestBody = {}, onDone, tools = [], receivedTools }) {
  const created = Math.floor(Date.now() / 1000)
  const responseId = id()
  const encoder = new TextEncoder()

  const body = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
      const frame = (delta, finish = null) =>
        send({
          id: responseId,
          object: "chat.completion.chunk",
          created,
          model: modelId,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })

      // 首帧只播角色，跟 OpenAI 一致
      frame({ role: "assistant", content: "" })

      try {
        // ⚠ 先攒、后发，不要边收边发。
        //
        // 原因：`stop` / `max_tokens` 是插件侧实现的（上游不收这两个字段），
        // 而流式一旦把正文帧发出去了就收不回来 —— 截断就成了空话。
        // 上游本来也不吐增量（实测见 docs/internals.md 第十三节：只在一帧里给全），
        // 所以「攒着」在当前通道上零损失；等它将来真开始分片，再按停止序列边界做增量截断。
        let full = ""
        for await (const ev of source) {
          if (ev.type === "delta" && ev.text) {
            full += ev.text
          } else if (ev.type === "done") {
            full = ev.text ?? full
            if (typeof onDone === "function") onDone(ev)
          }
        }
        const streamed = ""

        // 工具调用是被「文本协议」模拟的：正文里可能出现那个 JSON。它一次性给全，
        // 所以中途已经当文本流出去了。判定为工具调用时补发 tool_calls 帧，
        // 并把已经流出去的那段正文「收回」—— OpenAI 的语义是 content=null。
        // stop / max_tokens：上游不认，本地落实。
        // ★ 模板解析：一次拿到 reasoning / content / tool_calls ★
        //
        // 注意流式现在是「先攒后发」（上游本来也不吐增量），所以 stop / max_tokens
        // 能在这里真正生效 —— 正文还没发出去，截断不是空话。
        const parsed = parseTemplate(full, templateToolNames(tools))
        const constrained = constrainOutput(parsed.content || (parsed.kind === "raw" ? full : ""), requestBody)
        const calls = parsed.toolCalls ?? (knownNames?.size ? extractToolCalls(constrained, knownNames) : null)

        // ★ 思考过程：单独一个块 ★
        //
        // DSH 的解析器把 thinking 当成**独立的 content block**
        // （thinking_start → thinking_delta → thinking_end），而 OpenAI-completions 路径
        // 从 `delta.reasoning_content` 读它。所以：
        //   · 不能和正文混在同一帧（会被当正文）
        //   · 先发只有 reasoning 的帧，再发只有 content 的帧
        // DSH 的 openai-completions 解析器认两种形态：
        //   ① `delta.reasoning_content`（OpenAI 兼容社区惯例）
        //   ② `delta.content: [{type:"thinking",...}, {type:"text",...}]`（它自己的 content-block 协议）
        // 两个都发会重复；这里选 ①（更通用），并在注释里记下 ② 的存在。
        // 若将来发现有客户端只认 ②，把下面这行换成数组形式即可。
        if (parsed.reasoning) {
          frame({ reasoning_content: parsed.reasoning })
        }

        // 正文在确认过截断之后才发。判定是工具调用时不发正文（OpenAI 的 content 为 null）。
        if (!calls && constrained) frame({ content: constrained })
        if (calls) {
          const openai = toOpenAIToolCalls(calls)
          openai.forEach((tc, i) => {
            frame({
              tool_calls: [
                {
                  index: i,
                  id: tc.id,
                  type: "function",
                  function: { name: tc.function.name, arguments: tc.function.arguments },
                },
              ],
            })
          })
          frame({}, "tool_calls")
        } else {
          // 截断过 → finish_reason 应该是 "stop"（OpenAI 在命中 stop 序列时也用 stop，
          // 只有撞 max_tokens 才是 length）。这里不细分，如实给 stop。
          frame({}, "stop")
        }

        // 用量帧：OpenAI 只在 stream_options.include_usage 时才发，形状是 choices 为空。
        // 不发就不用发 —— 但发了必须按规范发，否则客户端会把 choices:[] 当成异常。
        if (includeUsage) {
          send({
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [],
            usage: fullUsage(estimateUsage({ promptText, completionText: calls ? "" : full })),
            ...(receivedTools !== undefined ? { today_debug_tools: receivedTools } : {}),
          })
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        void streamed
      } catch (e) {
        send({ error: { type: "api_error", message: String(e?.message ?? e) } })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  })
}

/** 出错的响应，形状照 OpenAI。 */
export function errorResponse(status, message, type = "api_error") {
  return new Response(JSON.stringify({ error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  })
}
