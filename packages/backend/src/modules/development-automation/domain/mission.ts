// RFC-310 T22 —— DevelopmentMission 聚合状态机（design.md §2.1/§2.2/§2.3）。
//
// 纯 domain：转移表显式穷举（图 §2.2），terminal absorbing；`automationMode`
// 与业务 status 正交；cancel/handoff 是 transition fence（先 fence 新写、
// settle 已 dispatch effect、后置终态/tracking-only），不在本表里走捷径。
// 「下一步做什么」不在 status 里——那属于 DecisionReceipt（§2.1）。

export const MISSION_STATUSES = [
  'admitting',
  'awaiting-information',
  'working',
  'publishing',
  'watching',
  'waiting-committer',
  'ready-to-merge',
  'blocked',
  'merged',
  'closed-unmerged',
  'completed-no-change',
  'canceled',
] as const

export type MissionStatus = (typeof MISSION_STATUSES)[number]

export const TERMINAL_STATUSES: ReadonlySet<MissionStatus> = new Set([
  'merged',
  'closed-unmerged',
  'completed-no-change',
  'canceled',
])

/** 合法业务转移（from → to 集）；不含 fence 中间态（fence 是列，不是状态）。 */
const TRANSITIONS: Readonly<Record<MissionStatus, readonly MissionStatus[]>> = {
  admitting: ['awaiting-information', 'working', 'blocked', 'canceled'],
  'awaiting-information': ['working', 'blocked', 'canceled'],
  working: [
    'publishing',
    'awaiting-information',
    'blocked',
    'completed-no-change',
    'canceled',
    'merged',
    'closed-unmerged',
  ],
  publishing: ['watching', 'working', 'blocked', 'canceled', 'merged', 'closed-unmerged'],
  watching: [
    'working',
    'waiting-committer',
    'ready-to-merge',
    'blocked',
    'canceled',
    'merged',
    'closed-unmerged',
  ],
  'waiting-committer': [
    'working',
    'ready-to-merge',
    'watching',
    'blocked',
    'canceled',
    'merged',
    'closed-unmerged',
  ],
  'ready-to-merge': [
    'working',
    'watching',
    'waiting-committer',
    'blocked',
    'canceled',
    'merged',
    'closed-unmerged',
  ],
  blocked: ['working', 'awaiting-information', 'canceled', 'merged', 'closed-unmerged'],
  merged: [],
  'closed-unmerged': [],
  'completed-no-change': [],
  canceled: [],
}

export type TransitionFence = 'none' | 'cancel-pending' | 'handoff-pending'

export interface MissionTransitionInput {
  readonly from: MissionStatus
  readonly to: MissionStatus
  readonly fence: TransitionFence
}

export type MissionTransitionVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly code:
        | 'terminal-absorbing'
        | 'illegal-transition'
        | 'fence-blocks-non-terminal-writes'
    }

/**
 * 判定一次业务转移是否合法。fence 语义：cancel/handoff pending 期间只允许
 * 走向终态（cancel 收口）或保持不动——任何常规推进都被拒（新写已被 fence）。
 */
export function checkMissionTransition(input: MissionTransitionInput): MissionTransitionVerdict {
  if (TERMINAL_STATUSES.has(input.from)) {
    return { ok: false, code: 'terminal-absorbing' }
  }
  if (input.fence !== 'none' && !TERMINAL_STATUSES.has(input.to)) {
    return { ok: false, code: 'fence-blocks-non-terminal-writes' }
  }
  if (!TRANSITIONS[input.from].includes(input.to)) {
    return { ok: false, code: 'illegal-transition' }
  }
  return { ok: true }
}

/** MR 外部终态优先于一切普通动作（§2.2 图注 + §4.3 guard 1）。 */
export function terminalStatusForMr(mr: 'merged' | 'closed'): MissionStatus {
  return mr === 'merged' ? 'merged' : 'closed-unmerged'
}

export type MissionCommandKind =
  | 'launch'
  | 'select-requirement-source'
  | 'submit-answers'
  | 'cancel'
  | 'handoff'
  | 'resume-automation'
  | 'attach-merge-request'
  | 'retry-blocked'
  | 'configuration-upgrade'
  | 'confirm-no-change'

export interface CommandAdmissibilityInput {
  readonly command: MissionCommandKind
  readonly status: MissionStatus
  readonly automationMode: 'active' | 'tracking-only'
  readonly fence: TransitionFence
  readonly hasMergeRequest: boolean
}

export type CommandAdmissibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string }

/** 人工命令的准入（§2.3/§4.8）；每次仍需 route 层按当前 actor 重新授权。 */
export function checkCommandAdmissible(input: CommandAdmissibilityInput): CommandAdmissibility {
  const terminal = TERMINAL_STATUSES.has(input.status)
  switch (input.command) {
    case 'launch':
      return { ok: true }
    case 'select-requirement-source':
      return input.status === 'awaiting-information'
        ? { ok: true }
        : { ok: false, code: 'not-awaiting-information' }
    case 'submit-answers':
      return input.status === 'awaiting-information'
        ? { ok: true }
        : { ok: false, code: 'not-awaiting-information' }
    case 'confirm-no-change':
      // PR-5 T55a：no-change human gate 的确认——只在 awaiting-information、
      // active、无 fence 时可用；gate 是否真的挂起由命令层对 cells 复核。
      if (input.fence !== 'none') return { ok: false, code: 'transition-fence-pending' }
      if (input.automationMode !== 'active') return { ok: false, code: 'tracking-only' }
      return input.status === 'awaiting-information'
        ? { ok: true }
        : { ok: false, code: 'not-awaiting-information' }
    case 'cancel':
      if (terminal) return { ok: false, code: 'already-terminal' }
      if (input.fence === 'cancel-pending') return { ok: false, code: 'cancel-already-pending' }
      return { ok: true }
    case 'handoff':
      if (terminal) return { ok: false, code: 'already-terminal' }
      if (input.automationMode === 'tracking-only') {
        return { ok: false, code: 'already-tracking-only' }
      }
      if (input.fence !== 'none') return { ok: false, code: 'transition-pending' }
      return { ok: true }
    case 'resume-automation':
      if (terminal) return { ok: false, code: 'already-terminal' }
      if (input.automationMode !== 'tracking-only') return { ok: false, code: 'not-tracking-only' }
      if (input.fence !== 'none') return { ok: false, code: 'transition-pending' }
      return { ok: true }
    case 'attach-merge-request':
      if (terminal) return { ok: false, code: 'already-terminal' }
      if (input.hasMergeRequest) return { ok: false, code: 'mr-already-bound' }
      if (input.automationMode !== 'tracking-only') {
        // §4.8：无 MR 的 handoff 后（waiting-for-mr-attachment）才可挂接。
        return { ok: false, code: 'attach-requires-tracking-only' }
      }
      return { ok: true }
    case 'retry-blocked':
      return input.status === 'blocked' ? { ok: true } : { ok: false, code: 'not-blocked' }
    case 'configuration-upgrade':
      if (terminal) return { ok: false, code: 'already-terminal' }
      if (input.fence !== 'none') return { ok: false, code: 'transition-pending' }
      return { ok: true }
  }
}
