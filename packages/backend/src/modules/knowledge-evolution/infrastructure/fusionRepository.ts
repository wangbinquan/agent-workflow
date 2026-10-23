// RFC-359 W4-D5 —— 融合仓库：一份实现，两个 provider 共用。以 PG 版为底：多语句写走统一事务原语；
// 跨聚合的两半（memory 的成员关系、resource-catalog 的版本提交）经 tx-bound participant 注入。
// RFC-370 §10 V20：技能的字节与版本操作日志归 resource-catalog——apply 把提案树交给它暂存、在本仓的
// 事务里经它的 participant 提交、事务后由它发布；这里不再碰文件系统，也不再自己写技能操作锁。

import { createWorkflowExecutionQueries } from '@/modules/resource-catalog/public/queries'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { MemoryMembershipParticipantInTx } from '@/modules/memory/public/participants'
import type {
  FusionResourceSeedParticipant,
  SkillTreeVersionOperations,
  SkillVersionCommitParticipantInTx,
} from '@/modules/resource-catalog/public/participants'
import type { FusionStatus } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type {
  FusionBuiltinWorkflowSeed,
  FusionDecisionRecoveryReceipt,
  FusionPersistencePatch,
  FusionPersistenceRecord,
  FusionProvenanceRepairReceipt,
  FusionResourceSeed,
  FusionSkillAccess,
  FusionSkillIdentity,
} from '../public/types'
import type {
  FusionApplyCommand,
  FusionDecisionClaimInput,
  FusionPersistence,
  FusionStatusCas,
} from '../public/participants'
import {
  QUARANTINED_FUSION_SKILL_ID,
  canEditFusionSkill,
  decodeFusionSkillToken,
  encodeFusionSkillToken,
  repairFusionWorkflowDefinition,
  resolveFusionSkillAccess,
} from './fusionRepositorySupport'
import { ConflictError, staleConflictError } from '@/util/errors'

type FusionRow = PersistenceTables['fusions']['$inferSelect']
type SkillRow = PersistenceTables['skills']['$inferSelect']

function asRecord(row: FusionRow): FusionPersistenceRecord {
  return { ...row, status: row.status as FusionStatus }
}

function skillIdentity(row: SkillRow): FusionSkillIdentity {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    contentVersion: row.contentVersion,
    metaRevision: row.metaRevision,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    aclRevision: row.aclRevision,
  }
}

async function grantInTx(
  tx: PersistenceTx,
  actor: Actor,
  skillId: string,
): Promise<'read' | 'write' | null> {
  if (!actor.permissions.has('resource-acl:private')) return null
  const { resourceGrants } = tablesOf(tx)
  const row = await first(
    tx
      .select({ level: resourceGrants.level })
      .from(resourceGrants)
      .where(
        and(
          eq(resourceGrants.resourceType, 'skill'),
          eq(resourceGrants.resourceId, skillId),
          eq(resourceGrants.userId, actor.user.id),
        ),
      ),
  )
  return row?.level ?? null
}

function mutablePatch(patch: FusionPersistencePatch | undefined) {
  return patch === undefined ? {} : patch
}

async function assertClaimSkill(tx: PersistenceTx, row: FusionRow, actor: Actor): Promise<void> {
  if (row.preconditionToken === null) {
    throw new ConflictError(
      'fusion-precondition-legacy',
      'this fusion predates snapshot protection; re-initiate it against the current skill',
    )
  }
  const target = decodeFusionSkillToken(row.preconditionToken)
  if (
    target === null ||
    row.skillId === QUARANTINED_FUSION_SKILL_ID ||
    target.skillId !== row.skillId ||
    target.contentVersion !== row.baseSkillVersion
  ) {
    throw new ConflictError(
      'fusion-precondition-stale',
      'the target skill identity is invalid; re-initiate the fusion',
    )
  }
  const { skills } = tablesOf(tx)
  const live = await first(
    tx
      .select()
      .from(skills)
      .where(and(eq(skills.id, target.skillId), eq(skills.reservationState, 'ready'))),
  )
  const liveToken =
    live === undefined
      ? null
      : encodeFusionSkillToken({
          skillId: live.id,
          contentVersion: live.contentVersion,
          metaRevision: live.metaRevision,
        })
  if (live === undefined || liveToken !== row.preconditionToken) {
    throw new ConflictError(
      'fusion-precondition-stale',
      'the target skill changed since this fusion started; re-initiate the fusion',
    )
  }
  const access = resolveFusionSkillAccess(actor, live, await grantInTx(tx, actor, live.id))
  if (!canEditFusionSkill(access)) {
    throw new ConflictError(
      'fusion-skill-forbidden',
      'you no longer have write access to the target skill',
    )
  }
}

