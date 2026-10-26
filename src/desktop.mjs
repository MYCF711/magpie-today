// Today · 桌面端登录态导入
//
// Today 桌面端是 Electron 应用，登录态写在 userData 目录下的三份文件里：
//
//   account-credentials.head     当前有效 slot 的索引
//   account-credentials.slot-a   账号记录（双缓冲，a/b 轮换）
//   account-credentials.slot-b
//
// 内容由 Electron `safeStorage` 加密，载荷格式是 `v10` + nonce(12) + 密文 + tag(16)。
// 密钥的取法各平台不同，下面按平台分支：
//
//   Windows  Local State 里 os_crypt.encrypted_key（base64，去掉 `DPAPI` 前缀）
//            → CryptUnprotectData → 32 字节 AES-256-GCM 密钥
//   Linux    safeStorage 回退到 basic_text 后端时用固定口令 `peanuts`
//            → PBKDF2(sha1, salt=`saltysalt`, 1 轮, 16 字节) → AES-128-CBC
//            （受 keyring 保护的后端读不了，这时返回 null，让上层提示粘贴 token）
//   macOS    Keychain 里的 `Today Safe Storage` → `security` CLI 取
//
// ⚠ 只读本机自己的客户端数据，不外传、不打日志。
// ⚠ 读不到一律返回 null，由上层给出「请先打开 Today 客户端登录」这类提示，
//   绝不让导入失败演变成插件加载失败。

import { execFileSync } from "node:child_process"
import { createDecipheriv, pbkdf2Sync } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const HEAD = "account-credentials.head"
const SLOTS = ["account-credentials.slot-a", "account-credentials.slot-b"]

/** Today 桌面端 userData 目录（CN 渠道 prod 名就叫 `Today CN`）。 */
export function userDataDirs() {
  const home = os.homedir()
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming")
    return [path.join(appData, "Today CN")]
  }
  if (process.platform === "darwin") {
    return [path.join(home, "Library", "Application Support", "Today CN")]
  }
  const cfg = process.env.XDG_CONFIG_HOME || path.join(home, ".config")
  return [path.join(cfg, "Today CN")]
}

// ── 密钥 ────────────────────────────────────────────────────────────────

let cachedKey
let keyFailed = false

function windowsKey(dir) {
  const ls = JSON.parse(readFileSync(path.join(dir, "Local State"), "utf8"))
  const raw = Buffer.from(ls?.os_crypt?.encrypted_key ?? "", "base64")
  if (raw.subarray(0, 5).toString("ascii") !== "DPAPI") {
    throw new Error("Local State 里没有 DPAPI 前缀的密钥")
  }
  // PowerShell 是 Windows 上唯一不用编译原生模块就能调 DPAPI 的路子。
  // `Add-Type -AssemblyName System.Security` 不能省：默认会话里这个类型没加载。
  const b64 = raw.subarray(5).toString("base64")
  const script = [
    "Add-Type -AssemblyName System.Security",
    `$b=[Convert]::FromBase64String('${b64}')`,
    "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))",
  ].join(";")
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 20_000 },
  ).trim()
  return Buffer.from(out, "base64")
}

function linuxKey() {
  // Electron 在 Linux 上没有 keyring 时会落到 basic_text，密钥是固定口令派生的。
  return pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1")
}

function macKey() {
  // Electron 的 Keychain 条目；服务名带空格，取不出就抛，由上层回落。
  const out = execFileSync(
    "security",
    ["find-generic-password", "-w", "-s", "Today Safe Storage"],
    { encoding: "utf8", timeout: 15_000 },
  ).trim()
  return Buffer.from(out, "utf8").subarray(0, 16)
}

function keyFor(dir) {
  if (cachedKey) return cachedKey
  if (keyFailed) throw new Error("unavailable")
  try {
    if (process.platform === "win32") cachedKey = windowsKey(dir)
    else if (process.platform === "darwin") cachedKey = macKey()
    else cachedKey = linuxKey()
    return cachedKey
  } catch (e) {
    keyFailed = true
    throw e
  }
}

// ── 解密 ────────────────────────────────────────────────────────────────

/**
 * 解一个 safeStorage 载荷。
 *
 * Windows/macOS 是 GCM（nonce 12 / tag 16 在尾部），Linux basic_text 是 CBC（IV 固定 16 空格）。
 * 两条路都以 `v10` 开头，所以先按 GCM 试，失败再按 CBC 试 —— 不猜平台，猜格式更准。
 */
