// 经 magpie 网关的验收：多轮 / 工具 / 分流 / stop / tool_choice / usage / SSE
//   node tests/gateway.mjs
//
// 前提：magpie 在跑、today 已登录、且**改过源码后已 plugin add 重新注册**
// （magpie 不热重载插件源码，见 docs/internals.md 17.4）。
// 花额度：5 条消息。

const GW = "http://127.0.0.1:3425/v1/chat/completions"
const M = "today/deepseek-v4.1-flash"
const chat = async (b) => {
  const t0 = Date.now()
  const r = await fetch(GW, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })
  return { ms: Date.now() - t0, s: r.status, j: await r.json() }
}
const tools = [
  { type: "function", function: { name: "read_file", description: "读文件", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "web_fetch", description: "取网页正文", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
]
let pass = 0, total = 0
const check = (name, ok, note) => { total++; if (ok) pass++; console.log(`${ok ? "✅" : "❌"} ${name}${note ? "  " + note : ""}`) }

const msgs = [{ role: "system", content: "你是 DSH 的模型后端。" }, { role: "user", content: "读 E:/cfg.txt，只回内容。" }]
let r = await chat({ model: M, stream: false, messages: msgs, tools })
const m1 = r.j.choices[0].message
check("工具回合出 tool_calls", !!m1.tool_calls, `${r.ms}ms ${m1.tool_calls?.[0]?.function?.name ?? ""}`)
msgs.push({ role: "assistant", content: m1.content ?? "", tool_calls: m1.tool_calls })
msgs.push({ role: "tool", tool_call_id: m1.tool_calls?.[0]?.id, name: "read_file", content: "TIMEOUT=30" })
r = await chat({ model: M, stream: false, messages: msgs, tools })
check("工具结果回合给答案", (r.j.choices[0].message.content ?? "").includes("TIMEOUT"), `${r.ms}ms`)
msgs.push({ role: "assistant", content: r.j.choices[0].message.content })
msgs.push({ role: "user", content: "TIMEOUT 的值是多少？只回答数字。" })
r = await chat({ model: M, stream: false, messages: msgs, tools })
check("第三轮记得上文", (r.j.choices[0].message.content ?? "").includes("30"), `${r.ms}ms`)

r = await chat({ model: M, stream: false, messages: [{ role: "user", content: "用 web_fetch 打开 https://example.com 并贴出正文。" }], tools })
check("web_fetch 分流给 Today 自己做", !r.j.choices[0].message.tool_calls, `${r.ms}ms`)

r = await chat({ model: M, stream: false, stop: ["5"], messages: [{ role: "user", content: "数到 10，只输出数字空格分隔" }] })
check("stop 截断", r.j.choices[0].message.content.trim() === "1 2 3 4", JSON.stringify(r.j.choices[0].message.content))

r = await chat({ model: M, stream: false, tools, tool_choice: "none", messages: [{ role: "user", content: "读 E:/cfg.txt" }] })
check("tool_choice=none 不出调用", !r.j.choices[0].message.tool_calls, `${r.ms}ms`)

r = await chat({ model: M, stream: false, messages: [{ role: "user", content: "只回复：好" }] })
check("有 usage", (r.j.usage?.total_tokens ?? 0) > 0, JSON.stringify(r.j.usage))

const sr = await fetch(GW, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: M, stream: true, messages: [{ role: "user", content: "只回复两个字：好的" }] }) })
const t = await sr.text()
check("SSE 形状", (sr.headers.get("content-type") ?? "").includes("event-stream") && t.includes("[DONE]"))

console.log(`\n${pass}/${total} 通过`)
