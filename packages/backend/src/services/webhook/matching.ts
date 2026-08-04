// RFC-257 T4 — 分流引擎的纯函数面：规则匹配 / 流键 / 熔断评估。
// 全部零 I/O，五维矩阵与并发语义的测试都落在这里（design §10「首选可断言面」）。
import type { CodeHostEvent, CodeHostEventType, WebhookRepoScope } from '@agent-workflow/shared'
import { AUTHOR_FILTERED_EVENT_TYPES } from '@agent-workflow/shared'

/** 触发器规则的运行时形态（DB 行 JSON 列解析后；wire schema 见 shared/schemas/webhook.ts）。 */
export type TriggerRule = {
  repoScope: WebhookRepoScope
  eventTypes: ReadonlyArray<CodeHostEventType>
  branchFilter?: string | null
  commandPrefix?: string | null
  ignoreUsernames: ReadonlyArray<string>
}

export type MatchMiss =
  | 'repo-scope'
  | 'event-type'
  | 'branch-filter'
  | 'command-prefix'
  | 'author-ignored'

export type MatchResult = { hit: true } | { hit: false; miss: MatchMiss }

/**
 * 极简 glob：`*` 匹配任意字符序列（含 `/`——`release/*` 也罩 `release/a/b`），
 * 其余字符字面匹配，整串锚定。空/未设 = 不过滤。
 */
export function branchGlobMatch(pattern: string, branch: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`).test(branch)
}

function repoScopeMatch(scope: WebhookRepoScope, repoPath: string): boolean {
  if (scope.kind === 'all') return true
  if (scope.kind === 'prefix') return repoPath.startsWith(scope.prefix)
  return scope.paths.includes(repoPath)
}

/**
 * 五维 AND 匹配（design §4.1）。维度顺序即 miss 报告优先级（先粗后细）。
 * 忽略名单**只作用于 push / tag_push / mr_x / note**（AUTHOR_FILTERED_EVENT_TYPES）；
 * pipeline 类事件不按作者过滤——流水线失败是客观事实，bot push 引发的失败
 * 必须能继续触发修到绿循环（设计门 F-1 / D14；作者身份改为参与熔断重置，
 * 见 evaluateCircuit）。
 */
export function matchTrigger(event: CodeHostEvent, rule: TriggerRule): MatchResult {
  if (!repoScopeMatch(rule.repoScope, event.repoPath)) return { hit: false, miss: 'repo-scope' }
  if (!rule.eventTypes.includes(event.eventType)) return { hit: false, miss: 'event-type' }
  const branchForFilter =
    event.eventType === 'mr_opened' ||
    event.eventType === 'mr_updated' ||
    event.eventType === 'mr_merged' ||
    event.eventType === 'mr_closed' ||
    event.eventType === 'note'
      ? (event.targetBranch ?? '')
      : (event.branch ?? '')
  if (
    rule.branchFilter !== undefined &&
    rule.branchFilter !== null &&
    rule.branchFilter !== '' &&
    !branchGlobMatch(rule.branchFilter, branchForFilter)
  ) {
    return { hit: false, miss: 'branch-filter' }
  }
  if (event.eventType === 'note') {
    const prefix = rule.commandPrefix ?? ''
    if (prefix !== '' && !(event.commentText ?? '').trim().startsWith(prefix)) {
      return { hit: false, miss: 'command-prefix' }
    }
  }
  if (
    AUTHOR_FILTERED_EVENT_TYPES.includes(event.eventType) &&
    event.author.username !== undefined &&
    rule.ignoreUsernames.includes(event.author.username)
  ) {
    return { hit: false, miss: 'author-ignored' }
  }
  return { hit: true }
}

/**
 * 流键（supersede 维度 + 熔断计数桶）。设计门 F-2：**必含 repo 维度**——
 * GitLab 的 MR iid 是 per-project 序号，prefix 范围罩几百仓时 `mr:42` 会跨仓
 * 同流（互相取消对方任务、熔断计数串桶）。
 */
export function streamKeyOf(event: CodeHostEvent): string {
  if (event.mrIid !== undefined) return `${event.repoPath}|mr:${event.mrIid}`
  return `${event.repoPath}|branch:${event.branch ?? ''}`
}

/** 熔断计数的惰性重置窗口：距上次触发超过该时长视为计数归零（D22 来源③）。 */
export const CIRCUIT_RESET_WINDOW_MS = 24 * 60 * 60 * 1000

export type CircuitStreamState = {
  consecutiveFires: number
  lastFireAt: number | null
}

export type CircuitDecision = {
  decision: 'pass' | 'open'
  /** true = 本事件把计数清零（launched 后从 1 重新计）——写回 streams 行。 */
  resetCount: boolean
  /** 闸门评估后的有效计数（open 时 = 达到上限的旧值）。 */
  effectiveCount: number
}

/**
 * 熔断闸门（D22，设计门 F-1 修订后的顺序）：
 *   ① 无状态 / 惰性过期（now-lastFireAt > 窗口）→ 计数视为 0；
 *   ② 事件作者 ∉ ignoreUsernames → 清零（「人已介入」；与命中过滤解耦——
 *      pipeline 事件不被名单挡在命中之外，但 bot 作者的 pipeline 失败在这里
 *      **不清零**、正常累加，人类作者清零 ⇒ 循环既能持续又有上限）；
 *   ③ 计数 ≥ 上限 → open（fire 记 skipped-circuit-open）；
 *   ④ 否则 pass（launched 后计数 +1 由调用方落库）。
 * author.username 缺失视为人类（清零）——事件已过验签，可信度 = secret 保密度。
 */
export function evaluateCircuit(
  stream: CircuitStreamState | null,
  event: CodeHostEvent,
  rule: { maxConsecutiveFires: number; ignoreUsernames: ReadonlyArray<string> },
  now: number,
): CircuitDecision {
  let count = stream?.consecutiveFires ?? 0
  const lastFireAt = stream?.lastFireAt ?? null
  if (lastFireAt !== null && now - lastFireAt > CIRCUIT_RESET_WINDOW_MS) count = 0
  const authorIsIgnored =
    event.author.username !== undefined && rule.ignoreUsernames.includes(event.author.username)
  const resetCount = !authorIsIgnored && count > 0
  if (resetCount) count = 0
  if (count >= rule.maxConsecutiveFires) {
    return { decision: 'open', resetCount: false, effectiveCount: count }
  }
  return { decision: 'pass', resetCount, effectiveCount: count }
}
