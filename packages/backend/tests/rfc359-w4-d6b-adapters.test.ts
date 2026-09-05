// RFC-359 W4-D6b —— development-automation 配置族合一：action template / verification profile 持久化、
// digital employee / automation policy 的 identity 与 immutable revision、assignment、员工 publish 闭包
// lookup、legacy 迁移落库——同一段断言在两个引擎上各跑一遍。末尾一条源码锁保证该族不再出现 provider
// 专属文件，中立实现也不引用任一 provider 客户端。

import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { actionTemplates, automationPolicies, capabilityTemplates } from '@/db/schema'
import { analyzeLegacyAssets } from '@/modules/development-automation/application/migrationAnalyzer'
import { resolveAdmissionAssignment } from '@/modules/development-automation/infrastructure/assignmentStore'
import {
  createActionTemplatePersistence,
  createVerificationProfilePersistence,
} from '@/modules/development-automation/infrastructure/configResourceStore'
import { createDevelopmentConfigPersistence } from '@/modules/development-automation/infrastructure/developmentConfigPersistence'
import {
  collectLegacyAssets,
  materializeMigrationCandidates,
  readPersistedMigrationRun,
} from '@/modules/development-automation/infrastructure/migrationAssets'
import { describeEachProvider } from './helpers/eachProvider'

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

