// loader.fetch 的形状自测：走真实 agent 通道，检查 OpenAI 形状是否合规范。
//   node tests/fetch.mjs
import assert from "node:assert/strict"
import { TodayAuthPlugin } from "../index.mjs"
import { testAuth } from "./auth.mjs"

const { auth, getAuth, source } = await testAuth(process.cwd())
console.log("  登录态来源:", source)

const plugin = await TodayAuthPlugin({ client: { app: { log: (m) => console.log("  [log]", m.message) } }, directory: process.cwd() }, {})
const opts = await plugin.auth.loader(getAuth, { id: "today" })
assert.equal(typeof opts.fetch, "function", "loader 必须返回 fetch")

const base = {
  model: "deepseek-v4.1-flash",
  messages: [{ role: "user", content: "只回复两个字：好的" }],
}

// ── 非流式 ──
{
  const t0 = Date.now()
  const res = await opts.fetch("https://api.todayai.cn/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...base, stream: false }),
  })
  assert.equal(res.status, 200, `非流式状态码 ${res.status}`)
  assert.match(res.headers.get("content-type") ?? "", /application\/json/)
  const j = await res.json()
  assert.equal(j.object, "chat.completion")
  assert.equal(j.model, "deepseek-v4.1-flash")
  assert.equal(j.choices?.[0]?.message?.role, "assistant")
  assert.ok(typeof j.choices[0].message.content === "string")
  assert.ok(j.choices[0].message.content.length > 0, "内容不应为空")
  assert.ok(Number.isFinite(j.usage.total_tokens))
  console.log(`非流式 ok  ${((Date.now() - t0) / 1000).toFixed(1)}s  content=${JSON.stringify(j.choices[0].message.content.slice(0, 30))}  finish=${j.choices[0].finish_reason}`)
}

// ── 流式 ──
{
  const t0 = Date.now()
  const res = await opts.fetch("https://api.todayai.cn/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...base, messages: [{ role: "user", content: "从 1 数到 15，只输出数字，空格分隔" }], stream: true }),
  })
  assert.equal(res.status, 200)
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/)
  const text = await res.text()
  const lines = text.split("\n").filter((l) => l.startsWith("data: "))
  assert.ok(lines.length >= 3, `SSE 至少要有 3 帧，实际 ${lines.length}`)
  const frames = lines.filter((l) => !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)))
  assert.equal(frames[0].choices[0].delta.role, "assistant")
  assert.ok(frames[frames.length - 1].choices[0].finish_reason === "stop", "最后一帧应是 stop")
  const content = frames.map((f) => f.choices[0].delta.content ?? "").join("")
  assert.ok(content.length > 0, "流式内容不应为空")
  console.log(`流式 ok  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${frames.length} 帧  content=${JSON.stringify(content.slice(0, 40))}`)
}

// ── 工具调用 ──
{
  const tools = [{ type: "function", function: { name: "read_file", description: "读取文件", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }]
  const res = await opts.fetch("https://api.todayai.cn/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "读取 E:/demo.txt 的内容" }], tools, stream: false }),
  })
  const j = await res.json()
  const m = j.choices[0].message
  console.log(`工具 ok  finish=${j.choices[0].finish_reason}  content=${m.content ? JSON.stringify(m.content.slice(0,60)) : "null"}  tool_calls=${m.tool_calls ? m.tool_calls.map(t=>t.function.name+"("+t.function.arguments+")").join(",") : "无"}`)
}
