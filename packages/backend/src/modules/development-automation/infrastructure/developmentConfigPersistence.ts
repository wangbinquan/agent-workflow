import { and, eq, isNull, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import {
  actionTemplateRevisions,
  automationPolicies,
  automationPolicyRevisions,
  developmentAdapterDefinitionRevisions,
  digitalEmployeeRevisions,
  digitalEmployees,
  repositoryEmployeeAssignments,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import type {
  DevelopmentAssignmentRecord,
  DevelopmentConfigPersistence,
  DevelopmentResourceIdentity,
  DevelopmentResourceIdentityPersistence,
} from '../application/ports/developmentConfigPersistence'
import { deleteAssignment, listAssignments, upsertAssignment } from './sqliteAssignmentStore'
import { createEmployeePublishLookup } from './publishLookup'

function identityOf(row: {
  readonly id: string
  readonly name: string
  readonly draftJson: string
  readonly publishedRevision: number | null
  readonly ownerUserId: string | null
  readonly visibility: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt: number | null
}): DevelopmentResourceIdentity {
  if (row.visibility !== 'private' && row.visibility !== 'public') {
    throw new Error(`invalid development resource visibility: ${row.visibility}`)
  }
  return { ...row, visibility: row.visibility }
}

function uniqueGuard(error: unknown, resource: string): never {
  const message = error instanceof Error ? error.message : String(error)
  if (message.toLowerCase().includes('unique')) {
    throw new ConflictError(`${resource}-name-taken`, `a ${resource} with this name already exists`)
  }
  throw error
}

function createSqliteEmployeeIdentityPersistence(
  db: DbClient,
): DevelopmentResourceIdentityPersistence {
  return {
    async create(input) {
      const row = {
        id: input.id,
        name: input.name,
        draftJson: input.draftJson,
        publishedRevision: null,
        ownerUserId: input.ownerUserId,
        visibility: 'private' as const,
        aclRevision: 0,
        createdAt: input.now,
        updatedAt: input.now,
        archivedAt: null,
      }
      try {
        db.insert(digitalEmployees).values(row).run()
      } catch (error) {
        uniqueGuard(error, 'digital-employee')
      }
      return identityOf(row)
    },
    async get(id) {
      const row = db.select().from(digitalEmployees).where(eq(digitalEmployees.id, id)).get()
      return row === undefined ? null : identityOf(row)
    },
    async listActive() {
      return db
        .select()
        .from(digitalEmployees)
        .where(isNull(digitalEmployees.archivedAt))
        .all()
        .map(identityOf)
    },
    async revise(input) {
      const row = db.select().from(digitalEmployees).where(eq(digitalEmployees.id, input.id)).get()
      if (row === undefined || row.archivedAt !== null) {
        throw new NotFoundError('digital-employee-not-found', 'digital employee not found')
      }
      try {
        db.update(digitalEmployees)
          .set({
            draftJson: input.draftJson,
            updatedAt: input.now,
            ...(input.name === undefined ? {} : { name: input.name.trim() }),
          })
          .where(eq(digitalEmployees.id, input.id))
          .run()
      } catch (error) {
        uniqueGuard(error, 'digital-employee')
      }
    },
    async archive(id, now) {
      const row = db
        .select({ id: digitalEmployees.id })
        .from(digitalEmployees)
        .where(eq(digitalEmployees.id, id))
        .get()
      if (row === undefined) throw new NotFoundError('digital-employee-not-found', 'not found')
      db.update(digitalEmployees)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(digitalEmployees.id, id))
        .run()
    },
    async publish(input) {
      return dbTxSync(db, (tx) => {
        const identity = tx
          .select()
          .from(digitalEmployees)
          .where(eq(digitalEmployees.id, input.id))
          .get()
        if (identity === undefined || identity.archivedAt !== null) {
          throw new NotFoundError('digital-employee-not-found', 'digital employee not found')
        }
        if (identity.draftJson !== input.expectedDraftJson) {
          throw new ConflictError(
            'digital-employee-draft-changed',
            'draft changed while publishing',
          )
        }
        const revision = (identity.publishedRevision ?? 0) + 1
        tx.insert(digitalEmployeeRevisions)
          .values({
            employeeId: input.id,
            revision,
            contentJson: input.contentJson,
            contentDigest: input.contentDigest,
            publishedAt: input.now,
            publishedBy: input.publishedBy,
          })
          .run()
        tx.update(digitalEmployees)
          .set({ publishedRevision: revision, updatedAt: input.now })
          .where(eq(digitalEmployees.id, input.id))
          .run()
        return { revision, contentDigest: input.contentDigest }
      })
    },
  }
}

function createSqlitePolicyIdentityPersistence(
  db: DbClient,
): DevelopmentResourceIdentityPersistence {
  return {
    async create(input) {
      const row = {
        id: input.id,
        name: input.name,
        draftJson: input.draftJson,
        publishedRevision: null,
        ownerUserId: input.ownerUserId,
        visibility: 'private' as const,
        aclRevision: 0,
        createdAt: input.now,
        updatedAt: input.now,
        archivedAt: null,
      }
      try {
        db.insert(automationPolicies).values(row).run()
      } catch (error) {
        uniqueGuard(error, 'automation-policy')
      }
      return identityOf(row)
    },
    async get(id) {
      const row = db.select().from(automationPolicies).where(eq(automationPolicies.id, id)).get()
      return row === undefined ? null : identityOf(row)
    },
    async listActive() {
      return db
        .select()
        .from(automationPolicies)
        .where(isNull(automationPolicies.archivedAt))
        .all()
        .map(identityOf)
    },
    async revise(input) {
      const row = db
        .select()
        .from(automationPolicies)
        .where(eq(automationPolicies.id, input.id))
        .get()
      if (row === undefined || row.archivedAt !== null) {
        throw new NotFoundError('automation-policy-not-found', 'automation policy not found')
      }
      try {
        db.update(automationPolicies)
          .set({
            draftJson: input.draftJson,
            updatedAt: input.now,
            ...(input.name === undefined ? {} : { name: input.name.trim() }),
          })
          .where(eq(automationPolicies.id, input.id))
          .run()
      } catch (error) {
        uniqueGuard(error, 'automation-policy')
      }
    },
    async archive(id, now) {
      const row = db
        .select({ id: automationPolicies.id })
        .from(automationPolicies)
        .where(eq(automationPolicies.id, id))
        .get()
      if (row === undefined) throw new NotFoundError('automation-policy-not-found', 'not found')
      db.update(automationPolicies)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(automationPolicies.id, id))
        .run()
    },
    async publish(input) {
      return dbTxSync(db, (tx) => {
        const identity = tx
          .select()
          .from(automationPolicies)
          .where(eq(automationPolicies.id, input.id))
          .get()
        if (identity === undefined || identity.archivedAt !== null) {
          throw new NotFoundError('automation-policy-not-found', 'automation policy not found')
        }
        if (identity.draftJson !== input.expectedDraftJson) {
          throw new ConflictError(
            'automation-policy-draft-changed',
            'draft changed while publishing',
          )
        }
        const revision = (identity.publishedRevision ?? 0) + 1
        tx.insert(automationPolicyRevisions)
          .values({
            policyId: input.id,
            revision,
            contentJson: input.contentJson,
            contentDigest: input.contentDigest,
            publishedAt: input.now,
            publishedBy: input.publishedBy,
          })
          .run()
        tx.update(automationPolicies)
          .set({ publishedRevision: revision, updatedAt: input.now })
          .where(eq(automationPolicies.id, input.id))
          .run()
        return { revision, contentDigest: input.contentDigest }
      })
    },
  }
}

