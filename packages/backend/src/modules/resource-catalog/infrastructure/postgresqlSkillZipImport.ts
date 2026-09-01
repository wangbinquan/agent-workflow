import {
  SKILL_NAME_RE,
  parseSkillZipEntries,
  type ResourceGrantLevel,
  type Skill,
  type SkillCandidate,
  type SkillZipCandidateView,
  type SkillZipCommitFailure,
  type SkillZipCommitFailureCode,
  type SkillZipCommitSkipped,
  type SkillZipDecisionMap,
  type SkillZipOverwriteCandidate,
} from '@agent-workflow/shared'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'
import { resourceGrants, skillVersions, skills } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ConflictError } from '@/util/errors'
import { monotonicNow } from '@/util/time'
import { createSkillZipImportParticipant } from '../application/skills/skillZipImport'
import type { SkillZipImportPort } from '../application/skills/ports'
import {
  canEditAccess,
  canViewAccess,
  hasResourceAclBypass,
  resolveResourceAccess,
} from '../domain/resourceAccess'
import {
  decodeSkillToken,
  encodeSkillToken,
  skillTokenMatches,
} from '../application/skills/skillToken'
import type { SkillOperationContext, SkillZipImportParticipant } from '../public/participants'
import { skillFromPersistenceRow } from './skillPersistence'
import { decodeSkillZipArchive } from './skillZipArchive'
import {
  executePostgresqlSkillVersionPlan,
  type PostgresqlSkillContentLifecycle,
  type PostgresqlSkillVersionPlan,
} from './postgresqlSkillRepository'
import {
  isPostgresqlUniqueViolation,
  runPostgresqlResourceCatalogTransaction,
  type PostgresqlResourceCatalogTransaction,
} from './postgresql/repositorySupport'

type SkillZipTargetRow = typeof skills.$inferSelect

interface CommitOutcome {
  readonly created: Skill[]
  readonly updated: Skill[]
  readonly skipped: SkillZipCommitSkipped[]
  readonly failed: SkillZipCommitFailure[]
}

class SkillZipCandidateFailure extends Error {
  constructor(
    readonly code: SkillZipCommitFailureCode,
    message: string,
  ) {
    super(message)
    this.name = 'SkillZipCandidateFailure'
  }
}

function ownerWhere(ownerUserId: string | null) {
  return ownerUserId === null ? isNull(skills.ownerUserId) : eq(skills.ownerUserId, ownerUserId)
}

function targetUnavailable(): SkillZipCandidateFailure {
  return new SkillZipCandidateFailure(
    'resource-operation-stale',
    'the previewed overwrite target is no longer available; review the ZIP again',
  )
}

function targetChanged(): SkillZipCandidateFailure {
  return new SkillZipCandidateFailure(
    'resource-operation-stale',
    'the previewed overwrite target changed; review the ZIP again',
  )
}

function targetForbidden(): SkillZipCandidateFailure {
  return new SkillZipCandidateFailure(
    'skill-overwrite-forbidden',
    'you can no longer overwrite the previewed skill; review the ZIP again',
  )
}

async function listTargetsByName(
  db: PostgresqlDatabaseClient,
  names: readonly string[],
): Promise<readonly SkillZipTargetRow[]> {
  const unique = [...new Set(names)]
  if (unique.length === 0) return []
  return await db.select().from(skills).where(inArray(skills.name, unique)).all()
}

async function loadTargetById(
  db: PostgresqlDatabaseClient,
  id: string,
): Promise<SkillZipTargetRow | null> {
  return (await db.select().from(skills).where(eq(skills.id, id)).limit(1).get()) ?? null
}

async function listActorSkillGrants(
  db: PostgresqlDatabaseClient,
  authority: SkillOperationContext,
): Promise<ReadonlyMap<string, ResourceGrantLevel>> {
  if (hasResourceAclBypass(authority)) return new Map()
  const rows = await db
    .select({ resourceId: resourceGrants.resourceId, level: resourceGrants.level })
    .from(resourceGrants)
    .where(
      and(eq(resourceGrants.resourceType, 'skill'), eq(resourceGrants.userId, authority.user.id)),
    )
    .all()
  return new Map(rows.map((row) => [row.resourceId, row.level]))
}

async function loadActorSkillGrantInTransaction(
  transaction: PostgresqlResourceCatalogTransaction,
  authority: SkillOperationContext,
  skillId: string,
): Promise<ResourceGrantLevel | null> {
  if (hasResourceAclBypass(authority)) return null
  const row = await transaction
    .select({ level: resourceGrants.level })
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.resourceType, 'skill'),
        eq(resourceGrants.resourceId, skillId),
        eq(resourceGrants.userId, authority.user.id),
      ),
    )
    .limit(1)
    .get()
  return row?.level ?? null
}

