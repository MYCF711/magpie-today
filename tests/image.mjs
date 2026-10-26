// 图像输入自测：data URL 的图能不能被模型真正看见。
//   node tests/image.mjs
//
// 判据用一张**已知内容**的图（上半红、下半绿），要求它说出颜色 —— 猜不出来。
// 花额度：1 条消息（+1 次上传，按内容哈希缓存，重跑不重传）。
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { deflateSync } from "node:zlib"
import { createClient } from "../src/api.mjs"
import { createConversation, listConversationMessages, readTurn, sendToConversation } from "../src/conversation.mjs"
import { attachmentsFor } from "../src/files.mjs"
import { testAuth } from "./auth.mjs"

/** 现造一张上半红、下半绿的 PNG，不依赖 _probe/ 里的东西。 */
function makePng(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, "ascii"), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2 // truecolor
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3)
    raw[off] = 0
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 3
      const top = y < h / 2
      raw[p] = top ? 255 : 0
      raw[p + 1] = top ? 0 : 200
      raw[p + 2] = 0
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

let pass = 0, fail = 0
async function t(name, fn) {
  process.stdout.write(`▸ ${name} … `)
  try { const n = await fn(); pass++; console.log(`ok  ${n ?? ""}`) }
  catch (e) { fail++; console.log(`FAIL\n    ${e?.stack ?? e}`) }
}

const { getAuth, device, source } = await testAuth(process.cwd())
const api = createClient({ getAuth, deviceId: device })

await t("data URL 解析", async () => {
  const { parseDataUrl } = await import("../src/files.mjs")
  const d = parseDataUrl("data:image/png;base64,aGVsbG8=")
  assert.equal(d.mime, "image/png")
  assert.equal(d.buffer.toString(), "hello")
  assert.equal(parseDataUrl("https://x/y.png"), null, "http 不该被当成 data URL")
  return "mime 与内容都对"
})

await t("两种输入形状都能收集到图", async () => {
  const { collectImageUrlsFlexible } = await import("../src/files.mjs")
  const url = "data:image/png;base64,AAA"
  const asMessages = [{ role: "user", content: [{ type: "text", text: "x" }, { type: "image_url", image_url: { url } }] }]
  assert.deepEqual(collectImageUrlsFlexible(asMessages), [url], "整个 messages 也该能收集")
  assert.deepEqual(collectImageUrlsFlexible(asMessages[0].content), [url], "content 数组也该能收集")
  return "messages 与 content 两种都行（这是修过的 bug）"
})

await t("上传一次并拿到 attachments 引用", async () => {
  const { auth } = await testAuth(process.cwd())
  const png = makePng(32, 32)
  const refs = await attachmentsFor(api, [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64," + png.toString("base64") } }] }], { token: auth.access, deviceId: device })
  assert.equal(refs.length, 1, `应上传 1 张，实际 ${refs.length}`)
  const r = refs[0]
  for (const k of ["type", "storagePath", "filename", "mimeType", "size"]) {
    assert.ok(r[k] !== undefined, `attachments 引用缺 ${k}（缺 size 会被服务端 400）`)
  }
  assert.equal(r.type, "image")
  return `${r.storagePath.split("/").pop()} ${r.size}B`
})

await t("模型真的看得见图", async () => {
  const { auth } = await testAuth(process.cwd())
  const png = makePng(64, 64)
  const url = "data:image/png;base64," + png.toString("base64")
  const refs = await attachmentsFor(api, [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }], { token: auth.access, deviceId: device })
  const conv = await createConversation(api)
  await sendToConversation(api, conv.conversationId, "这张图里有哪些颜色？只要颜色名，用逗号分隔。", { attachments: refs })
  const t0 = Date.now()
  while (Date.now() - t0 < 180_000) {
    await new Promise((r) => setTimeout(r, 400))
    const rows = await listConversationMessages(api, conv.conversationId, { limit: 40 })
    const turn = readTurn(rows, 0)
    if (turn?.isFinal) {
      assert.ok(/红/.test(turn.text) && /绿/.test(turn.text), `该说出红与绿，实际：${turn.text.slice(0, 120)}`)
      return `${((Date.now() - t0) / 1000).toFixed(1)}s -> ${JSON.stringify(turn.text.slice(0, 30))}`
    }
  }
  throw new Error("等回复超时")
})

console.log(`\n${pass} 通过，${fail} 失败（登录态来源：${source}）`)
process.exit(fail ? 1 : 0)
