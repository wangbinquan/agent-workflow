// RFC-355 T4（RFC-294 W4-E4a）—— apply 大事务里**能算的那一半**，两个 provider 共用一份。
//
// 两个 provider 的 apply 编排（`sqliteIntentApplyOperations` / `postgresqlIntentApplyOperations`）
// 逐段对照下来只有一处真差别：**事务机制**——SQLite 的 `dbTxSync` 是同步回调，PostgreSQL 的
// `db.transaction` 是 async。RFC-353 已经实测过：同步事务回调里 `await` 会让事务在 Promise
// 兑现前提交。所以事务边界必须留在 provider，不能塞进 application。
//
// 但**事务里做的事**并不都是机制。CAS 之后那一大段——基线是否还新鲜、这一 bundle 要创建哪些
// 名字、plan 与 op 是否同序、receipt 的 applied 行、来源谱系与新 manifest、handle 水位、
// 下一个 commitSeq —— 全是可以先算完再写的**纯计算**，此前在两个文件里各抄了一份约 120 行。
// 判据抄两份的代价 RFC-355 T1 已经实测过一次（同一处 changeset 校验，SQLite 裸 `JSON.parse`、
// PostgreSQL 有校验，用户看到的错误形状取决于部署选了哪个数据库）。
//
// 于是这里的分法是：**provider 开事务、读 `sessionNow`、按自己的同步 / async 风格执行写入；
// 计算全部走这一份**。provider 侧剩下的是「怎么读怎么写怎么开事务」，正是 RFC-294 给
// infrastructure 划的职责。

import { ConflictError } from '@/util/errors'
import {
  applyCommitMounts,
  createHandleAllocator,
  handleWatermarkOf,
  lineageRootOf,
  mergeHandleWatermarks,
  parseHandleWatermark,
  type IntentContextManifest,
} from './manifest'
import type { ResolvedIntentOp } from './resolveChangeset'
import type { IntentApplyReceipt } from './ports/intentApplyOperations'

/** claim 段认下来的会话基线（两个 provider 的行类型不同，这里只要这四个字段）。 */
export interface IntentApplyClaimBaseline {
  readonly contextRevision: number
  readonly commitSeq: number
  readonly handleWatermarkJson: string
}

/** 事务里重读到的会话行（同上，只取判据要的字段）。 */
export interface IntentApplySessionSnapshot {
  readonly contextRevision: number
  readonly currentDraftId: string | null
  readonly inFlightTurnId: string | null
  readonly contextManifestJson: string
}

/**
 * 大事务里的基线重验（Codex impl-gate P1-1）。
 *
 * claim 时的检查挡不住 prestage 窗口——npm install / 技能暂存期间会话可能被 rebase、挂载、
 * 或生成了新草稿。这里在**提交事务内**重新认一次身份，然后下面的 epoch 自增才建立在真正
 * 验过的值上。`sessionNow === undefined` 与三项不符同形，都是 `intent-baseline-stale`。
 */
export function assertIntentApplyBaselineFresh(input: {
  readonly claimSession: IntentApplyClaimBaseline
  readonly claimDraftId: string
  readonly sessionNow: IntentApplySessionSnapshot | undefined
}): asserts input is typeof input & { readonly sessionNow: IntentApplySessionSnapshot } {
  const sessionNow = input.sessionNow
  if (
    sessionNow === undefined ||
    sessionNow.contextRevision !== input.claimSession.contextRevision ||
    sessionNow.currentDraftId !== input.claimDraftId ||
    sessionNow.inFlightTurnId !== null
  ) {
    throw new ConflictError(
      'intent-baseline-stale',
      'the session changed while the apply was staging; rebase and regenerate',
    )
  }
}

/** 事务里做重名校验时要知道「这一 bundle 自己正在创建哪些名字」。 */
export interface IntentBundleCreatedNames {
  readonly workflow: Set<string>
  readonly workgroup: Set<string>
}

/**
 * 本 bundle 将要创建的 workflow / workgroup 名字。
 *
 * 读的是**已解析的 plan**（finalName 覆盖已经生效），不是原始 changeset。
 */
export function bundleCreatedNamesOf(
  plans: readonly {
    readonly action: string
    readonly kind: string
    readonly payload: unknown
  }[],
): IntentBundleCreatedNames {
  const created: IntentBundleCreatedNames = { workflow: new Set(), workgroup: new Set() }
  for (const plan of plans) {
    if (plan.action !== 'create') continue
    const bucket =
      plan.kind === 'workflow'
        ? created.workflow
        : plan.kind === 'workgroup'
          ? created.workgroup
          : null
    if (bucket === null) continue
    const name = (plan.payload as { readonly name?: unknown }).name
    if (typeof name === 'string' && name.length > 0) bucket.add(name)
  }
  return created
}

