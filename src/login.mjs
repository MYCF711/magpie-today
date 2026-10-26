// Today · 登录（不依赖桌面端）
//
// Today 的账号只有一条自助登录路径：**手机号 + 短信验证码**。实测其余都是关的：
//
//   POST /api/auth/email-otp/send-verification-otp  → 403 auth.email_sign_in_disabled（本地区关闭）
//   POST /api/auth/sign-up/email                    → 403 同上
//   GET  /api/auth/oauth2/authorize                 → 只接受注册过的 redirect_uri
//                                                     （today-connector://auth/callback），
//                                                     我们把回调落到本地 127.0.0.1 会被拒：
//                                                     error=invalid_redirect
//
// 所以独立登录 = 走手机 OTP：
//
//   POST /api/auth/phone-number/send-otp  { phoneNumber }         → {"message":"code sent"}
//   POST /api/auth/phone-number/verify    { phoneNumber, code }   → {"token":"<session token>"}
//   GET  /api/auth/token  (Bearer <session token>)                → {"token":"<JWT>"}
//
// 第三行走 api.mjs 的 exchangeSession()。
//
// ⚠ 号码要带国家码（`+8613800000000`）。不带则 400 INVALID_PHONE_NUMBER。
// ⚠ 验证码有失败次数与过期：400 INVALID_OTP / OTP_EXPIRED，403 TOO_MANY_ATTEMPTS。

import { AUTH_HOST, APP_VERSION, CLIENT_CAPABILITIES } from "./constants.mjs"

function authHeaders() {
  return {
    accept: "application/json",
    "content-type": "application/json",
    origin: "https://todayai.cn",
    "x-app-version": APP_VERSION,
    "x-client-platform": "windows-client",
    "x-client-capabilities": CLIENT_CAPABILITIES,
    "user-agent": "node",
  }
}

async function post(pathname, body, fetchImpl = fetch) {
  const res = await fetchImpl(`${AUTH_HOST}${pathname}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
    redirect: "error",
  })
  const text = await res.text().catch(() => "")
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, ok: res.ok, json, text }
}

/** 发验证码。返回 `{ ok, message }`，不抛 —— 错误要能显示给人看。 */
export async function sendOtp(phoneNumber, fetchImpl = fetch) {
  const phone = String(phoneNumber ?? "").trim()
  if (!phone) return { ok: false, message: "请填手机号（带国家码，如 +8613800000000）" }
  try {
    const r = await post("/api/auth/phone-number/send-otp", { phoneNumber: phone }, fetchImpl)
    if (r.ok) return { ok: true, message: "验证码已发送" }
    const code = r.json?.code ?? ""
    if (code === "INVALID_PHONE_NUMBER") {
      return { ok: false, message: "手机号格式不对：要带国家码，例如 +8613800000000" }
    }
    return { ok: false, message: r.json?.message ?? r.text?.slice(0, 160) ?? `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, message: `发码失败：${String(e?.message ?? e)}` }
  }
}

/**
 * 校验验证码，拿到 **session token**（长期有效，插件的 refresh 位）。
 *
 * 返回 `{ ok, sessionToken }` 或 `{ ok:false, message }`。
 */
export async function verifyOtp(phoneNumber, code, fetchImpl = fetch) {
  const phone = String(phoneNumber ?? "").trim()
  const otp = String(code ?? "").trim()
  if (!phone || !otp) return { ok: false, message: "手机号和验证码都要填" }
  try {
    const r = await post("/api/auth/phone-number/verify", { phoneNumber: phone, code: otp }, fetchImpl)
    if (!r.ok) {
      const c = r.json?.code ?? ""
      const map = {
        INVALID_OTP: "验证码不对",
        OTP_EXPIRED: "验证码已过期，重新发一次",
        TOO_MANY_ATTEMPTS: "尝试次数过多，稍后再试",
        INVALID_PHONE_NUMBER: "手机号格式不对（要带国家码）",
      }
      return { ok: false, message: map[c] ?? r.json?.message ?? `HTTP ${r.status}` }
    }
    const token = r.json?.token
    if (typeof token !== "string" || !token) {
      return { ok: false, message: "服务端没有返回 session token" }
    }
    return { ok: true, sessionToken: token }
  } catch (e) {
    return { ok: false, message: `校验失败：${String(e?.message ?? e)}` }
  }
}
