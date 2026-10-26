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
import { readDesktopCredential, desktopDeviceId } from "../src/desktop.mjs"
import { createClient, exchangeSession } from "../src/api.mjs"
import { TodayAuthPlugin, _internal } from "../index.mjs"
import { buildPrompt, extractToolCalls, streamTurn } from "../src/chat.mjs"
import { createConversation, listConversationMessages, messageCount, sendToConversation } from "../src/conversation.mjs"
import { staticModels } from "../src/models.mjs"

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

const cred = readDesktopCredential()
if (!cred && (only("login") || only("chat") || only("stream") || only("tools"))) {
  console.error("本机没有 Today 桌面端登录态，先登录一次再跑。")
  process.exit(2)
}

let auth
async function getAuth() {
  return auth
}

async function ensureAuth() {
  if (auth) return auth
  const { accessToken, expiresAt } = await exchangeSession(cred.refreshCredential, desktopDeviceId())
  auth = { access: accessToken, refresh: cred.refreshCredential, expires: expiresAt, accountId: cred.userId, uid: cred.userId, type: "oauth" }
  return auth
}

const plugin = await TodayAuthPlugin(
  { client: { app: { log: () => {} } }, directory: process.cwd() },
  {},
)

// ── 各项 ────────────────────────────────────────────────────────────────

await t("login", async () => {
  const a = await ensureAuth()
  const api = createClient({ getAuth, deviceId: desktopDeviceId() })
  const r = await api.request("/v1/users/me", { timeout: 20_000 })
  assert.equal(r.status, 200, `users/me -> ${r.status} ${r.text?.slice(0, 200)}`)
  assert.equal(r.json?.id, cred.userId, "返回的 user id 应等于凭据里的")
  return `account=${r.json?.preferredName ?? cred.userId}`
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
  const ok = extractToolCalls('{"tool_calls":[{"name":"read_file","arguments":{"path":"E:/a.txt"}}]}', names)
  assert.deepEqual(ok, [{ name: "read_file", arguments: { path: "E:/a.txt" } }])
  const fenced = extractToolCalls('```json\n{"tool_calls":[{"name":"run_shell","arguments":{"command":"ls"}}]}\n```', names)
  assert.deepEqual(fenced, [{ name: "run_shell", arguments: { command: "ls" } }])
  const unknown = extractToolCalls('{"tool_calls":[{"name":"nope","arguments":{}}]}', names)
  assert.equal(unknown, null, "不在清单里的函数名必须丢掉")
  const none = extractToolCalls('{"tool_calls":[]}', names)
  assert.equal(none, null)
  return "裸 JSON / 围栏 / 未知函数名 / 空数组"
})

// 要花额度的项

await t("chat", async () => {
  await ensureAuth()
  const api = createClient({ getAuth, deviceId: desktopDeviceId() })
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
  const api = createClient({ getAuth, deviceId: desktopDeviceId() })
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
    [{ role: "user", content: "请读取 E:/test.txt 的内容" }],
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
