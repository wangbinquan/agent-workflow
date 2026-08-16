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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ulid } from 'ulid'
import { stringify as stringifyYaml } from 'yaml'
import {
  CreateAgentSchema,
  CreateMcpSchema,
  CreateWorkgroupSchema,
  UpdateAgentSchema,
  WorkflowDefinitionSchema,
  migrateWorkflowDefinitionToLatest,
  type CreateMcp,
  type CreateWorkgroup,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { plugins, resourceBundleApplies, skillOperations } from '@/db/schema'
import {
  commitBindingInTx,
  commitFrameworkInTx,
  prepareBindingFromBundle,
  prepareFrameworkFromBundle,
  type PreparedBindingWrite,
  type PreparedFrameworkWrite,
} from '@/services/capabilityTemplates'
import { ACL_TABLES, initialPrivateResourceAcl } from '@/services/resourceAcl'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger, type Logger } from '@/util/log'
import {
  commitAgentCreateInTx,
  commitAgentUpdateInTx,
  getAgentById,
  prepareAgentCreate,
  prepareAgentUpdate,
  type PreparedAgentCreate,
  type PreparedAgentUpdate,
} from '@/services/agent'
import {
  commitMcpCreateInTx,
  commitMcpUpdateInTx,
  getMcpById,
  prepareMcpCreate,
  type PreparedMcpCreate,
  type PreparedMcpUpdate,
} from '@/services/mcp'
import { commitPluginCreateInTx, commitPluginPublishInTx } from '@/services/plugin'
import { installPlugin, plannedGenerationDir, type InstallResult } from '@/services/pluginInstaller'
import {
  commitSkillReadyInTx,
  compensateManagedSkillStage,
  stageManagedSkill,
} from '@/services/skill'
import {
  abortStagedSkillVersion,
  commitSkillVersionInTx,
  publishStagedSkillVersion,
  stageSkillVersion,
  type StagedSkillVersion,
} from '@/services/skillVersion'
import { unmarkSkillBootVerified } from '@/services/skillBootVerify'
import { finishOperation } from '@/services/skillOperations'
import {
  assertRefsUsableInTx,
  extractWorkflowWorkflowRefs,
  extractWorkflowWorkgroupRefs,
} from '@/services/resourceRefs'
import {
  broadcastWorkflowCreated,
  commitWorkflowSaveInTx,
  insertWorkflowInTx,
  prepareWorkflowSave,
  rowToWorkflowDetail,
  type PreparedWorkflowSave,
} from '@/services/workflow'
import {
  broadcastWorkgroupCreated,
  commitWorkgroupCreateInTx,
  commitWorkgroupSaveInTx,
  prepareWorkgroupCreate,
  prepareWorkgroupSave,
  type PreparedWorkgroupCreate,
  type PreparedWorkgroupSave,
} from '@/services/workgroups'
import {
  planBundleOps,
  type BundleApplyInput,
  type BundleArtifact,
  type BundleReceipt,
} from './provider'
import { lowerBundlePayloads, type LoweredOp } from './lower'
import { monotonicNow } from '@/util/time'

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

