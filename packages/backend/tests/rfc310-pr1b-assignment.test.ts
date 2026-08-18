// RFC-310 PR-1B（T17）—— repository employee assignment 测试。
//
// 锁的合同：①引用 (id, revision) 必须是已发布 revision，否则 typed 422；
// ②scope 形状校验（global-default 无 scopeRef、repo/group 必须有）；③空
// assignment 拒绝；④同 scope upsert 是更新不是第二行；⑤resolve 的三级优先
// 级 exact repository > repository-group > global-default；⑥delete 后回落。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { defaultAutomationPolicyContent } from '../src/modules/development-automation/domain/automationPolicy'
import type { DigitalEmployeeContent } from '../src/modules/development-automation/domain/digitalEmployee'
import {
  createAutomationPolicy,
  createDigitalEmployee,
  publishAutomationPolicy,
  publishDigitalEmployee,
} from '../src/modules/development-automation/infrastructure/sqliteDigitalEmployeeStore'
import {
  deleteAssignment,
  listAssignments,
  resolveAdmissionAssignment,
  upsertAssignment,
} from '../src/modules/development-automation/infrastructure/sqliteAssignmentStore'

const MIGRATIONS = resolve(import.meta.dirname, '..', 'db', 'migrations')

const EMPLOYEE_CONTENT: DigitalEmployeeContent = {
  schemaVersion: 1,
  description: 'polyglot',
  supportedRepositoryFacts: [],
  capabilityRoutes: [],
  requirementSources: [],
  pipelineProviders: [],
  defaultPolicyRef: { id: 'pol-1', revision: 1 },
}

async function seedPublished(db: DbClient): Promise<{ employeeId: string; policyId: string }> {
  const policy = await createAutomationPolicy(db, {
    name: 'p',
    ownerUserId: null,
    draft: defaultAutomationPolicyContent(),
  })
  await publishAutomationPolicy(db, { id: policy.id, publishedBy: null })
  const employee = await createDigitalEmployee(db, {
    name: 'e',
    ownerUserId: null,
    draft: { ...EMPLOYEE_CONTENT, defaultPolicyRef: { id: policy.id, revision: 1 } },
  })
  await publishDigitalEmployee(db, {
    id: employee.id,
    publishedBy: null,
    lookup: {
      getTemplate: () => null,
      getPolicy: (id, rev) => (id === policy.id && rev === 1 ? { exists: true } : null),
      getAdapter: () => null,
    },
  })
  return { employeeId: employee.id, policyId: policy.id }
}

describe('T17 assignment store', () => {
  test('reference validation: unpublished employee/policy revisions are rejected', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await expect(
      upsertAssignment(db, {
        scopeKind: 'repository',
        scopeRef: 'repo-1',
        employee: { id: 'ghost', revision: 1 },
        selectionPolicy: null,
        executionPolicy: null,
        defaultRequirementSourceKey: null,
        updatedBy: null,
      }),
    ).rejects.toMatchObject({ code: 'assignment-ref-missing', status: 422 })

    const { employeeId } = await seedPublished(db)
    await expect(
      upsertAssignment(db, {
        scopeKind: 'repository',
        scopeRef: 'repo-1',
        employee: { id: employeeId, revision: 99 },
        selectionPolicy: null,
        executionPolicy: null,
        defaultRequirementSourceKey: null,
        updatedBy: null,
      }),
    ).rejects.toMatchObject({ code: 'assignment-ref-missing' })
  })

  test('scope shape and empty assignment are rejected', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await expect(
      upsertAssignment(db, {
        scopeKind: 'global-default',
        scopeRef: 'oops',
        employee: null,
        selectionPolicy: null,
        executionPolicy: null,
        defaultRequirementSourceKey: 'k',
        updatedBy: null,
      }),
    ).rejects.toMatchObject({ code: 'assignment-scope-invalid' })
    await expect(
      upsertAssignment(db, {
        scopeKind: 'repository',
        scopeRef: null,
        employee: null,
        selectionPolicy: null,
        executionPolicy: null,
        defaultRequirementSourceKey: 'k',
        updatedBy: null,
      }),
    ).rejects.toMatchObject({ code: 'assignment-scope-invalid' })
    await expect(
      upsertAssignment(db, {
        scopeKind: 'global-default',
        scopeRef: null,
        employee: null,
        selectionPolicy: null,
        executionPolicy: null,
        defaultRequirementSourceKey: null,
        updatedBy: null,
      }),
    ).rejects.toMatchObject({ code: 'assignment-empty' })
  })

  test('same-scope upsert updates in place; resolve honours repo > group > global', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { employeeId, policyId } = await seedPublished(db)
    const ref = { id: employeeId, revision: 1 }

    await upsertAssignment(db, {
      scopeKind: 'global-default',
      scopeRef: null,
      employee: ref,
      selectionPolicy: null,
      executionPolicy: { id: policyId, revision: 1 },
      defaultRequirementSourceKey: 'global-source',
      updatedBy: 'admin',
    })
    await upsertAssignment(db, {
      scopeKind: 'repository-group',
      scopeRef: 'group-1',
      employee: ref,
      selectionPolicy: null,
      executionPolicy: null,
      defaultRequirementSourceKey: 'group-source',
      updatedBy: 'admin',
    })
    await upsertAssignment(db, {
      scopeKind: 'repository',
      scopeRef: 'repo-1',
      employee: ref,
      selectionPolicy: null,
      executionPolicy: null,
      defaultRequirementSourceKey: 'repo-source',
      updatedBy: 'admin',
    })

    const exact = await resolveAdmissionAssignment(db, {
      repositoryId: 'repo-1',
      repositoryGroupId: 'group-1',
    })
    expect(exact?.defaultRequirementSourceKey).toBe('repo-source')

    const group = await resolveAdmissionAssignment(db, {
      repositoryId: 'repo-other',
      repositoryGroupId: 'group-1',
    })
    expect(group?.defaultRequirementSourceKey).toBe('group-source')

    const global = await resolveAdmissionAssignment(db, {
      repositoryId: 'repo-other',
      repositoryGroupId: null,
    })
    expect(global?.defaultRequirementSourceKey).toBe('global-source')

    // 同 scope 再 upsert = 更新同一行
    await upsertAssignment(db, {
      scopeKind: 'repository',
      scopeRef: 'repo-1',
      employee: ref,
      selectionPolicy: null,
      executionPolicy: null,
      defaultRequirementSourceKey: 'repo-source-v2',
      updatedBy: 'admin',
    })
    expect((await listAssignments(db)).filter((a) => a.scopeKind === 'repository')).toHaveLength(1)

    await deleteAssignment(db, 'repository', 'repo-1')
    const afterDelete = await resolveAdmissionAssignment(db, {
      repositoryId: 'repo-1',
      repositoryGroupId: 'group-1',
    })
    expect(afterDelete?.defaultRequirementSourceKey).toBe('group-source')
    await expect(deleteAssignment(db, 'repository', 'repo-1')).rejects.toMatchObject({
      code: 'assignment-not-found',
    })
  })
})
