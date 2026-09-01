import { and, desc, eq, isNull } from 'drizzle-orm'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ulid } from 'ulid'
import type { FusionStatus } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
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
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  FusionApplyCommand,
  FusionBuiltinWorkflowSeed,
  FusionDecisionClaim,
  FusionDecisionRecoveryReceipt,
  FusionPersistence,
  FusionPersistencePatch,
  FusionPersistenceRecord,
  FusionProvenanceRepairReceipt,
  FusionResourceSeed,
  FusionSkillAccess,
  FusionSkillIdentity,
  FusionStatusCas,
} from '../public/fusion'
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
} from './fusionPersistenceSupport'
import { ConflictError, staleConflictError } from '@/util/errors'

type PostgresqlTransaction = Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]
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
  const candidate = error as { readonly code?: string; readonly message?: string }
  return (
    candidate.code === '23505' ||
    /duplicate key|unique constraint|primary key/i.test(candidate.message ?? String(error))
  )
}

async function grantInTx(
  tx: PostgresqlTransaction,
  actor: Actor,
  skillId: string,
): Promise<'read' | 'write' | null> {
  if (!actor.permissions.has('resource-acl:private')) return null
  const row = await tx
    .select({ level: resourceGrants.level })
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.resourceType, 'skill'),
        eq(resourceGrants.resourceId, skillId),
        eq(resourceGrants.userId, actor.user.id),
      ),
    )
    .get()
  return row?.level ?? null
}

function mutablePatch(patch: FusionPersistencePatch | undefined) {
  return patch === undefined ? {} : patch
}

async function assertClaimSkill(
  tx: PostgresqlTransaction,
  row: FusionRow,
  actor: Actor,
): Promise<void> {
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
  const live = await tx
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
  const access = resolveFusionSkillAccess(actor, live, await grantInTx(tx, actor, live.id))
  if (!canEditFusionSkill(access)) {
    throw new ConflictError(
      'fusion-skill-forbidden',
      'you no longer have write access to the target skill',
    )
  }
}

