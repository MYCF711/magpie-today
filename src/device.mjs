// Today · 设备身份（自己生成、自己持有，不依赖桌面端）
//
// 实测（2026-10-26）：Today 的 HTTP 接口不校验设备是不是「真设备」——
// 一个自己造的、从未注册过的 `X-Device-Id` 照样 202（连空值都能过）。
// 唯一的设备身份就是这个头，它只被用来在服务端建台账。
//
// 于是这里的选择是：**自己生成一个 UUID 并持久化**，而不是去读桌面端的 installation-id。
// 理由：读桌面端等于要求「装了 Today 桌面端」，而插件要能独立跑（服务器、别的机器、没装客户端）。
//
// ⚠ 持久化很重要：每次进程重启换一个新 UUID，服务端那本台账里就会多出一台设备。

import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const FILE = "today-device.json"
let cached = null

/**
 * 取本机这个插件的设备身份。
 *
 * `configDir` 是 magpie 的配置目录（插件工厂拿到的 `directory`）。
 * 写不进去就退回一个内存里的临时值 —— 宁可这次会话设备 id 不稳定，
 * 也不能因为写不了文件而让插件加载失败。
 */
export function deviceId(configDir) {
  if (cached) return cached
  const dir = configDir || process.cwd()
  const file = path.join(dir, FILE)
  try {
    if (existsSync(file)) {
      const j = JSON.parse(readFileSync(file, "utf8"))
      if (typeof j?.deviceId === "string" && j.deviceId) {
        cached = j.deviceId
        return cached
      }
    }
    const fresh = `magpie-${randomUUID()}`
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({ deviceId: fresh, createdAt: new Date().toISOString() }, null, 2), "utf8")
    cached = fresh
    return cached
  } catch {
    cached = cached || `magpie-${randomUUID()}`
    return cached
  }
}

/** 供测试：清掉进程内缓存。 */
export function _reset() {
  cached = null
}
