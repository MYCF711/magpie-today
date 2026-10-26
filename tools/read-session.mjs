// 取出本机 Today 桌面端的 session token
//
// 为什么要单独给一个脚本：插件「粘贴 session token」那条登录路径需要一个 token，
// 而它加密存在桌面端的 userData 里。这个脚本就是把它读出来、打印出来。
//
//   node tools/read-session.mjs          # 打印 session token
//   node tools/read-session.mjs --json   # 连账号 id、过期时间一起，JSON 出来
//
// ⚠ 打印出来的是**凭据**。别贴进聊天、别写进文件、别提交进仓库。
//   本工具只在本机读自己的客户端数据，不联网。

import { readDesktopCredential, desktopDeviceId } from "../src/desktop.mjs"
import { exchangeSession } from "../src/api.mjs"

const asJson = process.argv.includes("--json")
const cred = readDesktopCredential()

if (!cred) {
  console.error("没有读到 Today 桌面端的登录态。")
  console.error("先确认：① 装了 Today 桌面端 ② 在它里面登录过 ③ 用的是 CN 渠道（prod）")
  process.exit(2)
}

if (asJson) {
  // 顺带验证 session 还能换到 token —— 换不到就说明这份登录态已经废了
  let live = false
  let until = null
  try {
    const r = await exchangeSession(cred.refreshCredential, desktopDeviceId())
    live = true
    until = new Date(r.expiresAt).toISOString()
  } catch {}
  console.log(
    JSON.stringify(
      {
        userId: cred.userId,
        environment: cred.environment,
        deviceId: desktopDeviceId(),
        sessionToken: cred.refreshCredential,
        accessTokenExpiresAt: new Date(cred.expiresAt).toISOString(),
        sessionIsLive: live,
        nextAccessTokenExpiresAt: until,
      },
      null,
      2,
    ),
  )
} else {
  console.log(cred.refreshCredential)
}
