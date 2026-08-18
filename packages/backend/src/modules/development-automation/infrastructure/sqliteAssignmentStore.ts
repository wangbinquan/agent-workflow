// RFC-310 T17 —— repository / repo-group / global-default 员工 assignment store。
//
// §3.8：scope 优先级 exact repository > repository-group > global default，
// **每一级最多一份**——由 (scope_kind, COALESCE(scope_ref,'')) 唯一索引直接
// 保证，同级第二份是配置错误（typed 409），不是「随便取第一个」。assignment
// 的每个引用都是 (id, revision) 精确版本，upsert 时校验 revision 行存在——
// 挂一个从未发布过的 revision 属配置错误，当场拒绝。

import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import {
  automationPolicyRevisions,
  digitalEmployeeRevisions,
  repositoryEmployeeAssignments,
} from '@/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'

export interface AssignmentRow {
  id: string
  scopeKind: 'repository' | 'repository-group' | 'global-default'
  scopeRef: string | null
  employeeId: string | null
  employeeRevision: number | null
  selectionPolicyId: string | null
  selectionPolicyRevision: number | null
  executionPolicyId: string | null
  executionPolicyRevision: number | null
  defaultRequirementSourceKey: string | null
}

export interface UpsertAssignmentInput {
  scopeKind: 'repository' | 'repository-group' | 'global-default'
  scopeRef: string | null
  employee: { id: string; revision: number } | null
  selectionPolicy: { id: string; revision: number } | null
  executionPolicy: { id: string; revision: number } | null
  defaultRequirementSourceKey: string | null
  updatedBy: string | null
}

async function assertPolicyRevision(
  db: DbClient,
  ref: { id: string; revision: number },
  where: string,
): Promise<void> {
  const rows = await db
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
  db: DbClient,
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
  if (input.employee !== null) {
    const rows = await db
      .select({ revision: digitalEmployeeRevisions.revision })
      .from(digitalEmployeeRevisions)
      .where(
        and(
          eq(digitalEmployeeRevisions.employeeId, input.employee.id),
          eq(digitalEmployeeRevisions.revision, input.employee.revision),
        ),
      )
      .limit(1)
    if (rows.length === 0) {
      throw new ValidationError('assignment-ref-missing', 'employee revision does not exist', {
        where: 'employee',
        ref: input.employee,
      })
    }
  }
  if (input.selectionPolicy !== null) {
    await assertPolicyRevision(db, input.selectionPolicy, 'selectionPolicy')
  }
  if (input.executionPolicy !== null) {
    await assertPolicyRevision(db, input.executionPolicy, 'executionPolicy')
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

  const now = Date.now()
  const existing = await findAssignment(db, input.scopeKind, input.scopeRef)
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
  if (existing !== null) {
    await db
      .update(repositoryEmployeeAssignments)
      .set(values)
      .where(eq(repositoryEmployeeAssignments.id, existing.id))
    return { ...existing, ...values }
  }
  const row = { id: ulid(), ...values, createdAt: now }
  try {
    await db.insert(repositoryEmployeeAssignments).values(row)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('scope_unique') || message.includes('UNIQUE')) {
      throw new ConflictError(
        'assignment-scope-taken',
        'another assignment for this scope was written concurrently',
      )
    }
    throw error
  }
  return row
}

export async function findAssignment(
  db: DbClient,
  scopeKind: AssignmentRow['scopeKind'],
  scopeRef: string | null,
): Promise<AssignmentRow | null> {
  const rows = await db
    .select()
    .from(repositoryEmployeeAssignments)
    .where(eq(repositoryEmployeeAssignments.scopeKind, scopeKind))
  const match = rows.find((r) => (r.scopeRef ?? null) === (scopeRef ?? null))
  return (match as AssignmentRow | undefined) ?? null
}

export async function deleteAssignment(
  db: DbClient,
  scopeKind: AssignmentRow['scopeKind'],
  scopeRef: string | null,
): Promise<void> {
  const existing = await findAssignment(db, scopeKind, scopeRef)
  if (existing === null) throw new NotFoundError('assignment-not-found', 'assignment not found')
  await db
    .delete(repositoryEmployeeAssignments)
    .where(eq(repositoryEmployeeAssignments.id, existing.id))
}

export async function listAssignments(db: DbClient): Promise<AssignmentRow[]> {
  return (await db.select().from(repositoryEmployeeAssignments)) as AssignmentRow[]
}

/** §3.8 唯一解析：exact repository > repository-group > global default。 */
export async function resolveAdmissionAssignment(
  db: DbClient,
  scope: { repositoryId: string; repositoryGroupId: string | null },
): Promise<AssignmentRow | null> {
  const repo = await findAssignment(db, 'repository', scope.repositoryId)
  if (repo !== null) return repo
  if (scope.repositoryGroupId !== null) {
    const group = await findAssignment(db, 'repository-group', scope.repositoryGroupId)
    if (group !== null) return group
  }
  return findAssignment(db, 'global-default', null)
}