function targetAccess(
  authority: SkillOperationContext,
  row: SkillZipTargetRow,
  grant: ResourceGrantLevel | null,
) {
  return resolveResourceAccess(authority, row, grant)
}

async function targetIsAvailable(
  content: PostgresqlSkillContentLifecycle,
  row: SkillZipTargetRow,
): Promise<boolean> {
  return (
    row.reservationState === 'ready' && (await content.isAvailable(skillFromPersistenceRow(row)))
  )
}

function toOverwriteCandidate(row: SkillZipTargetRow): SkillZipOverwriteCandidate {
  return {
    skillId: row.id,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    expectedAclRevision: row.aclRevision,
    expectedToken: encodeSkillToken({
      skillId: row.id,
      contentVersion: row.contentVersion,
      metaRevision: row.metaRevision,
    }),
  }
}

function decisionMatchesTarget(
  row: SkillZipTargetRow,
  candidateName: string,
  decision: Extract<SkillZipDecisionMap[string], { action: 'overwrite' }>,
): boolean {
  const token = decodeSkillToken(decision.expectedToken)
  return (
    row.name === candidateName &&
    row.ownerUserId === decision.expectedOwnerUserId &&
    row.visibility === decision.expectedVisibility &&
    row.aclRevision === decision.expectedAclRevision &&
    token !== null &&
    skillTokenMatches(token, {
      skillId: row.id,
      contentVersion: row.contentVersion,
      metaRevision: row.metaRevision,
    })
  )
}

function databaseAvailabilityMatches(
  expected: SkillZipTargetRow,
  fresh: SkillZipTargetRow,
): boolean {
  return (
    fresh.reservationState === 'ready' &&
    fresh.reservationState === expected.reservationState &&
    fresh.versionState === expected.versionState
  )
}

async function requirePreviewedOverwriteTarget(input: {
  readonly db: PostgresqlDatabaseClient
  readonly content: PostgresqlSkillContentLifecycle
  readonly authority: SkillOperationContext
  readonly candidateName: string
  readonly decision: Extract<SkillZipDecisionMap[string], { action: 'overwrite' }>
}): Promise<SkillZipTargetRow> {
  const target = await loadTargetById(input.db, input.decision.skillId)
  if (target === null) throw targetUnavailable()
  const grants = await listActorSkillGrants(input.db, input.authority)
  const access = targetAccess(input.authority, target, grants.get(target.id) ?? null)
  if (!canViewAccess(access)) throw targetUnavailable()
  if (!canEditAccess(access)) throw targetForbidden()
  if (!(await targetIsAvailable(input.content, target))) throw targetUnavailable()
  if (!decisionMatchesTarget(target, input.candidateName, input.decision)) {
    throw targetChanged()
  }
  return target
}

async function assertOwnSlotFree(
  db: PostgresqlDatabaseClient,
  content: PostgresqlSkillContentLifecycle,
  ownerUserId: string,
  name: string,
): Promise<void> {
  const occupied = await db
    .select()
    .from(skills)
    .where(and(eq(skills.ownerUserId, ownerUserId), eq(skills.name, name)))
    .limit(1)
    .get()
  if (occupied === undefined) return
  const available = await targetIsAvailable(content, occupied)
  throw new SkillZipCandidateFailure(
    'skill-rename-conflict',
    available
      ? `skill '${name}' already exists for this owner; pick a different name or choose Overwrite`
      : `target name '${name}' is held by an unavailable skill for this owner; pick a different name`,
  )
}

async function createImportedSkill(input: {
  readonly db: PostgresqlDatabaseClient
  readonly content: PostgresqlSkillContentLifecycle
  readonly authority: SkillOperationContext
  readonly candidate: SkillCandidate
  readonly targetName: string
  readonly id: () => string
  readonly now: () => number
}): Promise<Skill> {
  const id = input.id()
  const createdAt = input.now()
  const plan = await input.content.prepareImportCreate({
    authority: input.authority,
    id,
    targetName: input.targetName,
    candidate: input.candidate,
    now: createdAt,
  })
  let created: Skill | null = null
  try {
    await executePostgresqlSkillVersionPlan(plan, async () => {
      await runPostgresqlResourceCatalogTransaction(input.db, async (transaction) => {
        const reservation = await transaction
          .select({ id: skills.id, reservationState: skills.reservationState })
          .from(skills)
          .where(eq(skills.id, id))
          .get()
        if (reservation?.reservationState !== 'reserving') {
          throw new Error('skill ZIP create reservation is missing')
        }
        await plan.commitInTransaction(transaction, 1)
        const row = await transaction
          .select()
          .from(skills)
          .where(and(eq(skills.id, id), eq(skills.reservationState, 'ready')))
          .get()
        if (row === undefined) throw new Error('skill ZIP reservation did not become ready')
        created = skillFromPersistenceRow(row)
      })
    })
  } catch (error) {
    if (isPostgresqlUniqueViolation(error, ['skills_owner_name_unique'])) {
      throw new SkillZipCandidateFailure(
        'skill-rename-conflict',
        `skill '${input.targetName}' already exists for this owner; pick a different name or choose Overwrite`,
      )
    }
    throw error
  }
  if (created === null) throw new Error('skill ZIP create committed without a row')
  return created
}

