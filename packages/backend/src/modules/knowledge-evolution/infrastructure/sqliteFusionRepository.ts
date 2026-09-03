import { and, desc, eq, isNull } from 'drizzle-orm'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ulid } from 'ulid'
import type { FusionStatus } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import {
  agents,
  fusions,
  memories,
  resourceGrants,
  skillOperationLocks,
  skillOperations,
  skills,
  skillVersions,
  workflows,
} from '@/db/schema'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import type {
  SkillVersionCommitHooks,
  SkillVersionCommitRequest,
} from '@/modules/resource-catalog/public/participants'
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
  abortFusionSkillFilesystem,
  canEditFusionSkill,
  decodeFusionSkillToken,
  encodeFusionSkillToken,
  prepareFusionSkillFilesystem,
  publishFusionSkillFilesystem,
  repairFusionWorkflowDefinition,
  resolveFusionSkillAccess,
  type FusionSkillFilesystemPlan,
} from './fusionRepositorySupport'
import { ConflictError, staleConflictError } from '@/util/errors'

type FusionRow = typeof fusions.$inferSelect
type SkillRow = typeof skills.$inferSelect

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

function uniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /UNIQUE constraint failed|PRIMARY KEY|SQLITE_CONSTRAINT|constraint failed/i.test(message)
}

function grantInTx(tx: DbTxSync, actor: Actor, skillId: string): 'read' | 'write' | null {
  if (!actor.permissions.has('resource-acl:private')) return null
  return (
    tx
      .select({ level: resourceGrants.level })
      .from(resourceGrants)
      .where(
        and(
          eq(resourceGrants.resourceType, 'skill'),
          eq(resourceGrants.resourceId, skillId),
          eq(resourceGrants.userId, actor.user.id),
        ),
      )
      .get()?.level ?? null
  )
}

function mutablePatch(patch: FusionPersistencePatch | undefined) {
  return patch === undefined ? {} : patch
}

function assertClaimSkill(tx: DbTxSync, row: FusionRow, actor: Actor): void {
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
  const live = tx
    .select()
    .from(skills)
    .where(and(eq(skills.id, target.skillId), eq(skills.reservationState, 'ready')))
    .get()
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
  const access = resolveFusionSkillAccess(actor, live, grantInTx(tx, actor, live.id))
  if (!canEditFusionSkill(access)) {
    throw new ConflictError(
      'fusion-skill-forbidden',
      'you no longer have write access to the target skill',
    )
  }
}

function beginSkillOperation(
  tx: DbTxSync,
  input: {
    readonly operationId: string
    readonly skillId: string
    readonly versionIndex: number
    readonly stagingPath: string
    readonly candidatePath: string
  },
): void {
  try {
    tx.insert(skillOperationLocks)
      .values({ lockedSkillId: input.skillId, opId: input.operationId })
      .run()
  } catch (error) {
    if (uniqueViolation(error)) {
      throw new ConflictError(
        'skill-operation-busy',
        `skill ${input.skillId} is busy under another operation`,
      )
    }
    throw error
  }
  tx.insert(skillOperations)
    .values({
      opId: input.operationId,
      skillId: input.skillId,
      kind: 'version-write',
      phase: 'intent',
      active: 1,
      stagingPath: input.stagingPath,
      backupPath: null,
      candidatePath: input.candidatePath,
      candidateFingerprint: null,
      backupFingerprint: null,
      targetVersion: input.versionIndex,
      generation: null,
      ownerUserId: null,
      preconditionJson: JSON.stringify({ skillId: input.skillId }),
    })
    .run()
}

function advanceOperation(tx: DbTxSync, operationId: string, phase: string): void {
  tx.update(skillOperations).set({ phase }).where(eq(skillOperations.opId, operationId)).run()
}

function finishOperation(tx: DbTxSync, operationId: string): void {
  tx.update(skillOperations)
    .set({ phase: 'done', active: 0 })
    .where(eq(skillOperations.opId, operationId))
    .run()
  tx.delete(skillOperationLocks).where(eq(skillOperationLocks.opId, operationId)).run()
}

