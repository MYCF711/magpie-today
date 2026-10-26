// Today · 文件上传（图片输入的必经之路）
//
// 为什么需要它：Today 的 agent 收图不是靠 URL，而是靠**先上传、再引用**：
//
//   POST /v1/files  (multipart/form-data)  → { file: { id, storagePath, type, size, … } }
//   然后发消息时带上：
//     attachments: [{ type:"image", storagePath, filename, mimeType, size }]
//
// 实测（2026-10-26）：
//   · `images: [storagePath]` / `images: [url]` 全部 **400** —— 那条字段不是这么用的。
//   · `attachments: [{…缺 size}]` 也 400 —— `size` 是必填。
//   · `attachments` 带上完整五件套 → 202，且模型**真的看见了**：
//     发一张上半红下半绿的图，问「有哪些颜色」，答「红、绿」。
//
// ⚠ 为什么必须缓存：调用方每一轮都会把整个历史重发（OpenAI 语义），历史里的图会被
//   反复要求上传。按内容哈希缓存，同一张图只上传一次。
//   `source=chat` 的图上限 5 MiB；其他图 20 MiB；其他文件 50 MiB。

import { createHash } from "node:crypto"
import { HOST } from "./constants.mjs"

/** 同一次进程内，按内容哈希记住已上传的文件。 */
const uploaded = new Map()

/** data URL → { mime, buffer }；不是 data URL 就返回 null。 */
export function parseDataUrl(url) {
  if (typeof url !== "string") return null
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url.trim())
  if (!m) return null
  const [, mime, isBase64, payload] = m
  try {
    const buffer = isBase64
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8")
    return { mime: mime || "application/octet-stream", buffer }
  } catch {
    return null
  }
}

/** 文件名从 mime 推一个像样的（上游会显示它）。 */
function nameFor(mime, hash, fallback) {
  if (fallback) return fallback
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf" }[mime]
  return ext ? `image-${hash.slice(0, 8)}.${ext}` : `file-${hash.slice(0, 8)}`
}

/** Today 的 `type` 枚举：image / text / pdf / file / voice。 */
function kindOf(mime) {
  if (String(mime).startsWith("image/")) return "image"
  if (mime === "application/pdf") return "pdf"
  if (String(mime).startsWith("text/")) return "text"
  return "file"
}

/**
 * 上传一段二进制，返回可直接放进 `attachments` 的对象。
 *
 * 同样内容的第二次调用直接吃缓存，不发请求。
 *
 * @returns {Promise<{type, storagePath, filename, mimeType, size, id}>}
 */
export async function uploadBytes(client, buffer, mime, { filename, token, deviceId } = {}) {
  const hash = createHash("sha256").update(buffer).digest("hex")
  const cached = uploaded.get(hash)
  if (cached) return cached

  const form = new FormData()
  form.append("file", new Blob([buffer], { type: mime }), nameFor(mime, hash, filename))
  form.append("purpose", "chat")
  form.append("source", "chat")

  // ⚠ 上传走的是裸 fetch（FormData 要让运行时自己设 content-type 边界），
  //   所以不走 client.request —— 它会塞 application/json。
  const res = await fetch(`${HOST}/v1/files`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(deviceId ? { "x-device-id": deviceId } : {}),
    },
    body: form,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    const err = new Error(`上传文件失败：HTTP ${res.status} ${body.slice(0, 160)}`)
    err.status = res.status
    throw err
  }
  const json = await res.json().catch(() => null)
  const f = json?.file
  if (!f?.storagePath) throw new Error("上传文件失败：响应里没有 storagePath")

  const ref = {
    type: f.type ?? kindOf(mime),
    storagePath: f.storagePath,
    filename: f.filename ?? nameFor(mime, hash, filename),
    mimeType: f.mimeType ?? mime,
    size: f.size ?? buffer.length,
    ...(f.id ? { id: f.id } : {}),
  }
  uploaded.set(hash, ref)
  void client
  return ref
}

/**
 * 从 OpenAI 的 `content` 数组里取出图片部分。
 *
 * 支持两种写法（OpenAI 规范的就这两种）：
 *   `{type:"image_url", image_url:{url:"data:image/png;base64,…"}}`
 *   `{type:"image_url", image_url:{url:"https://…"}}`
 */
export function imagesFromContent(content) {
  if (!Array.isArray(content)) return []
  const out = []
  for (const part of content) {
    if (part?.type !== "image_url") continue
    const url = part?.image_url?.url ?? part?.image_url
    if (typeof url !== "string" || !url) continue
    out.push(url)
  }
  return out
}

/** http(s) 的图要先取回来再上传。取不回来就如实报错，不静默丢弃。 */
export async function fetchRemote(url, { timeout = 30_000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) })
  if (!res.ok) {
    const err = new Error(`取图失败：HTTP ${res.status} ${url.slice(0, 80)}`)
    err.status = res.status
    throw err
  }
  const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim() || "application/octet-stream"
  const buffer = Buffer.from(await res.arrayBuffer())
  return { buffer, mime }
}

/**
 * 一条消息里的图片 → 可放进 `attachments` 的引用数组。
 *
 * 任何一张图上传失败都**抛错**，不返回残缺的数组 —— 静默丢图比报错糟得多：
 * 调用方会以为模型看过图，其实是瞎子。
 */
export async function attachmentsFor(client, content, { token, deviceId } = {}) {
  const urls = imagesFromContent(content)
  if (urls.length === 0) return []
  const refs = []
  for (const url of urls) {
    const data = parseDataUrl(url)
    if (data) {
      refs.push(await uploadBytes(client, data.buffer, data.mime, { token, deviceId }))
      continue
    }
    if (/^https?:\/\//i.test(url)) {
      const remote = await fetchRemote(url)
      refs.push(await uploadBytes(client, remote.buffer, remote.mime, { token, deviceId }))
      continue
    }
    throw new Error(`不认识的图片地址（既不是 data URL 也不是 http(s)）：${String(url).slice(0, 80)}`)
  }
  return refs
}

/** 供测试：清空上传缓存。 */
export function _resetUploadCache() {
  uploaded.clear()
}