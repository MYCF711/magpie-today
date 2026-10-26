// Today · HTTP 客户端
//
// 所有请求都带上桌面端自己那套头（见 constants.mjs 的说明）。
// 认证走 `Authorization: Bearer <accessToken>`，token 是 10 分钟有效期的 JWT。
//
// ⚠ 关于「身份识别与指纹」：实测（2026-10-26，全量抓包 183 条请求）Today 的
//   HTTP 接口**没有签名头**，没有 device-key / device-sig / HMAC / nonce。
//   唯一的设备身份是 `X-Device-Id`，它就是本地生成的 installation-id ，
//   服务端拿它做设备注册（`POST /registry/devices`）与工具目录上报，不做防伪。
//   所以「照抄请求头」这件事在这里没有密码学门槛，只有形状问题。

import {
  APP_VERSION,
  AUTH_HOST,
  CLIENT_CAPABILITIES,
  HOST,
  USER_AGENT,
} from "./constants.mjs"

/** 无 token 的裸头（注册设备、查版本升级这类端点用）。 */
export function baseHeaders(deviceId) {
  return {
    accept: "application/json",
    "accept-language": "zh-CN,zh;q=0.9",
    "x-app-version": APP_VERSION,
    "x-client-platform": "windows-client",
    "x-client-capabilities": CLIENT_CAPABILITIES,
    ...(deviceId ? { "x-device-id": deviceId } : {}),
    "user-agent": USER_AGENT,
  }
}

/** 带 token 的头。 */
export function authHeaders(token, deviceId) {
  return { ...baseHeaders(deviceId), authorization: `Bearer ${token}` }
}

/**
 * 换新 token。
 *
 * 桌面端的 `better-auth-session` 源：拿 session token（32 字符，长期有效）
 * 去 `GET /api/auth/token` 换一个 10 分钟的 JWT。session token 不变。
 *
 * ⚠ 这里**不**用 oauth2 的 refresh_token 流程 —— 那是另一条路（`source: "oauth2"`），
 *   本账号的桌面端登录态是 `better-auth-session`，用错了服务端会拒。
 */
export async function exchangeSession(sessionToken, deviceId, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${AUTH_HOST}/api/auth/token`, {
    method: "GET",
    headers: {
      ...baseHeaders(deviceId),
      // 换 token 这一步桌面端用的是 `windows-client`（不是 `windows`）
      origin: "https://todayai.cn",
      authorization: `Bearer ${sessionToken}`,
    },
    redirect: "error",
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`换 token 失败：HTTP ${res.status} ${body.slice(0, 200)}`)
  }
  const json = await res.json()
  const token = typeof json?.token === "string" ? json.token : ""
  if (!token) throw new Error("换 token 失败：响应里没有 token")
  // 响应不带 expiresIn，按 JWT 的 exp 自己算；算不出来就取保守的 9 分钟。
  return { accessToken: token, expiresAt: jwtExpiry(token) ?? Date.now() + 9 * 60_000 }
}

/** 从 JWT 里读 exp（毫秒）。读不出返回 null。 */
export function jwtExpiry(token) {
  try {
    const part = String(token).split(".")[1]
    if (!part) return null
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
    return typeof payload?.exp === "number" ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

/**
 * 一个带 token 的小客户端。`getToken` 每次都重新取，好让 refresh 生效。
 *
 * `retry` 只对**幂等**的调用生效，靠调用方自己保证：本项目的两个写操作都有去重键
 * （`POST /v3/conversations` 用 `Idempotency-Key`，`POST /v3/messages` 用
 * `clientMessageId` 且响应里有 `isDuplicate`），所以重发不会产生两条。
 *
 * 为什么要重试：实测上游的 500/503 是**偶发**的（同一个尺寸连试 4 次全是 500 属于尺寸问题，
 * 但正常尺寸下也会零星出现），一次抖动就让整轮对话失败，体验上不可接受。
 * 只重试 5xx 与网络错误 —— 4xx 重试没有意义（参数或权限错了，重发还是错）。
 */
export function createClient({ getAuth, deviceId, fetchImpl = fetch }) {
  async function once(pathname, { method, body, headers, timeout }) {
    method ??= "GET"
    timeout ??= 30_000
    const auth = await getAuth()
    const token = typeof auth === "string" ? auth : auth?.access
    if (!token) throw new Error("Today 未登录")
    const h = authHeaders(token, deviceId)
    if (body !== undefined) h["content-type"] = "application/json"
    const res = await fetchImpl(`${HOST}${pathname}`, {
      method,
      headers: { ...h, ...(headers ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: res.status, ok: res.ok, json, text }
  }

  /**
   * `retry: { attempts, delayMs }` —— 只给幂等调用用。
   * 不传就是一次，行为与之前完全一致。
   */
  async function request(pathname, opts = {}) {
    const { retry } = opts
    const attempts = Math.max(1, Number(retry?.attempts) || 1)
    const delayMs = Math.max(0, Number(retry?.delayMs) || 400)
    let last = null
    for (let i = 0; i < attempts; i++) {
      try {
        last = await once(pathname, { method: opts.method, body: opts.body, headers: opts.headers, timeout: opts.timeout })
      } catch (e) {
        // 网络层错误（超时、连接被断）也算可重试
        if (i === attempts - 1) throw e
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)))
        continue
      }
      const retriable = last.status >= 500 && last.status !== 501
      if (!retriable || i === attempts - 1) return last
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)))
    }
    return last
  }

  return { request }
}

/** 把 HTTP 错误翻成给用户看的话。 */
export function describeError(status, json, text) {
  const code = json?.code ?? json?.error ?? ""
  const message = json?.message ?? json?.error?.message ?? ""
  if (status === 401 || status === 403) {
    // 403 有两种：登录被拒（要重登）和能力不足（不怪登录）。这里分开。
    if (String(code).startsWith("auth.") || status === 401) return "登录已失效，请重新登录"
    return message || "这个账号没有该接口的权限"
  }
  if (status === 413) return "内容太大（上游限制：单条正文最多 100 万字符，且整个请求体不超过 1 MiB），请缩短后重试"
  if (status === 429) return message || "请求太频繁，稍后重试"
  return message || code || text?.slice(0, 200) || `HTTP ${status}`
}
