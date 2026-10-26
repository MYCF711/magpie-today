// 会话层的自测：隔离、增量、水位线。
//   node tests/conversation.mjs
//
// 花额度：3 条用户消息。跑之前确认这是你愿意花的。
import assert from "node:assert/strict"
import { readDesktopCredential, desktopDeviceId } from "../src/desktop.mjs"
import { createClient, exchangeSession } from "../src/api.mjs"
import { createConversation, listConversationMessages, messageCount, readTurn, sendToConversation } from "../src/conversation.mjs"

const cred = readDesktopCredential()
if (!cred) {
  console.error("没有桌面端登录态，先登录一次再跑。")
  process.exit(2)
}
const { accessToken } = await exchangeSession(cred.refreshCredential, desktopDeviceId())
const api = createClient({ getAuth: async () => ({ access: accessToken }), deviceId: desktopDeviceId() })

let pass = 0
let fail = 0
async function t(name, fn) {
  process.stdout.write(`▸ ${name} … `)
  try {
    const note = await fn()
    pass++
    console.log(`ok  ${note ?? ""}`)
  } catch (e) {
    fail++
    console.log(`FAIL\n    ${e?.stack ?? e}`)
  }
}

/** 发一条，等到「本条之后」的终稿。 */
async function ask(convId, text, afterCount, timeoutMs = 120_000) {
  const t0 = Date.now()
  await sendToConversation(api, convId, text)
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 300))
    const rows = await listConversationMessages(api, convId, { limit: 60 })
    const turn = readTurn(rows, afterCount)
    if (turn?.isFinal) {
      // 再等一拍，确认没有后续消息
      await new Promise((r) => setTimeout(r, 500))
      const again = await listConversationMessages(api, convId, { limit: 60 })
      const settled = readTurn(again, afterCount)
      return { text: settled?.text ?? turn.text, count: messageCount(again), ms: Date.now() - t0 }
    }
  }
  throw new Error("等回复超时")
}

const token = "TK" + Math.random().toString(36).slice(2, 7).toUpperCase()

await t("会话隔离", async () => {
  const a = await createConversation(api)
  const b = await createConversation(api)
  assert.ok(a.conversationId && b.conversationId, "两个会话都要有 id")
  assert.notEqual(a.conversationId, b.conversationId, "会话 id 不能相同")

  const ra = await ask(a.conversationId, `请原样记住这串字符：${token}。只回复：收到`, 0)
  assert.ok(ra.text.length > 0, "A 要有回复")

  const rb = await ask(
    b.conversationId,
    `如果上面任何地方出现过以 ${token.slice(0, 3)} 开头的字符，把它原样说出来；没有就说没有。`,
    0,
  )
  assert.ok(!rb.text.includes(token), `B 不该看到 A 的内容，实际回复：${rb.text.slice(0, 120)}`)
  return `A=${ra.ms}ms B=${rb.ms}ms B 答「${rb.text.slice(0, 20)}」`
})

await t("会话内增量续聊", async () => {
  const c = await createConversation(api)
  const r1 = await ask(c.conversationId, `我最喜欢的数字是 ${token.length === 7 ? 47 : 47}。只回复：知道了`, 0)
  const r2 = await ask(c.conversationId, "我最喜欢的数字是几？只回答数字。", r1.count)
  assert.ok(r2.text.includes("47"), `第二轮该答 47，实际：${r2.text.slice(0, 80)}`)
  assert.ok(r2.count > r1.count, "水位线应该前进")
  return `轮1 ${r1.count} 条 → 轮2 ${r2.count} 条，${r2.ms}ms，答「${r2.text.trim().slice(0, 10)}」`
})

await t("水位线不返回旧答案", async () => {
  const c = await createConversation(api)
  const r1 = await ask(c.conversationId, "只回复：第一轮", 0)
  assert.ok(r1.text.includes("第一轮"), `第一次要拿到自己的答案，实际：${r1.text.slice(0, 60)}`)
  // 拿同样的水位线再读一次：不该把已经返回过的答案当成新一轮
  const rows = await listConversationMessages(api, c.conversationId, { limit: 60 })
  assert.equal(readTurn(rows, r1.count), null, "水位线之后没有新消息时，readTurn 必须返回 null")
  return `${r1.count} 条之后 readTurn=null ✅`
})

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)