type PreparedOp =
  | { op: LoweredOp; kind: 'agent-create'; prepared: PreparedAgentCreate }
  | { op: LoweredOp; kind: 'agent-update'; prepared: PreparedAgentUpdate }
  | { op: LoweredOp; kind: 'mcp-create'; prepared: PreparedMcpCreate }
  | { op: LoweredOp; kind: 'mcp-update'; prepared: PreparedMcpUpdate }
  | { op: LoweredOp; kind: 'plugin-create'; spec: string; parsed: Record<string, unknown> }
  | { op: LoweredOp; kind: 'plugin-update'; spec: string; captured: Record<string, unknown> }
  | { op: LoweredOp; kind: 'skill-create' }
  | { op: LoweredOp; kind: 'skill-update' }
  | { op: LoweredOp; kind: 'workflow-create'; definition: WorkflowDefinition }
  | { op: LoweredOp; kind: 'workflow-update'; prepared: PreparedWorkflowSave }
  | { op: LoweredOp; kind: 'workgroup-create'; prepared: PreparedWorkgroupCreate }
  | { op: LoweredOp; kind: 'workgroup-update'; prepared: PreparedWorkgroupSave }
  | { op: LoweredOp; kind: 'capability-framework'; prepared: PreparedFrameworkWrite }
  | { op: LoweredOp; kind: 'capability-binding'; prepared: PreparedBindingWrite }

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

  const pluginInstalls = new Map<string, InstallResult>()
  const skillStages = new Map<string, { skillId: string; opId: string; skillDir: string }>()
  const skillVersionStages = new Map<string, StagedSkillVersion>()
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

    const preparedOps: PreparedOp[] = []
    for (const op of lowered) {
      preparedOps.push(await prepareOne(deps, op, { actor, pendingIds, pendingAgentNames, key }))
    }

    // ── ② pre-stage（record-before-act） ─────────────────────────────────
    for (const item of preparedOps) {
      if (item.kind === 'plugin-create' || item.kind === 'plugin-update') {
        // I14：generation id **由调用方预铸**，精确路径先落 journal 再安装。
        const generationId = ulid()
        const generationDir = plannedGenerationDir(
          item.op.resourceId,
          item.spec,
          generationId,
          deps.pluginInstallOpts?.pluginsDir,
        )
        if (generationDir !== null) {
          recordArtifact({
            kind: 'plugin-install',
            pluginId: item.op.resourceId,
            generationId,
            generationDir,
          })
        }
        const install = await installPlugin(item.op.resourceId, item.spec, {
          ...deps.pluginInstallOpts,
          generationId,
        })
        pluginInstalls.set(item.op.opId, install)
        deps.faults?.afterPluginInstall?.()
      } else if (item.kind === 'skill-create') {
        const stage = await stageManagedSkill(
          db,
          { appHome: deps.appHome },
          {
            name: skillPayload(item.op).name,
            description: skillPayload(item.op).description,
            ownerUserId: actor.user.id,
            actor,
            id: item.op.resourceId,
          },
          (filesDir) => writeSkillTree(filesDir, item.op, provider.readSkillFile),
        )
        skillStages.set(item.op.opId, stage)
        recordArtifact({ kind: 'skill-stage', ...stage })
        deps.faults?.afterSkillStage?.()
      } else if (item.kind === 'skill-update') {
        const staged = stageSkillVersion(
          db,
          { appHome: deps.appHome },
          item.op.resourceId,
          (stagingDir) => writeSkillTree(stagingDir, item.op, provider.readSkillFile),
          {
            source: 'import',
            authorUserId: actor.user.id,
            ...skillExpectOf(item.op),
            // T12：owner 围栏与其它类型同源——update 只能落在自己的行上。
            expectedOwnerUserId: actor.user.id,
            setDescription: skillPayload(item.op).description,
          },
        )
        skillVersionStages.set(item.op.opId, staged)
        // 完整结构落库：补偿只需要 stagingDir，但 committed 之后的 publish 重放
        // 需要全部字段（见 `BundleArtifact` 的注释）。
        recordArtifact({ kind: 'skill-version-stage', staged })
        deps.faults?.afterSkillStage?.()
      }
    }

    deps.faults?.beforeTx?.()

    // ── ③ big tx ─────────────────────────────────────────────────────────
    const applied: BundleReceipt['applied'] = []
    const createdWorkflowRows: Array<ReturnType<typeof insertWorkflowInTx>> = []
    const createdWorkgroups: Array<ReturnType<typeof commitWorkgroupCreateInTx>> = []
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
      assertUpdateTargetsOwnedInTx(tx, actor.user.id, lowered)

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
        commitOne(tx, item, {
          actor,
          pluginInstalls,
          skillStages,
          skillVersionStages,
          bundleCreatedNames,
          createdWorkflowRows,
          createdWorkgroups,
        })
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
    rollForwardCommitted(db, deps.appHome, { skillStages, skillVersionStages }, log)
    for (const row of createdWorkflowRows) {
      try {
        broadcastWorkflowCreated(rowToWorkflowDetail(row))
      } catch {
        /* broadcast is fire-and-forget */
      }
    }
    for (const wg of createdWorkgroups) {
      try {
        broadcastWorkgroupCreated(wg)
      } catch {
        /* broadcast is fire-and-forget */
      }
    }
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
        compensateArtifact(db, deps.appHome, artifact)
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

