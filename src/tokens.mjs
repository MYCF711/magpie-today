// Today · 用量估算
//
// Today 的 agent 通道**不回报任何 token 用量**（202 的响应体里没有、终稿消息里也没有）。
// 但 OpenAI 形状的响应必须带 `usage` —— 它是调用方（DSH 等）做上下文水位、
// 压缩时机、成本统计的唯一输入。全填 0 等于告诉它们「什么都没消耗」，
// 于是压缩永远不会触发，最后撞上上游 17 万字符的硬上限。
//
// 所以这里**估算**，并且在 README 与 docs/internals.md 里明说它是估算。
//
// 口径（别当成精确值用）：
//   CJK 字符（汉字、假名、全角标点）≈ 1 token / 字
//   其他字符（ASCII、半角）        ≈ 1 token / 4 字符
//   这个比例与主流 BPE 词表在中文上的表现同量级，误差约 ±20%。
//
// ⚠ 这是**估算**不是实测 —— 上游不给真值，我们也测不到真值。
//   任何拿它做计费的用途都是错的；拿它做"该不该压缩了"的判断是够的。

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

/** 估算一段文本的 token 数。空/非字符串返回 0。 */
export function estimateTokens(text) {
  if (typeof text !== "string" || !text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

/**
 * 一轮请求/响应的用量。
 *
 * `promptText` 传**调用方眼中的完整上下文**（`buildPrompt(messages)` 的全量产物），
 * 不是我们实际发出去的增量。为什么：调用方拿 `prompt_tokens` 判上下文水位、
 * 决定何时压缩；续用 Today 会话时我们只发增量，若按增量估，调用方会以为
 * 上下文几乎没长，于是永不压缩，最后撞上上游的载荷上限。
 *
 * 代价：这个数会略大于上游真正读到的量（它已经记得的一部分被重复计了）。
 * 对「该不该压缩了」这个用途，宁可偏高 —— 偏高只是提前压缩，偏低会炸。
 */
export function estimateUsage({ promptText, completionText } = {}) {
  const prompt = estimateTokens(promptText)
  const completion = estimateTokens(completionText)
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    // 非标准字段：调用方认得出这是估算，不会把它当真值写进账单
    estimated: true,
  }
}