async function overwriteImportedSkill(input: {
  readonly db: PostgresqlDatabaseClient
  readonly content: PostgresqlSkillContentLifecycle
  readonly authority: SkillOperationContext
  readonly candidate: SkillCandidate
  readonly decision: Extract<SkillZipDecisionMap[string], { action: 'overwrite' }>
  readonly id: () => string
  readonly now: () => number
}): Promise<Skill> {
  const expected = await requirePreviewedOverwriteTarget({
    db: input.db,
    content: input.content,
    authority: input.authority,
    candidateName: input.candidate.name,
    decision: input.decision,
  })
  const current = skillFromPersistenceRow(expected)
  const preparedAt = input.now()
  const plan: PostgresqlSkillVersionPlan<void> = await input.content.prepareImportOverwrite({
    authority: input.authority,
    current,
    targetName: input.candidate.name,
    candidate: input.candidate,
    now: preparedAt,
  })
  let updated: Skill | null = null
  await executePostgresqlSkillVersionPlan(plan, async () => {
    await runPostgresqlResourceCatalogTransaction(input.db, async (transaction) => {
      const fresh = await transaction.select().from(skills).where(eq(skills.id, expected.id)).get()
      if (fresh === undefined) throw targetUnavailable()
      const grant = await loadActorSkillGrantInTransaction(transaction, input.authority, fresh.id)
      const access = targetAccess(input.authority, fresh, grant)
      if (!canViewAccess(access)) throw targetUnavailable()
      if (!canEditAccess(access)) throw targetForbidden()
      if (!databaseAvailabilityMatches(expected, fresh)) throw targetUnavailable()
      if (!decisionMatchesTarget(fresh, input.candidate.name, input.decision)) {
        throw targetChanged()
      }

      const versionIndex = fresh.contentVersion + 1
      await plan.commitInTransaction(transaction, versionIndex)
      const updatedAt = monotonicNow(fresh.updatedAt)
      const metaRevision =
        input.candidate.description === fresh.description
          ? fresh.metaRevision
          : fresh.metaRevision + 1
      const row = await transaction
        .update(skills)
        .set({
          description: input.candidate.description,
          contentVersion: versionIndex,
          metaRevision,
          versionState: 'snapshot-authoritative',
          updatedAt,
        })
        .where(
          and(
            eq(skills.id, fresh.id),
            eq(skills.name, fresh.name),
            ownerWhere(fresh.ownerUserId),
            eq(skills.visibility, fresh.visibility),
            eq(skills.aclRevision, fresh.aclRevision),
            eq(skills.contentVersion, fresh.contentVersion),
            eq(skills.metaRevision, fresh.metaRevision),
            eq(skills.reservationState, fresh.reservationState),
            eq(skills.versionState, fresh.versionState),
          ),
        )
        .returning()
        .get()
      if (row === undefined) throw targetChanged()
      await transaction
        .insert(skillVersions)
        .values({
          id: input.id(),
          skillId: fresh.id,
          versionIndex,
          filesPath: plan.filesPath,
          source: 'editor',
          summary: null,
          fusionId: null,
          restoredFromVersion: null,
          authorUserId: input.authority.user.id,
          contentHash: plan.contentHash,
          createdAt: updatedAt,
        })
        .run()
      updated = skillFromPersistenceRow(row)
    })
  })
  if (updated === null) throw new Error('skill ZIP overwrite committed without a row')
  return updated
}

function failureFrom(error: unknown, candidateName: string): SkillZipCommitFailure {
  if (error instanceof SkillZipCandidateFailure) {
    return { name: candidateName, code: error.code, message: error.message }
  }
  if (error instanceof ConflictError && error.code === 'resource-operation-stale') {
    return {
      name: candidateName,
      code: 'resource-operation-stale',
      message: error.message,
    }
  }
  return {
    name: candidateName,
    code: 'skill-write-failed',
    message: error instanceof Error ? error.message : String(error),
  }
}

