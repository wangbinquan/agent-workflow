// RFC-310 PR-2 —— Mission 持久化 port（T23/T25/T27/T28 的存储合同）。
//
// 并发模型：**OCC 即 lease**。每次 mutation 都携带 (expectedRevision,
// expectedEpoch)；单 daemon 内并发 reconcile、旧 continuation、fence 之后的
// 迟到写全部被 revision/epoch 挡在存储层——不建内存锁（daemon 重启后内存锁
// 是谎言，行版本不是）。写路径的唯一性兜底全部落在 0177 的唯一索引上：
// launch idempotency、active MR claim、writable action 单活、attempt ordinal、
// effect idempotency、decision input 去重——进程内检查只是好错误信息，索引
// 才是不变量。
//
// outbox：`development_effects` 表兼职 outbox——`prepared` 行就是待派发队列
// （worker 扫 listPreparedEffects），不另建 outbox 表：effect 行本来就要求
// intent 与 decision 同事务落库、idempotency key 唯一、崩溃后可重扫，单独的
// outbox 表只会引入两行漂移的可能。外部执行永远发生在事务之外。

import type { TransitionFence, MissionStatus } from '../../domain/mission'
import type { DeferredWakeRow } from '../../domain/deferredWake'

export interface MissionRow {
  readonly id: string
  readonly revision: number
  readonly epoch: number
  readonly status: MissionStatus
  readonly automationMode: 'active' | 'tracking-only'
  readonly transitionFence: TransitionFence
  readonly repositoryId: string
  readonly sourceKind: 'direct' | 'external-reference'
  readonly sourceContentDigest: string | null
  readonly requestedSourceKey: string | null
  readonly externalId: string | null
  readonly resolvedSourceKey: string | null
  readonly resolvedAdapterId: string | null
  readonly resolvedAdapterRevision: number | null
  readonly deliveryKind: 'create-merge-request' | 'adopt-merge-request'
  readonly deliveryTargetRef: string | null
  readonly deliverySourceBranch: string | null
  readonly adoptedMrRef: string | null
  readonly assignmentId: string | null
  readonly employeeId: string | null
  readonly employeeRevision: number | null
  readonly policyId: string | null
  readonly policyRevision: number | null
  readonly requirementBundleRef: string | null
  readonly repositoryFactsRef: string | null
  readonly uploadPlanRef: string | null
  readonly uploadPlacementRef: string | null
  readonly uploadPublicationRef: string | null
  readonly mrClaimId: string | null
  readonly currentActionRunId: string | null
  readonly readinessJson: string | null
  readonly blockCode: string | null
  readonly blockDetail: string | null
  readonly terminalKind: string | null
  readonly terminalUploadFulfillment: string | null
  readonly terminalAt: number | null
  readonly launchIdempotencyKey: string | null
  readonly createdBy: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export type MissionPatch = Partial<
  Omit<MissionRow, 'id' | 'revision' | 'epoch' | 'createdAt' | 'launchIdempotencyKey'>
>

export type OccResult =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly code: 'revision-conflict' | 'epoch-conflict' | 'not-found' }

export interface MissionSourceRow {
  readonly id: string
  readonly missionId: string
  readonly generation: number
  readonly sourceKind: 'direct' | 'external-reference'
  readonly externalId: string | null
  readonly adapterId: string | null
  readonly adapterRevision: number | null
  readonly sourceRevision: string | null
  readonly bundleRef: string | null
  readonly manifestDigest: string | null
  readonly fileCount: number | null
  readonly totalBytes: number | null
  readonly state: string
}

export interface EffectRow {
  readonly id: string
  readonly missionId: string
  readonly actionRunId: string | null
  readonly effectKind: string
  readonly intentDigest: string
  readonly idempotencyKey: string
  readonly epoch: number
  readonly state: 'prepared' | 'dispatched' | 'confirmed' | 'invalidated' | 'failed'
  readonly receiptRef: string | null
}

export interface ActionRunRow {
  readonly id: string
  readonly missionId: string
  readonly decisionId: string
  readonly capabilityId: string
  readonly writable: boolean
  readonly status: string
}

export interface MissionStore {
  /** launchIdempotencyKey 撞唯一索引 ⇒ 返回既有行（HTTP 重试幂等）。 */
  createMission(row: MissionRow): { readonly created: boolean; readonly mission: MissionRow }
  getMission(id: string): MissionRow | null
  findByIdempotencyKey(key: string): MissionRow | null
  /** OCC 写：revision 必须严格匹配且 epoch 未前进；成功后 revision+1。 */
  occUpdate(
    missionId: string,
    expectedRevision: number,
    expectedEpoch: number,
    patch: MissionPatch,
  ): OccResult
  /** cancel/handoff/resume/upgrade 专用：epoch+1 使一切在途 continuation 过期。 */
  bumpEpoch(missionId: string, expectedRevision: number, patch: MissionPatch): OccResult

  insertMissionSource(row: MissionSourceRow & { readonly createdAt: number }): void
  listMissionSources(missionId: string): MissionSourceRow[]