/** T12 —— 每个 update 目标必须归 actor 所有。 */
function assertUpdateTargetsOwnedInTx(
  tx: DbTxSync,
  actorUserId: string,
  ops: readonly LoweredOp[],
): void {
  for (const op of ops) {
    if (op.action !== 'update') continue
    const table = ACL_TABLES[op.resourceType]
    const row = tx
      .select({ ownerUserId: table.ownerUserId })
      .from(table)
      .where(eq(table.id, op.resourceId))
      .get()
    if (row === undefined) {
      throw new NotFoundError(
        `${op.resourceType}-not-found`,
        `update target '${op.resourceId}' not found`,
      )
    }
    if (row.ownerUserId !== actorUserId) {
      // 「只能覆盖自己的，别人的不给覆盖选项」——服务端复算，不信客户端说什么。
      throw new ValidationError(
        'bundle-overwrite-not-owned',
        `cannot overwrite ${op.resourceType} '${op.resourceId}': it belongs to another user`,
      )
    }
  }
}

// --- 各 op 的 prepare / commit ---------------------------------------------

const skillPayload = (op: LoweredOp): { name: string; description: string } =>
  op.payload as { name: string; description: string }

const skillExpectOf = (
  op: LoweredOp,
): { expectedVersion?: number; expectedMetaRevision?: number } => {
  const expect = op.expect as
    | { expectedContentVersion?: number; expectedMetaRevision?: number }
    | undefined
  if (expect === undefined) return {}
  return {
    ...(expect.expectedContentVersion !== undefined
      ? { expectedVersion: expect.expectedContentVersion }
      : {}),
    ...(expect.expectedMetaRevision !== undefined
      ? { expectedMetaRevision: expect.expectedMetaRevision }
      : {}),
  }
}

function writeSkillTree(
  filesDir: string,
  op: LoweredOp,
  readSkillFile: (ref: string) => Uint8Array,
): void {
  const payload = op.payload as {
    name: string
    description: string
    frontmatterExtra: Record<string, unknown>
    bodyMd: string
    files: Array<{ path: string; ref: string }>
  }
  const skillMd = `---\n${stringifyYaml(
    { name: payload.name, description: payload.description, ...payload.frontmatterExtra },
    { lineWidth: 0 },
  )}---\n\n${payload.bodyMd}\n`
  writeFileSync(join(filesDir, 'SKILL.md'), skillMd)
  for (const file of payload.files) {
    const abs = join(filesDir, file.path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, readSkillFile(file.ref))
  }
}

