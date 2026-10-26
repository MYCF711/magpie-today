// Today · 把一轮 agent 回复写成 OpenAI 的两种形状
//
// magpie 只要求插件返回一个 Response；形状对不对由 `@ai-sdk/openai-compatible` 决定。
// 非流式要 chat.completion，流式要 SSE（每行 `data: {...}`，结尾 `data: [DONE]`）。
//
// ⚠ 流式的分帧要自己造：Today 只在终稿时才给完整正文，中间态只是长度增长。
//   所以这里把增量直接转成 OpenAI 的 delta，不攒批、不重排。

import { argumentsString, newCallId } from "./chat.mjs"

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
export function nonStreamResponse({ modelId, text, toolCalls, created }) {
  const hasTools = Array.isArray(toolCalls) && toolCalls.length > 0
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
          content: hasTools ? (text ? text : null) : (text ?? ""),
          ...(hasTools ? { tool_calls: toOpenAIToolCalls(toolCalls) } : {}),
        },
        finish_reason: hasTools ? "tool_calls" : "stop",
      },
    ],
    // agent 通道不回报 token 用量。给 0 而不是编一个数：
    // 编出来的数字会被上层当真，0 至少不会被拿去算钱。
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

/** SSE 响应。`source` 是一个异步生成器，产出 `{type:"delta",text}` / `{type:"done",text}`。 */
export function streamResponse({ modelId, source, knownNames }) {
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
        for await (const ev of source) {
          if (ev.type === "delta" && ev.text) {
            // 工具调用是被「文本协议」模拟的：正文里可能出现那个 JSON。
            // 但它只在最后一次性给全，所以中途照常当文本流出去；
            // 到 done 时若判定为工具调用，再补发 tool_calls 帧。
            full += ev.text
            frame({ content: ev.text })
          } else if (ev.type === "done") {
            full = ev.text ?? full
          }
        }

        const { extractToolCalls } = await import("./chat.mjs")
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
          frame({}, "stop")
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
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
