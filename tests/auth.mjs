// 测试用的取凭据入口 —— 按「不依赖桌面端」的顺序找
//
// 顺序是刻意的：
//   1. `TODAY_SESSION` 环境变量        —— 最独立，CI 里也能用
//   2. magpie 的 plugin-auth.json      —— 插件自己登录后存在那里的（手机验证码那条路）
//   3. 本机桌面端的登录态               —— 兜底，最后才用
//
// 前两条都不碰 Today 桌面端。第三条只是方便已经装了客户端的人。
//
// ⚠ 任何一条路径的 token 都不会被打印 —— 它们只用于发请求。

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { exchangeSession } from "../src/api.mjs"
import { readDesktopCredential } from "../src/desktop.mjs"
import { deviceId as persistentDeviceId } from "../src/device.mjs"

const CONFIG_DIR = path.join(os.homedir(), ".config", "magpie")

/** magpie 存插件登录态的地方，取 `today` 那一项。 */
function fromMagpieStore() {
  const file = path.join(CONFIG_DIR, "plugin-auth.json")
  if (!existsSync(file)) return null
  try {
    const all = JSON.parse(readFileSync(file, "utf8"))
    const one = all?.today
    if (typeof one?.refresh === "string" && one.refresh) {
      return {
        session: one.refresh,
        accountId: one.accountId,
        uid: one.uid,
        deviceId: one.deviceId,
        source: "magpie plugin-auth.json",
      }
    }
  } catch {}
  return null
}

function fromEnv() {
  const s = process.env.TODAY_SESSION
  if (typeof s === "string" && s.trim()) {
    return { session: s.trim(), accountId: process.env.TODAY_ACCOUNT, uid: process.env.TODAY_ACCOUNT, source: "TODAY_SESSION 环境变量" }
  }
  return null
}

function fromDesktop() {
  const cred = readDesktopCredential()
  if (cred?.refreshCredential) {
    return {
      session: cred.refreshCredential,
      accountId: cred.userId,
      uid: cred.userId,
      source: "本机桌面端登录态",
    }
  }
  return null
}

/**
 * 取一份可用的 auth（含新换的 access token），以及造好的 getAuth。
 *
 * @param {string} [workdir] 用于持久化自持设备 id 的目录
 */
export async function testAuth(workdir = process.cwd()) {
  const found = fromEnv() ?? fromMagpieStore() ?? fromDesktop()
  if (!found) {
    throw new Error(
      "取不到登录态。三条路都不通：TODAY_SESSION 未设、magpie 的 plugin-auth.json 里没有 today、" +
        "本机也没有桌面端登录态。跑一次 `magpie plugin login today` 即可（手机验证码，不需要桌面端）。",
    )
  }
  const device = persistentDeviceId(workdir)
  const { accessToken, expiresAt } = await exchangeSession(found.session, device)
  const auth = {
    access: accessToken,
    refresh: found.session,
    expires: expiresAt,
    accountId: found.accountId,
    uid: found.uid,
    deviceId: found.deviceId ?? device,
    type: "oauth",
  }
  return {
    auth,
    device,
    source: found.source,
    getAuth: async () => auth,
  }
}
