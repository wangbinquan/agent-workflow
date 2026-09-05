// RFC-310 T17 —— repository / repo-group / global-default 员工 assignment store。RFC-359 W4-D6b 起一份实现，
// 两个 provider 共用。
//
// §3.8：scope 优先级 exact repository > repository-group > global default，**每一级最多一份**——由
// (scope_kind, COALESCE(scope_ref,'')) 唯一索引直接保证，同级第二份是配置错误（typed 409），不是「随便
// 取第一个」。assignment 的每个引用都是 (id, revision) 精确版本，upsert 在同一写事务里校验 revision 行
// 存在——挂一个从未发布过的 revision 属配置错误，当场拒绝。并发写同一 scope 由唯一索引兜底，撞库经能力
// 矩阵归类成 typed 409。

import { and, asc, eq, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  automationPolicyRevisions,
  digitalEmployeeRevisions,
  repositoryEmployeeAssignments,
} from '@/db/schema'
import {
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'

export type AssignmentScopeKind = 'repository' | 'repository-group' | 'global-default'

export interface AssignmentRow {
  readonly id: string
  readonly scopeKind: AssignmentScopeKind
  readonly scopeRef: string | null
  readonly employeeId: string | null
  readonly employeeRevision: number | null
  readonly selectionPolicyId: string | null
  readonly selectionPolicyRevision: number | null
  readonly executionPolicyId: string | null
  readonly executionPolicyRevision: number | null
  readonly defaultRequirementSourceKey: string | null
}

export interface UpsertAssignmentInput {
  readonly scopeKind: AssignmentScopeKind
  readonly scopeRef: string | null
  readonly employee: { readonly id: string; readonly revision: number } | null
  readonly selectionPolicy: { readonly id: string; readonly revision: number } | null
  readonly executionPolicy: { readonly id: string; readonly revision: number } | null
  readonly defaultRequirementSourceKey: string | null
  readonly updatedBy: string | null
  /** 缺省取 Date.now()。 */
  readonly now?: number
}

function assignmentOf(row: typeof repositoryEmployeeAssignments.$inferSelect): AssignmentRow {
  if (
    row.scopeKind !== 'repository' &&
    row.scopeKind !== 'repository-group' &&
    row.scopeKind !== 'global-default'
  ) {
    throw new Error(`invalid assignment scope kind: ${row.scopeKind}`)
  }
  return {
    id: row.id,
    scopeKind: row.scopeKind,
    scopeRef: row.scopeRef,
    employeeId: row.employeeId,
    employeeRevision: row.employeeRevision,
    selectionPolicyId: row.selectionPolicyId,
    selectionPolicyRevision: row.selectionPolicyRevision,
    executionPolicyId: row.executionPolicyId,
    executionPolicyRevision: row.executionPolicyRevision,
    defaultRequirementSourceKey: row.defaultRequirementSourceKey,
  }
}

function scopeWhere(scopeKind: AssignmentScopeKind, scopeRef: string | null) {
  return and(
    eq(repositoryEmployeeAssignments.scopeKind, scopeKind),
    scopeRef === null
      ? isNull(repositoryEmployeeAssignments.scopeRef)
      : eq(repositoryEmployeeAssignments.scopeRef, scopeRef),
  )
}

async function assertEmployeeRevision(
  tx: DatabaseTransaction,
  ref: { readonly id: string; readonly revision: number },
): Promise<void> {
  const rows = await tx
    .select({ revision: digitalEmployeeRevisions.revision })
    .from(digitalEmployeeRevisions)
    .where(
      and(
        eq(digitalEmployeeRevisions.employeeId, ref.id),
        eq(digitalEmployeeRevisions.revision, ref.revision),
      ),
    )
    .limit(1)
  if (rows.length === 0) {
    throw new ValidationError('assignment-ref-missing', 'employee revision does not exist', {
      where: 'employee',
      ref,
    })
  }
}

async function assertPolicyRevision(
  tx: DatabaseTransaction,
  ref: { readonly id: string; readonly revision: number },
  where: string,
): Promise<void> {
  const rows = await tx
    .select({ revision: automationPolicyRevisions.revision })
    .from(automationPolicyRevisions)
    .where(
      and(
        eq(automationPolicyRevisions.policyId, ref.id),
        eq(automationPolicyRevisions.revision, ref.revision),
      ),
    )
    .limit(1)
  if (rows.length === 0) {
    throw new ValidationError('assignment-ref-missing', `${where} revision does not exist`, {
      where,
      ref,
    })
  }
}

export async function upsertAssignment(
  db: ProviderNeutralDatabase,
  input: UpsertAssignmentInput,
): Promise<AssignmentRow> {
  if (input.scopeKind === 'global-default' && input.scopeRef !== null) {
    throw new ValidationError(
      'assignment-scope-invalid',
      'global-default must not carry a scopeRef',
    )
  }
  if (input.scopeKind !== 'global-default' && (input.scopeRef === null || input.scopeRef === '')) {
    throw new ValidationError('assignment-scope-invalid', `${input.scopeKind} needs a scopeRef`)
  }
  const session = databaseSessionFor(db)
  const now = input.now ?? Date.now()
  try {
    return await session.transaction(async (tx) => {
      if (input.employee !== null) await assertEmployeeRevision(tx, input.employee)
      if (input.selectionPolicy !== null) {
        await assertPolicyRevision(tx, input.selectionPolicy, 'selectionPolicy')
      }
      if (input.executionPolicy !== null) {
        await assertPolicyRevision(tx, input.executionPolicy, 'executionPolicy')
      }
      // defaults-only assignment 合法（§3.8）；但完全空行没有意义。
      if (
        input.employee === null &&
        input.selectionPolicy === null &&
        input.executionPolicy === null &&
        input.defaultRequirementSourceKey === null
      ) {
        throw new ValidationError('assignment-empty', 'assignment must set at least one field')
      }
      const existing = (
        await tx
          .select({ id: repositoryEmployeeAssignments.id })
          .from(repositoryEmployeeAssignments)
          .where(scopeWhere(input.scopeKind, input.scopeRef))
          .limit(1)
      )[0]
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
        updatedAt: now,
      }
      if (existing !== undefined) {
        const updated = (
          await tx
            .update(repositoryEmployeeAssignments)
            .set(values)
            .where(eq(repositoryEmployeeAssignments.id, existing.id))
            .returning()
        )[0]
        if (updated === undefined) throw new Error('assignment update disappeared')
        return assignmentOf(updated)
      }
      const inserted = (
        await tx
          .insert(repositoryEmployeeAssignments)
          .values({ id: ulid(), ...values, createdAt: now })
          .returning()
      )[0]
      if (inserted === undefined) throw new Error('assignment insert returned no row')
      return assignmentOf(inserted)
    })
  } catch (error) {
    if (session.engine.classifyError(error) === 'unique-violation') {
      throw new ConflictError(
        'assignment-scope-taken',
        'another assignment for this scope was written concurrently',
      )
    }
    throw error
  }
}