/**
 * RFC-353 T6 —— 融合提交时「把这批记忆标记为已融合」那一半，由 memory 注入：memory offered 的
 * tx-bound participant（带 brand、唯一 owner 工厂铸造），绑定调用方交来的统一事务句柄。
 * RFC-359 W4-D5 起两个 provider 同一份，SQLite 那侧的同步变体退役。
 */
export interface FusionMemoryMembership {
  inTransaction(transaction: PersistenceTx): MemoryMembershipParticipantInTx
}

/**
 * RFC-353 T6 / RFC-370 §10 V20 —— 融合提交时「推进技能版本」那一半，由 resource-catalog 注入。
 * `skills` / `skill_versions` 与技能字节归它单写：bootstrap 交来与数据库无关的工厂，
 * 由本仓的数据库句柄 `bind` 出绑在选定内容绑定上的 participant。
 */
export interface FusionSkillVersionCommit {
  bind(input: { readonly db: PersistenceDb; readonly appHome: string }): FusionSkillTrees
}

/** The bound participant: tree operations plus the tx-bound version commit. */
export interface FusionSkillTrees extends SkillTreeVersionOperations {
  inTransaction(transaction: PersistenceTx): SkillVersionCommitParticipantInTx
}

/** RFC-223 provenance 修复：非事务，逐条改判某条记忆的 `fusedIntoSkillId`。 */
export interface FusedSkillReassignment {
  reassign(input: { readonly memoryId: string; readonly skillId: string }): Promise<void>
}

/** 旧名保留为装配别名，PG 装配收敛后删除。 */
export type PostgresqlFusionMemoryMembership = FusionMemoryMembership
export type PostgresqlFusionSkillVersionCommit = FusionSkillVersionCommit
export type PostgresqlFusedSkillReassignment = FusedSkillReassignment

