// RFC-271 T9 —— `BundleApply` 引擎本体，从 `services/intent/applyChangeset.ts` 泛化。
//
// 外部不变量：一个 bundle 的每个资源**要么全部终态可见、要么零个可见**；同一个
// `(scope,key)` 至多生效一次。
//
// 五段生命周期（编号对应 `invariants.md` 的 I 项）：
//
//   ① claim     一个事务内：**duplicate 查询先于其它校验**（I2），命中按**三态**
//               回答（I3）；然后 provider 的场景校验，最后插 journal 'prepared'。
//   ② pre-stage FS / 安装副作用。每一项在**动手之前**先把「足以精确补偿它」的信息
//               写进 journal artifacts（I14 record-before-act）。
//   ③ big tx    CAS prepared→applying（I6）→ provider 二次校验 → 每个 op 的 commit
//               内核 + 引用 ACL 复核 + owner 断言 + receipt + journal committed，
//               **全部同事务**（I13 / I7）。
//   ④ 幂等尾    publish / broadcast。失败无害，收敛会重放。
//   ⑤ 收敛      启动 + 每小时：prepared/applying → 逆序补偿 → failed；
//               committed → 重放幂等尾。带 **active set + 10 分钟下限**（I9）。
//
// ⚠️ **DB 提交之后的任何异常都不得补偿、也不得改写 journal**（I8）。
// `committedReceipt !== null` 这个哨兵是整个错误处理的分水岭——写 catch 块时把
// 补偿逻辑一并放进去是最自然的手滑，而那会把一次**已经成功**的导入回滚掉。

import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { resourceBundleApplies } from '@/db/schema'
import {
  compensateLegacyResourcePackageArtifact,
  createLegacyResourcePackageMutationAdapter,
  rollForwardLegacyResourcePackageArtifacts,
  type PreparedResourcePackageMutation,
  type ResourcePackageMutationArtifact,
} from '@/modules/resource-catalog/public/operations'
import { ConflictError } from '@/util/errors'
import { createLogger, type Logger } from '@/util/log'
import {
  planBundleOps,
  type BundleApplyInput,
  type BundleArtifact,
  type BundleReceipt,
} from './provider'
import { lowerBundlePayloads } from './lower'

export interface BundleApplyDeps {
  db: DbClient
  appHome: string
  log?: Logger
  pluginInstallOpts?: { pluginsDir?: string; npmBin?: string; timeoutMs?: number }
  /** 测试注入点：在生命周期的确定位置抛错，验证补偿与收敛。 */
  faults?: {
    afterPluginInstall?: () => void
    afterSkillStage?: () => void
    beforeTx?: () => void
    inTxAfterOps?: () => void
    afterTxBeforeRollForward?: () => void
    /** Test-only: fail a specific compensation attempt without corrupting the filesystem. */
    beforeArtifactCompensation?: (artifact: BundleArtifact) => void
  }
}

// --- I1 串行：按 provider 给的 `serializationKey`，**不是**幂等 namespace ---

const applyLocks = new Map<string, Promise<unknown>>()

async function withApplyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = applyLocks.get(key) ?? Promise.resolve()
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  // ⚠️ map 里存的是**派生**的 chain，不是 `gate` 本身。清理时必须比较同一个引用：
  // 拿 `gate` 去比 `applyLocks.get(key)` 恒为 false，于是每个出现过的
  // serializationKey 都会永久留一项 —— 串行语义仍对，但那是一处内存泄漏，
  // 而 serializationKey 是按资源实例派生的（基数无上限）。
  const chain = prior.then(() => gate)
  applyLocks.set(key, chain)
  await prior.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
    // 只有**最后一个** waiter 能删：中途完成的那些，map 早被后来者覆盖成新 chain。
    if (applyLocks.get(key) === chain) applyLocks.delete(key)
  }
}

/** I9：本进程正在跑的 journal，收敛器绝不能把它们当成崩溃残留。 */
const ACTIVE_BUNDLE_APPLIES = new Set<string>()
/** I9：再加一条下限——一个慢 npm 安装跨过小时 tick 是 ACTIVE，不是崩溃。 */
const CONVERGE_MIN_AGE_MS = 10 * 60 * 1000

export async function applyResourceBundle(
  deps: BundleApplyDeps,
  input: BundleApplyInput,
): Promise<BundleReceipt> {
  return withApplyLock(input.provider.serializationKey, () => applyInner(deps, input))
}

