// RFC-317 T44（DE-06）—— 数字员工 Case 的终态种类词汇。
//
// 放在 shared 而不是后端模块里：它有三个消费者——后端任务目录适配器、后端协作 join、
// 以及**前端**的展示分桶（components/digital-employees/outcomes.ts）。前端 import 不到
// 后端模块，词汇留在后端就必然在前端被再抄一遍，而再抄一遍正是本条 finding 的成因。

/**
 * RFC-317 T44（DE-06）—— OS Case 的终态种类，**闭合联合**。
 *
 * 改造前这是一个无 schema 的自由字符串，在四个互不相干的地方被铸出来
 * （类型包按 MR 状态铸 'merged'|'closed'、store 默认 'completed'、重试耗尽铸
 * 'execution-failed'、协作超时铸 'deadline-exceeded'、HTTP 路由接受任意字符串），
 * 然后被**三张互不一致的手写分类表**解读。其中两张已经是错的：
 *   · 任务目录那张认的是 'closed-unmerged'——那是**旧版 Mission** 的终态词，OS 从来
 *     不产出它；OS 真正铸的 'closed' 于是掉进兜底，被报成 status='done'。按状态筛
 *     canceled 会漏掉它们，而它们显示成"完成"。
 *   · 协作 join 那张写的是 'cancelled'（双 L），而全仓其它每一处都写 'canceled'——
 *     一个以 'canceled' 终结的 Case 会被判成 satisfied。
 *
 * 联合本身**只约束新写入**：库里存量行可能带任意历史字符串（路由曾经放行任何值），
 * 所以读侧一律走 `classifyTerminalKind`，它对未知值有显式兜底。
 */
export const EMPLOYEE_CASE_TERMINAL_KINDS = [
  'completed',
  'merged',
  'closed',
  'canceled',
  'execution-failed',
  'deadline-exceeded',
] as const

export type EmployeeCaseTerminalKind = (typeof EMPLOYEE_CASE_TERMINAL_KINDS)[number]

/**
 * 旧版 development Mission 的终态词。
 *
 * OS 不产出它们，但库里存量行与旧读路径仍会遇到——分类表必须认得，否则它们会掉进
 * 「未知」兜底，而兜底的语义与它们当年的语义未必一致。
 */
export const LEGACY_MISSION_TERMINAL_KINDS = [
  'closed-unmerged',
  'no-change-confirmed',
  'completed-no-change',
] as const

export type LegacyMissionTerminalKind = (typeof LEGACY_MISSION_TERMINAL_KINDS)[number]

/** 前端员工卡片的展示分桶。 */
export type TerminalOutcomeBucket = 'merged' | 'noChange' | 'failed' | 'otherFinished'

/** 终态的三个消费维度：任务目录状态、协作 join 结果、前端展示分桶。 */
export interface TerminalKindClassification {
  /** 任务目录里报成哪个 TaskStatus 家族。 */
  readonly catalog: 'done' | 'canceled'
  /** 协作 join 是否判为失败。 */
  readonly failed: boolean
  /** 前端员工卡片落哪个桶。 */
  readonly bucket: TerminalOutcomeBucket
}

const OS_TERMINAL_CLASSIFICATION = {
  completed: { catalog: 'done', failed: false, bucket: 'otherFinished' },
  merged: { catalog: 'done', failed: false, bucket: 'merged' },
  // ← 本次修的 bug 之一：OS 铸的是 'closed'，旧表认的却是 'closed-unmerged'。
  closed: { catalog: 'canceled', failed: true, bucket: 'otherFinished' },
  canceled: { catalog: 'canceled', failed: true, bucket: 'otherFinished' },
  // 保留改造前的目录口径（掉兜底 ⇒ 'done'）。把它改成 'failed' 是产品判断，
  // 不在本次「把三张走散的表并成一张」的范围内——改了会让既有列表的显示变化。
  // bucket 'failed' 保留改造前的口径：旧规则是 `terminalKind.endsWith('-failed')`。
  'execution-failed': { catalog: 'done', failed: true, bucket: 'failed' },
  'deadline-exceeded': { catalog: 'done', failed: true, bucket: 'otherFinished' },
} satisfies Record<EmployeeCaseTerminalKind, TerminalKindClassification>

const LEGACY_TERMINAL_CLASSIFICATION = {
  'closed-unmerged': { catalog: 'canceled', failed: true, bucket: 'otherFinished' },
  'no-change-confirmed': { catalog: 'done', failed: false, bucket: 'noChange' },
  'completed-no-change': { catalog: 'done', failed: false, bucket: 'noChange' },
} satisfies Record<LegacyMissionTerminalKind, TerminalKindClassification>

/**
 * 分类一个终态种类。**唯一**的解读入口。
 *
 * 未知值（库里的历史字符串、或将来某个还没进联合的新词）走显式兜底，而不是掉进
 * 某张表的 `else`——兜底与「表里明确写着」在读代码时必须分得开。
 */
export function classifyTerminalKind(kind: string | null): TerminalKindClassification {
  if (kind === null) return { catalog: 'done', failed: false, bucket: 'otherFinished' }
  const os = (OS_TERMINAL_CLASSIFICATION as Record<string, TerminalKindClassification | undefined>)[
    kind
  ]
  if (os !== undefined) return os
  const legacy = (
    LEGACY_TERMINAL_CLASSIFICATION as Record<string, TerminalKindClassification | undefined>
  )[kind]
  if (legacy !== undefined) return legacy
  // 未知：沿用改造前掉兜底时的语义（目录报 done、join 不判失败）。分桶那一维保留
  // 前端的旧后缀规则——`*-failed` 与 'failed' / 'blocked' 归失败桶，其余归 otherFinished，
  // 因为库里的历史值与运维手写的终态词都会落在这里，让它们从总数里消失比归错桶更糟。
  const legacyFailed = kind === 'failed' || kind === 'blocked' || kind.endsWith('-failed')
  return { catalog: 'done', failed: false, bucket: legacyFailed ? 'failed' : 'otherFinished' }
}

/**
 * Known persisted terminal kinds that the unified task catalog presents as
 * canceled. SQL-backed readers consume this derived list instead of copying a
 * second terminal-kind classification table.
 */
export const EMPLOYEE_TERMINAL_CATALOG_CANCELED_KINDS = [
  ...EMPLOYEE_CASE_TERMINAL_KINDS,
  ...LEGACY_MISSION_TERMINAL_KINDS,
].filter((kind) => classifyTerminalKind(kind).catalog === 'canceled')