export function decryptPayload(blob, key) {
  if (blob.subarray(0, 3).toString("ascii") !== "v10") {
    throw new Error("不是 safeStorage v10 载荷")
  }
  const body = blob.subarray(3)
  const attempts = []
  if (key.length === 32 && body.length > 28) attempts.push(["gcm", key])
  if (key.length === 16 && body.length > 16) attempts.push(["cbc", key])
  // 两种都试：Linux 的 key 是 16 字节、Windows 的是 32，但载荷头一样
  if (key.length === 16) attempts.push(["gcm", key])
  for (const [mode, k] of attempts) {
    try {
      if (mode === "gcm") {
        const d = createDecipheriv("aes-256-gcm", k, body.subarray(0, 12), { authTagLength: 16 })
        d.setAuthTag(body.subarray(body.length - 16))
        return Buffer.concat([d.update(body.subarray(12, body.length - 16)), d.final()])
      }
      const d = createDecipheriv("aes-128-cbc", k, Buffer.alloc(16, 0x20))
      return Buffer.concat([d.update(body), d.final()])
    } catch {
      continue
    }
  }
  throw new Error("载荷解密失败")
}

function parseSlot(dir, name) {
  if (!name) return null
  const file = path.join(dir, name)
  if (!existsSync(file)) return null
  const blob = readFileSync(file)
  const json = decryptPayload(blob, keyFor(dir)).toString("utf8")
  const parsed = JSON.parse(json)
  const record = parsed?.record
  if (!record || typeof record.accessToken !== "string") return null
  return { record, generation: parsed.generation ?? 0 }
}

/**
 * 读本机 Today 桌面端的登录态。
 *
 * 返回 `{ accessToken, refreshCredential, userId, environment, expiresAt }`，
 * 读不到返回 null（不是抛错）。
 */
export function readDesktopCredential() {
  for (const dir of userDataDirs()) {
    try {
      if (!existsSync(path.join(dir, HEAD))) continue
      const head = JSON.parse(
        decryptPayload(readFileSync(path.join(dir, HEAD)), keyFor(dir)).toString("utf8"),
      )
      if (head?.state !== "signed-in") continue

      // head.slotIndex 指向当前有效的那一份；它坏了就试另一份，
      // 因为双缓冲的写入是「先写新、再改 head」，两者可能短暂不一致。
      const ordered = head.slotIndex === 0 ? [SLOTS[0], SLOTS[1]] : [SLOTS[1], SLOTS[0]]
      let picked = null
      for (const name of ordered) {
        try {
          const slot = parseSlot(dir, name)
          if (slot) {
            picked = slot
            break
          }
        } catch {
          continue
        }
      }
      if (!picked) continue

      const r = picked.record
      if (r.environment !== "prod") continue
      const uid = r.user?.id
      if (typeof uid !== "string" || !uid) continue

      return {
        accessToken: r.accessToken,
        refreshCredential: r.refreshCredential,
        userId: uid,
        environment: r.environment,
        expiresAt: Number(r.accessTokenExpiresAt) || 0,
        source: "desktop",
      }
    } catch {
      continue
    }
  }
  return null
}

/** 本机是否装了 Today 桌面端（用于给用户更准确的提示）。 */
export function desktopInstalled() {
  return userDataDirs().some((d) => existsSync(path.join(d, HEAD)))
}

/**
 * 本机的设备身份。
 *
 * 这就是桌面端填进 `X-Device-Id` 的那个值 —— 它同时是
 * `POST /registry/devices` 的 `clientMachineId`，也就是服务端台账里的「这台机器」。
 * 实测（2026-10-26 全量抓包）它就是一个 UUID，服务端拿它登记设备，
 * 不做防伪、不参与签名 —— Today 的 HTTP 接口**没有任何签名头**。
 *
 * 复用它的意义是：服务端看到的是同一台设备，而不是每装一次插件就多一台。
 * 读不到返回 null，由上层按账号派生一个稳定的替代值。
 */
export function desktopDeviceId() {
  for (const dir of userDataDirs()) {
    try {
      const file = path.join(dir, "windows-platform-host", "installation-id")
      if (existsSync(file)) {
        const value = readFileSync(file, "utf8").trim()
        if (value) return value
      }
      // Linux/macOS 上没有 windows-platform-host，退回 updateId（也是稳定的）
      const updater = path.join(dir, ".updaterId")
      if (existsSync(updater)) {
        const value = readFileSync(updater, "utf8").trim()
        if (value) return value
      }
    } catch {
      continue
    }
  }
  return null
}
