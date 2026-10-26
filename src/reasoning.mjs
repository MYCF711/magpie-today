// Today · 思考过程（reasoning）
//
// 背景：Today 的 agent 通道**不吐思维链**（实测见 docs/internals.md 第二十二节：
// assistant 消息只有 messageType=text，v3 part type 全集也只有 text，
// 客户端 bundle 里 reasoning 0 处）。
//
// 但 DSH 想要它 —— 「没有思考过程仿佛回到两年前」。
//
// 所以这里走一条**模拟**的路：让模型把推理写进正文、用 `<reasoning>` 标签包起来，
// 我们再把它拆成 OpenAI 的 `reasoning_content` 字段。DSH 认这个字段：
//
//   const OPENAI_COMPLETIONS_REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text"]
//
// ⚠ 说清它是什么：这是**模型自己写出来的推理摘要**，不是底层模型的思维链。
//   区别在于：真思维链是模型在处理过程中自然产生的；这个是我们要求它"把想法写出来"。
//   它的价值是「能看见它在想什么」，它的局限是「它可能写得比想得简略，也可能事后合理化」。
//   不要把两者混为一谈 —— 后者会在调试时误导人。

/** 让模型按标签输出推理的一段指令（放在提示末尾，效用最高的位置）。 */
export const REASONING_INSTRUCTION = `## 输出格式（最严格）

先输出你的推理，用 <reasoning> 和 </reasoning> 包起来；再输出给用户看的正文。
正文里不要重复推理内容。不需要推理时，省略整个 reasoning 段。

例：
<reasoning>
用户要读文件，我需要请求 read 工具，路径是 xxx。
</reasoning>
我现在读一下这个文件。`

/**
 * 从模型输出里拆出推理段与正文。
 *
 * 认 `<reasoning>...</reasoning>`（大小写不敏感，允许跨行）。
 * 只有一对时直接用；多对时全部拼起来（模型偶尔会分几段写）。
 * 没有标签就原样返回，正文不变 —— **不要因为解析失败就丢掉正文**。
 *
 * @returns {{ reasoning: string, content: string }}
 */
export function splitReasoning(text) {
  const raw = typeof text === "string" ? text : ""
  if (!raw) return { reasoning: "", content: "" }

  const blocks = []
  const re = /<reasoning>([\s\S]*?)<\/reasoning>/gi
  let m
  while ((m = re.exec(raw)) !== null) {
    const one = m[1].trim()
    if (one) blocks.push(one)
  }
  const content = raw.replace(re, "").trim()
  return { reasoning: blocks.join("\n\n").trim(), content }
}

/**
 * 流式输出时，正文可能还没到齐就出现了半截标签。
 * 这个函数判断"当前这段能不能安全地发出去"。
 *
 * 规则：如果文本末尾可能是 `<reasoning>` / `</reasoning>` 的前缀，
 * 就先压住不发，等下一次拼出完整标签。否则会出现"半个标签"漏给客户端。
 */
export function safeToEmit(text) {
  const s = typeof text === "string" ? text : ""
  const tags = ["<reasoning>", "</reasoning>"]
  for (const tag of tags) {
    for (let n = 1; n < tag.length; n++) {
      if (s.endsWith(tag.slice(0, n))) return false
    }
  }
  return true
}