export async function findAssignment(
  db: ProviderNeutralDatabase,
  scopeKind: AssignmentScopeKind,
  scopeRef: string | null,
): Promise<AssignmentRow | null> {
  const row = (
    await db
      .select()
      .from(repositoryEmployeeAssignments)
      .where(scopeWhere(scopeKind, scopeRef))
      .limit(1)
  )[0]
  return row === undefined ? null : assignmentOf(row)
}

export async function deleteAssignment(
  db: ProviderNeutralDatabase,
  scopeKind: AssignmentScopeKind,
  scopeRef: string | null,
): Promise<void> {
  const existing = await findAssignment(db, scopeKind, scopeRef)
  if (existing === null) throw new NotFoundError('assignment-not-found', 'assignment not found')
  await db
    .delete(repositoryEmployeeAssignments)
    .where(eq(repositoryEmployeeAssignments.id, existing.id))
}

export async function listAssignments(db: ProviderNeutralDatabase): Promise<AssignmentRow[]> {
  const rows = await db
    .select()
    .from(repositoryEmployeeAssignments)
    .orderBy(asc(repositoryEmployeeAssignments.createdAt), asc(repositoryEmployeeAssignments.id))
  return rows.map(assignmentOf)
}

/** §3.8 唯一解析：exact repository > repository-group > global default。 */
export async function resolveAdmissionAssignment(
  db: ProviderNeutralDatabase,
  scope: { readonly repositoryId: string; readonly repositoryGroupId: string | null },
): Promise<AssignmentRow | null> {
  const repo = await findAssignment(db, 'repository', scope.repositoryId)
  if (repo !== null) return repo
  if (scope.repositoryGroupId !== null) {
    const group = await findAssignment(db, 'repository-group', scope.repositoryGroupId)
    if (group !== null) return group
  }
  return findAssignment(db, 'global-default', null)
}
