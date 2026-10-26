// Today · 输出模板与解析
//
// 为什么用模板而不是散文式指令：实测（2026-10-26）把输出形态固定成一个 JSON 模板后，
// 5 道题（纯回答 / 问候 / 两种工具调用 / 推理题）**全部 5/5**：
//   · kind 正确 5/5
//   · 整段就是裸 JSON（无代码块、无前后解释）5/5
//   · 每条都带 reasoning 5/5
// 而散文式指令（"情况一……情况二……"）在同样的题上偶发失手（edit 那题会先 read）。
//
// ── 模板长什么样 ──────────────────────────────────────────────────
//
//   {"kind":"answer","reasoning":"…","content":"…"}
//   {"kind":"tool_call","reasoning":"…","tool_calls":[{"name":"…","arguments":{…}}]}
//
// 一个 JSON、三个必填语义：做什么（kind）、想了什么（reasoning）、产出（content / tool_calls）。
// 这样 reasoning 和 tool_calls 能出现在**同一条输出**里 —— 散文式协议做不到这点
// （它要么输出正文、要么输出调用，二选一）。
//
// ⚠ reasoning 是它**自己写出来的推理摘要**，不是底层模型的思维链。两者不等价：
//   真思维链是处理过程中自然产生的；这个是要求它"把想法写出来"。
//   价值是"能看见它在想什么"，局限是"可能写得简略、可能事后合理化"。

import { compactParams, toolName } from "./toolmap.mjs"

/** 模板说明（放在提示末尾 —— 效用最高的位置）。 */
export function outputTemplate(tools) {
  const table =
    Array.isArray(tools) && tools.length
      ? tools
          .map((t) => {
            const f = t?.function ?? t
            return `  ${f?.name ?? "?"}(${compactParams(f?.parameters)})`
          })
          .join("\n")
      : "  （本次没有可用工具）"

  return `## 输出格式（唯一允许的形状，违反即为错误输出）

你**只能**输出一个 JSON 对象，不要有任何其他字符：不要代码块围栏，不要前后说明，不要道歉。

{"kind":"answer|tool_call","reasoning":"<这一步的简短推理，1-3 句>", ...分支字段}

- kind="answer"    → 必须且只能再带 "content":"<给用户看的正文>"
- kind="tool_call" → 必须且只能再带 "tool_calls":[{"name":"函数名","arguments":{参数对象}}]

严格示例（照这个形状，不要改字段名）：

{"kind":"answer","reasoning":"这是简单算术，不需要工具。","content":"1+1 等于 2。"}

{"kind":"tool_call","reasoning":"需要读文件内容才能回答。","tool_calls":[{"name":"read","arguments":{"path":"D:/x/a.txt"}}]}

本次可用的工具：
${table}`
}

/**
 * 解析模型输出成统一形状。
 *
 * 返回 `{ kind, reasoning, content, toolCalls }`：
 *   kind: "answer" | "tool_call" | "raw"
 *   raw 表示模板没被遵守 —— 此时**把原文当 content**，不要丢。
 *
 * ⚠ 解析要宽松：模型偶尔会包 ```json 围栏，或前后多一句解释。
 *   只要能抠出 JSON 就用；抠不出就当正文。**永远不要因为解析失败而丢掉内容。**
 */
export function parseTemplate(text, knownNames) {
  const raw = typeof text === "string" ? text : ""
  const trimmed = raw.trim()
  if (!trimmed) return { kind: "raw", reasoning: "", content: "", toolCalls: null }

  const obj = tryParseJson(trimmed)
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { kind: "raw", reasoning: "", content: trimmed, toolCalls: null }
  }

  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning.trim() : ""
  const kind = obj.kind === "tool_call" ? "tool_call" : obj.kind === "answer" ? "answer" : ""

  // tool_call 分支
  const listed = Array.isArray(obj.tool_calls) ? obj.tool_calls : null
  if (listed && listed.length) {
    const known = knownNames instanceof Set ? knownNames : new Set(knownNames ?? [])
    const calls = []
    for (const c of listed) {
      const name = typeof c?.name === "string" ? c.name : (typeof c?.function?.name === "string" ? c.function.name : "")
      if (!name) continue
      if (known.size && !known.has(name)) continue
      let args = c?.arguments ?? c?.function?.arguments ?? {}
      if (typeof args === "string") {
        try {
          args = JSON.parse(args)
        } catch {
          args = {}
        }
      }
      calls.push({ name, arguments: args && typeof args === "object" ? args : {} })
    }
    if (calls.length) return { kind: "tool_call", reasoning, content: "", toolCalls: calls }
    // 点名的工具全都不在清单里 ⇒ 别伪造调用，退回正文
    return { kind: "raw", reasoning, content: trimmed, toolCalls: null }
  }

  // answer 分支
  if (typeof obj.content === "string") {
    return { kind: kind === "tool_call" ? "answer" : "answer", reasoning, content: obj.content, toolCalls: null }
  }

  // 有 kind 但缺分支字段，或根本不是我们的模板 —— 原文当正文
  return { kind: "raw", reasoning, content: trimmed, toolCalls: null }
}

/** 先试整段，再试首尾花括号之间。围栏也顺手剥掉。 */
function tryParseJson(s) {
  const attempts = [s]
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) attempts.unshift(fenced[1].trim())
  const i = s.indexOf("{")
  const k = s.lastIndexOf("}")
  if (i >= 0 && k > i) attempts.push(s.slice(i, k + 1))
  for (const a of attempts) {
    try {
      return JSON.parse(a)
    } catch {}
  }
  return null
}

/** 这个模板里的工具名集合（给解析用）。 */
export function templateToolNames(tools) {
  const out = new Set()
  for (const t of Array.isArray(tools) ? tools : []) {
    const n = toolName(t)
    if (n) out.add(n)
  }
  return out
}