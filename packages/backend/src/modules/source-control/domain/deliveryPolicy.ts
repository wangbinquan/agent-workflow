// RFC-310 PR-5 T59 —— DeliveryPolicy 的纯判定面（design §9.0）。
//
// source branch 由平台按受限模板 + Mission marker 生成，Agent 永远不供名；
// 碰撞处理是 closed policy：同 marker 且 repository/target 一致 ⇒ 幂等 adopt，
// 普通同名 ⇒ deterministic suffix（闭区间试探）或 blocked(source-branch-
// collision)；不允许覆盖/删除未知 ref——本文件只产判定，任何 ref 写动作都在
// application 层且只走「新建或 fast-forward」。

import { stableGitRefComponent } from '@/util/gitRef'

export const MISSION_BRANCH_PREFIX = 'aw/mission-'
const SUFFIX_LIMIT = 9

/**
 * Business Case identities are not Git ref components: OS child identities,
 * for example, contain `:`. Preserve the readable legacy form when it is a
 * small closed-safe token; otherwise use a full deterministic digest. The
 * original identity remains in the commit/MR machine marker, so the ref never
 * becomes the identity authority.
 */
export function missionGitRefComponent(missionId: string): string {
  return stableGitRefComponent(missionId)
}

/** 平台生成的 source branch：`aw/mission-<合法稳定 component>`。 */
export function missionSourceBranch(missionId: string): string {
  return `${MISSION_BRANCH_PREFIX}${missionGitRefComponent(missionId)}`
}

/** 从 branch 名反解 mission marker；非本平台命名 ⇒ null。 */
export function missionMarkerOfBranch(branch: string): string | null {
  if (!branch.startsWith(MISSION_BRANCH_PREFIX)) return null
  const rest = branch.slice(MISSION_BRANCH_PREFIX.length)
  // 可能带 deterministic suffix（-2..-9）。
  const m = /^([0-9a-z]+)(?:-([2-9]))?$/.exec(rest)
  return m === null ? null : m[1]!.toUpperCase()
}

/** commit message / MR body 里的机器 marker（§9.3）。 */
export function missionMachineMarker(missionId: string): string {
  return `[aw-mission:${missionId}]`
}

export interface DeliveryContextEnvelope {
  readonly employeeCaseRef: string
  readonly issueContextRef: string
  readonly schemaRef: 'issue-handling.v1'
  readonly workItemRef: string
}

export function renderDeliveryContextEnvelope(envelope: DeliveryContextEnvelope): string {
  const line = (value: string): string =>
    value
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 1_000)
  return [
    `Agent-Workflow-Case: ${line(envelope.employeeCaseRef)}`,
    `Agent-Workflow-Context: ${line(envelope.issueContextRef)}`,
    `Agent-Workflow-Schema: ${envelope.schemaRef}`,
    `Work-Item: ${line(envelope.workItemRef)}`,
  ].join('\n')
}

export interface ExistingBranchFact {
  readonly branch: string
  /** 已存在分支的 mission marker（由消费方按 missionMarkerOfBranch 提供；无 ⇒ null）。 */
  readonly missionMarker: string | null
  readonly repositoryRef: string
  readonly targetRef: string
}

export interface ResolveSourceBranchInput {
  readonly missionId: string
  readonly repositoryRef: string
  readonly targetRef: string
  readonly existing: readonly ExistingBranchFact[]
}

export type SourceBranchResolution =
  | { readonly kind: 'create'; readonly branch: string }
  /** 同 marker 且 repository/target 一致：幂等接管既有分支。 */
  | { readonly kind: 'adopt'; readonly branch: string }
  /** 普通同名：确定性后缀（-2..-9 第一个可用）。 */
  | { readonly kind: 'create-suffixed'; readonly branch: string }
  | {
      readonly kind: 'blocked'
      readonly code: 'source-branch-collision'
      readonly detail: string
    }

export function resolveSourceBranch(input: ResolveSourceBranchInput): SourceBranchResolution {
  const wanted = missionSourceBranch(input.missionId)
  const byName = new Map(input.existing.map((row) => [row.branch, row]))
  const hit = byName.get(wanted)
  if (hit === undefined) return { kind: 'create', branch: wanted }
  if (
    hit.missionMarker !== null &&
    hit.missionMarker.toUpperCase() === input.missionId.toUpperCase()
  ) {
    if (hit.repositoryRef === input.repositoryRef && hit.targetRef === input.targetRef) {
      return { kind: 'adopt', branch: wanted }
    }
    return {
      kind: 'blocked',
      code: 'source-branch-collision',
      detail: `branch '${wanted}' carries this mission's marker but binds repository '${hit.repositoryRef}' target '${hit.targetRef}'`,
    }
  }
  for (let n = 2; n <= SUFFIX_LIMIT; n += 1) {
    const candidate = `${wanted}-${n}`
    if (!byName.has(candidate)) return { kind: 'create-suffixed', branch: candidate }
  }
  return {
    kind: 'blocked',
    code: 'source-branch-collision',
    detail: `branch '${wanted}' and all deterministic suffixes -2..-${SUFFIX_LIMIT} are taken`,
  }
}

/** §9.2：commit message 由平台模板生成——Agent 只供 summary 素材。 */
export function candidateCommitMessage(input: {
  readonly missionId: string
  readonly summarySource: string
  readonly contextEnvelope?: DeliveryContextEnvelope
}): string {
  const firstLine = input.summarySource.split('\n')[0]!.trim().slice(0, 72)
  const subject = firstLine.length === 0 ? 'apply mission change candidate' : firstLine
  const context =
    input.contextEnvelope === undefined
      ? ''
      : `\n${renderDeliveryContextEnvelope(input.contextEnvelope)}\n`
  return `aw: ${subject}\n\nMission: ${input.missionId}\n${missionMachineMarker(input.missionId)}${context}\n`
}
