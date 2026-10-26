#!/usr/bin/env node
// 打印邀请链接与重置卡。
//
// 用法：
//   node tools/invite.mjs            # 看链接、已邀请人数、里程碑
//   node tools/invite.mjs --resets   # 看还剩几张重置卡
//   node tools/invite.mjs --use      # 用掉一张（⚠ 不可逆，额度恢复到 100%）
//
// 凭据来源：tests/auth.mjs 的三条通道（TODAY_SESSION → magpie → 桌面端）。
import { testAuth } from "../tests/auth.mjs"
import { createClient } from "../src/api.mjs"
import { readInvite, readResets, useReset } from "../src/growth.mjs"

const args = new Set(process.argv.slice(2))
const dir = process.cwd()
const { getAuth, device } = await testAuth(dir)
const client = createClient({ getAuth, deviceId: device })

if (args.has("--resets")) {
  const r = await readResets(client)
  if (!r) {
    console.log("读不到重置卡")
    process.exit(1)
  }
  console.log(`可用重置：${r.totalCount} 次`)
  for (const x of r.items) console.log(`  ${x.resetId}  过期 ${x.expiresAt ?? "永不"}`)
  process.exit(0)
}

if (args.has("--use")) {
  const r = await useReset(client)
  console.log(r.ok ? `已用掉一张（${r.resetId}），额度恢复到 100%` : `失败：HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`)
  process.exit(r.ok ? 0 : 1)
}

const inv = await readInvite(client)
if (!inv) {
  console.log("读不到邀请链接")
  process.exit(1)
}
console.log("邀请链接（拿去注册第二个号）：")
console.log(`  ${inv.link}`)
console.log()
console.log(`已成功邀请：${inv.invitedCount} 人`)
console.log(`已发重置额度：${inv.resetCount} 次`)
if (inv.milestones.length) {
  console.log()
  console.log("里程碑：")
  for (const m of inv.milestones) {
    console.log(`  邀请 ${m.need} 位 → ${m.reward} 次重置  ${m.reached ? "✅ 已达成" : ""}`)
  }
}
