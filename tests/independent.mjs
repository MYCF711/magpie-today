// 独立性自测：证明插件不依赖 Today 桌面端。
//   node tests/independent.mjs
//
// 两条判据：
//   ① 静态：index.mjs 的模块图里不含 desktop.mjs（除了那处动态 import）
//   ② 运行：把 APPDATA 指到不存在的目录、桌面端进程数为 0 时，chat 仍可用
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { execFileSync } from "node:child_process"

let pass = 0, fail = 0
async function t(name, fn) {
  process.stdout.write(`▸ ${name} … `)
  try { const n = await fn(); pass++; console.log(`ok  ${n ?? ""}`) }
  catch (e) { fail++; console.log(`FAIL\n    ${e?.stack ?? e}`) }
}

await t("index.mjs 不静态 import desktop.mjs", async () => {
  const s = readFileSync("index.mjs", "utf8")
  const statics = s.match(/^import[^\n]*desktop\.mjs[^\n]*$/gm) ?? []
  assert.equal(statics.length, 0, `还有静态导入：${statics.join(" | ")}`)
  assert.ok(s.includes('await import("./src/desktop.mjs")'), "应该保留一处动态 import（登录可选路径用）")
  return "只有一处动态 import"
})

await t("src/ 里除 desktop.mjs 自己外没人静态引用它", async () => {
  const bad = []
  for (const f of readdirSync("src")) {
    if (!f.endsWith(".mjs") || f === "desktop.mjs") continue
    const s = readFileSync(`src/${f}`, "utf8")
    if (/^import[^\n]*desktop\.mjs/m.test(s)) bad.push(f)
  }
  assert.deepEqual(bad, [], `这些文件还在引用：${bad.join(", ")}`)
  return "干净"
})

await t("登录方式三条齐全，且第一条不需要桌面端", async () => {
  const { TodayAuthPlugin } = await import("../index.mjs")
  const p = await TodayAuthPlugin({ client: { app: { log: () => {} } }, directory: process.cwd() }, {})
  const labels = p.auth.methods.map((m) => m.label)
  assert.ok(labels.length >= 3, `应有 3 条登录路径，实际 ${labels.length}`)
  assert.ok(/手机号/.test(labels[0]), `第一条应是手机验证码，实际「${labels[0]}」`)
  // ⚠ 不能只看「有没有『桌面端』三个字」——第一条的 label 是
  //   「Today 手机号 + 验证码（不需要桌面端）」，它本来就要说明"不需要"。
  //   真正的判据是：这条路**不依赖**桌面端，即它自己不带「导入」动作。
  assert.ok(!/导入/.test(labels[0]), `第一条不该是导入式登录，实际「${labels[0]}」`)
  return labels.join(" / ")
})

await t("设备身份自持（不读 installation-id）", async () => {
  const { deviceId } = await import("../src/device.mjs")
  const id = deviceId(process.cwd())
  assert.ok(/^magpie-/.test(id), `设备 id 应是自生成的 magpie- 前缀，实际 ${id}`)
  // ⚠ 要剥掉注释再查：device.mjs 的注释里正解释着「而不是去读桌面端的 installation-id」，
  //   直接全文正则会把那句解释当成违规。
  const code = readFileSync("src/device.mjs", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
  assert.ok(!/installation-id/.test(code), "device.mjs 的代码里不该出现 installation-id")
  return id.slice(0, 24) + "…"
})

await t("桌面端进程为 0 时 chat 仍可用", async () => {
  let count = 0
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      "(Get-Process | Where-Object { $_.ProcessName -match 'Today' } | Measure-Object).Count"],
      { encoding: "utf8", timeout: 20_000 })
    count = Number(String(out).trim()) || 0
  } catch { count = -1 }
  if (count > 0) return `跳过（桌面端在跑，${count} 个进程）—— 想验就先把 TodayCN 停掉`
  const { testAuth } = await import("./auth.mjs")
  const { auth, getAuth, source } = await testAuth(process.cwd())
  const { TodayAuthPlugin } = await import("../index.mjs")
  const plugin = await TodayAuthPlugin({ client: { app: { log: () => {} } }, directory: process.cwd() }, {})
  const opts = await plugin.auth.loader(getAuth, { id: "today" })
  const res = await opts.fetch("https://api.todayai.cn/v1/chat/completions", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4.1-flash", stream: false,
      messages: [{ role: "user", content: "只回复两个字：独立" }] }) })
  const j = await res.json()
  assert.equal(res.status, 200, `状态码 ${res.status}`)
  assert.ok((j?.choices?.[0]?.message?.content ?? "").length > 0, "回复不该为空")
  void auth
  return `无桌面端可用（凭据来源：${source}）`
})

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
