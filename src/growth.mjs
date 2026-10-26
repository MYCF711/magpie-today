// Today · 成长体系：用量、邀请链接、重置卡
//
// 三样东西来自三个接口（都是用户级，不需要 admin）：
//
//   GET /v1/pricing/status            → 套餐 + 用量（progress / remainingPercent / 重置周期）
//   GET /v1/growth/invitations/me/link → 邀请链接（utm_id）+ 里程碑 + 已达成的重置次数
//   GET /v1/pricing/resets            → 手上还有几张重置卡（每张 resetId + expiresAt）
//
// ⚠ 没有「每日签到」这个功能。找遍了 /v1/growth/* 与 /v1/pricing/*（只各有一个/一堆端点，
//   见 docs/internals.md 第二十五节），既没有 checkin 也没有 daily-reward。
//   客户端日志里那个 `app_daily_active` 是**埋点事件**，不是用户可点的签到，不计任何额度。
//   所以 `auth.checkin` 只能报 `inactive` —— 这是诚实的结果，不是没实现。

/** 用量与套餐。给 `auth.usage` 用。 */
export async function readUsage(client) {
  const res = await client.request("/v1/pricing/status", { timeout: 20_000 })
  if (!res.ok) return null
  const d = res.json?.data ?? {}
  const st = d.status ?? {}
  const usage = st.usage ?? {}
  const total = usage.breakdown?.display?.totalUsedText
  const remain = usage.breakdown?.display?.remainingPercentText ?? usage.progressText
  return {
    plan: st.plan ? String(st.plan).replace(/^./, (c) => c.toUpperCase()) : undefined,
    until: st.entitlementEndsAt ?? st.currentPeriodEndAt ?? undefined,
    // magpie 的 `used` 是**必填**：它不只画进度条，还是路由排序输入。
    // 漏了会被当成 0% = 满额，空号反而排到队首（HOOKS.md 第二节）。
    // `progress` 是「已用百分比」的整数（实测 75 = 剩余 25%）。
    used: typeof usage.progress === "number" ? usage.progress : undefined,
    total: 100,
    message: [remain, total].filter(Boolean).join(" · ") || undefined,
  }
}

/** 邀请链接。返回链接、已邀请人数、里程碑。 */
export async function readInvite(client) {
  const res = await client.request("/v1/growth/invitations/me/link", { timeout: 20_000 })
  if (!res.ok) return null
  const d = res.json?.data ?? {}
  const link = d.invitationLink?.link
  if (!link) return null
  return {
    link,
    utmId: d.invitationLink?.utmId,
    invitedCount: d.successfulInviteCount ?? 0,
    resetCount: d.rewards?.grantedResetCount ?? d.inviteeResetCount ?? 0,
    milestones: Array.isArray(d.rewardMilestones)
      ? d.rewardMilestones.map((m) => ({
          need: m.requiredInviteCount,
          reward: m.cumulativeResetCount,
          reached: Boolean(m.reached),
        }))
      : [],
  }
}

/**
 * 换一个邀请链接（重新生成）。
 *
 * ⚠ 只在用户明确要换的时候调 —— 换链接会不会让已分享出去的旧链接失效，服务端没说。
 *   所以默认**不调**，`readInvite` 是只读的。
 */
export async function regenerateInvite(client) {
  const res = await client.request("/v1/growth/invitations/me/link", { method: "POST", timeout: 20_000 })
  if (!res.ok) return null
  const d = res.json?.data ?? {}
  return d.invitationLink?.link ?? null
}

/** 手上还有几张重置卡。 */
export async function readResets(client) {
  const res = await client.request("/v1/pricing/resets", { timeout: 20_000 })
  if (!res.ok) return null
  const d = res.json?.data ?? {}
  const items = Array.isArray(d.items) ? d.items : []
  return {
    totalCount: d.totalCount ?? items.length,
    items: items.map((x) => ({ resetId: x.resetId, expiresAt: x.expiresAt })),
    observedAt: d.observedAt,
  }
}

/**
 * 用掉一张重置卡。
 *
 * ⚠ **这是不可逆操作**：用掉就没了，额度恢复到 100%。
 *   插件里**不自动调用它** —— 只在 `auth.checkin` 之外单独暴露给 UI/脚本。
 *   真要自动用，得由调用方显式决定（比如额度低于阈值时），不是插件替你决定。
 *
 * @param {string} [resetId] 不传就取第一张
 */
export async function useReset(client, resetId) {
  let id = resetId
  if (!id) {
    const cur = await readResets(client)
    id = cur?.items?.[0]?.resetId
    if (!id) return { ok: false, reason: "没有可用的重置卡" }
  }
  const res = await client.request("/v1/pricing/resets", {
    method: "POST",
    timeout: 30_000,
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: { resetId: id },
  })
  return { ok: res.ok, status: res.status, body: res.json ?? res.text, resetId: id }
}