async function applyInner(deps: BundleApplyDeps, input: BundleApplyInput): Promise<BundleReceipt> {
  const log = deps.log ?? createLogger('bundleApply')
  const { db } = deps
  const { provider } = input
  const actor = provider.actor
  const journalId = ulid()
  const { scope, key } = provider.idempotencyKey

  // ── ① claim ────────────────────────────────────────────────────────────
  // 顺序是承重的（I2）：duplicate 查询**先于**任何业务校验。排在后面的话，一次
  // 已 committed 的重放会因为此后状态变化而报错，而不是返回原 receipt。
  const replay = dbTxSync(db, (tx) => {
    const existing = tx
      .select()
      .from(resourceBundleApplies)
      .where(and(eq(resourceBundleApplies.scope, scope), eq(resourceBundleApplies.key, key)))
      .get()
    if (existing !== undefined) return existing
    provider.claimInTx?.(tx)
    const now = Date.now()
    tx.insert(resourceBundleApplies)
      .values({
        id: journalId,
        scope,
        key,
        actorUserId: actor.user.id,
        state: 'prepared',
        preparedArtifactsJson: '[]',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    return null
  })

  if (replay !== null) return replayBundleApplyOutcome(replay)

  // I9：claim 一成功**立刻**注册。晚于 pre-stage 会留下「本进程在跑、收敛器却
  // 看不见」的窗口，那正好是最长的一段（npm 安装 / 技能暂存）。
  ACTIVE_BUNDLE_APPLIES.add(journalId)

  const artifacts: BundleArtifact[] = []
  const recordArtifact = (artifact: BundleArtifact): void => {
    artifacts.push(artifact)
    dbTxSync(db, (tx) => {
      tx.update(resourceBundleApplies)
        .set({ preparedArtifactsJson: JSON.stringify(artifacts), updatedAt: Date.now() })
        .where(eq(resourceBundleApplies.id, journalId))
        .run()
    })
  }
  const settleFailed = (error: unknown): void => {
    dbTxSync(db, (tx) => {
      tx.update(resourceBundleApplies)
        .set({
          state: 'failed',
          error:
            error instanceof Error
              ? `${(error as { code?: string }).code ?? 'error'}: ${error.message}`
              : String(error),
          updatedAt: Date.now(),
        })
        .where(eq(resourceBundleApplies.id, journalId))
        .run()
    })
  }

  const mutationAdapter = createLegacyResourcePackageMutationAdapter({
    db,
    appHome: deps.appHome,
    actor,
    ...(deps.pluginInstallOpts === undefined ? {} : { pluginInstallOpts: deps.pluginInstallOpts }),
    ...(deps.faults?.afterPluginInstall === undefined
      ? {}
      : { afterPluginInstall: deps.faults.afterPluginInstall }),
    ...(deps.faults?.afterSkillStage === undefined
      ? {}
      : { afterSkillStage: deps.faults.afterSkillStage }),
  })
  let committedReceipt: BundleReceipt | null = null

  try {
    // ── preflight ────────────────────────────────────────────────────────
    // 规划（I4）→ 预铸 id（I5，**必须早于 preflight**）→ 引用回填 → 各 prepare* 内核。
    const planned = planBundleOps(input.bundle.ops)
    const lowered = await lowerBundlePayloads(db, planned, provider)
    const pendingIds = new Set(
      lowered.filter((o) => o.action === 'create').map((o) => o.resourceId),
    )
    const pendingAgentNames = new Map(
      lowered
        .filter((o) => o.action === 'create' && o.resourceType === 'agent')
        .map((o) => [o.resourceId, (o.payload as { name: string }).name]),
    )

    const preparedOps: PreparedResourcePackageMutation[] = []
    for (const op of lowered) {
      preparedOps.push(await mutationAdapter.prepare(op, { pendingIds, pendingAgentNames, key }))
    }

    // ── ② pre-stage（record-before-act） ─────────────────────────────────
    for (const item of preparedOps) {
      await mutationAdapter.prestage(item, {
        readSkillFile: provider.readSkillFile,
        recordArtifact: (artifact) => recordArtifact(artifact),
      })
    }

    deps.faults?.beforeTx?.()

    // ── ③ big tx ─────────────────────────────────────────────────────────
    const applied: BundleReceipt['applied'] = []
    const receipt = dbTxSync(db, (tx) => {
      const cas = tx
        .update(resourceBundleApplies)
        .set({ state: 'applying', updatedAt: Date.now() })
        .where(
          and(eq(resourceBundleApplies.id, journalId), eq(resourceBundleApplies.state, 'prepared')),
        )
        .run()
      if ((cas as unknown as { changes?: number }).changes !== 1) {
        throw new ConflictError('bundle-apply-unsettled', 'journal claim lost')
      }

      // I6：CAS 之后、任何 commit 内核之前。pre-stage 窗口足够长（npm 安装 / 技能
      // 暂存），claim 期校验过的东西在这里可能已经过期。
      provider.revalidateInTx?.(tx)

      // T12：**每个 update 目标**在提交事务里断言 owner。这是 §5.4 的核心——
      // 内容 hash 只证明「我读到的是这一版」，不是授权。
      mutationAdapter.assertUpdateTargetsOwnedInTx(tx, lowered)

      // 设计门 B3：本 bundle 正在创建的名字要从引用 ACL 复核里排除——那些行是
      // actor 在**这个事务里**创建的，没有别人的行可以躲在同名背后。
      const bundleCreatedNames = { workflow: new Set<string>(), workgroup: new Set<string>() }
      for (const op of lowered) {
        if (op.action !== 'create') continue
        const bucket =
          op.resourceType === 'workflow'
            ? bundleCreatedNames.workflow
            : op.resourceType === 'workgroup'
              ? bundleCreatedNames.workgroup
              : null
        if (bucket === null) continue
        const name = (op.payload as { name?: unknown }).name
        if (typeof name === 'string' && name.length > 0) bucket.add(name)
      }

      for (const item of preparedOps) {
        mutationAdapter.commitInTx(tx, item, { bundleCreatedNames })
        applied.push({
          opId: item.op.opId,
          resourceType: item.op.resourceType,
          resourceId: item.op.resourceId,
          action: item.op.action,
          name: (item.op.payload as { name: string }).name,
        })
      }

      deps.faults?.inTxAfterOps?.()

      const receiptValue: BundleReceipt = { journalId, applied }
      // I7：provider 的伴随写入在 journal committed **之前**，同事务。
      provider.finalizeInTx?.(tx, receiptValue)
      tx.update(resourceBundleApplies)
        .set({
          state: 'committed',
          receiptJson: JSON.stringify(receiptValue),
          updatedAt: Date.now(),
        })
        .where(eq(resourceBundleApplies.id, journalId))
        .run()
      return receiptValue
    })
    committedReceipt = receipt

    // ── ④ 幂等尾 ─────────────────────────────────────────────────────────
    deps.faults?.afterTxBeforeRollForward?.()
    mutationAdapter.rollForwardCommitted(log)
    mutationAdapter.broadcastCommitted()
    return receipt
  } catch (error) {
    if (committedReceipt !== null) {
      // I8：事务已持久化 —— 这个包**已经生效**。post-commit 的异常绝不补偿、也不
      // 改写 journal 状态；收敛器会重放那条幂等的尾巴。
      log.warn('bundle-roll-forward-crashed', {
        journalId,
        err: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    // 逆序补偿，然后 journal → failed（零可见）。必须以已持久化的 artifact
    // 为 oracle，不能只看「成功返回后才填充」的内存 map：installer 可能已 mkdir
    // 却在返回 InstallResult 前抛错，那时 map 还是空的，而 journal 里已有精确路径。
    let compensated = true
    for (const artifact of [...artifacts].reverse()) {
      try {
        deps.faults?.beforeArtifactCompensation?.(artifact)
        compensateLegacyResourcePackageArtifact(db, artifact as ResourcePackageMutationArtifact)
      } catch (err) {
        compensated = false
        log.warn('bundle-artifact-compensation-failed', {
          kind: artifact.kind,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (compensated) {
      settleFailed(error)
    } else {
      // I9 的**对称条款**（收敛器那一侧早就这么做了，这一侧漏了）：补偿没做干净就
      // **不终态化**。标 failed 会让收敛器（它显式跳过 failed 行）再也不重试这些
      // 残留，而粗粒度 GC 又被任一非终态 run 挡住 ⇒ 目录永久残留，且 journal 反过来
      // 宣称「这次什么都没留下」。保留非终态，下一轮收敛接手。
      //
      // 代价是同一个 importId 在收敛前重放会拿到 `bundle-apply-unsettled` —— 那正是
      // 事实：确实有一次未结的尝试。
      log.warn('bundle-left-retryable', {
        journalId,
        err: error instanceof Error ? error.message : String(error),
      })
    }
    throw error
  } finally {
    ACTIVE_BUNDLE_APPLIES.delete(journalId)
  }
}

/** I3 —— 重放是**三态**，不是「总是返回 receipt」。 */
/**
 * I3's single replay oracle. Scenario adapters may call it after authenticating
 * their own envelope, before any mutable business validation, so a committed
 * request can always return its original receipt.
 */
export function replayBundleApplyOutcome(
  row: typeof resourceBundleApplies.$inferSelect,
): BundleReceipt {
  if (row.state === 'committed' && row.receiptJson !== null) {
    return JSON.parse(row.receiptJson) as BundleReceipt
  }
  if (row.state === 'failed') {
    throw new ConflictError(
      'bundle-apply-failed-replay',
      'this bundle apply already failed; inspect the error and submit a new one',
      { journalId: row.id, error: row.error },
    )
  }
  // prepared / applying —— 一次没有活锁持有者的尝试 = 崩溃残留，收敛器还没扫到。
  // **拒绝，而不是猜**：重跑会把一次可能已经部分落地的 pre-stage 再来一遍。
  throw new ConflictError(
    'bundle-apply-unsettled',
    'an earlier attempt with this key has not settled yet; retry later',
    { journalId: row.id },
  )
}

/**
 * ⑤ 收敛（启动 + 每小时）。
 *
 * 两个条件是**或**关系（I9）：本进程正在跑的、或更新时间在 10 分钟内的，都算
 * ACTIVE，不收割——收割它们会去补偿一个**活事务**的 pre-stage，然后在 journal
 * CAS 上失败。
 */
export async function convergeResourceBundleApplies(
  db: DbClient,
  appHome: string,
  log: Logger = createLogger('bundleApply'),
  options: { activeApplyIds?: readonly string[] } = {},
): Promise<{ failed: number; rolledForward: number }> {
  let failed = 0
  let rolledForward = 0
  const rows = await db.select().from(resourceBundleApplies)
  const reapBefore = Date.now() - CONVERGE_MIN_AGE_MS
  for (const row of rows) {
    if (row.state === 'committed') {
      // committed 的尾巴是幂等的：**重放**即可，绝不回滚。
      //
      // ⚠️ 光计数不算收敛：一次「DB 已提交、publish 前 SIGKILL」的 run 会留下一个
      // 已入库但**内容未发布**的技能版本。只 `rolledForward += 1` 等于宣称已经处理，
      // 而实际什么都没做。
      const artifacts = parseArtifacts(row.preparedArtifactsJson)
      if (
        artifacts.some(
          (artifact) => artifact.kind === 'skill-stage' || artifact.kind === 'skill-version-stage',
        )
      ) {
        // 每一步自己吞异常并 log（publish 已经发生过时会「重放即无操作」）。
        rollForwardLegacyResourcePackageArtifacts(
          db,
          appHome,
          artifacts as ResourcePackageMutationArtifact[],
          log,
        )
      }
      rolledForward += 1
      continue
    }
    if (row.state === 'failed') continue
    if (
      ACTIVE_BUNDLE_APPLIES.has(row.id) ||
      options.activeApplyIds?.includes(row.id) === true ||
      row.updatedAt > reapBefore
    )
      continue

    let compensated = true
    const artifacts = parseArtifacts(row.preparedArtifactsJson)
    for (const artifact of [...artifacts].reverse()) {
      try {
        compensateLegacyResourcePackageArtifact(db, artifact as ResourcePackageMutationArtifact)
      } catch (err) {
        compensated = false
        log.warn('bundle-converge-compensation-failed', {
          journalId: row.id,
          kind: artifact.kind,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (!compensated) {
      // I9（R5 补充）：**补偿未成功时不得无条件终态化**。旧实现在这里照样标
      // failed，于是那次的残留再也不会被重试；GC 又被任一非终态 run 挡住 ⇒ 目录
      // 永久残留。保留非终态，下一轮再试。
      log.warn('bundle-converge-left-retryable', { journalId: row.id })
      continue
    }
    const cas = dbTxSync(db, (tx) =>
      tx
        .update(resourceBundleApplies)
        .set({ state: 'failed', error: 'converged: crashed before commit', updatedAt: Date.now() })
        .where(
          and(eq(resourceBundleApplies.id, row.id), eq(resourceBundleApplies.state, row.state)),
        )
        .run(),
    )
    if ((cas as unknown as { changes?: number }).changes === 1) failed += 1
  }
  return { failed, rolledForward }
}

function parseArtifacts(json: string): BundleArtifact[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as BundleArtifact[]) : []
  } catch {
    return []
  }
}

export { ACTIVE_BUNDLE_APPLIES as __activeBundleAppliesForTests }

/** RFC-338: strict process-local advisory snapshot for the maintenance Worker. */
export function activeResourceBundleApplyIds(): string[] {
  return [...ACTIVE_BUNDLE_APPLIES]
}
