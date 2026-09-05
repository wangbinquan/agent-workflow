// RFC-310 PR-1B —— digital_employees / automation_policies 的 identity + immutable revision 持久化，连同
// assignment 与员工 publish 闭包 lookup。RFC-359 W4-D6b 起一份实现，两个 provider 共用。
//
// 两类资源同构：identity 行（ACL + 可变 draft_json）+ immutable revision 行（publish 冻结 canonical JSON +
// digest，revision 单调递增）。publish 的业务校验在 application（strict parse + 闭包检查），这里只做持久化
// 原语：publish 先 lockAggregateRoot 锁住 identity（PG 渲染 FOR UPDATE，SQLite 独占事务下 no-op），再做
// 「draft 未变」CAS、插 revision 行、推进 published_revision——不存在半个 revision。name 撞 (owner, name)
// 唯一索引经能力矩阵归类成 typed 409。

import { and, asc, eq, isNull } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  actionTemplateRevisions,
  automationPolicies,
  automationPolicyRevisions,
  developmentAdapterDefinitionRevisions,
  digitalEmployeeRevisions,
  digitalEmployees,
} from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { ConflictError, NotFoundError } from '@/util/errors'
import type {
  DevelopmentConfigPersistence,
  DevelopmentResourceIdentity,
  DevelopmentResourceIdentityPersistence,
} from '../application/ports/developmentConfigPersistence'
import { deleteAssignment, listAssignments, upsertAssignment } from './assignmentStore'

const IDENTITY = {
  employee: { table: digitalEmployees, code: 'digital-employee', label: 'digital employee' },
  policy: { table: automationPolicies, code: 'automation-policy', label: 'automation policy' },
} as const

type IdentityKind = keyof typeof IDENTITY

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

function identityPersistence(
  db: ProviderNeutralDatabase,
  kind: IdentityKind,
): DevelopmentResourceIdentityPersistence {
  const session = databaseSessionFor(db)
  const { table, code, label } = IDENTITY[kind]
  const notFound = (message: string): NotFoundError =>
    new NotFoundError(`${code}-not-found`, message)
  const nameTaken = (error: unknown): never => {
    if (session.engine.classifyError(error) === 'unique-violation') {
      throw new ConflictError(`${code}-name-taken`, `a ${code} with this name already exists`)
    }
    throw error
  }
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
        await db.insert(table).values(row)
      } catch (error) {
        nameTaken(error)
      }
      return identityOf(row)
    },
    async get(id) {
      const row = (await db.select().from(table).where(eq(table.id, id)).limit(1))[0]
      return row === undefined ? null : identityOf(row)
    },
    async listActive() {
      const rows = await db
        .select()
        .from(table)
        .where(isNull(table.archivedAt))
        .orderBy(asc(table.createdAt), asc(table.id))
      return rows.map(identityOf)
    },
    async revise(input) {
      const row = (await db.select().from(table).where(eq(table.id, input.id)).limit(1))[0]
      if (row === undefined || row.archivedAt !== null) throw notFound(`${label} not found`)
      try {
        await db
          .update(table)
          .set({
            draftJson: input.draftJson,
            updatedAt: input.now,
            ...(input.name === undefined ? {} : { name: input.name.trim() }),
          })
          .where(eq(table.id, input.id))
      } catch (error) {
        nameTaken(error)
      }
    },
    async archive(id, now) {
      const updated = await db
        .update(table)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(table.id, id))
        .returning({ id: table.id })
      if (updated.length !== 1) throw notFound('not found')
    },
    async publish(input) {
      return await session.transaction(async (tx) => {
        await session.engine.lockAggregateRoot(tx, table, table.id, input.id)
        const identity = (await tx.select().from(table).where(eq(table.id, input.id)).limit(1))[0]
        if (identity === undefined || identity.archivedAt !== null) {
          throw notFound(`${label} not found`)
        }
        if (identity.draftJson !== input.expectedDraftJson) {
          throw new ConflictError(`${code}-draft-changed`, 'draft changed while publishing')
        }
        const revision = (identity.publishedRevision ?? 0) + 1
        if (kind === 'employee') {
          await tx.insert(digitalEmployeeRevisions).values({
            employeeId: input.id,
            revision,
            contentJson: input.contentJson,
            contentDigest: input.contentDigest,
            publishedAt: input.now,
            publishedBy: input.publishedBy,
          })
        } else {
          await tx.insert(automationPolicyRevisions).values({
            policyId: input.id,
            revision,
            contentJson: input.contentJson,
            contentDigest: input.contentDigest,
            publishedAt: input.now,
            publishedBy: input.publishedBy,
          })
        }
        await tx
          .update(table)
          .set({ publishedRevision: revision, updatedAt: input.now })
          .where(eq(table.id, input.id))
        return { revision, contentDigest: input.contentDigest }
      })
    },
  }
}

export function createDevelopmentConfigPersistence(
  db: ProviderNeutralDatabase,
): DevelopmentConfigPersistence {
  return {
    employees: identityPersistence(db, 'employee'),
    policies: identityPersistence(db, 'policy'),
    assignments: {
      list: () => listAssignments(db),
      upsert: (input) => upsertAssignment(db, input),
      delete: (scopeKind, scopeRef) => deleteAssignment(db, scopeKind, scopeRef),
    },
    publishLookup: {
      async getTemplate(id, revision) {
        const row = (
          await db
            .select({ contentJson: actionTemplateRevisions.contentJson })
            .from(actionTemplateRevisions)
            .where(
              and(
                eq(actionTemplateRevisions.templateId, id),
                eq(actionTemplateRevisions.revision, revision),
              ),
            )
            .limit(1)
        )[0]
        if (row === undefined) return null
        const content = JSON.parse(row.contentJson) as { readonly capabilityId?: unknown }
        return typeof content.capabilityId === 'string'
          ? { capabilityId: content.capabilityId }
          : null
      },
      async getPolicy(id, revision) {
        const row = (
          await db
            .select({ revision: automationPolicyRevisions.revision })
            .from(automationPolicyRevisions)
            .where(
              and(
                eq(automationPolicyRevisions.policyId, id),
                eq(automationPolicyRevisions.revision, revision),
              ),
            )
            .limit(1)
        )[0]
        return row === undefined ? null : { exists: true }
      },
      async getAdapter(id, revision) {
        const row = (
          await db
            .select({ contentJson: developmentAdapterDefinitionRevisions.contentJson })
            .from(developmentAdapterDefinitionRevisions)
            .where(
              and(
                eq(developmentAdapterDefinitionRevisions.adapterId, id),
                eq(developmentAdapterDefinitionRevisions.revision, revision),
              ),
            )
            .limit(1)
        )[0]
        if (row === undefined) return null
        const content = JSON.parse(row.contentJson) as { readonly purpose?: unknown }
        return typeof content.purpose === 'string' ? { purpose: content.purpose } : null
      },
      async getEmployee(id, revision) {
        const row = (
          await db
            .select({ revision: digitalEmployeeRevisions.revision })
            .from(digitalEmployeeRevisions)
            .where(
              and(
                eq(digitalEmployeeRevisions.employeeId, id),
                eq(digitalEmployeeRevisions.revision, revision),
              ),
            )
            .limit(1)
        )[0]
        return row === undefined ? null : { exists: true }
      },
    },
  }
}
