import type {
  CombinedSaveSkill,
  CreateManagedSkill,
  DeleteSkill,
  FileNode,
  RestoreSkillVersion,
  Skill,
  SkillCandidate,
  SkillContent,
  SkillVersionContent,
  SkillVersionDiff,
  WriteSkillFile,
} from '@agent-workflow/shared'
import { and, desc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { skillVersions, skills } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ConflictError, NotFoundError, ValidationError, staleConflictError } from '@/util/errors'
import { monotonicNow } from '@/util/time'
import type { SkillRepository } from '../application/skills/ports'
import {
  decodeSkillToken,
  encodeSkillToken,
  skillTokenMatches,
} from '../application/skills/skillToken'
import type { SkillOperationContext } from '../public/participants'
import type {
  DeleteSkillFileCatalogReceipt,
  RestoreSkillVersionCatalogReceipt,
  WriteSkillFileCatalogReceipt,
} from '../public/types'
import { skillFromPersistenceRow, skillVersionFromPersistenceRow } from './skillPersistence'
import {
  isPostgresqlUniqueViolation,
  runPostgresqlResourceCatalogTransaction,
  type PostgresqlResourceCatalogTransaction,
} from './postgresql/repositorySupport'

export interface PostgresqlSkillVersionPlan<TResult> {
  readonly filesPath: string
  readonly contentHash: string | null
  readonly result: TResult
  commitInTransaction(
    transaction: PostgresqlResourceCatalogTransaction,
    versionIndex: number,
  ): Promise<void>
  publish(): Promise<void>
  complete(): Promise<void>
  abort(input: { readonly databaseCommitted: boolean }): Promise<void>
}

/**
 * Memory owns fusion provenance. Resource Catalog only asks the selected
 * provider to clear provenance that is newer than the restored Skill version,
 * using the exact transaction already reserved for the Skill version bump.
 */
export interface PostgresqlSkillMemoryFusionParticipantInTx {
  unfuseAboveVersion(input: {
    readonly skillId: string
    readonly aboveVersion: number
  }): Promise<readonly string[]>
}

export interface PostgresqlSkillMemoryFusionParticipantFactory {
  inTransaction(
    transaction: PostgresqlResourceCatalogTransaction,
  ): PostgresqlSkillMemoryFusionParticipantInTx
}

export interface PostgresqlSkillDeletePlan {
  commitInTransaction(transaction: PostgresqlResourceCatalogTransaction): Promise<void>
  publish(): Promise<void>
  complete(): Promise<void>
  abort(input: { readonly databaseCommitted: boolean }): Promise<void>
}

/**
 * Filesystem staging/publish/recovery owner for PostgreSQL-backed skills.
 * Implementations must durably journal before commitInTransaction and recover
 * a database-committed plan after a process crash; the repository never falls
 * back to the synchronous SQLite skill facade.
 */
export interface PostgresqlSkillContentLifecycle {
  isAvailable(skill: Skill): Promise<boolean>
  prepareCreate(input: {
    readonly authority: SkillOperationContext
    readonly id: string
    readonly input: CreateManagedSkill
    readonly now: number
  }): Promise<PostgresqlSkillVersionPlan<SkillContent> & { readonly managedPath: string }>
  prepareSave(input: {
    readonly authority: SkillOperationContext
    readonly current: Skill
    readonly input: Omit<CombinedSaveSkill, 'expectedToken'>
  }): Promise<PostgresqlSkillVersionPlan<SkillContent>>
  /**
   * Record and prestage one complete ZIP tree before the database transaction.
   * The plan publishes exactly one v1 snapshot; callers must not replay files
   * through the ordinary per-file writer.
   */
  prepareImportCreate(input: {
    readonly authority: SkillOperationContext
    readonly id: string
    readonly targetName: string
    readonly candidate: SkillCandidate
    readonly now: number
  }): Promise<PostgresqlSkillVersionPlan<void> & { readonly managedPath: string }>
  /** Record and prestage one full replacement tree for one new version. */
  prepareImportOverwrite(input: {
    readonly authority: SkillOperationContext
    readonly current: Skill
    readonly targetName: string
    readonly candidate: SkillCandidate
    readonly now: number
  }): Promise<PostgresqlSkillVersionPlan<void>>
  prepareWriteFile(input: {
    readonly authority: SkillOperationContext
    readonly current: Skill
    readonly path: string
    readonly input: WriteSkillFile
  }): Promise<PostgresqlSkillVersionPlan<Readonly<{ path: string }>>>
  prepareDeleteFile(input: {
    readonly authority: SkillOperationContext
    readonly current: Skill
    readonly path: string
  }): Promise<PostgresqlSkillVersionPlan<Readonly<{ path: string }>>>
  prepareRestore(input: {
    readonly authority: SkillOperationContext
    readonly current: Skill
    readonly version: number
    readonly input: RestoreSkillVersion
  }): Promise<PostgresqlSkillVersionPlan<Readonly<{ unfusedMemoryIds: readonly string[] }>>>
  prepareDelete(input: {
    readonly authority: SkillOperationContext
    readonly current: Skill
  }): Promise<PostgresqlSkillDeletePlan>
  assertDeleteInTransaction(
    transaction: PostgresqlResourceCatalogTransaction,
    authority: SkillOperationContext,
    current: Skill,
  ): Promise<void>
  readContent(skill: Skill): Promise<SkillContent>
  listFiles(skill: Skill): Promise<readonly FileNode[]>
  readFile(skill: Skill, path: string): Promise<string>
  getVersionContent(skill: Skill, version: number): Promise<SkillVersionContent>
  diffVersions(skill: Skill, from: number, to: number): Promise<SkillVersionDiff>
}