async function prepareOne(
  deps: BundleApplyDeps,
  op: LoweredOp,
  ctx: {
    actor: BundleApplyInput['provider']['actor']
    pendingIds: Set<string>
    pendingAgentNames: Map<string, string>
    key: string
  },
): Promise<PreparedOp> {
  const { db } = deps
  const { actor } = ctx
  switch (op.kind) {
    case 'agent-create': {
      const parsed = CreateAgentSchema.parse(op.payload)
      const prepared = await prepareAgentCreate(db, parsed, {
        ownerUserId: actor.user.id,
        actor,
        id: op.resourceId,
        pendingBundleIds: ctx.pendingIds,
      })
      return { op, kind: 'agent-create', prepared }
    }
    case 'agent-update': {
      const existing = await getAgentById(db, op.resourceId)
      if (existing === null) throw new NotFoundError('agent-not-found', 'agent not found')
      const { name: _name, ...patchBody } = op.payload as Record<string, unknown>
      const patch = UpdateAgentSchema.parse(patchBody)
      const expect = op.expect as { expectedUpdatedAt: number; expectedAclRevision: number }
      const prepared = await prepareAgentUpdate(db, op.resourceId, patch, actor, expect, {
        pendingBundleIds: ctx.pendingIds,
      })
      return { op, kind: 'agent-update', prepared }
    }
    case 'mcp-create': {
      const parsed: CreateMcp = CreateMcpSchema.parse(op.payload)
      const prepared = await prepareMcpCreate(db, parsed, {
        ownerUserId: actor.user.id,
        actor,
      })
      return { op, kind: 'mcp-create', prepared: { ...prepared, id: op.resourceId } }
    }
    case 'mcp-update': {
      const existing = await getMcpById(db, op.resourceId)
      if (existing === null) throw new NotFoundError('mcp-not-found', 'mcp not found')
      const p = op.payload as CreateMcp
      if (p.type !== existing.type) {
        throw new ValidationError('mcp-type-immutable', 'mcp type cannot change')
      }
      const expect = op.expect as { expectedConfigHash: string }
      return {
        op,
        kind: 'mcp-update',
        prepared: {
          id: op.resourceId,
          set: {
            updatedAt: monotonicNow(existing.updatedAt),
            description: p.description,
            enabled: p.enabled,
            config: JSON.stringify(p.config),
          },
          expectedConfigHash: expect.expectedConfigHash,
          expectedOwnerUserId: actor.user.id,
        },
      }
    }
    case 'plugin-create': {
      const p = op.payload as { spec: string } & Record<string, unknown>
      return { op, kind: 'plugin-create', spec: p.spec, parsed: p }
    }
    case 'plugin-update': {
      const p = op.payload as { spec: string } & Record<string, unknown>
      return { op, kind: 'plugin-update', spec: p.spec, captured: p }
    }
    case 'skill-create':
      return { op, kind: 'skill-create' }
    case 'skill-update':
      return { op, kind: 'skill-update' }
    case 'workflow-create': {
      const definition = migrateWorkflowDefinitionToLatest(
        WorkflowDefinitionSchema.parse((op.payload as { definition: unknown }).definition),
      )
      return { op, kind: 'workflow-create', definition }
    }
    case 'workflow-update': {
      const expect = op.expect as { expectedVersion: number }
      const payload = op.payload as { name: string; description: string; definition: unknown }
      const prepared = await prepareWorkflowSave(
        db,
        op.resourceId,
        {
          expectedVersion: expect.expectedVersion,
          clientMutationId: ctx.key,
          snapshot: {
            name: payload.name,
            description: payload.description,
            definition: migrateWorkflowDefinitionToLatest(
              WorkflowDefinitionSchema.parse(payload.definition),
            ),
          },
        },
        { kind: 'actor', actor },
      )
      return { op, kind: 'workflow-update', prepared }
    }
    case 'workgroup-create': {
      const parsed: CreateWorkgroup = CreateWorkgroupSchema.parse(op.payload)
      const prepared = await prepareWorkgroupCreate(db, parsed, {
        ownerUserId: actor.user.id,
        actor,
        pendingAgentNames: ctx.pendingAgentNames,
      })
      return {
        op,
        kind: 'workgroup-create',
        prepared: { ...prepared, groupId: op.resourceId },
      }
    }
    // RFC-304 T17b — create and update collapse into one prepared kind because
    // the row builder is the same either way; `existing` is what distinguishes
    // them, and it is a fact about the database rather than about the op.
    case 'capability-framework-create':
    case 'capability-framework-update': {
      const prepared = await prepareFrameworkFromBundle(
        db,
        { ...(op.payload as Record<string, unknown>), id: op.resourceId } as never,
        actor,
        op.kind === 'capability-framework-update' ? op.resourceId : null,
      )
      return { op, kind: 'capability-framework', prepared }
    }
    case 'capability-binding-create':
    case 'capability-binding-update': {
      const prepared = await prepareBindingFromBundle(
        db,
        { ...(op.payload as Record<string, unknown>), id: op.resourceId } as never,
        actor,
        op.kind === 'capability-binding-update' ? op.resourceId : null,
      )
      return { op, kind: 'capability-binding', prepared }
    }
    case 'workgroup-update': {
      const expect = op.expect as { expectedVersion: number }
      const prepared = await prepareWorkgroupSave(
        db,
        op.resourceId,
        {
          expectedVersion: expect.expectedVersion,
          clientMutationId: ctx.key,
          snapshot: op.payload,
        } as never,
        { kind: 'actor', actor },
      )
      return { op, kind: 'workgroup-update', prepared }
    }
  }
}