export interface PostgresqlSkillZipImportDependencies {
  readonly db: PostgresqlDatabaseClient
  readonly content: PostgresqlSkillContentLifecycle
  readonly id?: () => string
  readonly now?: () => number
}

/** PostgreSQL-native whole-tree ZIP participant; never opens a SQLite shadow. */
export function createPostgresqlSkillZipImportParticipant(
  input: PostgresqlSkillZipImportDependencies,
): SkillZipImportParticipant {
  const mintId = input.id ?? ulid
  const now = input.now ?? Date.now
  const port: SkillZipImportPort = {
    async parse(authority, archive) {
      const parsed = parseSkillZipEntries(decodeSkillZipArchive(archive))
      const existing = await listTargetsByName(
        input.db,
        parsed.skills.map((candidate) => candidate.name),
      )
      const grants = await listActorSkillGrants(input.db, authority)
      const byName = new Map<string, SkillZipTargetRow[]>()
      for (const row of existing) {
        const rows = byName.get(row.name) ?? []
        rows.push(row)
        byName.set(row.name, rows)
      }

      const skillsView: SkillZipCandidateView[] = []
      for (const candidate of parsed.skills) {
        const sameName = byName.get(candidate.name) ?? []
        const overwriteCandidates: SkillZipOverwriteCandidate[] = []
        for (const row of sameName) {
          const access = targetAccess(authority, row, grants.get(row.id) ?? null)
          if (canEditAccess(access) && (await targetIsAvailable(input.content, row))) {
            overwriteCandidates.push(toOverwriteCandidate(row))
          }
        }
        overwriteCandidates.sort((left, right) => {
          const ownerOrder = (left.ownerUserId ?? '').localeCompare(right.ownerUserId ?? '')
          return ownerOrder !== 0 ? ownerOrder : left.skillId.localeCompare(right.skillId)
        })
        skillsView.push({
          name: candidate.name,
          description: candidate.description,
          fileCount: candidate.files.length,
          totalBytes: candidate.totalBytes,
          warnings: candidate.warnings,
          ...(sameName.some((row) => row.ownerUserId === authority.user.id)
            ? { conflict: 'managed' }
            : {}),
          overwriteCandidates,
        })
      }
      return { skills: skillsView, errors: parsed.errors }
    },

    async commit(authority, archive, decisions) {
      const candidates = parseSkillZipEntries(decodeSkillZipArchive(archive)).skills
      const decisionFor = new Map(Object.entries(decisions))
      const claimedNames = new Set<string>()
      const outcome: CommitOutcome = { created: [], updated: [], skipped: [], failed: [] }

      for (const candidate of candidates) {
        const decision = decisionFor.get(candidate.name)
        if (decision === undefined || decision.action === 'skip') {
          outcome.skipped.push({
            name: candidate.name,
            reason: decision === undefined ? 'no decision in request' : 'skipped by user',
          })
          continue
        }

        const targetName = decision.action === 'rename' ? decision.newName : candidate.name
        if (!SKILL_NAME_RE.test(targetName)) {
          outcome.failed.push({
            name: candidate.name,
            code: 'skill-name-invalid',
            message: `target name '${targetName}' is not a valid skill name`,
          })
          continue
        }
        if (claimedNames.has(targetName)) {
          outcome.failed.push({
            name: candidate.name,
            code: 'skill-rename-conflict',
            message: `target name '${targetName}' already taken by another candidate in this import`,
          })
          continue
        }

        try {
          if (decision.action === 'overwrite') {
            outcome.updated.push(
              await overwriteImportedSkill({
                db: input.db,
                content: input.content,
                authority,
                candidate,
                decision,
                id: mintId,
                now,
              }),
            )
          } else {
            await assertOwnSlotFree(input.db, input.content, authority.user.id, targetName)
            outcome.created.push(
              await createImportedSkill({
                db: input.db,
                content: input.content,
                authority,
                candidate,
                targetName,
                id: mintId,
                now,
              }),
            )
          }
          claimedNames.add(targetName)
        } catch (error) {
          outcome.failed.push(failureFrom(error, candidate.name))
        }
      }

      const candidateNames = new Set(candidates.map((candidate) => candidate.name))
      for (const name of decisionFor.keys()) {
        if (!candidateNames.has(name)) {
          outcome.skipped.push({ name, reason: 'no matching candidate in zip' })
        }
      }
      return outcome
    },
  }
  return createSkillZipImportParticipant(Object.freeze(port))
}
