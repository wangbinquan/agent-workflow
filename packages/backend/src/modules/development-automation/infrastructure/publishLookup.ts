// RFC-310 PR-1B —— 员工 publish 闭包检查的同步 lookup 绑定器。
//
// `EmployeePublishLookup` 是同步接口（domain validator 逐 ref 按需查），这里
// 用 bun-sqlite 的同步 `.get()` 直接绑三类 revision 表。employee publish 是
// 低频管理操作，同步点查不构成热路径。

import { eq, and } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  actionTemplateRevisions,
  automationPolicyRevisions,
  developmentAdapterDefinitionRevisions,
} from '@/db/schema'
import type { EmployeePublishLookup } from '../domain/digitalEmployee'

export function createEmployeePublishLookup(db: DbClient): EmployeePublishLookup {
  return {
    getTemplate(templateId, revision) {
      const row = db
        .select()
        .from(actionTemplateRevisions)
        .where(
          and(
            eq(actionTemplateRevisions.templateId, templateId),
            eq(actionTemplateRevisions.revision, revision),
          ),
        )
        .get()
      if (row === undefined) return null
      const content = JSON.parse(row.contentJson) as { capabilityId?: unknown }
      return typeof content.capabilityId === 'string'
        ? { capabilityId: content.capabilityId }
        : null
    },
    getPolicy(policyId, revision) {
      const row = db
        .select()
        .from(automationPolicyRevisions)
        .where(
          and(
            eq(automationPolicyRevisions.policyId, policyId),
            eq(automationPolicyRevisions.revision, revision),
          ),
        )
        .get()
      return row === undefined ? null : { exists: true }
    },
    getAdapter(adapterId, revision) {
      const row = db
        .select()
        .from(developmentAdapterDefinitionRevisions)
        .where(
          and(
            eq(developmentAdapterDefinitionRevisions.adapterId, adapterId),
            eq(developmentAdapterDefinitionRevisions.revision, revision),
          ),
        )
        .get()
      if (row === undefined) return null
      const content = JSON.parse(row.contentJson) as { purpose?: unknown }
      return typeof content.purpose === 'string' ? { purpose: content.purpose } : null
    },
  }
}
