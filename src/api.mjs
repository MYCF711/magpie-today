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

/** 一个带 token 的小客户端。`getToken` 每次都重新取，好让 refresh 生效。 */
export function createClient({ getAuth, deviceId, fetchImpl = fetch }) {
  async function request(pathname, { method = "GET", body, headers, timeout = 30_000 } = {}) {
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
  if (status === 413) return "内容太大（单条消息上限约 17 万字符），请缩短后重试"
  if (status === 429) return message || "请求太频繁，稍后重试"
  return message || code || text?.slice(0, 200) || `HTTP ${status}`
}