function notFound(id: string): NotFoundError {
  return new NotFoundError('skill-not-found', `skill '${id}' not found`)
}

function stale(skill: Skill) {
  return staleConflictError(
    'skill',
    `skill '${skill.name}' changed since you loaded it; reload and retry`,
  )
}

function currentToken(skill: Skill): string {
  return encodeSkillToken({
    skillId: skill.id,
    contentVersion: skill.contentVersion,
    metaRevision: skill.metaRevision,
  })
}

function assertToken(skill: Skill, expectedToken: string | undefined): void {
  if (expectedToken === undefined) return
  const expected = decodeSkillToken(expectedToken)
  if (expected === null) {
    throw new ValidationError(
      'skill-token-invalid',
      'malformed precondition token; reload and retry',
    )
  }
  if (
    !skillTokenMatches(expected, {
      skillId: skill.id,
      contentVersion: skill.contentVersion,
      metaRevision: skill.metaRevision,
    })
  ) {
    throw stale(skill)
  }
}

export async function executePostgresqlSkillVersionPlan<TResult>(
  plan: PostgresqlSkillVersionPlan<TResult>,
  databaseCommit: () => Promise<void>,
): Promise<void> {
  let databaseCommitted = false
  try {
    await databaseCommit()
    databaseCommitted = true
    await plan.publish()
    await plan.complete()
  } catch (error) {
    await plan.abort({ databaseCommitted })
    throw error
  }
}

