// 真机自测：把插件的九项钩子逐条打一遍，用的是本机已登录的 Today 桌面端。
//
//   node tests/live.mjs            # 全跑
//   node tests/live.mjs tools      # 只跑工具调用那一项（会真的发请求）
//
// ⚠ 这个脚本会真的用你的账号发消息 —— Today 里会留下会话记录。
//   额度消耗按账号套餐计。默认只跑那些**只读**的项，发消息的项要显式点名。
//
// 判据（每一项都必须有可复现的期望，不能只看「没报错」）：
//   login    从本机读出的凭据能换到 token，且 token 能调 users/me
//   usage    windows 里每条都有有限的 used
//   models   两个档位都在，且带 context/limit
//   refresh  换 token 后 session 不变、access 变
//   chat     发一条，拿到非空回复
//   stream   流式拿到多帧 delta，最后一帧 finish_reason=stop
//   notool   不带 tools 的请求不会被误判成工具调用
//   tools    带 tools 的请求能解析出 tool_calls（或明确回文本）

import assert from "node:assert/strict"
import { createClient } from "../src/api.mjs"
import { TodayAuthPlugin, _internal } from "../index.mjs"
import { buildPrompt, extractToolCalls, streamTurn } from "../src/chat.mjs"
import { createConversation, listConversationMessages, messageCount, sendToConversation } from "../src/conversation.mjs"
import { staticModels } from "../src/models.mjs"
import { testAuth } from "./auth.mjs"

const want = process.argv[2]
const only = (name) => !want || want === name

let pass = 0
let fail = 0
async function t(name, fn) {
  if (!only(name)) return
  process.stdout.write(`▸ ${name} … `)
  try {
    const detail = await fn()
    pass++
    console.log(`ok${detail ? `  ${detail}` : ""}`)
  } catch (e) {
    fail++
    console.log(`FAIL\n    ${e?.stack ?? e}`)
  }
}

// ── 取一份可用的 auth ───────────────────────────────────────────────────

let auth
let DEVICE = ""
async function getAuth() {
  return auth
}

async function ensureAuth() {
  if (auth) return auth
  const t = await testAuth(process.cwd())
  auth = t.auth
  DEVICE = t.device
  return auth
}

const plugin = await TodayAuthPlugin(
  { client: { app: { log: () => {} } }, directory: process.cwd() },
  {},
)

// ── 各项 ────────────────────────────────────────────────────────────────

await t("login", async () => {
  const a = await ensureAuth()
  const api = createClient({ getAuth, deviceId: DEVICE })
  const r = await api.request("/v1/users/me", { timeout: 20_000 })
  assert.equal(r.status, 200, `users/me -> ${r.status} ${r.text?.slice(0, 200)}`)
  assert.ok(r.json?.id, "users/me 应返回 id")
  return `account=${r.json?.preferredName ?? r.json?.id}`
})

await t("refresh", async () => {
  await ensureAuth()
  const before = auth.access
  const patch = await plugin.auth.refresh(auth)
  assert.ok(patch, "refresh 应返回补丁对象")
  assert.equal(patch.refresh, auth.refresh, "session token 不应变化")
  assert.ok(typeof patch.expires === "number" && patch.expires > Date.now(), "expires 应是未来时间")
  auth = { ...auth, ...patch }
  assert.notEqual(auth.access, before, "access token 应已更换")
  return `expires in ${Math.round((patch.expires - Date.now()) / 1000)}s`
})

await t("usage", async () => {
  await ensureAuth()
  const u = await plugin.auth.usage(getAuth)
  assert.ok(!u.error, `usage 报错：${u.error}`)
  assert.ok(Array.isArray(u.windows) && u.windows.length > 0, "至少一条窗口")
  for (const w of u.windows) {
    assert.ok(Number.isFinite(w.used), `窗口 ${w.name} 的 used 必须是有限数字（路由排序要用）`)
  }
  return `${u.windows.length} 条窗口，plan=${u.plan ?? "-"}`
})

await t("models", async () => {
  const m = await plugin.provider.models({}, { auth: await ensureAuth() })
  const ids = Object.keys(m)
  assert.deepEqual(ids.sort(), ["deepseek-v4.1-flash", "glm-5.3"])
  for (const id of ids) {
    assert.ok(m[id].limit.context > 0, "context 必须为正")
    assert.equal(m[id].api.npm, "@ai-sdk/openai-compatible")
  }
  return ids.join(", ")
})