function abandonOperation(tx: DbTxSync, operationId: string): void {
  tx.update(skillOperations).set({ active: 0 }).where(eq(skillOperations.opId, operationId)).run()
  tx.delete(skillOperationLocks).where(eq(skillOperationLocks.opId, operationId)).run()
}

function planPaths(appHome: string, skillId: string, versionIndex: number, operationId: string) {
  const filesDir = join(appHome, 'skills', skillId, 'files')
  return {
    stagingPath: relative(appHome, `${filesDir}.op-${operationId}.staged`),
    candidatePath: relative(
      appHome,
      join(appHome, 'skills', skillId, 'versions', `v${versionIndex}`, 'files'),
    ),
  }
}

function recoverPublishedPlan(
  appHome: string,
  operation: typeof skillOperations.$inferSelect,
  contentHash: string,
): FusionSkillFilesystemPlan | null {
  if (
    operation.targetVersion === null ||
    operation.stagingPath === null ||
    operation.candidatePath === null
  ) {
    return null
  }
  const filesDir = join(appHome, 'skills', operation.skillId, 'files')
  return {
    operationId: operation.opId,
    skillId: operation.skillId,
    versionIndex: operation.targetVersion,
    filesDir,
    stagingDir: join(appHome, operation.stagingPath),
    backupDir: `${filesDir}.op-${operation.opId}.backup`,
    versionDir: join(appHome, operation.candidatePath),
    stagingPath: operation.stagingPath,
    candidatePath: operation.candidatePath,
    contentHash,
  }
}

/**
 * RFC-353 T6 —— 融合提交时「把这批记忆标记为已融合」那一半，由 memory 注入。
 *
 * 为什么在这里声明一个窄端口而不是直接吃 memory 的 `MemoryMembershipParticipantInTx`：
 * 那个合同的方法返回 Promise（provider 中性），而 SQLite 侧的 `apply` 跑在 `dbTxSync` 的
 * **同步**回调里，拿不到 await。与 T3 给技能回滚落的 `SkillRestoreMemoryMembership` 同形：
 * 消费处声明自己能用的形状，memory 提供实现，composition 注入。
 *
 * 判据（谁会被标记、返回什么顺序、写哪几列）**全在 memory 那边**——这里只负责把事务交过去。
 */
export interface FusionMemoryMembershipSync {
  markFused(
    tx: DbTxSync,
    command: {
      readonly memoryIds: readonly string[]
      readonly skillId: string
      readonly skillName: string
      readonly skillVersion: number
      readonly fusionId: string
      readonly actorUserId: string
      readonly now: number
    },
  ): string[]
  /** RFC-223 provenance 修复：把某条记忆的 `fusedIntoSkillId` 改判为解析出的技能（或隔离哨兵）。 */
  reassignFusedSkill(
    db: DbClient,
    input: { readonly memoryId: string; readonly skillId: string },
  ): void
}

/**
 * RFC-353 T6 —— 融合提交时「推进技能版本」那一半，由 resource-catalog 注入。
 *
 * `skills` / `skill_versions` 归 resource-catalog 单写。此前本文件是跨 context 直写它们，
 * 复合前置条件还只比了 `contentVersion` / `metaRevision` 两项（RC 自己的写入路径比六项）。
 * 同步端口的理由与上面的 `FusionMemoryMembershipSync` 一致：`apply` 跑在 `dbTxSync` 的同步回调里。
 */
export interface FusionSkillVersionCommitSync {
  commit(
    tx: DbTxSync,
    request: SkillVersionCommitRequest,
    hooks?: SkillVersionCommitHooks<void>,
  ): number
}