export function createPostgresqlSkillRepository(input: {
  readonly db: PostgresqlDatabaseClient
  readonly content: PostgresqlSkillContentLifecycle
  readonly id?: () => string
  readonly now?: () => number
}): SkillRepository {
  const mintId = input.id ?? ulid
  const now = input.now ?? Date.now

  async function loadStored(id: string): Promise<Skill | null> {
    const row = await input.db
      .select()
      .from(skills)
      .where(and(eq(skills.id, id), eq(skills.reservationState, 'ready')))
      .limit(1)
      .get()
    if (row === undefined) return null
    const skill = skillFromPersistenceRow(row)
    return (await input.content.isAvailable(skill)) ? skill : null
  }

  async function requireFresh(
    transaction: PostgresqlResourceCatalogTransaction,
    expected: Skill,
  ): Promise<Skill> {
    const row = await transaction.select().from(skills).where(eq(skills.id, expected.id)).get()
    if (row === undefined) throw notFound(expected.id)
    const fresh = skillFromPersistenceRow(row)
    if (
      fresh.contentVersion !== expected.contentVersion ||
      fresh.metaRevision !== expected.metaRevision ||
      (fresh.aclRevision ?? 0) !== (expected.aclRevision ?? 0) ||
      fresh.ownerUserId !== expected.ownerUserId
    ) {
      throw stale(fresh)
    }
    return fresh
  }

  async function commitVersion<TResult>(inputPlan: {
    readonly authority: SkillOperationContext
    readonly current: Skill
    readonly plan: PostgresqlSkillVersionPlan<TResult>
    readonly source: 'editor' | 'restore'
    readonly summary?: string
    readonly restoredFromVersion?: number
    readonly description?: string
  }): Promise<{ readonly fresh: Skill; readonly versionIndex: number }> {
    const versionIndex = inputPlan.current.contentVersion + 1
    let freshAfter: Skill | null = null
    await executePostgresqlSkillVersionPlan(inputPlan.plan, async () => {
      await runPostgresqlResourceCatalogTransaction(input.db, async (transaction) => {
        const fresh = await requireFresh(transaction, inputPlan.current)
        await inputPlan.plan.commitInTransaction(transaction, versionIndex)
        const updatedAt = monotonicNow(fresh.updatedAt)
        const nextDescription = inputPlan.description ?? fresh.description
        const nextMetaRevision =
          nextDescription === fresh.description ? fresh.metaRevision : fresh.metaRevision + 1
        const changed = await transaction
          .update(skills)
          .set({
            description: nextDescription,
            contentVersion: versionIndex,
            metaRevision: nextMetaRevision,
            versionState: 'snapshot-authoritative',
            updatedAt,
          })
          .where(
            and(
              eq(skills.id, fresh.id),
              eq(skills.contentVersion, fresh.contentVersion),
              eq(skills.metaRevision, fresh.metaRevision),
              eq(skills.aclRevision, fresh.aclRevision ?? 0),
            ),
          )
          .returning()
          .get()
        if (changed === undefined) throw stale(fresh)
        await transaction
          .insert(skillVersions)
          .values({
            id: mintId(),
            skillId: fresh.id,
            versionIndex,
            filesPath: inputPlan.plan.filesPath,
            source: inputPlan.source,
            summary: inputPlan.summary ?? null,
            fusionId: null,
            restoredFromVersion: inputPlan.restoredFromVersion ?? null,
            authorUserId: inputPlan.authority.user.id,
            contentHash: inputPlan.plan.contentHash,
            createdAt: updatedAt,
          })
          .run()
        freshAfter = skillFromPersistenceRow(changed)
      })
    })
    if (freshAfter === null) throw new Error('skill disappeared after version commit')
    return { fresh: freshAfter, versionIndex }
  }

  const repository: SkillRepository = {
    async list() {
      const rows = await input.db
        .select()
        .from(skills)
        .where(eq(skills.reservationState, 'ready'))
        .all()
      const visible: Skill[] = []
      for (const row of rows) {
        const skill = skillFromPersistenceRow(row)
        if (await input.content.isAvailable(skill)) visible.push(skill)
      }
      return visible
    },
    get: loadStored,
    async create(authority, submitted) {
      const id = mintId()
      const createdAt = now()
      const plan = await input.content.prepareCreate({
        authority,
        id,
        input: submitted,
        now: createdAt,
      })
      try {
        await executePostgresqlSkillVersionPlan(plan, async () => {
          await runPostgresqlResourceCatalogTransaction(input.db, async (transaction) => {
            const reservation = await transaction
              .select({ id: skills.id, reservationState: skills.reservationState })
              .from(skills)
              .where(eq(skills.id, id))
              .get()
            if (reservation?.reservationState !== 'reserving') {
              throw new Error('skill create reservation is missing')
            }
            await plan.commitInTransaction(transaction, 1)
          })
        })
      } catch (error) {
        if (isPostgresqlUniqueViolation(error, ['skills_owner_name_unique'])) {
          throw new ConflictError('skill-name-in-use', `skill '${submitted.name}' already exists`)
        }
        throw error
      }
      const created = await loadStored(id)
      if (created === null) throw new Error('skill disappeared right after insert')
      return created
    },
    async save(authority, current, submitted) {
      assertToken(current, submitted.expectedToken)
      const { expectedToken: _expectedToken, ...patch } = submitted
      const plan = await input.content.prepareSave({ authority, current, input: patch })
      const committed = await commitVersion({
        authority,
        current,
        plan,
        source: 'editor',
        ...(patch.description === undefined ? {} : { description: patch.description }),
      })
      return {
        ...plan.result,
        token: currentToken(committed.fresh),
        contentVersion: committed.fresh.contentVersion,
        metaRevision: committed.fresh.metaRevision,
      }
    },
    async delete(authority, current, submitted: DeleteSkill) {
      assertToken(current, submitted.expectedToken)
      if ((current.aclRevision ?? 0) !== submitted.expectedAclRevision) throw stale(current)
      const plan = await input.content.prepareDelete({ authority, current })
      let databaseCommitted = false
      try {
        await runPostgresqlResourceCatalogTransaction(input.db, async (transaction) => {
          const fresh = await requireFresh(transaction, current)
          await input.content.assertDeleteInTransaction(transaction, authority, fresh)
          await plan.commitInTransaction(transaction)
          const removed = await transaction
            .delete(skills)
            .where(
              and(
                eq(skills.id, fresh.id),
                eq(skills.contentVersion, fresh.contentVersion),
                eq(skills.metaRevision, fresh.metaRevision),
                eq(skills.aclRevision, submitted.expectedAclRevision),
              ),
            )
            .returning({ id: skills.id })
            .get()
          if (removed === undefined) throw stale(fresh)
        })
        databaseCommitted = true
        await plan.publish()
        await plan.complete()
      } catch (error) {
        await plan.abort({ databaseCommitted })
        throw error
      }
    },
    async readContent(id) {
      const skill = await loadStored(id)
      if (skill === null) throw notFound(id)
      const content = await input.content.readContent(skill)
      return {
        ...content,
        token: currentToken(skill),
        contentVersion: skill.contentVersion,
        metaRevision: skill.metaRevision,
      }
    },
    async listFiles(id) {
      const skill = await loadStored(id)
      if (skill === null) throw notFound(id)
      return input.content.listFiles(skill)
    },
    async readFile(id, path) {
      const skill = await loadStored(id)
      if (skill === null) throw notFound(id)
      return input.content.readFile(skill, path)
    },
    async writeFile(authority, current, path, submitted) {
      assertToken(current, submitted.expectedToken)
      const plan = await input.content.prepareWriteFile({
        authority,
        current,
        path,
        input: submitted,
      })
      const committed = await commitVersion({ authority, current, plan, source: 'editor' })
      return Object.freeze({
        ok: true,
        path: plan.result.path,
        token: currentToken(committed.fresh),
      } satisfies WriteSkillFileCatalogReceipt)
    },
    async deleteFile(authority, current, path, expectedToken) {
      assertToken(current, expectedToken)
      const plan = await input.content.prepareDeleteFile({ authority, current, path })
      const committed = await commitVersion({ authority, current, plan, source: 'editor' })
      return Object.freeze({
        deleted: Object.freeze({ skillId: current.id, name: current.name, path: plan.result.path }),
        token: currentToken(committed.fresh),
      } satisfies DeleteSkillFileCatalogReceipt)
    },
    async listVersions(id) {
      const skill = await loadStored(id)
      if (skill === null) throw notFound(id)
      return (
        await input.db
          .select()
          .from(skillVersions)
          .where(eq(skillVersions.skillId, id))
          .orderBy(desc(skillVersions.versionIndex))
          .all()
      ).map((row) => skillVersionFromPersistenceRow(row, skill.name))
    },
    async diffVersions(id, from, to) {
      const skill = await loadStored(id)
      if (skill === null) throw notFound(id)
      return input.content.diffVersions(skill, from, to)
    },
    async getVersionContent(id, version) {
      const skill = await loadStored(id)
      if (skill === null) throw notFound(id)
      return input.content.getVersionContent(skill, version)
    },
    async restoreVersion(authority, current, version, submitted) {
      assertToken(current, submitted.expectedToken)
      const plan = await input.content.prepareRestore({
        authority,
        current,
        version,
        input: submitted,
      })
      const committed = await commitVersion({
        authority,
        current,
        plan,
        source: 'restore',
        restoredFromVersion: version,
        summary:
          submitted.reason !== undefined && submitted.reason.length > 0
            ? submitted.reason
            : `Restored from v${version}`,
      })
      const versionRow = await input.db
        .select()
        .from(skillVersions)
        .where(
          and(
            eq(skillVersions.skillId, current.id),
            eq(skillVersions.versionIndex, committed.versionIndex),
          ),
        )
        .get()
      if (versionRow === undefined) throw new Error('skill version disappeared after restore')
      return Object.freeze({
        version: skillVersionFromPersistenceRow(versionRow, current.name),
        unfusedMemoryIds: Object.freeze([...plan.result.unfusedMemoryIds]),
        token: currentToken(committed.fresh),
      } satisfies RestoreSkillVersionCatalogReceipt)
    },
  }
  return Object.freeze(repository)
}
