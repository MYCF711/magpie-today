// 剥离 / 还原 Today 侧的人设（系统提示词）
//
// 为什么需要它：Today 的 agent 会给每一轮对话前置一段**服务端人设**
// （`GET /v1/agents/me` 的 `agentCharacter` + `aboutMe`）。那份人设里写着
// 「回复中不要使用 markdown 格式」「默认不使用 emoji」这类格式约束 ——
// 当作模型用时，它们会和调用方（DSH）的系统提示词打架，而且优先级不明确。
//
// 实测（2026-10-26）：这段人设是**用户可以改的账号状态**，
// `PATCH /v1/agents/default` 能把 `agentCharacter` / `aboutMe` 置空，回读长度为 0。
// 置空之后调用方的系统提示词就是唯一的一份。
//
//   node tools/agent-persona.mjs --show       # 看现在是什么
//   node tools/agent-persona.mjs --strip      # 备份后置空
//   node tools/agent-persona.mjs --restore    # 用备份还原
//
// ⚠ 这是改**你账号**的状态：桌面端里的助手人设会跟着变（名字不变）。
//   备份写在 `.agent-persona-backup.json`（已 gitignore），`--restore` 靠它。
// ⚠ 只动 `agentCharacter` 与 `aboutMe`，**不动 `userFacts`** ——
//   那是 agent 攒下来的关于你的记忆，清掉是另一回事（也没有这个需求）。

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createClient, baseHeaders } from "../src/api.mjs"
import { readDesktopCredential, desktopDeviceId } from "../src/desktop.mjs"
import { exchangeSession } from "../src/api.mjs"

const BACKUP = path.join(import.meta.dirname, "..", ".agent-persona-backup.json")

const cred = readDesktopCredential()
if (!cred) {
  console.error("读不到 Today 桌面端登录态。先在桌面端登录一次。")
  process.exit(2)
}
const { accessToken } = await exchangeSession(cred.refreshCredential, desktopDeviceId())
const client = createClient({ getAuth: async () => ({ access: accessToken }), deviceId: desktopDeviceId() })

async function profile() {
  const r = await client.request("/v1/agents/me", { timeout: 20_000 })
  if (!r.ok) throw new Error(`读人设失败：HTTP ${r.status} ${r.text?.slice(0, 160)}`)
  return r.json
}

async function patch(body) {
  const r = await client.request("/v1/agents/default", { method: "PATCH", body, timeout: 20_000 })
  if (!r.ok) throw new Error(`改人设失败：HTTP ${r.status} ${r.text?.slice(0, 200)}`)
  return r.json
}

const mode = process.argv[2] ?? "--show"

if (mode === "--show") {
  const me = await profile()
  console.log("agentName      :", me.agentName)
  console.log("aboutMe        :", `${(me.aboutMe ?? "").length} 字符  ${JSON.stringify((me.aboutMe ?? "").slice(0, 60))}`)
  console.log("agentCharacter :", `${(me.agentCharacter ?? "").length} 字符`)
  console.log("userFacts      :", `${(me.userFacts ?? "").length} 字符（本工具不动它）`)
  console.log("备份文件       :", existsSync(BACKUP) ? "有" : "无")
} else if (mode === "--strip") {
  const me = await profile()
  const backup = {
    agentName: me.agentName,
    aboutMe: me.aboutMe,
    agentCharacter: me.agentCharacter,
    savedAt: new Date().toISOString(),
  }
  if ((me.agentCharacter ?? "") === "" && (me.aboutMe ?? "") === "") {
    console.log("已经是空的，无需处理。")
  } else {
    if (existsSync(BACKUP)) {
      const old = JSON.parse(readFileSync(BACKUP, "utf8"))
      if (old?.agentCharacter !== backup.agentCharacter) {
        console.error("⚠ 已有一份备份，内容与当前不同。先 --restore 或用 --force 覆盖。")
        if (!process.argv.includes("--force")) process.exit(3)
      }
    }
    writeFileSync(BACKUP, JSON.stringify(backup, null, 2), "utf8")
    await patch({ agentCharacter: "", aboutMe: "" })
    const after = await profile()
    console.log(`已置空：agentCharacter ${(backup.agentCharacter ?? "").length} → ${(after.agentCharacter ?? "").length} 字符，` +
      `aboutMe ${(backup.aboutMe ?? "").length} → ${(after.aboutMe ?? "").length} 字符`)
    console.log(`备份：${BACKUP}`)
  }
} else if (mode === "--restore") {
  if (!existsSync(BACKUP)) {
    console.error(`没有备份文件：${BACKUP}`)
    process.exit(3)
  }
  const b = JSON.parse(readFileSync(BACKUP, "utf8"))
  await patch({ agentCharacter: b.agentCharacter ?? "", aboutMe: b.aboutMe ?? "" })
  const after = await profile()
  console.log(`已还原：agentCharacter ${(after.agentCharacter ?? "").length} 字符，aboutMe ${(after.aboutMe ?? "").length} 字符`)
} else {
  console.error("用法：--show | --strip [--force] | --restore")
  process.exit(2)
}

void baseHeaders
