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
import { estimateUsage } from "./tokens.mjs"

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
export function nonStreamResponse({ modelId, text, toolCalls, created, promptText, usage }) {
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
          ...(hasTools ? { tool_calls: toOpenAIToolCalls(toolCalls) } : {}),
        },
        finish_reason: hasTools ? "tool_calls" : "stop",
      },
    ],
    usage: usage ?? estimateUsage({ promptText, completionText: content ?? "" }),
  }
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

/** SSE 响应。`source` 是一个异步生成器，产出 `{type:"delta",text}` / `{type:"done",text}`。 */
export function streamResponse({ modelId, source, knownNames, promptText, includeUsage = false, requestBody = {} }) {
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
        let full = ""
        let streamed = ""
        for await (const ev of source) {
          if (ev.type === "delta" && ev.text) {
            full += ev.text
            streamed += ev.text
            frame({ content: ev.text })
          } else if (ev.type === "done") {
            full = ev.text ?? full
          }
        }

        // 工具调用是被「文本协议」模拟的：正文里可能出现那个 JSON。它一次性给全，
        // 所以中途已经当文本流出去了。判定为工具调用时补发 tool_calls 帧，
        // 并把已经流出去的那段正文「收回」—— OpenAI 的语义是 content=null。
        // stop / max_tokens：上游不认，本地落实。
        // ⚠ 流式下正文已经一帧帧发出去了，这里只能影响**收尾的 usage 估算**；
        //   要真正截断得在发帧之前做。所以流式路径的 stop 是"尽力而为"：
        //   上游本来就一次性给全（不增量），因此下面这段实际能拦住绝大多数情况。
        const constrained = constrainOutput(full, requestBody)
        const truncated = constrained !== full
        full = constrained
        const calls = knownNames?.size ? extractToolCalls(full, knownNames) : null
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
            usage: estimateUsage({ promptText, completionText: calls ? "" : full }),
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