function commitOne(
  tx: DbTxSync,
  item: PreparedOp,
  ctx: {
    actor: BundleApplyInput['provider']['actor']
    pluginInstalls: Map<string, InstallResult>
    skillStages: Map<string, { skillId: string; opId: string }>
    skillVersionStages: Map<string, StagedSkillVersion>
    bundleCreatedNames: { workflow: Set<string>; workgroup: Set<string> }
    createdWorkflowRows: Array<ReturnType<typeof insertWorkflowInTx>>
    createdWorkgroups: Array<ReturnType<typeof commitWorkgroupCreateInTx>>
  },
): void {
  switch (item.kind) {
    case 'agent-create':
      commitAgentCreateInTx(tx, item.prepared)
      return
    case 'agent-update':
      commitAgentUpdateInTx(tx, item.prepared)
      return
    case 'mcp-create':
      commitMcpCreateInTx(tx, item.prepared)
      return
    case 'mcp-update':
      commitMcpUpdateInTx(tx, item.prepared)
      return
    case 'plugin-create': {
      const install = ctx.pluginInstalls.get(item.op.opId)
      if (install === undefined) throw new Error('plugin install result missing')
      commitPluginCreateInTx(tx, {
        id: item.op.resourceId,
        parsed: item.parsed as never,
        // RFC-284 T11：字面 ACL 初值收编 initialPrivateResourceAcl（值逐字节同）。
        initialAcl: initialPrivateResourceAcl(ctx.actor.user.id),
        install,
        now: Date.now(),
      })
      return
    }
    case 'plugin-update': {
      const install = ctx.pluginInstalls.get(item.op.opId)
      if (install === undefined) throw new Error('plugin install result missing')
      const captured = selectPluginRowInTx(tx, item.op.resourceId)
      const p = item.captured as {
        spec: string
        options?: Record<string, unknown>
        description?: string
        enabled?: boolean
      }
      commitPluginPublishInTx(tx, captured, {
        spec: p.spec,
        optionsJson: JSON.stringify(p.options ?? {}),
        description: p.description ?? captured.description,
        enabled: p.enabled ?? captured.enabled,
        sourceKind: install.sourceKind,
        cachedPath: install.cachedPath,
        resolvedVersion: install.resolvedVersion,
        installedAt: Date.now(),
        updatedAt: monotonicNow(captured.updatedAt),
      })
      return
    }
    case 'skill-create': {
      const stage = ctx.skillStages.get(item.op.opId)
      if (stage === undefined) throw new Error('skill stage missing')
      commitSkillReadyInTx(tx, { skillId: stage.skillId, opId: stage.opId })
      return
    }
    case 'skill-update': {
      const staged = ctx.skillVersionStages.get(item.op.opId)
      if (staged === undefined) throw new Error('skill version stage missing')
      commitSkillVersionInTx(tx, staged, {
        source: 'import',
        authorUserId: ctx.actor.user.id,
        setDescription: skillPayload(item.op).description,
      })
      return
    }
    case 'workflow-create': {
      // I13：引用 ACL 复核**在事务内**。挪到事务外（很自然的「preflight 归
      // preflight」重构）会留下一个窗口：检查通过之后、提交之前 grant 被撤销，
      // 资源仍带着一个已失效的引用落库。
      assertRefsUsableInTx(tx, ctx.actor, [
        {
          type: 'agent',
          domain: 'id',
          names: (item.definition.nodes ?? [])
            .filter((n) => n.kind === 'agent-single' && typeof n.agentId === 'string')
            .map((n) => n.agentId as string),
        },
        {
          type: 'workflow',
          names: extractWorkflowWorkflowRefs(item.definition).filter(
            (name) => !ctx.bundleCreatedNames.workflow.has(name),
          ),
          domain: 'name',
        },
        {
          type: 'workgroup',
          names: extractWorkflowWorkgroupRefs(item.definition).filter(
            (name) => !ctx.bundleCreatedNames.workgroup.has(name),
          ),
          domain: 'name',
        },
      ])
      const payload = item.op.payload as { name: string; description: string }
      ctx.createdWorkflowRows.push(
        insertWorkflowInTx(tx, {
          scriptPrincipal: { kind: 'actor', actor: ctx.actor },
          id: item.op.resourceId,
          name: payload.name,
          description: payload.description,
          definition: item.definition,
          ownerUserId: ctx.actor.user.id,
          builtin: false,
          now: Date.now(),
        }),
      )
      return
    }
    case 'workflow-update': {
      const result = commitWorkflowSaveInTx(tx, item.prepared)
      if (!result.committed && result.receipt.outcome !== 'already-current') {
        throw new ConflictError('bundle-baseline-stale', 'workflow save did not commit')
      }
      return
    }
    case 'workgroup-create':
      ctx.createdWorkgroups.push(commitWorkgroupCreateInTx(tx, item.prepared))
      return
    case 'workgroup-update': {
      const result = commitWorkgroupSaveInTx(tx, item.prepared)
      if (!result.committed && result.receipt.outcome !== 'already-current') {
        throw new ConflictError('bundle-baseline-stale', 'workgroup save did not commit')
      }
      return
    }
    case 'capability-framework':
      commitFrameworkInTx(tx, item.prepared)
      return
    case 'capability-binding':
      commitBindingInTx(tx, item.prepared)
      return
  }
}

function selectPluginRowInTx(tx: DbTxSync, id: string): typeof plugins.$inferSelect {
  const row = tx.select().from(plugins).where(eq(plugins.id, id)).get()
  if (row === undefined) throw new NotFoundError('plugin-not-found', `plugin '${id}' not found`)
  return row
}