export function createFusionPersistence(input: {
  readonly db: PersistenceDb
  readonly memoryMembership: FusionMemoryMembership
  readonly fusedSkillReassignment: FusedSkillReassignment
  readonly skillVersionCommit: FusionSkillTrees
  readonly resourceSeed?: FusionResourceSeedParticipant
}): FusionPersistence {
  const { db, memoryMembership, fusedSkillReassignment, skillVersionCommit } = input
  const session = databaseSessionFor(db)

  async function seedResources(seed: FusionResourceSeed): Promise<void> {
    if (input.resourceSeed === undefined) throw new Error('fusion resource seeding is not bound')
    await input.resourceSeed.seed(seed, { repair: repairFusionWorkflowDefinition })
  }

  async function loadBuiltinWorkflowId(
    seed: FusionBuiltinWorkflowSeed,
    ownerUserId: string,
  ): Promise<string> {
    const row = await first(
      createWorkflowExecutionQueries(db)
        .summaries([seed.id])
        .then((rows) =>
          rows.map((row) => ({
            id: row.id,
            name: row.name,
            ownerUserId: row.ownerUserId,
            builtin: row.builtin,
          })),
        ),
    )
    if (
      row === undefined ||
      row.name !== seed.name ||
      row.ownerUserId !== ownerUserId ||
      row.builtin !== true
    ) {
      throw new Error('aw-skill-fusion canonical built-in workflow missing after seed')
    }
    return row.id
  }

  async function loadSkillAccess(actor: Actor, skillId: string): Promise<FusionSkillAccess | null> {
    return await session.transaction(async (tx) => {
      const { skills } = tablesOf(tx)
      const row = await first(
        tx
          .select()
          .from(skills)
          .where(and(eq(skills.id, skillId), eq(skills.reservationState, 'ready'))),
      )
      if (row === undefined) return null
      const skill = skillIdentity(row)
      return {
        skill,
        access: resolveFusionSkillAccess(actor, skill, await grantInTx(tx, actor, skill.id)),
        preconditionToken: encodeFusionSkillToken({
          skillId: skill.id,
          contentVersion: skill.contentVersion,
          metaRevision: skill.metaRevision,
        }),
      }
    })
  }

  async function loadSkillIdentity(skillId: string): Promise<FusionSkillIdentity | null> {
    const { skills } = tablesOf(db)
    const row = await first(
      db
        .select()
        .from(skills)
        .where(and(eq(skills.id, skillId), eq(skills.reservationState, 'ready'))),
    )
    return row === undefined ? null : skillIdentity(row)
  }

  async function casStatus(command: FusionStatusCas): Promise<boolean> {
    return await session.transaction(async (tx) => {
      const { fusions } = tablesOf(tx)
      const current = await first(
        tx
          .select({ status: fusions.status, currentTaskId: fusions.currentTaskId })
          .from(fusions)
          .where(eq(fusions.id, command.id)),
      )
      if (current === undefined || !command.from.includes(current.status as FusionStatus)) {
        return false
      }
      if (
        command.expectedCurrentTaskId !== undefined &&
        current.currentTaskId !== command.expectedCurrentTaskId
      ) {
        return false
      }
      await tx
        .update(fusions)
        .set({ status: command.to, ...mutablePatch(command.patch) })
        .where(eq(fusions.id, command.id))
      return true
    })
  }

  async function claimDecision(command: FusionDecisionClaimInput): Promise<boolean> {
    return await session.transaction(async (tx) => {
      const { fusions } = tablesOf(tx)
      const row = await first(tx.select().from(fusions).where(eq(fusions.id, command.id)))
      if (row === undefined || row.status !== command.from) return false
      await assertClaimSkill(tx, row, command.actor)
      await tx
        .update(fusions)
        .set({ status: command.to, ...mutablePatch(command.patch) })
        .where(eq(fusions.id, command.id))
      return true
    })
  }

  async function apply(command: FusionApplyCommand): Promise<{ readonly versionIndex: number }> {
    const { fusions } = tablesOf(db)
    const fusion = await first(db.select().from(fusions).where(eq(fusions.id, command.fusionId)))
    if (fusion === undefined || fusion.status !== 'applying') {
      throw new ConflictError('fusion-not-applying', 'fusion is no longer applying')
    }
    const token =
      fusion.preconditionToken === null ? null : decodeFusionSkillToken(fusion.preconditionToken)
    if (token === null || token.skillId !== fusion.skillId) {
      throw staleConflictError('skill', 'fusion target skill changed; reload and retry')
    }
    // RFC-370 §10 V20：暂存经 resource-catalog——开带锁的 version-write 操作（另一操作占着这个技能 ⇒
    // skill-operation-busy），提案树经选定的内容绑定暂存。复合栅栏在下面的事务里、`before` 之后判。
    const staged = await skillVersionCommit.stage({
      skillId: fusion.skillId,
      source: { kind: 'tree', files: command.proposal },
      versionSource: 'fusion',
      summary: command.summary,
      fusionId: command.fusionId,
      authorUserId: command.actor.user.id,
      now: command.now,
      expectedSkillId: token.skillId,
      expectedVersion: token.contentVersion,
      expectedMetaRevision: token.metaRevision,
      staleMessage: 'fusion target skill changed; reload and retry',
    })
    let databaseCommitted = false
    try {
      const versionIndex = await session.transaction(
        async (tx) =>
          // RFC-353 T6：`skills` / `skill_versions` 归 resource-catalog 单写，这里只把事务交过去。
          await skillVersionCommit.inTransaction(tx).commit(staged, {
            // 先答「还在 applying 吗 / 还有权吗」，再答「技能被推进」——这正是既有的错误优先级。
            before: async () => {
              const { fusions } = tablesOf(tx)
              const currentFusion = await first(
                tx.select().from(fusions).where(eq(fusions.id, command.fusionId)),
              )
              if (currentFusion === undefined || currentFusion.status !== 'applying') {
                throw new ConflictError('fusion-not-applying', 'fusion is no longer applying')
              }
              await assertClaimSkill(tx, currentFusion, command.actor)
            },
            // RFC-353 T6：记忆的成员关系由 memory 单写，与技能版本写入**同一事务**——
            // 不变式是 fused ⟺ 该知识在技能的当前版本里，中间态被读到就是一条幽灵行。
            after: async (version) => {
              await memoryMembership.inTransaction(tx).markFused({
                memoryIds: command.incorporatedMemoryIds,
                skillId: fusion.skillId,
                skillName: fusion.skillName,
                skillVersion: version,
                fusionId: command.fusionId,
                actorUserId: command.actor.user.id,
                now: command.now,
              })
            },
          }),
      )
      databaseCommitted = true
      await skillVersionCommit.publish(staged)
      return { versionIndex }
    } catch (error) {
      // 版本已提交之后的失败（发布中断）留给 resource-catalog 的启动恢复前滚，不在这里回退。
      if (!databaseCommitted) await skillVersionCommit.abort(staged)
      throw error
    }
  }

  async function repairProvenance(): Promise<FusionProvenanceRepairReceipt> {
    let repairedFusions = 0
    let quarantinedFusions = 0
    let terminalizedFusions = 0
    let repairedMemories = 0
    let quarantinedMemories = 0
    const nonterminal = new Set<FusionStatus>(['running', 'awaiting_approval', 'applying'])
    const { fusions, skillVersions, memories } = tablesOf(db)
    const fusionRows = await db.select().from(fusions)
    for (const row of fusionRows) {
      const versions = (
        await db
          .select({
            skillId: skillVersions.skillId,
            versionIndex: skillVersions.versionIndex,
            source: skillVersions.source,
          })
          .from(skillVersions)
          .where(eq(skillVersions.fusionId, row.id))
      ).filter((version) => version.source === 'fusion')
      const token =
        row.preconditionToken === null ? null : decodeFusionSkillToken(row.preconditionToken)
      const tokenValid =
        token !== null &&
        token.skillId !== QUARANTINED_FUSION_SKILL_ID &&
        token.contentVersion === row.baseSkillVersion
      const soleVersion = versions.length === 1 ? versions[0] : undefined
      const ledgerValid =
        soleVersion !== undefined &&
        soleVersion.skillId !== QUARANTINED_FUSION_SKILL_ID &&
        (row.appliedSkillVersion === null || row.appliedSkillVersion === soleVersion.versionIndex)
      let resolved = QUARANTINED_FUSION_SKILL_ID
      if (row.preconditionToken === null || token === null) {
        if (ledgerValid) resolved = soleVersion!.skillId
      } else if (tokenValid) {
        if (versions.length === 0 && row.appliedSkillVersion === null) resolved = token.skillId
        else if (ledgerValid && soleVersion!.skillId === token.skillId) resolved = token.skillId
      }
      const terminalize =
        resolved === QUARANTINED_FUSION_SKILL_ID && nonterminal.has(row.status as FusionStatus)
      if (row.skillId !== resolved || terminalize) {
        await db
          .update(fusions)
          .set({
            skillId: resolved,
            ...(terminalize
              ? {
                  status: 'failed' as const,
                  error:
                    'fusion provenance could not be proven during upgrade; re-initiate the fusion',
                  decidedAt: Date.now(),
                }
              : {}),
          })
          .where(eq(fusions.id, row.id))
        if (resolved === QUARANTINED_FUSION_SKILL_ID) quarantinedFusions++
        else repairedFusions++
        if (terminalize) terminalizedFusions++
      }
    }

    const resolvedFusions = new Map(
      (await db.select({ id: fusions.id, skillId: fusions.skillId }).from(fusions)).map(
        (row) => [row.id, row.skillId] as const,
      ),
    )
    const fusedRows = await db
      .select({
        id: memories.id,
        fusionId: memories.fusedFusionId,
        skillId: memories.fusedIntoSkillId,
        version: memories.fusedIntoSkillVersion,
      })
      .from(memories)
      .where(eq(memories.status, 'fused'))
    for (const memory of fusedRows) {
      const fusionSkillId =
        memory.fusionId === null ? undefined : resolvedFusions.get(memory.fusionId)
      const exactVersions =
        memory.fusionId === null || memory.version === null
          ? []
          : (
              await db
                .select({
                  skillId: skillVersions.skillId,
                  source: skillVersions.source,
                  version: skillVersions.versionIndex,
                })
                .from(skillVersions)
                .where(eq(skillVersions.fusionId, memory.fusionId))
            ).filter((version) => version.source === 'fusion' && version.version === memory.version)
      const exactId = exactVersions.length === 1 ? exactVersions[0]!.skillId : undefined
      const resolved =
        fusionSkillId !== undefined &&
        fusionSkillId !== QUARANTINED_FUSION_SKILL_ID &&
        exactId === fusionSkillId
          ? fusionSkillId
          : QUARANTINED_FUSION_SKILL_ID
      if (memory.skillId !== resolved) {
        await fusedSkillReassignment.reassign({ memoryId: memory.id, skillId: resolved })
        if (resolved === QUARANTINED_FUSION_SKILL_ID) quarantinedMemories++
        else repairedMemories++
      }
    }
    return {
      repairedFusions,
      quarantinedFusions,
      terminalizedFusions,
      repairedMemories,
      quarantinedMemories,
    }
  }

  async function recoverDecisions(now = Date.now()): Promise<FusionDecisionRecoveryReceipt> {
    let rolledForward = 0
    let rolledBack = 0
    let rejectFailed = 0
    const { fusions, skillVersions } = tablesOf(db)
    const applying = await db
      .select({
        id: fusions.id,
        skillId: fusions.skillId,
        appliedSkillVersion: fusions.appliedSkillVersion,
      })
      .from(fusions)
      .where(eq(fusions.status, 'applying'))
    for (const fusion of applying) {
      const versions = (
        await db
          .select()
          .from(skillVersions)
          .where(eq(skillVersions.fusionId, fusion.id))
          .orderBy(desc(skillVersions.versionIndex))
      ).filter((version) => version.source === 'fusion')
      const sole = versions.length === 1 ? versions[0] : undefined
      const trustworthy =
        fusion.skillId !== QUARANTINED_FUSION_SKILL_ID &&
        sole !== undefined &&
        sole.skillId === fusion.skillId &&
        (fusion.appliedSkillVersion === null || fusion.appliedSkillVersion === sole.versionIndex)
      if (trustworthy && sole !== undefined) {
        if (
          await casStatus({
            id: fusion.id,
            from: ['applying'],
            to: 'done',
            patch: { appliedSkillVersion: sole.versionIndex, decidedAt: now },
          })
        ) {
          rolledForward++
        }
      } else if (
        await casStatus({
          id: fusion.id,
          from: ['applying'],
          to: 'failed',
          patch: {
            error: 'daemon restarted mid-apply; re-run on the latest version',
            decidedAt: now,
          },
        })
      ) {
        rolledBack++
      }
    }

    const stuck = await db
      .select({ id: fusions.id })
      .from(fusions)
      .where(and(eq(fusions.status, 'running'), isNull(fusions.currentTaskId)))
    for (const row of stuck) {
      if (
        await casStatus({
          id: row.id,
          from: ['running'],
          to: 'failed',
          expectedCurrentTaskId: null,
          patch: { error: 'daemon restarted mid-rerun; re-initiate the fusion', decidedAt: now },
        })
      ) {
        rejectFailed++
      }
    }
    return { rolledForward, rolledBack, rejectFailed }
  }

  return Object.freeze({
    seedResources,
    loadBuiltinWorkflowId,
    loadSkillAccess,
    loadSkillIdentity,
    async create(record: FusionPersistenceRecord) {
      const { fusions } = tablesOf(db)
      await insertOne(db, fusions, record)
    },
    async load(id: string) {
      const { fusions } = tablesOf(db)
      const row = await first(db.select().from(fusions).where(eq(fusions.id, id)))
      return row === undefined ? null : asRecord(row)
    },
    async listSummaries(
      filter: { readonly skillId?: string; readonly status?: FusionStatus } = {},
    ) {
      const conditions = []
      const { fusions } = tablesOf(db)
      if (filter.skillId !== undefined) conditions.push(eq(fusions.skillId, filter.skillId))
      if (filter.status !== undefined) conditions.push(eq(fusions.status, filter.status))
      const base = db
        .select({
          id: fusions.id,
          skillId: fusions.skillId,
          skillName: fusions.skillName,
          baseSkillVersion: fusions.baseSkillVersion,
          preconditionToken: fusions.preconditionToken,
          memoryIdsJson: fusions.memoryIdsJson,
          intent: fusions.intent,
          status: fusions.status,
          iteration: fusions.iteration,
          currentTaskId: fusions.currentTaskId,
          proposedWorktreePath: fusions.proposedWorktreePath,
          incorporatedMemoryIdsJson: fusions.incorporatedMemoryIdsJson,
          skippedJson: fusions.skippedJson,
          changelog: fusions.changelog,
          appliedSkillVersion: fusions.appliedSkillVersion,
          ownerUserId: fusions.ownerUserId,
          createdAt: fusions.createdAt,
          decidedByUserId: fusions.decidedByUserId,
          decidedAt: fusions.decidedAt,
          decisionReason: fusions.decisionReason,
          error: fusions.error,
        })
        .from(fusions)
      const rows = await (conditions.length === 0 ? base : base.where(and(...conditions)))
      return rows
        .sort((left, right) => right.createdAt - left.createdAt)
        .map((row) => asRecord({ ...row, proposedDiff: null }))
    },
    async listIdsByStatus(status: FusionStatus) {
      const { fusions } = tablesOf(db)
      return (
        await db.select({ id: fusions.id }).from(fusions).where(eq(fusions.status, status))
      ).map((row) => row.id)
    },
    async listAwaitingApprovalOwners() {
      const { fusions } = tablesOf(db)
      return await db
        .select({ id: fusions.id, ownerUserId: fusions.ownerUserId })
        .from(fusions)
        .where(eq(fusions.status, 'awaiting_approval'))
    },
    casStatus,
    claimDecision,
    async claimCancellation(command: {
      readonly id: string
      readonly actor: Actor
      readonly now: number
    }) {
      return await session.transaction(async (tx) => {
        const { fusions } = tablesOf(tx)
        const row = await first(tx.select().from(fusions).where(eq(fusions.id, command.id)))
        if (row === undefined || (row.status !== 'running' && row.status !== 'awaiting_approval')) {
          return { ok: false as const }
        }
        if (
          !command.actor.permissions.has('resource-acl:bypass') &&
          row.ownerUserId !== command.actor.user.id
        ) {
          throw new ConflictError(
            'fusion-forbidden',
            'only the fusion owner or an actor with resource-acl:bypass may cancel',
          )
        }
        await tx
          .update(fusions)
          .set({
            status: 'canceled',
            decidedByUserId: command.actor.user.id,
            decidedAt: command.now,
          })
          .where(eq(fusions.id, command.id))
        return { ok: true as const, taskId: row.currentTaskId }
      })
    },
    apply,
    repairProvenance,
    recoverDecisions,
  })
}

/** 旧名保留为装配别名，PG 装配收敛后删除。 */
