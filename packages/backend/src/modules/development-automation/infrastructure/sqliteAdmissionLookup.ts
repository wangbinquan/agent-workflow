// RFC-310 PR-2 —— AdmissionLookup 的生产绑定器（admission 命令读取配置资源的
// 唯一入口）。测试里同形绑定的提炼：assignment 三级解析 + published revision
// 内容读取（employee/policy），全部只读。

import type { DbClient } from '@/db/client'
import type { AdmissionLookup } from '../application/ports/admissionLookup'
import { resolveAdmissionAssignment } from './sqliteAssignmentStore'
import {
  getAutomationPolicyRevision,
  getDigitalEmployeeRevision,
} from './sqliteDigitalEmployeeStore'

export function createSqliteAdmissionLookup(db: DbClient): AdmissionLookup {
  return {
    async resolveAssignment(scope) {
      const row = await resolveAdmissionAssignment(db, {
        repositoryId: scope.repositoryId,
        repositoryGroupId: scope.repositoryGroupId,
      })
      if (row === null) return null
      return {
        scopeKind: row.scopeKind,
        employeeId: row.employeeId,
        employeeRevision: row.employeeRevision,
        selectionPolicyId: row.selectionPolicyId,
        selectionPolicyRevision: row.selectionPolicyRevision,
        executionPolicyId: row.executionPolicyId,
        executionPolicyRevision: row.executionPolicyRevision,
        defaultRequirementSourceKey: row.defaultRequirementSourceKey,
      }
    },
    async getEmployeeRevisionContent(id, revision) {
      const row = await getDigitalEmployeeRevision(db, id, revision)
      return row === null ? null : (JSON.parse(row.contentJson) as unknown)
    },
    async getPolicyRevisionContent(id, revision) {
      const row = await getAutomationPolicyRevision(db, id, revision)
      return row === null ? null : (JSON.parse(row.contentJson) as unknown)
    },
  }
}