/**
 * ④ 幂等尾。可安全重放。
 *
 * ⚠️ `unmarkSkillBootVerified` 在这里**一次性**对全部已提交技能做，且在任何逐项
 * publish 之前（T10 的那条注释）：放进 publish 里的话，先发布的技能已经 mark
 * 回来，而后一个还没发布的仍带着上一代 admission。
 */
function rollForwardCommitted(
  db: DbClient,
  appHome: string,
  state: {
    skillStages: Map<string, { skillId: string; opId: string }>
    skillVersionStages: Map<string, StagedSkillVersion>
  },
  log: Logger,
): void {
  // A committed journal is retained for audit and the hourly converger sees it forever. Once a
  // skill operation is `done`, its exact tail has already published, verified and released its
  // lock; replaying that old artifact after a later edit would compare today's live tree with the
  // old hash and, worse, unmark the healthy skill before failing. Only the exact still-active op
  // is an unfinished tail. Boot recovery may have finished it before this journal converger runs,
  // in which case the boot snapshot verifier owns admission and this pass must be a no-op.
  const pendingSkillVersions: StagedSkillVersion[] = []
  for (const staged of state.skillVersionStages.values()) {
    if (staged.opId === null) {
      pendingSkillVersions.push(staged)
      continue
    }
    const op = db
      .select({ active: skillOperations.active, phase: skillOperations.phase })
      .from(skillOperations)
      .where(eq(skillOperations.opId, staged.opId))
      .get()
    if (op?.active === 1) {
      pendingSkillVersions.push(staged)
      continue
    }
    if (op?.phase !== 'done') {
      log.warn('bundle-skill-publish-op-not-replayable', {
        skillId: staged.skillId,
        opId: staged.opId,
        phase: op?.phase ?? 'missing',
      })
    }
  }

  for (const staged of pendingSkillVersions) unmarkSkillBootVerified(staged.skillId)
  for (const staged of pendingSkillVersions) {
    try {
      publishStagedSkillVersion(db, { appHome }, staged)
    } catch (err) {
      log.warn('bundle-skill-publish-replayed-or-failed', {
        skillId: staged.skillId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
  for (const stage of state.skillStages.values()) {
    try {
      dbTxSync(db, (tx) => finishOperation(tx, stage.opId))
    } catch (err) {
      log.warn('bundle-skill-finish-replayed-or-failed', {
        skillId: stage.skillId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
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
      const state = {
        skillStages: new Map<string, { skillId: string; opId: string }>(),
        skillVersionStages: new Map<string, StagedSkillVersion>(),
      }
      for (const artifact of parseArtifacts(row.preparedArtifactsJson)) {
        if (artifact.kind === 'skill-stage') {
          state.skillStages.set(artifact.opId, {
            skillId: artifact.skillId,
            opId: artifact.opId,
          })
        } else if (artifact.kind === 'skill-version-stage') {
          const staged = artifact.staged as StagedSkillVersion
          state.skillVersionStages.set(staged.publishId, staged)
        }
      }
      if (state.skillStages.size > 0 || state.skillVersionStages.size > 0) {
        // 每一步自己吞异常并 log（publish 已经发生过时会「重放即无操作」）。
        rollForwardCommitted(db, appHome, state, log)
      }
      rolledForward += 1
      continue
    }
    if (row.state === 'failed') continue
    if (ACTIVE_BUNDLE_APPLIES.has(row.id) || row.updatedAt > reapBefore) continue

    let compensated = true
    const artifacts = parseArtifacts(row.preparedArtifactsJson)
    for (const artifact of [...artifacts].reverse()) {
      try {
        compensateArtifact(db, appHome, artifact)
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

function compensateArtifact(db: DbClient, appHome: string, artifact: BundleArtifact): void {
  switch (artifact.kind) {
    case 'skill-stage':
      compensateManagedSkillStage(db, artifact)
      return
    case 'skill-version-stage':
      // 用**落库的那一份真实结构**，不再现编一个（旧写法把 newVersion/newHash 填
      // 成 0/''、versionDir 填成 stagingDir，abort 恰好用不到才没出事——那是运气，
      // 不是设计）。
      abortStagedSkillVersion(db, artifact.staged as StagedSkillVersion)
      return
    case 'plugin-install':
      // I14 的收益就在这一行：**精确路径**事前落了库，所以这里能删得准。
      rmSync(artifact.generationDir, { recursive: true, force: true })
      return
  }
}

export { ACTIVE_BUNDLE_APPLIES as __activeBundleAppliesForTests }
