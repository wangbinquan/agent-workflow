// RFC-310 PR-2 —— AdmissionLookup 的生产绑定器（admission 命令读取配置资源的
// 唯一入口）：assignment 三级解析（repository → repository-group → global-default）+
// published revision 内容读取（employee/policy），全部只读。
// RFC-359 W4-B5：一份实现，两个 provider 共用（以 PG 版为底——自带查询，不再借道 SQLite 的
// assignment / employee store 同步助手）。

import { and, eq, isNull } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  automationPolicyRevisions,
  digitalEmployeeRevisions,
  repositoryEmployeeAssignments,
} from '@/db/schema'
import type { AdmissionAssignmentView, AdmissionLookup } from '../application/ports/admissionLookup'

/** 查询时再取列：表是按 provider 投影的代理，顶层捕获会钉死在加载时的 provider（见 dev-gotchas）。 */
function assignmentFields() {
  return {
    scopeKind: repositoryEmployeeAssignments.scopeKind,
    employeeId: repositoryEmployeeAssignments.employeeId,
    employeeRevision: repositoryEmployeeAssignments.employeeRevision,
    selectionPolicyId: repositoryEmployeeAssignments.selectionPolicyId,
    selectionPolicyRevision: repositoryEmployeeAssignments.selectionPolicyRevision,
    executionPolicyId: repositoryEmployeeAssignments.executionPolicyId,
    executionPolicyRevision: repositoryEmployeeAssignments.executionPolicyRevision,
    defaultRequirementSourceKey: repositoryEmployeeAssignments.defaultRequirementSourceKey,
  }
}

async function findAssignment(
  db: ProviderNeutralDatabase,
  scopeKind: AdmissionAssignmentView['scopeKind'],
  scopeRef: string | null,
): Promise<AdmissionAssignmentView | null> {
  const row = (
    await db
      .select(assignmentFields())
      .from(repositoryEmployeeAssignments)
      .where(
        and(
          eq(repositoryEmployeeAssignments.scopeKind, scopeKind),
          scopeRef === null
            ? isNull(repositoryEmployeeAssignments.scopeRef)
            : eq(repositoryEmployeeAssignments.scopeRef, scopeRef),
        ),
      )
      .limit(1)
  )[0]
  return row ?? null
}

function revisionContent(row: { readonly contentJson: string } | undefined): unknown | null {
  return row === undefined ? null : (JSON.parse(row.contentJson) as unknown)
}

export function createAdmissionLookup(db: ProviderNeutralDatabase): AdmissionLookup {
  return {
    async resolveAssignment(scope) {
      const repository = await findAssignment(db, 'repository', scope.repositoryId)
      if (repository !== null) return repository
      if (scope.repositoryGroupId !== null) {
        const group = await findAssignment(db, 'repository-group', scope.repositoryGroupId)
        if (group !== null) return group
      }
      return await findAssignment(db, 'global-default', null)
    },
    async getEmployeeRevisionContent(id, revision) {
      return revisionContent(
        (
          await db
            .select({ contentJson: digitalEmployeeRevisions.contentJson })
            .from(digitalEmployeeRevisions)
            .where(
              and(
                eq(digitalEmployeeRevisions.employeeId, id),
                eq(digitalEmployeeRevisions.revision, revision),
              ),
            )
            .limit(1)
        )[0],
      )
    },
    async getPolicyRevisionContent(id, revision) {
      return revisionContent(
        (
          await db
            .select({ contentJson: automationPolicyRevisions.contentJson })
            .from(automationPolicyRevisions)
            .where(
              and(
                eq(automationPolicyRevisions.policyId, id),
                eq(automationPolicyRevisions.revision, revision),
              ),
            )
            .limit(1)
        )[0],
      )
    },
  }
}