export function createSqliteFusionPersistence(input: {
  readonly db: DbClient
  readonly appHome: string
  readonly memoryMembership: FusionMemoryMembershipSync
  readonly skillVersionCommit: FusionSkillVersionCommitSync
}): FusionPersistence {
  const { db, appHome, memoryMembership, skillVersionCommit } = input

  async function seedResources(seed: FusionResourceSeed): Promise<void> {
    const now = Date.now()
    const merger = db.select().from(agents).where(eq(agents.id, seed.agent.id)).get()
    if (merger !== undefined) {
      if (merger.name !== seed.agent.name) {
        throw new ConflictError(
          'builtin-agent-id-collision',
          `stable built-in agent id '${seed.agent.id}' is occupied`,
        )
      }
      const drift =
        merger.ownerUserId !== seed.ownerUserId ||
        merger.visibility !== 'public' ||
        merger.builtin !== true
      if (drift) {
        db.update(agents)
          .set({
            ownerUserId: seed.ownerUserId,
            visibility: 'public',
            builtin: true,
            updatedAt: now,
            aclRevision: merger.aclRevision + 1,
          })
          .where(eq(agents.id, seed.agent.id))
          .run()
      }
    } else {
      db.insert(agents)
        .values({
          id: seed.agent.id,
          name: seed.agent.name,
          description: seed.agent.description,
          outputs: JSON.stringify(seed.agent.outputs),
          inputs: '[]',
          syncOutputsOnIterate: seed.agent.syncOutputsOnIterate,
          runtime: null,
          permission: '{}',
          skills: '[]',
          dependsOn: '[]',
          mcp: '[]',
          plugins: '[]',
          frontmatterExtra: '{}',
          bodyMd: seed.agent.bodyMd,
          ownerUserId: seed.ownerUserId,
          visibility: 'public',
          aclRevision: 0,
          builtin: true,
          schemaVersion: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run()
    }

    const workflow = db.select().from(workflows).where(eq(workflows.id, seed.workflow.id)).get()
    if (workflow !== undefined) {
      if (workflow.name !== seed.workflow.name) {
        throw new ConflictError(
          'builtin-workflow-id-collision',
          `stable built-in workflow id '${seed.workflow.id}' is occupied`,
        )
      }
      const repaired = repairFusionWorkflowDefinition(
        workflow.definition,
        seed.workflow.mergerAgentId,
      )
      const drift =
        workflow.ownerUserId !== seed.ownerUserId ||
        workflow.visibility !== 'public' ||
        workflow.builtin !== true
      if (repaired.changed || drift) {
        db.update(workflows)
          .set({
            definition: repaired.definition,
            version: workflow.version + 1,
            ownerUserId: seed.ownerUserId,
            visibility: 'public',
            builtin: true,
            ...(drift ? { aclRevision: workflow.aclRevision + 1, updatedAt: now } : {}),
          })
          .where(eq(workflows.id, seed.workflow.id))
          .run()
      }
    } else {
      const definition = repairFusionWorkflowDefinition(
        JSON.stringify(seed.workflow.definition),
        seed.workflow.mergerAgentId,
      ).definition
      db.insert(workflows)
        .values({
          id: seed.workflow.id,
          name: seed.workflow.name,
          description: seed.workflow.description,
          definition,
          version: 1,
          ownerUserId: seed.ownerUserId,
          visibility: 'public',
          aclRevision: 0,
          builtin: true,
          schemaVersion: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run()
    }
  }

  async function loadBuiltinWorkflowId(
    seed: FusionBuiltinWorkflowSeed,
    ownerUserId: string,
  ): Promise<string> {
    const row = db
      .select({
        id: workflows.id,
        name: workflows.name,
        ownerUserId: workflows.ownerUserId,
        builtin: workflows.builtin,
      })
      .from(workflows)
      .where(eq(workflows.id, seed.id))
      .get()
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
    return dbTxSync(db, (tx) => {
      const row = tx
        .select()
        .from(skills)
        .where(and(eq(skills.id, skillId), eq(skills.reservationState, 'ready')))
        .get()
      if (row === undefined) return null
      const skill = skillIdentity(row)
      return {
        skill,
        access: resolveFusionSkillAccess(actor, skill, grantInTx(tx, actor, skill.id)),
        preconditionToken: encodeFusionSkillToken({
          skillId: skill.id,
          contentVersion: skill.contentVersion,
          metaRevision: skill.metaRevision,
        }),
      }
    })
  }

  async function loadSkillIdentity(skillId: string): Promise<FusionSkillIdentity | null> {
    const row = db
      .select()
      .from(skills)
      .where(and(eq(skills.id, skillId), eq(skills.reservationState, 'ready')))
      .get()
    return row === undefined ? null : skillIdentity(row)
  }

  async function casStatus(command: FusionStatusCas): Promise<boolean> {
    return dbTxSync(db, (tx) => {
      const current = tx
        .select({ status: fusions.status, currentTaskId: fusions.currentTaskId })
        .from(fusions)
        .where(eq(fusions.id, command.id))
        .get()
      if (current === undefined || !command.from.includes(current.status as FusionStatus)) {
        return false
      }
      if (
        command.expectedCurrentTaskId !== undefined &&
        current.currentTaskId !== command.expectedCurrentTaskId
      ) {
        return false
      }
      tx.update(fusions)
        .set({ status: command.to, ...mutablePatch(command.patch) })
        .where(eq(fusions.id, command.id))
        .run()
      return true
    })
  }

  async function claimDecision(command: FusionDecisionClaimInput): Promise<boolean> {
    return dbTxSync(db, (tx) => {
      const row = tx.select().from(fusions).where(eq(fusions.id, command.id)).get()
      if (row === undefined || row.status !== command.from) return false
      assertClaimSkill(tx, row, command.actor)
      tx.update(fusions)
        .set({ status: command.to, ...mutablePatch(command.patch) })
        .where(eq(fusions.id, command.id))
        .run()
      return true
    })
  }

  async function apply(command: FusionApplyCommand): Promise<{ readonly versionIndex: number }> {
    const fusion = db.select().from(fusions).where(eq(fusions.id, command.fusionId)).get()
    if (fusion === undefined || fusion.status !== 'applying') {
      throw new ConflictError('fusion-not-applying', 'fusion is no longer applying')
    }
    const token =
      fusion.preconditionToken === null ? null : decodeFusionSkillToken(fusion.preconditionToken)
    if (token === null || token.skillId !== fusion.skillId) {
      throw staleConflictError('skill', 'fusion target skill changed; reload and retry')
    }
    const versionIndex = token.contentVersion + 1
    const operationId = ulid()
    const paths = planPaths(appHome, fusion.skillId, versionIndex, operationId)
    dbTxSync(db, (tx) =>
      beginSkillOperation(tx, {
        operationId,
        skillId: fusion.skillId,
        versionIndex,
        ...paths,
      }),
    )

    let plan: FusionSkillFilesystemPlan | null = null
    let databaseCommitted = false
    try {
      plan = prepareFusionSkillFilesystem({
        appHome,
        operationId,
        skillId: fusion.skillId,
        versionIndex,
        proposedWorktreePath: command.proposedWorktreePath,
      })
      dbTxSync(db, (tx) => advanceOperation(tx, operationId, 'fs-versioned'))
      dbTxSync(db, (tx) => {
        const currentFusion = tx
          .select()
          .from(fusions)
          .where(eq(fusions.id, command.fusionId))
          .get()
        if (currentFusion === undefined || currentFusion.status !== 'applying') {
          throw new ConflictError('fusion-not-applying', 'fusion is no longer applying')
        }
        assertClaimSkill(tx, currentFusion, command.actor)
        // RFC-353 T6：`skills` / `skill_versions` 归 resource-catalog 单写，这里只把事务交过去。
        // `before` 空着——上面两道（还在 applying 吗 / 还有权吗）已经跑完，正是它们决定的
        // 错误优先级：先答无权，再答技能被推进。
        skillVersionCommit.commit(
          tx,
          {
            skillId: fusion.skillId,
            versionIndex,
            contentHash: plan!.contentHash,
            source: 'fusion',
            summary: command.summary,
            fusionId: command.fusionId,
            restoredFromVersion: null,
            authorUserId: command.actor.user.id,
            now: command.now,
            expectedSkillId: token.skillId,
            expectedVersion: token.contentVersion,
            expectedMetaRevision: token.metaRevision,
            staleMessage: 'fusion target skill changed; reload and retry',
          },
          {
            // RFC-353 T6：记忆的成员关系由 memory 单写，与技能版本写入**同一事务**——
            // 不变式是 fused ⟺ 该知识在技能的当前版本里，中间态被读到就是一条幽灵行。
            after: () => {
              memoryMembership.markFused(tx, {
                memoryIds: command.incorporatedMemoryIds,
                skillId: fusion.skillId,
                skillName: fusion.skillName,
                skillVersion: versionIndex,
                fusionId: command.fusionId,
                actorUserId: command.actor.user.id,
                now: command.now,
              })
            },
          },
        )
        advanceOperation(tx, operationId, 'db-committed')
      })
      databaseCommitted = true
      publishFusionSkillFilesystem(plan)
      dbTxSync(db, (tx) => {
        advanceOperation(tx, operationId, 'fs-published')
        finishOperation(tx, operationId)
      })
      return { versionIndex }
    } catch (error) {
      if (!databaseCommitted) {
        if (plan !== null) abortFusionSkillFilesystem(plan)
        else {
          rmSync(join(appHome, paths.stagingPath), { recursive: true, force: true })
          rmSync(join(appHome, paths.candidatePath), { recursive: true, force: true })
        }
        dbTxSync(db, (tx) => abandonOperation(tx, operationId))
      }
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
    const fusionRows = db.select().from(fusions).all()
    for (const row of fusionRows) {
      const versions = db
        .select({
          skillId: skillVersions.skillId,
          versionIndex: skillVersions.versionIndex,
          source: skillVersions.source,
        })
        .from(skillVersions)
        .where(eq(skillVersions.fusionId, row.id))
        .all()
        .filter((version) => version.source === 'fusion')
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
        db.update(fusions)
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
          .run()
        if (resolved === QUARANTINED_FUSION_SKILL_ID) quarantinedFusions++
        else repairedFusions++
        if (terminalize) terminalizedFusions++
      }
    }

    const resolvedFusions = new Map(
      db
        .select({ id: fusions.id, skillId: fusions.skillId })
        .from(fusions)
        .all()
        .map((row) => [row.id, row.skillId] as const),
    )
    const fusedRows = db
      .select({
        id: memories.id,
        fusionId: memories.fusedFusionId,
        skillId: memories.fusedIntoSkillId,
        version: memories.fusedIntoSkillVersion,
      })
      .from(memories)
      .where(eq(memories.status, 'fused'))
      .all()
    for (const memory of fusedRows) {
      const fusionSkillId =
        memory.fusionId === null ? undefined : resolvedFusions.get(memory.fusionId)
      const exactVersions =
        memory.fusionId === null || memory.version === null
          ? []
          : db
              .select({
                skillId: skillVersions.skillId,
                source: skillVersions.source,
                version: skillVersions.versionIndex,
              })
              .from(skillVersions)
              .where(eq(skillVersions.fusionId, memory.fusionId))
              .all()
              .filter(
                (version) => version.source === 'fusion' && version.version === memory.version,
              )
      const exactId = exactVersions.length === 1 ? exactVersions[0]!.skillId : undefined
      const resolved =
        fusionSkillId !== undefined &&
        fusionSkillId !== QUARANTINED_FUSION_SKILL_ID &&
        exactId === fusionSkillId
          ? fusionSkillId
          : QUARANTINED_FUSION_SKILL_ID
      if (memory.skillId !== resolved) {
        memoryMembership.reassignFusedSkill(db, { memoryId: memory.id, skillId: resolved })
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
    const applying = db
      .select({
        id: fusions.id,
        skillId: fusions.skillId,
        appliedSkillVersion: fusions.appliedSkillVersion,
      })
      .from(fusions)
      .where(eq(fusions.status, 'applying'))
      .all()
    for (const fusion of applying) {
      const versions = db
        .select()
        .from(skillVersions)
        .where(eq(skillVersions.fusionId, fusion.id))
        .orderBy(desc(skillVersions.versionIndex))
        .all()
        .filter((version) => version.source === 'fusion')
      const sole = versions.length === 1 ? versions[0] : undefined
      const trustworthy =
        fusion.skillId !== QUARANTINED_FUSION_SKILL_ID &&
        sole !== undefined &&
        sole.skillId === fusion.skillId &&
        (fusion.appliedSkillVersion === null || fusion.appliedSkillVersion === sole.versionIndex)
      if (trustworthy && sole !== undefined) {
        const operation = db
          .select()
          .from(skillOperations)
          .where(
            and(
              eq(skillOperations.skillId, fusion.skillId),
              eq(skillOperations.active, 1),
              eq(skillOperations.kind, 'version-write'),
            ),
          )
          .get()
        if (operation !== undefined && sole.contentHash !== null) {
          const plan = recoverPublishedPlan(appHome, operation, sole.contentHash)
          if (plan !== null && operation.phase === 'db-committed') {
            if (!existsSync(plan.stagingDir) && existsSync(plan.versionDir)) {
              rmSync(plan.stagingDir, { recursive: true, force: true })
              // Rehydrate the exact committed snapshot for roll-forward.
              cpSync(plan.versionDir, plan.stagingDir, { recursive: true })
            }
            publishFusionSkillFilesystem(plan)
            dbTxSync(db, (tx) => {
              advanceOperation(tx, operation.opId, 'fs-published')
              finishOperation(tx, operation.opId)
            })
          }
        }
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

    const stuck = db
      .select({ id: fusions.id })
      .from(fusions)
      .where(and(eq(fusions.status, 'running'), isNull(fusions.currentTaskId)))
      .all()
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
      await db.insert(fusions).values(record).run()
    },
    async load(id: string) {
      const row = db.select().from(fusions).where(eq(fusions.id, id)).get()
      return row === undefined ? null : asRecord(row)
    },
    async listSummaries(
      filter: { readonly skillId?: string; readonly status?: FusionStatus } = {},
    ) {
      const conditions = []
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
      const rows = (conditions.length === 0 ? base : base.where(and(...conditions))).all()
      return rows
        .sort((left, right) => right.createdAt - left.createdAt)
        .map((row) => asRecord({ ...row, proposedDiff: null }))
    },
    async listIdsByStatus(status: FusionStatus) {
      return db
        .select({ id: fusions.id })
        .from(fusions)
        .where(eq(fusions.status, status))
        .all()
        .map((row) => row.id)
    },
    async listAwaitingApprovalOwners() {
      return db
        .select({ id: fusions.id, ownerUserId: fusions.ownerUserId })
        .from(fusions)
        .where(eq(fusions.status, 'awaiting_approval'))
        .all()
    },
    casStatus,
    claimDecision,
    async claimCancellation(command: {
      readonly id: string
      readonly actor: Actor
      readonly now: number
    }) {
      return dbTxSync(db, (tx) => {
        const row = tx.select().from(fusions).where(eq(fusions.id, command.id)).get()
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
        tx.update(fusions)
          .set({
            status: 'canceled',
            decidedByUserId: command.actor.user.id,
            decidedAt: command.now,
          })
          .where(eq(fusions.id, command.id))
          .run()
        return { ok: true as const, taskId: row.currentTaskId }
      })
    },
    apply,
    repairProvenance,
    recoverDecisions,
  })
}