export function createSqliteDevelopmentConfigPersistence(
  db: DbClient,
): DevelopmentConfigPersistence {
  const lookup = createEmployeePublishLookup(db)
  return {
    employees: createSqliteEmployeeIdentityPersistence(db),
    policies: createSqlitePolicyIdentityPersistence(db),
    assignments: {
      async list() {
        return await listAssignments(db)
      },
      async upsert(input) {
        return await upsertAssignment(db, input)
      },
      async delete(scopeKind, scopeRef) {
        await deleteAssignment(db, scopeKind, scopeRef)
      },
    },
    publishLookup: {
      async getTemplate(id, revision) {
        return lookup.getTemplate(id, revision)
      },
      async getPolicy(id, revision) {
        return lookup.getPolicy(id, revision)
      },
      async getAdapter(id, revision) {
        return lookup.getAdapter(id, revision)
      },
      async getEmployee(id, revision) {
        return lookup.getEmployee?.(id, revision) ?? null
      },
    },
  }
}

function createPostgresqlIdentityPersistence(
  db: PostgresqlDatabaseClient,
  kind: 'employee' | 'policy',
): DevelopmentResourceIdentityPersistence {
  const table = kind === 'employee' ? digitalEmployees : automationPolicies
  const resource = kind === 'employee' ? 'digital-employee' : 'automation-policy'
  return {
    async create(input) {
      const row = {
        id: input.id,
        name: input.name,
        draftJson: input.draftJson,
        publishedRevision: null,
        ownerUserId: input.ownerUserId,
        visibility: 'private' as const,
        aclRevision: 0,
        createdAt: input.now,
        updatedAt: input.now,
        archivedAt: null,
      }
      try {
        await db.insert(table).values(row).run()
      } catch (error) {
        uniqueGuard(error, resource)
      }
      return identityOf(row)
    },
    async get(id) {
      const row = await db.select().from(table).where(eq(table.id, id)).limit(1).get()
      return row === undefined ? null : identityOf(row)
    },
    async listActive() {
      return (await db.select().from(table).where(isNull(table.archivedAt)).all()).map(identityOf)
    },
    async revise(input) {
      const row = await db.select().from(table).where(eq(table.id, input.id)).limit(1).get()
      if (row === undefined || row.archivedAt !== null) {
        throw new NotFoundError(`${resource}-not-found`, `${resource} not found`)
      }
      try {
        await db
          .update(table)
          .set({
            draftJson: input.draftJson,
            updatedAt: input.now,
            ...(input.name === undefined ? {} : { name: input.name.trim() }),
          })
          .where(eq(table.id, input.id))
          .run()
      } catch (error) {
        uniqueGuard(error, resource)
      }
    },
    async archive(id, now) {
      const updated = await db
        .update(table)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(table.id, id))
        .returning({ id: table.id })
        .all()
      if (updated.length !== 1) throw new NotFoundError(`${resource}-not-found`, 'not found')
    },
    async publish(input) {
      return await db.transaction(async (tx) => {
        await tx.run(
          sql`select ${table.id} from ${table} where ${table.id} = ${input.id} for update`,
        )
        const identity = await tx.select().from(table).where(eq(table.id, input.id)).limit(1).get()
        if (identity === undefined || identity.archivedAt !== null) {
          throw new NotFoundError(`${resource}-not-found`, `${resource} not found`)
        }
        if (identity.draftJson !== input.expectedDraftJson) {
          throw new ConflictError(`${resource}-draft-changed`, 'draft changed while publishing')
        }
        const revision = (identity.publishedRevision ?? 0) + 1
        if (kind === 'employee') {
          await tx
            .insert(digitalEmployeeRevisions)
            .values({
              employeeId: input.id,
              revision,
              contentJson: input.contentJson,
              contentDigest: input.contentDigest,
              publishedAt: input.now,
              publishedBy: input.publishedBy,
            })
            .run()
        } else {
          await tx
            .insert(automationPolicyRevisions)
            .values({
              policyId: input.id,
              revision,
              contentJson: input.contentJson,
              contentDigest: input.contentDigest,
              publishedAt: input.now,
              publishedBy: input.publishedBy,
            })
            .run()
        }
        await tx
          .update(table)
          .set({ publishedRevision: revision, updatedAt: input.now })
          .where(eq(table.id, input.id))
          .run()
        return { revision, contentDigest: input.contentDigest }
      })
    },
  }
}