/**
 * plan 与 op 必须同序同 id——receipt 的每一行都按下标从 op 取值，错位会把 A 的结果记到 B 上。
 * 这不是用户可见错误，是编排自身的不变量，所以抛裸 `Error`（与迁移前逐字一致）。
 */
export function requireOpForPlan(
  operation: ResolvedIntentOp | undefined,
  plan: { readonly operationId: string },
): ResolvedIntentOp {
  if (operation === undefined || operation.opId !== plan.operationId) {
    throw new Error('intent-resource-plan-order-mismatch')
  }
  return operation
}

/** receipt 里的一行。 */
export function appliedEntryOf(operation: ResolvedIntentOp): IntentApplyReceipt['applied'][number] {
  return {
    opId: operation.opId,
    resourceType: operation.resourceType,
    resourceId: operation.resourceId,
    action: operation.action,
    fromCopy: operation.fromCopy,
    name: (operation.payload as { readonly name: string }).name,
  }
}

/** 提交事务要落的那一组会话侧写入（provider 负责按自己的机制执行）。 */
export interface IntentApplyCommitMutation {
  readonly commitSeq: number
  readonly contextRevision: number
  readonly contextManifestJson: string
  readonly handleWatermarkJson: string
}

/**
 * 关闭上下文代次（design-gate P1-5）+ 挂载迁移（RFC-291 面 A/B），一次算完。
 *
 * **挂载必须与资源同一个事务**：放到事务后面会留下「资源已落、挂载没跟上」的窗口，而
 * `convergeIntentApplyJournal` 只对 `committed` 行重放文件系统侧的前滚，从不重放大事务，
 * 这个窗口没有任何东西会修——那正是本 RFC 要消除的缺陷。
 *
 * 谱系记的是**根**不是直接来源：C1（O 的副本）再被复制成 C2 时记 O。记 C1 会破坏「只保留
 * 最新副本」——O→C1→C2 之后再 O→C3，会退役 C1 而留下 C2，出现两个根（design-gate P1-c）。
 *
 * `action` 是**归一化后**的动作（resolveChangeset），copy 已经算作 create，不需要第二个判据。
 */
export function intentApplyCommitMutationOf(input: {
  readonly claimSession: IntentApplyClaimBaseline
  /** 事务内重读到的、已被基线判据认过的那一行的 manifest JSON。 */
  readonly preCommitManifestJson: string
  readonly ops: readonly ResolvedIntentOp[]
}): IntentApplyCommitMutation {
  const preCommitManifest = JSON.parse(input.preCommitManifestJson) as IntentContextManifest
  const preCommitByHandle = new Map(
    preCommitManifest.map((entry) => [entry.handle, entry] as const),
  )
  const copySourceHandles: string[] = []
  const lineageOriginByResourceId = new Map<string, string>()
  for (const operation of input.ops) {
    const sourceHandle = operation.copiedFromHandle
    if (sourceHandle === undefined) continue
    copySourceHandles.push(sourceHandle)
    const sourceEntry = preCommitByHandle.get(sourceHandle)
    // 解析不出来的 handle 退化成「挂上副本、不追谱系」而不是让提交失败：只有会话在脚下
    // 变过才会缺这一项，而上面的基线判据已经排除了那种情况。
    if (sourceEntry !== undefined) {
      lineageOriginByResourceId.set(operation.resourceId, lineageRootOf(sourceEntry))
    }
  }
  const nextManifest = applyCommitMounts(preCommitManifest, {
    // 读已解析的 op 而不是 receipt：receipt 里的 resourceType 是 wire 层字符串，
    // 这里要的是规范联合类型。
    created: input.ops
      .filter((operation) => operation.action === 'create')
      .map((operation) => {
        const origin = lineageOriginByResourceId.get(operation.resourceId)
        return {
          resourceType: operation.resourceType,
          resourceId: operation.resourceId,
          ...(origin === undefined ? {} : { copiedFromResourceId: origin }),
        }
      }),
    unmountHandles: copySourceHandles,
  })
  return {
    commitSeq: input.claimSession.commitSeq + 1,
    contextRevision: input.claimSession.contextRevision + 1,
    contextManifestJson: JSON.stringify(nextManifest),
    // 面 F —— create 在这里也会铸出 handle，水位必须跟着走，否则后一个代次可能把同一个序号
    // 再发给别的行。
    handleWatermarkJson: JSON.stringify(
      mergeHandleWatermarks(
        parseHandleWatermark(input.claimSession.handleWatermarkJson),
        handleWatermarkOf(createHandleAllocator(nextManifest)),
      ),
    ),
  }
}