  claimMr(input: {
    readonly id: string
    readonly codeHostEndpointRef: string
    readonly stableProjectRef: string
    readonly mrIid: string
    readonly missionId: string
    readonly epoch: number
    readonly headSha: string | null
    readonly now: number
  }): { readonly ok: true } | { readonly ok: false; readonly code: 'mr-owned-by-another-mission' }
  releaseMr(claimId: string, now: number): void

  /** delivery_key 幂等：同键第二次记录返回 accepted=false。 */
  recordWakeHint(input: {
    readonly id: string
    readonly missionId: string
    readonly source: string
    readonly deliveryKey: string
    readonly now: number
  }): { readonly accepted: boolean }
  consumeWakeHints(missionId: string, now: number): number

  armWake(input: {
    readonly id: string
    readonly missionId: string
    readonly decisionId: string
    readonly reason: string
    readonly resumeAt: number | null
    readonly wakeSources: readonly DeferredWakeRow['wakeSources'][number][]
    readonly attemptOrdinal: number
    readonly now: number
  }): void
  getWake(missionId: string, decisionId: string): (DeferredWakeRow & { readonly id: string }) | null
  /** fire：armed→fired；early 唤醒不清零 ordinal（domain/deferredWake 语义）。 */
  fireWake(id: string, now: number): boolean
  settleWake(id: string, now: number): void
  listDueWakes(now: number): (DeferredWakeRow & { readonly id: string })[]

  insertFactSnapshot(input: {
    readonly id: string
    readonly missionId: string
    readonly missionRevision: number
    readonly capturedAt: string
    readonly cellsJson: string
    readonly refsJson: string
    readonly digest: string
    readonly now: number
  }): void

  /** (mission, decision_input_digest) 撞唯一 ⇒ 返回既有 decision id（同 snapshot 重复 reconcile 去重）。 */
  insertDecision(input: {
    readonly id: string
    readonly missionId: string
    readonly missionRevision: number
    readonly policyId: string | null
    readonly policyRevision: number | null
    readonly employeeId: string | null
    readonly employeeRevision: number | null
    readonly factSnapshotId: string | null
    readonly factDigest: string
    readonly workSetJson: string | null
    readonly guardTraceJson: string
    readonly ruleTraceJson: string
    readonly selectedJson: string
    readonly canonicalDigest: string
    readonly decisionInputDigest: string
    readonly now: number
  }): { readonly created: boolean; readonly decisionId: string }

  createActionRun(input: {
    readonly id: string
    readonly missionId: string
    readonly missionRevision: number
    readonly decisionId: string
    readonly capabilityId: string
    readonly capabilityContractVersion: number
    readonly templateId: string | null
    readonly templateRevision: number | null
    readonly workSetDigest: string | null
    readonly inputFactDigest: string
    readonly baselineRef: string | null
    readonly writable: boolean
    readonly now: number
  }):
    | { readonly ok: true }
    | { readonly ok: false; readonly code: 'writable-action-already-active' }
  settleActionRun(input: {
    readonly id: string
    readonly status: 'settled' | 'invalidated' | 'failed' | 'canceled'
    readonly resultRef: string | null
    readonly failureJson: string | null
    readonly now: number
  }): void
  getActionRun(id: string): ActionRunRow | null

  claimAttempt(input: {
    readonly id: string
    readonly actionRunId: string
    readonly rerunSeq: number
    readonly attemptSeq: number
    readonly executionRef: string | null
    readonly baselineRef: string
    readonly nonceDigest: string
    readonly inputDigest: string
    readonly now: number
  }): { readonly ok: true } | { readonly ok: false; readonly code: 'attempt-ordinal-taken' }
  settleAttempt(input: {
    readonly id: string
    readonly status: 'rejected' | 'validated' | 'interrupted' | 'discarded'
    readonly rejectionJson: string | null
    readonly outcomeRef: string | null
    readonly now: number
  }): void

  /** idempotency key 撞唯一 ⇒ 返回既有行（不重复准备同一 effect）。 */
  prepareEffect(input: {
    readonly id: string
    readonly missionId: string
    readonly actionRunId: string | null
    readonly effectKind: string
    readonly intentDigest: string
    readonly idempotencyKey: string
    readonly epoch: number
    readonly now: number
  }): { readonly created: boolean; readonly effect: EffectRow }
  /** prepared→dispatched→confirmed|invalidated|failed；非法迁移抛 typed 错误。 */
  markEffectDispatched(id: string, now: number): void
  confirmEffect(id: string, receiptRef: string, now: number): void
  invalidateEffect(id: string, now: number): void
  failEffect(id: string, failureJson: string, now: number): void
  getEffect(id: string): EffectRow | null
  listUnsettledEffects(missionId: string): EffectRow[]
  listPreparedEffects(): EffectRow[]

  /** decision + action/effect intents 的同事务原语；回调内禁止任何外部 IO。 */
  inTx<T>(fn: () => T): T
}