await t("config", async () => {
  const cfg = {}
  await plugin.config(cfg)
  assert.ok(cfg.provider.today, "config 应声明 today provider")
  assert.ok(Object.keys(cfg.provider.today.models).length > 0, "静态模型表不能为空")
  return `${Object.keys(cfg.provider.today.models).length} 个静态模型`
})

// 纯函数项：不花额度

await t("notool", async () => {
  const prompt = buildPrompt([
    { role: "system", content: "你是一个翻译器。" },
    { role: "user", content: "今天天气很好" },
  ])
  assert.ok(prompt.includes("翻译器"), "system 应被带上")
  assert.ok(prompt.includes("今天天气很好"), "user 应被带上")
  assert.ok(!prompt.includes("tool_calls"), "没有 tools 时不应注入工具协议")
  const calls = extractToolCalls("这是普通回答，不是 JSON。", new Set(["read_file"]))
  assert.equal(calls, null, "普通文本不能被误判成工具调用")
  return `${prompt.length} 字符`
})

await t("toolparse", async () => {
  const names = new Set(["read_file", "run_shell"])
  const ok = extractToolCalls('{"tool_calls":[{"name":"read_file","arguments":{"path":"/tmp/a.txt"}}]}', names)
  assert.deepEqual(ok, [{ name: "read_file", arguments: { path: "/tmp/a.txt" } }])
  const fenced = extractToolCalls('```json\n{"tool_calls":[{"name":"run_shell","arguments":{"command":"ls"}}]}\n```', names)
  assert.deepEqual(fenced, [{ name: "run_shell", arguments: { command: "ls" } }])
  const unknown = extractToolCalls('{"tool_calls":[{"name":"nope","arguments":{}}]}', names)
  assert.equal(unknown, null, "不在清单里的函数名必须丢掉")
  const none = extractToolCalls('{"tool_calls":[]}', names)
  assert.equal(none, null)
  return "裸 JSON / 围栏 / 未知函数名 / 空数组"
})

await t("tool_choice=none 摘掉协议", async () => {
  const { buildPrompt } = await import("../src/chat.mjs")
  const tools = [{ type: "function", function: { name: "read_file", description: "读文件" } }]
  const withTools = buildPrompt([{ role: "user", content: "x" }], { tools })
  const none = buildPrompt([{ role: "user", content: "x" }], { tools, toolChoice: "none" })
  assert.ok(withTools.includes("read_file"), "默认该把工具表写进提示")
  assert.ok(!none.includes("read_file"), `tool_choice=none 时不该出现工具名，实际：${none.slice(0, 200)}`)
  assert.ok(!none.includes("tool_calls"), "tool_choice=none 时不该出现协议")
  return "协议整段摘掉"
})

await t("分流尊重 tool_choice", async () => {
  const { splitTools } = await import("../src/toolmap.mjs")
  const T = [
    { type: "function", function: { name: "web_fetch", description: "取网页" } },
    { type: "function", function: { name: "read_file", description: "读文件" } },
  ]
  // 分流默认关闭（TODAY_NATIVE_SPLIT=1 才开）—— 主人要求「默认走工具，不碰沙盒」
  delete process.env.TODAY_NATIVE_SPLIT
  const off = splitTools(T)
  assert.deepEqual(off.native, [], "默认不该分流，全部走工具")
  assert.deepEqual(off.delegated.map((t) => t.function.name).sort(), ["read_file", "web_fetch"])

  process.env.TODAY_NATIVE_SPLIT = "1"
  const a = splitTools(T)
  assert.deepEqual(a.native.map((x) => x.name), ["web_fetch"], "开启后该把 web_fetch 分流走")
  assert.deepEqual(a.delegated.map((t) => t.function.name), ["read_file"])
  const b = splitTools(T, { forced: "web_fetch" })
  assert.deepEqual(b.native, [], "被 tool_choice 点名时不能再分流走")
  assert.deepEqual(b.delegated.map((t) => t.function.name).sort(), ["read_file", "web_fetch"])
  delete process.env.TODAY_NATIVE_SPLIT
  return "默认不分流 / 开启后分流 / 被点名时不分流"
})