describeEachProvider('RFC-359 W4-D6b —— development-automation 配置族', (harness) => {
  test('配置资源持久化：identity + immutable revisions、撞名经能力矩阵归类、archive 只封存 identity', async () => {
    const db = harness.db
    const templates = createActionTemplatePersistence(db)
    const template = await templates.create({
      id: ulid(),
      name: 'tpl-a',
      draftJson: '{}',
      ownerUserId: 'owner-1',
      now: 1000,
      extra: { capabilityId: 'change.implement' },
    })
    expect(template).toMatchObject({
      name: 'tpl-a',
      visibility: 'private',
      publishedRevision: null,
      archivedAt: null,
      extra: { capabilityId: 'change.implement' },
    })
    expect(
      await codeOf(() =>
        templates.create({
          id: ulid(),
          name: 'tpl-a',
          draftJson: '{}',
          ownerUserId: 'owner-1',
          now: 1001,
          extra: { capabilityId: 'change.implement' },
        }),
      ),
    ).toBe('action-template-name-conflict')
    // (owner, name) 唯一：另一个 owner 可以同名。
    const other = await templates.create({
      id: ulid(),
      name: 'tpl-a',
      draftJson: '{}',
      ownerUserId: 'owner-2',
      now: 1002,
      extra: { capabilityId: 'change.implement' },
    })
    const sibling = await templates.create({
      id: ulid(),
      name: 'tpl-b',
      draftJson: '{}',
      ownerUserId: 'owner-1',
      now: 1003,
      extra: { capabilityId: 'change.implement' },
    })

    await templates.updateDraft({
      id: template.id,
      draftJson: '{"v":1}',
      now: 1004,
      extra: { capabilityId: 'mr.feedback.apply' },
    })
    expect(await templates.getById(template.id)).toMatchObject({
      draftJson: '{"v":1}',
      updatedAt: 1004,
      extra: { capabilityId: 'mr.feedback.apply' },
    })
    expect(
      await codeOf(() =>
        templates.updateDraft({ id: sibling.id, draftJson: '{}', name: 'tpl-a', now: 1005 }),
      ),
    ).toBe('action-template-name-conflict')
    expect(
      await codeOf(() => templates.updateDraft({ id: 'missing', draftJson: '{}', now: 1 })),
    ).toBe('action-template-not-found')

    await templates.publishRevision({
      resourceId: template.id,
      revision: 1,
      contentJson: '{"r":1}',
      contentDigest: 'd1',
      publishedAt: 2000,
      publishedBy: 'owner-1',
    })
    await templates.publishRevision({
      resourceId: template.id,
      revision: 2,
      contentJson: '{"r":2}',
      contentDigest: 'd2',
      publishedAt: 2001,
      publishedBy: null,
    })
    expect(await templates.getById(template.id)).toMatchObject({
      publishedRevision: 2,
      updatedAt: 2001,
    })
    expect(await templates.getRevision(template.id, 1)).toEqual({
      resourceId: template.id,
      revision: 1,
      contentJson: '{"r":1}',
      contentDigest: 'd1',
      publishedAt: 2000,
      publishedBy: 'owner-1',
    })
    expect(await templates.getRevision(template.id, 3)).toBeNull()
    expect((await templates.listRevisions(template.id)).map((row) => row.revision)).toEqual([1, 2])
    expect(
      await codeOf(() =>
        templates.publishRevision({
          resourceId: 'missing',
          revision: 1,
          contentJson: '{}',
          contentDigest: 'x',
          publishedAt: 1,
          publishedBy: null,
        }),
      ),
    ).toBe('action-template-not-found')
    const listed = (await templates.list()).map((row) => row.id)
    expect(listed).toEqual(expect.arrayContaining([template.id, other.id, sibling.id]))

    await templates.archive(template.id, 3000)
    expect(await templates.getById(template.id)).toMatchObject({
      archivedAt: 3000,
      updatedAt: 3000,
    })
    expect(await templates.getRevision(template.id, 2)).not.toBeNull()
    expect(await codeOf(() => templates.archive('missing', 1))).toBe('action-template-not-found')

    const profiles = createVerificationProfilePersistence(db)
    const profile = await profiles.create({
      id: ulid(),
      name: 'vp-a',
      draftJson: '{}',
      ownerUserId: 'owner-1',
      now: 10,
      extra: {},
    })
    expect(profile.extra).toEqual({})
    expect(
      await codeOf(() =>
        profiles.create({
          id: ulid(),
          name: 'vp-a',
          draftJson: '{}',
          ownerUserId: 'owner-1',
          now: 11,
          extra: {},
        }),
      ),
    ).toBe('verification-profile-name-conflict')
    await profiles.publishRevision({
      resourceId: profile.id,
      revision: 1,
      contentJson: '{}',
      contentDigest: 'p1',
      publishedAt: 20,
      publishedBy: null,
    })
    expect((await profiles.listRevisions(profile.id)).map((row) => row.revision)).toEqual([1])
    expect((await profiles.getById(profile.id))?.publishedRevision).toBe(1)
    expect(await codeOf(() => profiles.archive('missing', 1))).toBe(
      'verification-profile-not-found',
    )
    expect(
      await codeOf(() => profiles.updateDraft({ id: 'missing', draftJson: '{}', now: 1 })),
    ).toBe('verification-profile-not-found')
  })

  test('identity 持久化：create / revise / publish CAS / archive，撞名归类，publish lookup 四类引用', async () => {
    const db = harness.db
    const config = createDevelopmentConfigPersistence(db)
    const employee = await config.employees.create({
      id: ulid(),
      name: 'emp-a',
      ownerUserId: 'owner-1',
      draftJson: '{"schemaVersion":1}',
      now: 100,
    })
    expect(employee).toMatchObject({
      visibility: 'private',
      publishedRevision: null,
      archivedAt: null,
      createdAt: 100,
    })
    expect(
      await codeOf(() =>
        config.employees.create({
          id: ulid(),
          name: 'emp-a',
          ownerUserId: 'owner-1',
          draftJson: '{}',
          now: 101,
        }),
      ),
    ).toBe('digital-employee-name-taken')
    await config.employees.revise({
      id: employee.id,
      draftJson: '{"schemaVersion":1,"v":2}',
      name: '  emp-b  ',
      now: 102,
    })
    expect(await config.employees.get(employee.id)).toMatchObject({
      name: 'emp-b',
      draftJson: '{"schemaVersion":1,"v":2}',
      updatedAt: 102,
    })
    expect((await config.employees.listActive()).map((row) => row.id)).toContain(employee.id)

    // CAS：expectedDraftJson 过期 → 409，不产生半个 revision。
    expect(
      await codeOf(() =>
        config.employees.publish({
          id: employee.id,
          expectedDraftJson: '{"schemaVersion":1}',
          contentJson: '{}',
          contentDigest: 'x',
          publishedBy: null,
          now: 103,
        }),
      ),
    ).toBe('digital-employee-draft-changed')
    expect(await config.publishLookup.getEmployee(employee.id, 1)).toBeNull()
    const published = await config.employees.publish({
      id: employee.id,
      expectedDraftJson: '{"schemaVersion":1,"v":2}',
      contentJson: '{"schemaVersion":1,"v":2}',
      contentDigest: 'e1',
      publishedBy: 'owner-1',
      now: 104,
    })
    expect(published).toEqual({ revision: 1, contentDigest: 'e1' })
    const again = await config.employees.publish({
      id: employee.id,
      expectedDraftJson: '{"schemaVersion":1,"v":2}',
      contentJson: '{"schemaVersion":1,"v":2}',
      contentDigest: 'e2',
      publishedBy: null,
      now: 105,
    })
    expect(again.revision).toBe(2)
    expect(await config.employees.get(employee.id)).toMatchObject({
      publishedRevision: 2,
      updatedAt: 105,
    })
    expect(
      await codeOf(() =>
        config.employees.publish({
          id: 'missing',
          expectedDraftJson: '{}',
          contentJson: '{}',
          contentDigest: 'x',
          publishedBy: null,
          now: 1,
        }),
      ),
    ).toBe('digital-employee-not-found')
    expect(
      await codeOf(() => config.employees.revise({ id: 'missing', draftJson: '{}', now: 1 })),
    ).toBe('digital-employee-not-found')
    await config.employees.archive(employee.id, 106)
    expect((await config.employees.listActive()).map((row) => row.id)).not.toContain(employee.id)
    expect(
      await codeOf(() => config.employees.revise({ id: employee.id, draftJson: '{}', now: 107 })),
    ).toBe('digital-employee-not-found')
    expect(await codeOf(() => config.employees.archive('missing', 1))).toBe(
      'digital-employee-not-found',
    )

    const policy = await config.policies.create({
      id: ulid(),
      name: 'pol-a',
      ownerUserId: 'owner-1',
      draftJson: '{}',
      now: 200,
    })
    expect(
      await config.policies.publish({
        id: policy.id,
        expectedDraftJson: '{}',
        contentJson: '{}',
        contentDigest: 'p1',
        publishedBy: null,
        now: 201,
      }),
    ).toEqual({ revision: 1, contentDigest: 'p1' })
    expect(
      await codeOf(() =>
        config.policies.create({
          id: ulid(),
          name: 'pol-a',
          ownerUserId: 'owner-1',
          draftJson: '{}',
          now: 202,
        }),
      ),
    ).toBe('automation-policy-name-taken')

    // publish lookup：模板 revision 读 capabilityId、policy / employee 只答存在性、adapter 无则 null。
    const templates = createActionTemplatePersistence(db)
    const template = await templates.create({
      id: ulid(),
      name: 'tpl-lookup',
      draftJson: '{}',
      ownerUserId: 'owner-1',
      now: 300,
      extra: { capabilityId: 'change.implement' },
    })
    await templates.publishRevision({
      resourceId: template.id,
      revision: 1,
      contentJson: JSON.stringify({ capabilityId: 'change.implement' }),
      contentDigest: 't1',
      publishedAt: 301,
      publishedBy: null,
    })
    expect(await config.publishLookup.getTemplate(template.id, 1)).toEqual({
      capabilityId: 'change.implement',
    })
    expect(await config.publishLookup.getTemplate(template.id, 2)).toBeNull()
    expect(await config.publishLookup.getPolicy(policy.id, 1)).toEqual({ exists: true })
    expect(await config.publishLookup.getPolicy(policy.id, 2)).toBeNull()
    expect(await config.publishLookup.getEmployee(employee.id, 2)).toEqual({ exists: true })
    expect(await config.publishLookup.getEmployee(employee.id, 3)).toBeNull()
    expect(await config.publishLookup.getAdapter('missing', 1)).toBeNull()
  })

  test('assignment：scope 校验、引用存在性、同 scope 覆盖、§3.8 解析与删除', async () => {
    const db = harness.db
    const config = createDevelopmentConfigPersistence(db)
    const employee = await config.employees.create({
      id: ulid(),
      name: 'emp-assign',
      ownerUserId: 'owner-1',
      draftJson: '{}',
      now: 1,
    })
    await config.employees.publish({
      id: employee.id,
      expectedDraftJson: '{}',
      contentJson: '{}',
      contentDigest: 'a',
      publishedBy: null,
      now: 2,
    })
    const policy = await config.policies.create({
      id: ulid(),
      name: 'pol-assign',
      ownerUserId: 'owner-1',
      draftJson: '{}',
      now: 3,
    })
    await config.policies.publish({
      id: policy.id,
      expectedDraftJson: '{}',
      contentJson: '{}',
      contentDigest: 'b',
      publishedBy: null,
      now: 4,
    })
    const base = {
      employee: { id: employee.id, revision: 1 },
      selectionPolicy: { id: policy.id, revision: 1 },
      executionPolicy: null,
      defaultRequirementSourceKey: null,
      updatedBy: 'admin',
      now: 10,
    }
    expect(
      await codeOf(() =>
        config.assignments.upsert({ ...base, scopeKind: 'global-default', scopeRef: 'x' }),
      ),
    ).toBe('assignment-scope-invalid')
    expect(
      await codeOf(() =>
        config.assignments.upsert({ ...base, scopeKind: 'repository', scopeRef: null }),
      ),
    ).toBe('assignment-scope-invalid')
    expect(
      await codeOf(() =>
        config.assignments.upsert({
          ...base,
          scopeKind: 'repository',
          scopeRef: 'repo-1',
          employee: { id: employee.id, revision: 9 },
        }),
      ),
    ).toBe('assignment-ref-missing')
    expect(
      await codeOf(() =>
        config.assignments.upsert({
          ...base,
          scopeKind: 'repository',
          scopeRef: 'repo-1',
          selectionPolicy: { id: policy.id, revision: 9 },
        }),
      ),
    ).toBe('assignment-ref-missing')
    expect(
      await codeOf(() =>
        config.assignments.upsert({
          ...base,
          scopeKind: 'repository',
          scopeRef: 'repo-1',
          employee: null,
          selectionPolicy: null,
        }),
      ),
    ).toBe('assignment-empty')
    expect(await config.assignments.list()).toEqual([])

    const repoScoped = await config.assignments.upsert({
      ...base,
      scopeKind: 'repository',
      scopeRef: 'repo-1',
    })
    expect(repoScoped).toMatchObject({
      scopeKind: 'repository',
      scopeRef: 'repo-1',
      employeeId: employee.id,
      employeeRevision: 1,
      selectionPolicyId: policy.id,
      selectionPolicyRevision: 1,
      executionPolicyId: null,
      defaultRequirementSourceKey: null,
    })
    // 同 scope 再 upsert 是覆盖同一行，不是第二份。
    const overwritten = await config.assignments.upsert({
      ...base,
      scopeKind: 'repository',
      scopeRef: 'repo-1',
      selectionPolicy: null,
      defaultRequirementSourceKey: 'jira',
      now: 11,
    })
    expect(overwritten.id).toBe(repoScoped.id)
    expect(overwritten).toMatchObject({
      selectionPolicyId: null,
      defaultRequirementSourceKey: 'jira',
    })
    const globalDefault = await config.assignments.upsert({
      ...base,
      scopeKind: 'global-default',
      scopeRef: null,
      employee: null,
      defaultRequirementSourceKey: 'gitlab',
    })
    expect((await config.assignments.list()).map((row) => row.id).sort()).toEqual(
      [repoScoped.id, globalDefault.id].sort(),
    )
    expect(
      (await resolveAdmissionAssignment(db, { repositoryId: 'repo-1', repositoryGroupId: null }))
        ?.id,
    ).toBe(repoScoped.id)
    expect(
      (await resolveAdmissionAssignment(db, { repositoryId: 'repo-x', repositoryGroupId: null }))
        ?.id,
    ).toBe(globalDefault.id)
    await config.assignments.delete('repository', 'repo-1')
    expect(
      (await resolveAdmissionAssignment(db, { repositoryId: 'repo-1', repositoryGroupId: null }))
        ?.id,
    ).toBe(globalDefault.id)
    expect(await codeOf(() => config.assignments.delete('repository', 'repo-1'))).toBe(
      'assignment-not-found',
    )
    await config.assignments.delete('global-default', null)
    expect(await config.assignments.list()).toEqual([])
  })

  test('legacy 迁移落库：读 legacy 表 → 分析 → materialize draft，幂等，报告落 maintenance_state', async () => {
    const db = harness.db
    const now0 = 1_700_000_000_000
    const suffix = ulid().toLowerCase()
    await db.insert(capabilityTemplates).values([
      {
        id: `t-fix-${suffix}`,
        name: `m-fix-${suffix}`,
        capability: 'mr-comment-fix',
        agentBySlotJson: JSON.stringify({ fixer: 'agent-a' }),
        promptBySlotJson: JSON.stringify({ fixer: 'be kind' }),
        ownerUserId: 'user-a',
        visibility: 'public',
        createdAt: now0,
        updatedAt: now0,
      },
      {
        id: `t-mon-${suffix}`,
        name: `m-mon-${suffix}`,
        capability: 'mr-monitor',
        ownerUserId: 'user-b',
        visibility: 'private',
        createdAt: now0,
        updatedAt: now0,
      },
    ])
    let tick = now0 + 100
    const now = () => tick++
    const report = analyzeLegacyAssets(await collectLegacyAssets(db), now())
    const first = await materializeMigrationCandidates(db, report, { now })
    expect(first.created.map((row) => `${row.resource}:${row.proposedName}`).sort()).toEqual([
      `action-template:m-fix-${suffix}`,
      `automation-policy:m-mon-${suffix}`,
    ])
    const templateRow = (
      await db
        .select()
        .from(actionTemplates)
        .where(eq(actionTemplates.name, `m-fix-${suffix}`))
    )[0]
    // draft only、owner 保留、legacy public 的 ACL 事实随迁移恢复。
    expect(templateRow).toMatchObject({
      publishedRevision: null,
      ownerUserId: 'user-a',
      visibility: 'public',
      capabilityId: 'mr.feedback.apply',
    })
    const policyRow = (
      await db
        .select()
        .from(automationPolicies)
        .where(eq(automationPolicies.name, `m-mon-${suffix}`))
    )[0]
    expect(policyRow).toMatchObject({
      publishedRevision: null,
      ownerUserId: 'user-b',
      visibility: 'private',
    })
    const persisted = await readPersistedMigrationRun(db)
    expect(persisted?.created).toHaveLength(2)
    expect(persisted?.report.summary.total).toBe(report.summary.total)

    // 幂等：重跑全部 skipped（name-exists），不重复建行。
    const second = await materializeMigrationCandidates(db, report, { now })
    expect(second.created).toEqual([])
    expect(
      second.skipped
        .filter((row) => row.reason === 'name-exists')
        .map((row) => row.proposedName)
        .sort(),
    ).toEqual([`m-fix-${suffix}`, `m-mon-${suffix}`])
    expect(
      await db
        .select()
        .from(actionTemplates)
        .where(eq(actionTemplates.name, `m-fix-${suffix}`)),
    ).toHaveLength(1)
  })
})

test('源码锁：配置族不再有 provider 专属文件，中立实现不引用任一 provider 客户端', () => {
  const infra = join(
    import.meta.dir,
    '..',
    'src',
    'modules',
    'development-automation',
    'infrastructure',
  )
  for (const legacy of [
    'sqliteConfigResourceStore.ts',
    'postgresqlConfigResourceStore.ts',
    'postgresqlMigrationAssets.ts',
    'sqliteAssignmentStore.ts',
    'publishLookup.ts',
    'sqliteDigitalEmployeeStore.ts',
  ]) {
    expect(existsSync(join(infra, legacy))).toBe(false)
  }
  for (const neutral of [
    'configResourceStore.ts',
    'assignmentStore.ts',
    'developmentConfigPersistence.ts',
    'migrationAssets.ts',
  ]) {
    // 只看代码行：文件头注释会解释「PG 渲染 FOR UPDATE」，那是能力矩阵的事，不是实现里写的方言。
    const source = readFileSync(join(infra, neutral), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    expect(source).not.toMatch(/PostgresqlDatabaseClient|\bDbClient\b|dbTxSync|for update/i)
    expect(source).toContain('ProviderNeutralDatabase')
  }
})
