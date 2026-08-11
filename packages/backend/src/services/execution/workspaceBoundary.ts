// RFC-281 T1 — opencode 任务工作区边界的 permission 合成（纯函数）。
//
// 目标（RFC-281 §0 首要原则）：把 agent 的写/执行关进「本任务自己的工作
// 区」，越界读写被 opencode 原生 `external_directory` 权限键拒绝。只做这一维，
// 不过度加固；业务正常执行不被误伤。
//
// 载荷是 opencode 的 `permission.external_directory`（读源，非记忆）：
//  - `packages/core/src/v1/config/permission.ts`：Action=ask|allow|deny；
//    Rule=Action | Record<pattern, Action>；顶层键 '*' 通配所有 permission 名。
//  - `packages/opencode/src/permission/index.ts:28-38`：规则 flatten 后
//    **findLast 匹配者胜**；`deny` 在 ask 之前短路（`--auto` 翻不动）。
//  - `packages/opencode/src/tool/external-directory.ts`：任何文件工具触碰
//    cwd/worktree 之外的路径都以「目标目录绝对 glob」发起 external_directory 判定。
//
// 键位纪律（RFC-251 踩过的坑 + RFC-281 T0 实证 E4/M1）：opencode 按**键序**
// flatten 再 findLast，而 external_directory 判定会同时匹配作者的 `'*': 'allow'`
// （通配所有 permission 名）和平台的 `external_directory` 规则。谁胜取决于键序。
//  - E4：同一 map 内 `{'*':allow, external_directory:deny}` → deny 胜（越界拒）；
//        `{external_directory:deny, '*':allow}` → allow 胜（越界放行）。
//  - M1：把 deny 放在**顶层 config**、作者 `'*':allow` 在**agent 条目** → 条目
//        的 '*' 溶解顶层 deny（跨层键序不可控）。
// ⇒ 必须在**每个业务 agent 条目自己的 map 内**注入 external_directory，并把它
//    追加在作者所有其他键（尤其 '*'）之后。这就是本函数做的事。

import type { AgentPermission } from '@agent-workflow/shared'

/** 本次 run 的合法工作区数据源（全部取自 scheduler/runner 既有结构，不从路径形状猜）。 */
export interface BoundaryCtx {
  /** 本任务全部 mount 的 cwd/iso 路径（单仓 = [cwd]，多仓 = 每个成员）。 */
  readonly taskMounts: readonly string[]
  /** 本次 run 的 config/注入资源目录 `runs/{taskId}/{nodeRunId}`。 */
  readonly runDir: string
  /** 平台 stage 的 managed skill 目录（含 sibling 文件）。 */
  readonly stagedSkillDirs: readonly string[]
  /** 已是 glob 形态的临时目录放行项（如 `<tmpdir>/opencode/*`）——原样使用，不追加 `/*`。 */
  readonly tmpGlobs: readonly string[]
  /** linked-worktree 的 git common/admin 目录（在 worktree 外，git 操作需放行）。 */
  readonly gitMetaDirs?: readonly string[]
}

type ExternalDirRule = Record<string, 'allow' | 'deny' | 'ask'>

const isAction = (v: unknown): v is 'allow' | 'deny' | 'ask' =>
  v === 'allow' || v === 'deny' || v === 'ask'

/** 目录 → `<dir>/*`（opencode 的 `*` 跨 `/`，一条即覆盖整棵子树）。 */
function boundaryAllowGlobs(ctx: BoundaryCtx): string[] {
  const dirs = [
    ctx.runDir,
    ...ctx.stagedSkillDirs,
    ...ctx.taskMounts,
    ...(ctx.gitMetaDirs ?? []),
  ].filter((d) => d.length > 0)
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of dirs) {
    const glob = `${d.replace(/\/+$/, '')}/*`
    if (!seen.has(glob)) {
      seen.add(glob)
      out.push(glob)
    }
  }
  for (const g of ctx.tmpGlobs) {
    if (g.length > 0 && !seen.has(g)) {
      seen.add(g)
      out.push(g)
    }
  }
  return out
}

/**
 * 把工作区边界合成进一个 agent 的 permission map。
 *
 * 用于两处（同一契约）：顶层 `config.permission`（`author=undefined`，覆盖原生
 * 子代理）与每个业务 agent 条目（`author=agent.permission`）。
 *
 * 规则（键序即优先序，findLast 后者胜）：
 *   external_directory = { '*': 'deny', <boundary allow globs...>, <作者 record 白名单...> }
 * 该键整体追加在作者其他键之后 → 作者 `'*':'allow'` 无法溶解它（E4/M1）。
 *
 * 作者若把 external_directory 写成 scalar（'allow'/'deny'/'ask'）视为显式接管整键，
 * 平台不合成（`'allow'` 等于放弃边界——保存面负责告警，见 design §3.3）。
 */
export function composeOpencodeBoundary(
  author: AgentPermission | undefined,
  ctx: BoundaryCtx,
): AgentPermission {
  const src = author ?? {}
  const authorExt = src['external_directory']

  // 作者 scalar external_directory → 显式接管，原样返回（不注入基线）。
  if (isAction(authorExt)) return { ...src }

  const composed: ExternalDirRule = { '*': 'deny' }
  for (const glob of boundaryAllowGlobs(ctx)) composed[glob] = 'allow'
  // 作者 record 白名单殿后（在 deny 基线之后，findLast 让作者显式 allow 胜）。
  if (authorExt !== null && typeof authorExt === 'object' && !Array.isArray(authorExt)) {
    for (const [pattern, action] of Object.entries(authorExt as Record<string, unknown>)) {
      if (isAction(action)) composed[pattern] = action
    }
  }

  // 保序重建：作者其余键原位，external_directory 作为新键追加到**末尾**。
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(src)) {
    if (key !== 'external_directory') out[key] = value
  }
  out['external_directory'] = composed
  return out
}