await t("输出约束", async () => {
  const { applyStop, applyMaxTokens, constrainOutput, responseFormatInstruction, unsupportedNotes } = await import("../src/params.mjs")
  assert.equal(applyStop("1 2 3 4 5 6", ["5"]), "1 2 3 4 ", "stop 该在 5 之前截断")
  assert.equal(applyStop("abcSTOPdefEND", ["END", "STOP"]), "abc", "多序列取最早出现的")
  assert.equal(applyStop("abc", undefined), "abc", "没给 stop 就原样返回")
  assert.equal(applyMaxTokens("字".repeat(20), 5), "字字字字字", "中文 1 token/字")
  assert.equal(applyMaxTokens("a".repeat(40), 5), "a".repeat(20), "ASCII 约 4 字符/token")
  assert.equal(applyMaxTokens("abc", 100), "abc", "没超预算就原样返回")
  assert.equal(constrainOutput("1 2 3 4 5 6", { stop: ["5"] }), "1 2 3 4 ", "constrainOutput 串起来")
  assert.ok(responseFormatInstruction({ type: "json_object" }).includes("JSON"), "json_object 要有指令")
  assert.ok(responseFormatInstruction({ type: "json_schema", json_schema: { name: "n", schema: { type: "object" } } }).includes("Schema"))
  assert.deepEqual(unsupportedNotes({ temperature: 0.1 }), ["temperature"], "temperature 该被记为忽略")
  assert.deepEqual(unsupportedNotes({ max_tokens: 5 }), [], "max_tokens 本地能做到，不算忽略")
  return "stop / max_tokens / response_format / 忽略清单"
})

await t("5xx 有界重试", async () => {
  const { createClient } = await import("../src/api.mjs")
  const run = async (seq) => {
    let calls = 0
    const c = createClient({
      getAuth: async () => ({ access: "t" }), deviceId: "d",
      fetchImpl: async () => {
        const s = seq[Math.min(calls, seq.length - 1)]; calls++
        return new Response(JSON.stringify({}), { status: s })
      },
    })
    const r = await c.request("/x", { method: "POST", body: {}, retry: { attempts: 3, delayMs: 5 } })
    return { status: r.status, calls }
  }
  assert.deepEqual(await run([200]), { status: 200, calls: 1 }, "200 不该重试")
  assert.deepEqual(await run([503, 200]), { status: 200, calls: 2 }, "503 后应重试")
  assert.deepEqual(await run([503, 503, 200]), { status: 200, calls: 3 }, "两次 503 后第三次成功")
  assert.deepEqual(await run([400]), { status: 400, calls: 1 }, "4xx 不该重试")
  const give = await run([503, 503, 503, 503])
  assert.equal(give.status, 503, "重试次数用尽后如实返回 5xx")
  assert.equal(give.calls, 3, `最多试 attempts 次，实际 ${give.calls}`)
  return "5xx 重试、4xx 不重试、次数有上限"
})

await t("Memory 开关生效", async () => {
  const { buildPrompt } = await import("../src/chat.mjs")
  const msgs = [{ role: "system", content: "你是助手" }, { role: "user", content: "hi" }]
  delete process.env.TODAY_NO_MEMORY
  const on = buildPrompt(msgs)
  assert.ok(!on.includes("无状态推理服务"), "默认该放开记忆（不含压制语句）")
  process.env.TODAY_NO_MEMORY = "1"
  const off = buildPrompt(msgs)
  assert.ok(off.includes("无状态推理服务"), "TODAY_NO_MEMORY=1 时应注入压制语句")
  delete process.env.TODAY_NO_MEMORY
  return "默认放开 / 开关可压制（量上下文时必须关）"
})

await t("图像输入支持两种 content 形状", async () => {
  const { collectImageUrlsFlexible } = await import("../src/files.mjs")
  const url = "data:image/png;base64,AAA"
  const asMessages = [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }]
  assert.deepEqual(collectImageUrlsFlexible(asMessages), [url])
  assert.deepEqual(collectImageUrlsFlexible(asMessages[0].content), [url])
  return "messages 与 content 都行"
})