function assignmentOf(
  row: typeof repositoryEmployeeAssignments.$inferSelect,
): DevelopmentAssignmentRecord {
  if (
    row.scopeKind !== 'repository' &&
    row.scopeKind !== 'repository-group' &&
    row.scopeKind !== 'global-default'
  ) {
    throw new Error(`invalid assignment scope kind: ${row.scopeKind}`)
  }
  return { ...row, scopeKind: row.scopeKind }
}

export function createPostgresqlDevelopmentConfigPersistence(
  db: PostgresqlDatabaseClient,
): DevelopmentConfigPersistence {
  const findAssignment = async (
    scopeKind: DevelopmentAssignmentRecord['scopeKind'],
    scopeRef: string | null,
  ) => {
    const rows = await db
      .select()
      .from(repositoryEmployeeAssignments)
      .where(eq(repositoryEmployeeAssignments.scopeKind, scopeKind))
      .all()
    const row = rows.find((candidate) => (candidate.scopeRef ?? null) === (scopeRef ?? null))
    return row === undefined ? null : assignmentOf(row)
  }
  return {
    employees: createPostgresqlIdentityPersistence(db, 'employee'),
    policies: createPostgresqlIdentityPersistence(db, 'policy'),
    assignments: {
      async list() {
        return (await db.select().from(repositoryEmployeeAssignments).all()).map(assignmentOf)
      },
      async upsert(input) {
        if (input.scopeKind === 'global-default' ? input.scopeRef !== null : !input.scopeRef) {
          throw new ValidationError('assignment-scope-invalid', 'assignment scope is invalid')
        }
        if (
          input.employee === null &&
          input.selectionPolicy === null &&
          input.executionPolicy === null &&
          input.defaultRequirementSourceKey === null
        ) {
          throw new ValidationError('assignment-empty', 'assignment must set at least one field')
        }
        try {
          return await db.transaction(async (tx) => {
            const assertRevision = async (
              kind: 'employee' | 'policy',
              ref: { readonly id: string; readonly revision: number },
              where: string,
            ): Promise<void> => {
              const row =
                kind === 'employee'
                  ? await tx
                      .select({ revision: digitalEmployeeRevisions.revision })
                      .from(digitalEmployeeRevisions)
                      .where(
                        and(
                          eq(digitalEmployeeRevisions.employeeId, ref.id),
                          eq(digitalEmployeeRevisions.revision, ref.revision),
                        ),
                      )
                      .limit(1)
                      .get()
                  : await tx
                      .select({ revision: automationPolicyRevisions.revision })
                      .from(automationPolicyRevisions)
                      .where(
                        and(
                          eq(automationPolicyRevisions.policyId, ref.id),
                          eq(automationPolicyRevisions.revision, ref.revision),
                        ),
                      )
                      .limit(1)
                      .get()
              if (row === undefined) {
                throw new ValidationError(
                  'assignment-ref-missing',
                  `${where} revision does not exist`,
                  { where, ref },
                )
              }
            }
            if (input.employee !== null)
              await assertRevision('employee', input.employee, 'employee')
            if (input.selectionPolicy !== null) {
              await assertRevision('policy', input.selectionPolicy, 'selectionPolicy')
            }
            if (input.executionPolicy !== null) {
              await assertRevision('policy', input.executionPolicy, 'executionPolicy')
            }
            await tx.run(
              sql`select ${repositoryEmployeeAssignments.id} from ${repositoryEmployeeAssignments} where ${repositoryEmployeeAssignments.scopeKind} = ${input.scopeKind} for update`,
            )
            const existingRows = await tx
              .select()
              .from(repositoryEmployeeAssignments)
              .where(eq(repositoryEmployeeAssignments.scopeKind, input.scopeKind))
              .all()
            const existing = existingRows.find(
              (candidate) => (candidate.scopeRef ?? null) === (input.scopeRef ?? null),
            )
            const values = {
              scopeKind: input.scopeKind,
              scopeRef: input.scopeRef,
              employeeId: input.employee?.id ?? null,
              employeeRevision: input.employee?.revision ?? null,
              selectionPolicyId: input.selectionPolicy?.id ?? null,
              selectionPolicyRevision: input.selectionPolicy?.revision ?? null,
              executionPolicyId: input.executionPolicy?.id ?? null,
              executionPolicyRevision: input.executionPolicy?.revision ?? null,
              defaultRequirementSourceKey: input.defaultRequirementSourceKey,
              updatedBy: input.updatedBy,
              updatedAt: input.now,
            }
            if (existing !== undefined) {
              const updated = await tx
                .update(repositoryEmployeeAssignments)
                .set(values)
                .where(eq(repositoryEmployeeAssignments.id, existing.id))
                .returning()
                .all()
              if (updated[0] === undefined) throw new Error('assignment update disappeared')
              return assignmentOf(updated[0])
            }
            const inserted = await tx
              .insert(repositoryEmployeeAssignments)
              .values({ id: ulid(), ...values, createdAt: input.now })
              .returning()
              .all()
            if (inserted[0] === undefined) throw new Error('assignment insert returned no row')
            return assignmentOf(inserted[0])
          })
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          if (/unique|scope_unique/i.test(detail)) {
            throw new ConflictError(
              'assignment-scope-taken',
              'another assignment for this scope was written concurrently',
            )
          }
          throw error
        }
      },
      async delete(scopeKind, scopeRef) {
        const existing = await findAssignment(scopeKind, scopeRef)
        if (existing === null)
          throw new NotFoundError('assignment-not-found', 'assignment not found')
        await db
          .delete(repositoryEmployeeAssignments)
          .where(eq(repositoryEmployeeAssignments.id, existing.id))
          .run()
      },
    },
    publishLookup: {
      async getTemplate(id, revision) {
        const row = await db
          .select({ contentJson: actionTemplateRevisions.contentJson })
          .from(actionTemplateRevisions)
          .where(
            and(
              eq(actionTemplateRevisions.templateId, id),
              eq(actionTemplateRevisions.revision, revision),
            ),
          )
          .limit(1)
          .get()
        if (row === undefined) return null
        const content = JSON.parse(row.contentJson) as { readonly capabilityId?: unknown }
        return typeof content.capabilityId === 'string'
          ? { capabilityId: content.capabilityId }
          : null
      },
      async getPolicy(id, revision) {
        const row = await db
          .select({ revision: automationPolicyRevisions.revision })
          .from(automationPolicyRevisions)
          .where(
            and(
              eq(automationPolicyRevisions.policyId, id),
              eq(automationPolicyRevisions.revision, revision),
            ),
          )
          .limit(1)
          .get()
        return row === undefined ? null : { exists: true }
      },
      async getAdapter(id, revision) {
        const row = await db
          .select({ contentJson: developmentAdapterDefinitionRevisions.contentJson })
          .from(developmentAdapterDefinitionRevisions)
          .where(
            and(
              eq(developmentAdapterDefinitionRevisions.adapterId, id),
              eq(developmentAdapterDefinitionRevisions.revision, revision),
            ),
          )
          .limit(1)
          .get()
        if (row === undefined) return null
        const content = JSON.parse(row.contentJson) as { readonly purpose?: unknown }
        return typeof content.purpose === 'string' ? { purpose: content.purpose } : null
      },
      async getEmployee(id, revision) {
        const row = await db
          .select({ revision: digitalEmployeeRevisions.revision })
          .from(digitalEmployeeRevisions)
          .where(
            and(
              eq(digitalEmployeeRevisions.employeeId, id),
              eq(digitalEmployeeRevisions.revision, revision),
            ),
          )
          .limit(1)
          .get()
        return row === undefined ? null : { exists: true }
      },
    },
  }
}
