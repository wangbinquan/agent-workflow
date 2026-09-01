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

import type { AtomicDecision } from './atomic'
import type { PersistUploadPlanInput } from '../uploadPlan'
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
  /**
   * RFC-310 T81（design §10.4）—— 外部 reopen 已关闭的 MR 时**终态不逆转**：原
   * `closed-unmerged` 那条保持终态，平台另建一条新 Mission generation 接管当前
   * MR/head，这一列记住它派生自哪条。
   *
   * 声明为可选而不是 `string | null`：该列可空且默认 NULL，「不写」与「写 null」
   * 是同一个事实，可选让既有 9 处 `createMission` 调用点一个字都不用改。读侧
   * 一律从 DB 取到显式 null。
   */
  readonly reopenedFromMissionId?: string | null
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
  readonly resultRef: string | null
  readonly failureJson: string | null
}

/** RFC-310 PR-4 —— attempt 台账读侧行（重试编排与恢复扫描共用）。 */
export interface AgentAttemptRow {
  readonly id: string
  readonly actionRunId: string
  readonly rerunSeq: number
  readonly attemptSeq: number
  readonly executionRef: string | null
  readonly baselineRef: string
  readonly nonceDigest: string
  readonly inputDigest: string
  readonly status: string
  readonly rejectionJson: string | null
  readonly outcomeRef: string | null
  readonly preSnapshotRef: string | null
}

/** RFC-310 PR-7 T73 —— feedback 台账行（design §10.2）。 */
import type { FeedbackLedgerRow } from '../../domain/feedbackLedger'

export type { FeedbackLedgerRow }

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
  /**
   * PR-7b T81 —— 按 claim id 回读 MR 身份三元组。终态释放的是 claim 的 state，
   * 行本身保留，所以 reopen 时仍能从这里拿到 (endpoint, project, iid) 去重新 claim；
   * `findMrClaim` 只能反向查（已知三元组问归属），给不出这个方向。
   */
  getMrClaim(claimId: string): {
    readonly id: string
    readonly codeHostEndpointRef: string
    readonly stableProjectRef: string
    readonly mrIid: string
    readonly missionId: string
    readonly state: string
  } | null
  /** claim 撞唯一后的消歧读面：该 (endpoint,project,iid) 现归谁。 */
  findMrClaim(input: {
    readonly codeHostEndpointRef: string
    readonly stableProjectRef: string
    readonly mrIid: string
  }): { readonly id: string; readonly missionId: string; readonly state: string } | null

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
  /**
   * PR-7b T78 —— 某能力在本 Mission 上已经开过几次动作（含失败与在途）。
   * conflict repair 的 `maxRepairAttempts` 封顶靠它：预算算的是「平台替人
   * 试了几次」，失败的那几次尤其要算进去，否则封顶形同虚设。
   */
  countActionRuns(missionId: string, capabilityId: string): number

  claimAttempt(input: {
    readonly id: string
    readonly actionRunId: string
    readonly rerunSeq: number
    readonly attemptSeq: number
    readonly executionRef: string | null
    readonly baselineRef: string
    readonly nonceDigest: string
    readonly inputDigest: string
    /** PR-4：attempt pre-state 上下文的 evidence blob ref（collect/重建用）。 */
    readonly preSnapshotRef?: string | null
    readonly now: number
  }): { readonly ok: true } | { readonly ok: false; readonly code: 'attempt-ordinal-taken' }
  settleAttempt(input: {
    readonly id: string
    readonly status: 'rejected' | 'validated' | 'interrupted' | 'discarded'
    readonly rejectionJson: string | null
    readonly outcomeRef: string | null
    readonly now: number
  }): void
  /** (rerunSeq, attemptSeq) 升序——重试编排读预算、恢复扫描找悬挂 attempt。 */
  listAttempts(actionRunId: string): AgentAttemptRow[]

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

  /** PR-7 T73：feedback 观察入账。撞 (mission,thread,revision,head) 唯一键 =
   *  已观察过（webhook 重放/重复采集不重复起 action），返回 created:false。 */
  upsertFeedbackObservation(input: {
    readonly id: string
    readonly missionId: string
    readonly threadRef: string
    readonly revision: string
    readonly headSha: string
    readonly fingerprint: string
    readonly authorClass: 'human' | 'bot' | 'self'
    readonly now: number
  }): { readonly created: boolean }
  listFeedback(missionId: string): FeedbackLedgerRow[]
  setFeedbackState(input: {
    readonly id: string
    readonly state: 'observed' | 'selected' | 'addressed' | 'needs-human' | 'obsolete'
    readonly actionRunId?: string | null
    readonly replyEffectId?: string | null
    readonly now: number
  }): void
  /** 新 head 观察到时：旧 head 的未终结（observed/selected）行标 obsolete。
   *  thread 被外部 resolve/head 前进只更新事实，不伪造平台曾处理（§10.2）。 */
  obsoleteFeedbackForOtherHeads(missionId: string, currentHeadSha: string, now: number): number

  /** decision + action/effect intents 的同事务原语；回调内禁止任何外部 IO。 */
  /**
   * RFC-317 T37（CC-04）—— 回调的返回类型套 `NotPromise`。
   *
   * 这是一个**可复用的事务端口**：不加约束时 `T = Promise<X>` 完全通得过类型检查，
   * 而它的实现直接调 drizzle 的 `db.transaction`，于是 `dbTxSync` 那两道防线
   * （类型层塌成 never + 运行期 thenable 抛错）一道都不生效。bun:sqlite 下 async 回调
   * 在第一个 await 处就 COMMIT，后续语句全在 autocommit，之后再抛什么都回滚不了——
   * RFC-052 的 approve 半提交事故就是这一类。今天的调用方都是同步的，所以这是**潜伏**
   * 而不是活跃缺陷；加上约束后它连写都写不出来。
   */
  inTx<T>(fn: () => AtomicDecision<T>): T
}

export type MissionFactSnapshotWrite = Parameters<MissionStore['insertFactSnapshot']>[0]
export type MissionDecisionWrite = Parameters<MissionStore['insertDecision']>[0]
export type MissionDecisionWriteReceipt = ReturnType<MissionStore['insertDecision']>

export interface MissionLaunchWrite {
  readonly mission: MissionRow
  readonly source: MissionSourceRow & { readonly createdAt: number }
  readonly upload: {
    readonly actorUserId: string | null
    readonly uploadRefs: readonly string[]
    readonly plan: PersistUploadPlanInput
    readonly now: number
  } | null
}

/**
 * Closed asynchronous persistence used by live provider composition. The
 * generic transaction callback is deliberately replaced by one named atomic
 * operation so application code cannot perform network I/O inside a storage
 * transaction or accidentally use an unbound client.
 */
export type MissionPersistence = {
  readonly [K in Exclude<keyof MissionStore, 'inTx'>]: MissionStore[K] extends (
    ...args: infer Args
  ) => infer Result
    ? (...args: Args) => Promise<Awaited<Result>>
    : never
} & {
  /** Mission, source provenance and optional upload claim/plan commit atomically. */
  commitMissionLaunch(
    input: MissionLaunchWrite,
  ): Promise<{ readonly created: boolean; readonly mission: MissionRow }>
  commitFactSnapshotAndDecision(input: {
    readonly snapshot: MissionFactSnapshotWrite
    readonly decision: MissionDecisionWrite
  }): Promise<MissionDecisionWriteReceipt>
}