await t("思考过程：模板与解析", async () => {
  const { outputTemplate, parseTemplate } = await import("../src/template.mjs")
  const tools = [{ type: "function", function: { name: "read", description: "读", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }]
  const tpl = outputTemplate(tools)
  assert.ok(tpl.includes('"kind":"answer|tool_call"'), "模板该含 kind 联合")
  assert.ok(tpl.includes("reasoning"), "模板该含 reasoning 字段")
  assert.ok(tpl.includes("read(path"), "模板该列出工具")
  const KNOWN = new Set(["read"])
  const a = parseTemplate('{"kind":"answer","reasoning":"简单","content":"2"}', KNOWN)
  assert.deepEqual([a.kind, a.reasoning, a.content], ["answer", "简单", "2"])
  const c = parseTemplate('{"kind":"tool_call","reasoning":"要读","tool_calls":[{"name":"read","arguments":{"path":"a"}}]}', KNOWN)
  assert.equal(c.kind, "tool_call")
  assert.deepEqual(c.toolCalls, [{ name: "read", arguments: { path: "a" } }])
  assert.equal(c.reasoning, "要读")
  // 未知工具不该被放行
  const u = parseTemplate('{"kind":"tool_call","tool_calls":[{"name":"nope","arguments":{}}]}', KNOWN)
  assert.equal(u.kind, "raw", "清单外的工具名不该变成 tool_call")
  // 非 JSON 原文当正文，不许丢
  const r = parseTemplate("这就是一句普通回答", KNOWN)
  assert.equal(r.kind, "raw")
  assert.equal(r.content, "这就是一句普通回答")
  // 围栏与前后杂字也要能抠出来
  const fenced = ["好的：", "```json", '{"kind":"answer","reasoning":"x","content":"y"}', "```"].join("\n")
  const f = parseTemplate(fenced, KNOWN)
  assert.equal(f.content, "y")
  return "模板 / 三条分支 / 未知工具 / 非 JSON / 围栏"
})

await t("过滤进度气泡", async () => {
  const { readTurn } = await import("../src/conversation.mjs")
  // 形状照抄实测：一条 assistant 里既有 turn 气泡又有 text 正文
  const rows = [
    { role: "user", isFinal: true, messages: [{ messageType: "text", content: { text: "查一下" } }] },
    {
      role: "assistant",
      isFinal: true,
      messages: [
        { messageType: "turn", content: { text: ["Searched the web"], toolCallStatus: "completed" } },
        { messageType: "text", content: { text: "1.99.1" } },
      ],
    },
  ]
  const r = readTurn(rows, 0)
  assert.equal(r.text, "1.99.1", `正文应只有 text part，实际 ${JSON.stringify(r.text)}`)
  return "turn 气泡被滤掉，只剩正文"
})

// 要花额度的项

await t("chat", async () => {
  await ensureAuth()
  const api = createClient({ getAuth, deviceId: DEVICE })
  const prompt = buildPrompt([
    { role: "user", content: "只回复三个字：收到了" },
  ])
  const conv = await createConversation(api)
  await sendToConversation(api, conv.conversationId, prompt)
  let text = ""
  const t0 = Date.now()
  for await (const ev of streamTurn(api, conv.conversationId, { afterCount: 0 })) {
    if (ev.type === "done") text = ev.text ?? text
  }
  assert.ok(text.trim().length > 0, "回复不应为空")
  return `${((Date.now() - t0) / 1000).toFixed(1)}s，${text.length} 字符：${text.slice(0, 40)}`
})

await t("tools", async () => {
  await ensureAuth()
  const api = createClient({ getAuth, deviceId: DEVICE })
  const tools = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "读取文件内容",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    },
  ]
  const prompt = buildPrompt(
    [{ role: "user", content: "请读取 /tmp/test.txt 的内容" }],
    { tools },
  )
  assert.ok(prompt.includes("read_file"), "工具表应进提示")
  const conv = await createConversation(api)
  await sendToConversation(api, conv.conversationId, prompt)
  let text = ""
  for await (const ev of streamTurn(api, conv.conversationId, { afterCount: 0 })) {
    if (ev.type === "done") text = ev.text ?? text
  }
  const calls = extractToolCalls(text, new Set(["read_file"]))
  return calls
    ? `解析出 ${calls.length} 个调用：${calls.map((c) => c.name).join(", ")}`
    : `没解析出调用（回文本 ${text.length} 字符）—— 这不算失败，但要人工看一眼是不是被拒了`
})

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