async function beginSkillOperation(
  tx: PostgresqlTransaction,
  input: {
    readonly operationId: string
    readonly skillId: string
    readonly versionIndex: number
    readonly stagingPath: string
    readonly candidatePath: string
  },
): Promise<void> {
  try {
    await tx
      .insert(skillOperationLocks)
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
  await tx
    .insert(skillOperations)
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

async function advanceOperation(
  tx: PostgresqlTransaction,
  operationId: string,
  phase: string,
): Promise<void> {
  await tx.update(skillOperations).set({ phase }).where(eq(skillOperations.opId, operationId)).run()
}

async function finishOperation(tx: PostgresqlTransaction, operationId: string): Promise<void> {
  await tx
    .update(skillOperations)
    .set({ phase: 'done', active: 0 })
    .where(eq(skillOperations.opId, operationId))
    .run()
  await tx.delete(skillOperationLocks).where(eq(skillOperationLocks.opId, operationId)).run()
}

async function abandonOperation(tx: PostgresqlTransaction, operationId: string): Promise<void> {
  await tx
    .update(skillOperations)
    .set({ active: 0 })
    .where(eq(skillOperations.opId, operationId))
    .run()
  await tx.delete(skillOperationLocks).where(eq(skillOperationLocks.opId, operationId)).run()
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

export function createPostgresqlFusionPersistence(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
}): FusionPersistence {
  const { db, appHome } = input

  async function seedResources(seed: FusionResourceSeed): Promise<void> {
    const now = Date.now()
    const merger = await db.select().from(agents).where(eq(agents.id, seed.agent.id)).get()
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
        await db
          .update(agents)
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
      await db
        .insert(agents)
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

    const workflow = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, seed.workflow.id))
      .get()
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
        await db
          .update(workflows)
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
      await db
        .insert(workflows)
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
    const row = await db
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
    return await db.transaction(async (tx) => {
      const row = await tx
        .select()
        .from(skills)
        .where(and(eq(skills.id, skillId), eq(skills.reservationState, 'ready')))
        .get()
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
    const row = await db
      .select()
      .from(skills)
      .where(and(eq(skills.id, skillId), eq(skills.reservationState, 'ready')))
      .get()
    return row === undefined ? null : skillIdentity(row)
  }

  async function casStatus(command: FusionStatusCas): Promise<boolean> {
    return await db.transaction(async (tx) => {
      const current = await tx
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
      await tx
        .update(fusions)
        .set({ status: command.to, ...mutablePatch(command.patch) })
        .where(eq(fusions.id, command.id))
        .run()
      return true
    })
  }

  async function claimDecision(command: FusionDecisionClaim): Promise<boolean> {
    return await db.transaction(async (tx) => {
      const row = await tx.select().from(fusions).where(eq(fusions.id, command.id)).get()
      if (row === undefined || row.status !== command.from) return false
      await assertClaimSkill(tx, row, command.actor)
      await tx
        .update(fusions)
        .set({ status: command.to, ...mutablePatch(command.patch) })
        .where(eq(fusions.id, command.id))
        .run()
      return true
    })
  }

  async function apply(command: FusionApplyCommand): Promise<{ readonly versionIndex: number }> {
    const fusion = await db.select().from(fusions).where(eq(fusions.id, command.fusionId)).get()
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
    await db.transaction(async (tx) => {
      await beginSkillOperation(tx, {
        operationId,
        skillId: fusion.skillId,
        versionIndex,
        ...paths,
      })
    })

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
      await db.transaction(async (tx) => await advanceOperation(tx, operationId, 'fs-versioned'))
      await db.transaction(async (tx) => {
        const currentFusion = await tx
          .select()
          .from(fusions)
          .where(eq(fusions.id, command.fusionId))
          .get()
        if (currentFusion === undefined || currentFusion.status !== 'applying') {
          throw new ConflictError('fusion-not-applying', 'fusion is no longer applying')
        }
        await assertClaimSkill(tx, currentFusion, command.actor)
        const currentSkill = await tx
          .select()
          .from(skills)
          .where(eq(skills.id, fusion.skillId))
          .get()
        if (
          currentSkill === undefined ||
          currentSkill.contentVersion !== token.contentVersion ||
          currentSkill.metaRevision !== token.metaRevision
        ) {
          throw staleConflictError('skill', 'fusion target skill changed; reload and retry')
        }
        await tx
          .update(skills)
          .set({
            contentVersion: versionIndex,
            versionState: 'snapshot-authoritative',
            updatedAt: command.now,
          })
          .where(eq(skills.id, fusion.skillId))
          .run()
        await tx
          .insert(skillVersions)
          .values({
            id: ulid(),
            skillId: fusion.skillId,
            versionIndex,
            filesPath: `skills/${fusion.skillId}/versions/v${versionIndex}/files`,
            source: 'fusion',
            summary: command.summary,
            fusionId: command.fusionId,
            restoredFromVersion: null,
            authorUserId: command.actor.user.id,
            contentHash: plan!.contentHash,
            createdAt: command.now,
          })
          .run()
        for (const memoryId of command.incorporatedMemoryIds) {
          const memory = await tx.select().from(memories).where(eq(memories.id, memoryId)).get()
          if (memory === undefined || memory.status !== 'approved') continue
          await tx
            .update(memories)
            .set({
              status: 'fused',
              fusedIntoSkillId: fusion.skillId,
              fusedIntoSkill: fusion.skillName,
              fusedIntoSkillVersion: versionIndex,
              fusedAt: command.now,
              fusedByUserId: command.actor.user.id,
              fusedFusionId: command.fusionId,
            })
            .where(eq(memories.id, memoryId))
            .run()
        }
        await advanceOperation(tx, operationId, 'db-committed')
      })
      databaseCommitted = true
      publishFusionSkillFilesystem(plan)
      await db.transaction(async (tx) => {
        await advanceOperation(tx, operationId, 'fs-published')
        await finishOperation(tx, operationId)
      })
      return { versionIndex }
    } catch (error) {
      if (!databaseCommitted) {
        if (plan !== null) abortFusionSkillFilesystem(plan)
        else {
          rmSync(join(appHome, paths.stagingPath), { recursive: true, force: true })
          rmSync(join(appHome, paths.candidatePath), { recursive: true, force: true })
        }
        await db.transaction(async (tx) => await abandonOperation(tx, operationId))
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
    const fusionRows = await db.select().from(fusions).all()
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
          .all()
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
          .run()
        if (resolved === QUARANTINED_FUSION_SKILL_ID) quarantinedFusions++
        else repairedFusions++
        if (terminalize) terminalizedFusions++
      }
    }

    const resolvedFusions = new Map(
      (await db.select({ id: fusions.id, skillId: fusions.skillId }).from(fusions).all()).map(
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
      .all()
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
                .all()
            ).filter((version) => version.source === 'fusion' && version.version === memory.version)
      const exactId = exactVersions.length === 1 ? exactVersions[0]!.skillId : undefined
      const resolved =
        fusionSkillId !== undefined &&
        fusionSkillId !== QUARANTINED_FUSION_SKILL_ID &&
        exactId === fusionSkillId
          ? fusionSkillId
          : QUARANTINED_FUSION_SKILL_ID
      if (memory.skillId !== resolved) {
        await db
          .update(memories)
          .set({ fusedIntoSkillId: resolved })
          .where(eq(memories.id, memory.id))
          .run()
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
    const applying = await db
      .select({
        id: fusions.id,
        skillId: fusions.skillId,
        appliedSkillVersion: fusions.appliedSkillVersion,
      })
      .from(fusions)
      .where(eq(fusions.status, 'applying'))
      .all()
    for (const fusion of applying) {
      const versions = (
        await db
          .select()
          .from(skillVersions)
          .where(eq(skillVersions.fusionId, fusion.id))
          .orderBy(desc(skillVersions.versionIndex))
          .all()
      ).filter((version) => version.source === 'fusion')
      const sole = versions.length === 1 ? versions[0] : undefined
      const trustworthy =
        fusion.skillId !== QUARANTINED_FUSION_SKILL_ID &&
        sole !== undefined &&
        sole.skillId === fusion.skillId &&
        (fusion.appliedSkillVersion === null || fusion.appliedSkillVersion === sole.versionIndex)
      if (trustworthy && sole !== undefined) {
        const operation = await db
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
              cpSync(plan.versionDir, plan.stagingDir, { recursive: true })
            }
            publishFusionSkillFilesystem(plan)
            await db.transaction(async (tx) => {
              await advanceOperation(tx, operation.opId, 'fs-published')
              await finishOperation(tx, operation.opId)
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

    const stuck = await db
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
      const row = await db.select().from(fusions).where(eq(fusions.id, id)).get()
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
      const rows = await (conditions.length === 0 ? base : base.where(and(...conditions))).all()
      return rows
        .sort((left, right) => right.createdAt - left.createdAt)
        .map((row) => asRecord({ ...row, proposedDiff: null }))
    },
    async listIdsByStatus(status: FusionStatus) {
      return (
        await db.select({ id: fusions.id }).from(fusions).where(eq(fusions.status, status)).all()
      ).map((row) => row.id)
    },
    async listAwaitingApprovalOwners() {
      return await db
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
      return await db.transaction(async (tx) => {
        const row = await tx.select().from(fusions).where(eq(fusions.id, command.id)).get()
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
          .run()
        return { ok: true as const, taskId: row.currentTaskId }
      })
    },
    apply,
    repairProvenance,
    recoverDecisions,
  })
}
