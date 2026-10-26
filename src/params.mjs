// Today · 采样参数与输出约束的本地实现
//
// 背景：Today 的 agent 通道**不接收** OpenAI 的采样参数。实测（2026-10-26）把
// `temperature` / `max_tokens` / `n` / `stop` / `response_format` 放进请求体，
// 五个全都 200、模型行为一字不变 —— 上层 body 里没有这些字段，和 `tools` 一样被
// schema 丢掉（见 docs/internals.md 第九节）。
//
// 但调用方会真的用它们。所以这里分两类处理：
//
//   **能本地做到的** —— 在插件侧实现，让调用方看到的行为与原生 API 一致：
//     · `response_format`  → 写进提示（实测有效：加一句「只输出 JSON」就拿到纯 JSON）
//     · `stop`             → 正文里出现停止序列就地截断
//     · `max_tokens`       → 按估算的 token 数截断（⚠ 是估算，不是精确计数）
//
//   **本地做不到的** —— 如实忽略，但**不假装生效**：
//     · `temperature` / `top_p` / `seed` —— agent 侧不接受，我们也不谎称控制了它
//     · `n > 1`             —— 一次调用只产生一条回复（要 n 条就得发 n 轮，费钱且慢）
//
// 「不假装生效」很重要：如果调用方以为 temperature=0 就得到了确定性输出，它会据此做出
// 错误的工程假设。宁可让它知道这个参数在这条通道上无效。

import { estimateTokens } from "./tokens.mjs"

/** 调用方给了但我们控制不了、也不该假装生效的参数。 */
export const IGNORED_PARAMS = ["temperature", "top_p", "top_k", "seed", "presence_penalty", "frequency_penalty", "logit_bias", "logprobs"]

/** 这些参数被要求了，但只能近似实现。用于告诉调用方真相。 */
export function unsupportedNotes(body) {
  const notes = []
  for (const k of IGNORED_PARAMS) {
    if (body?.[k] !== undefined) notes.push(k)
  }
  if (Number(body?.n) > 1) notes.push(`n=${body.n}（只返回 1 条）`)
  return notes
}

/**
 * `response_format` → 一段要加进提示的要求。
 *
 * 实测：不加这句时它会给 ```json 围栏加一段解释；加了就只给裸 JSON。
 * `json_schema` 把 schema 也写进去，比只说"输出 JSON"稳。
 */
export function responseFormatInstruction(responseFormat) {
  const type = responseFormat?.type
  if (type === "json_object") {
    // ⚠ 不要另起一套「只输出 JSON」的规则 —— 那会和末尾的输出契约冲突
    //   （契约允许 kind="answer" 时输出纯文本正文）。
    //   正确做法是**约束 content 字段的内容**，形状仍由末尾的契约管。
    return [
      "## 关于正文内容",
      "",
      "本次调用方要求 JSON 输出。放正文时，content 字段的值必须是一个合法的 JSON 对象字符串：",
      "不要在里面再套 markdown 代码块围栏，不要在 JSON 前后加解释。",
    ].join("\n")
  }
  if (type === "json_schema") {
    const schema = responseFormat?.json_schema?.schema
    const name = responseFormat?.json_schema?.name
    return [
      "## 关于正文内容",
      "",
      `本次调用方要求 JSON 输出${name ? `（schema 名：${name}）` : ""}。`,
      "不要 markdown 代码块围栏、不要前后解释、不要输出 JSON 之外的任何字符。",
      schema ? `\n必须满足这个 JSON Schema：\n${JSON.stringify(schema)}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  }
  return ""
}

/**
 * 把 `stop` 应用到正文上。
 *
 * OpenAI 的语义：正文里**第一次**出现任一停止序列就截断，且停止序列本身不含在结果里。
 * 多个序列时取最早出现的那个。
 */
export function applyStop(text, stop) {
  if (typeof text !== "string" || !text) return text
  const list = Array.isArray(stop) ? stop : typeof stop === "string" ? [stop] : []
  const seqs = list.filter((s) => typeof s === "string" && s.length > 0)
  if (seqs.length === 0) return text
  let cut = -1
  for (const s of seqs) {
    const i = text.indexOf(s)
    if (i >= 0 && (cut < 0 || i < cut)) cut = i
  }
  return cut < 0 ? text : text.slice(0, cut)
}

/**
 * 把 `max_tokens` 应用到正文上（按估算 token 截断）。
 *
 * ⚠ 这是**估算**：`estimateTokens` 的口径见 src/tokens.mjs（CJK ≈ 1 token/字，
 *   其他 ≈ 1 token/4 字符）。做不到精确 —— 上游不回报真实 token 数。
 *   用途是「别让它写太长」，不是「严格遵守预算」。
 */
export function applyMaxTokens(text, maxTokens) {
  const limit = Number(maxTokens)
  if (!Number.isFinite(limit) || limit <= 0 || typeof text !== "string" || !text) return text
  if (estimateTokens(text) <= limit) return text
  // 逐字符累加，到预算就停。比按比例切更准（中英混排的比例不一样）。
  let out = ""
  let used = 0
  for (const ch of text) {
    const cost = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 1 : 0.25
    if (used + cost > limit) break
    out += ch
    used += cost
  }
  return out
}

/** 按调用方的要求约束输出（顺序：先 stop、再 max_tokens）。 */
export function constrainOutput(text, body) {
  let out = applyStop(text, body?.stop)
  out = applyMaxTokens(out, body?.max_tokens)
  return out
}
