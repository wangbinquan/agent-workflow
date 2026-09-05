// RFC-359 W4-D6c —— Digital Employee 作者面持久化合一（类型包 / 工具 / 岗位模版 / 员工定义 / 全局执行策略）
// 与 employee_* 的 foreign-owner ACL 收尾：identity 行由 digital-employee 在目录写事务里交出，读 / 写经目录的中立
// foreign 路径，PG 专属 foreign ACL 适配器与目录的同步 identity 形态退役。同一段断言在两个引擎上各跑一遍。

import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ulid } from 'ulid'

import { buildActor, type Actor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { users } from '@/db/schema'
import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'
import type {
  DigitalEmployeeAuthoringAdapter,
  TypePackageRecord,
} from '@/modules/digital-employee/application/ports/authoringStore'
import { createDigitalEmployeeAuthoringPersistence } from '@/modules/digital-employee/infrastructure/authoringStore'
import {
  employeeTypePackageDescriptorSchema,
  packageDigest,
  type EmployeeTypePackageDescriptor,
  type EmployeeTypeRef,
} from '@/modules/digital-employee/domain/model'
import { composeForeignResourceAclFor } from '@/modules/resource-catalog/composition/resourceAcl'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_700_000_000_000

const descriptor = employeeTypePackageDescriptorSchema.parse(
  JSON.parse(developmentEmployeeTypePackage.descriptorJson) as unknown,
)

function descriptorAt(revision: number): EmployeeTypePackageDescriptor {
  const copy = structuredClone(descriptor)
  copy.typeRef.revision = revision
  return copy
}

function packageRecord(
  pkg: EmployeeTypePackageDescriptor,
  digest = packageDigest(pkg),
): TypePackageRecord {
  return { descriptor: pkg, descriptorDigest: digest, state: 'published', registeredAt: NOW }
}

function toolRecord(
  id: string,
  typeRef: EmployeeTypeRef,
  displayName: string,
  ownerUserId: string | null = null,
) {
  const workItem = descriptor.authoringManifest.workItems[0]
  if (workItem === undefined) throw new Error('missing work item fixture')
  const roleGroup = workItem.toolRoleGroups[0]
  if (roleGroup === undefined) throw new Error('missing tool role fixture')
  const workContractRef = roleGroup.workContractRef ?? workItem.workContractRef
  return {
    id,
    typeRef,
    workItemRef: workItem.workItemRef,
    content: {
      schemaVersion: 1 as const,
      typeRef,
      workItemRef: workItem.workItemRef,
      workContractRef,
      roleRef: roleGroup.roleRef,
      displayName,
      description: '',
      implementation: { kind: 'agent' as const, agentRef: { id: `${id}-agent`, revision: 1 } },
      connectionRef: null,
    },
    validationReceipt: {
      schemaVersion: 1 as const,
      status: 'valid' as const,
      contractRef: workContractRef,
      implementationDigest: '0'.repeat(64),
      checks: [{ code: 'seeded', ok: true, detail: 'seeded' }],
      checkedAt: NOW,
      receiptDigest: '1'.repeat(64),
    },
    publishedRevision: null,
    ownerUserId,
    visibility: 'public' as const,
    createdAt: NOW,
    updatedAt: NOW,
    retiredAt: null,
  }
}

function jobDraft(typeRef: EmployeeTypeRef) {
  return {
    schemaVersion: 1 as const,
    typeRef,
    description: '',
    defaultToolBindings: [],
    defaultAdapterBindings: [],
    defaultCollaborationBindings: [],
    orderedDispatchConfigurations: [],
    reactionLaneOrder: [],
  }
}

function jobTemplateRecord(
  id: string,
  typeRef: EmployeeTypeRef,
  name: string,
  ownerUserId: string | null = null,
) {
  return {
    id,
    typeRef,
    name,
    draft: jobDraft(typeRef),
    publishedRevision: null,
    ownerUserId,
    visibility: 'public' as const,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  }
}

function employeeSave(input: {
  readonly id: string
  readonly revision: number
  readonly typeRef: EmployeeTypeRef
  readonly jobTemplateId: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly mutation?: {
    readonly expectedTypeRef: EmployeeTypeRef
    readonly targetTypeRef: EmployeeTypeRef
  }
}) {
  const configuration = {
    schemaVersion: 1 as const,
    typeRef: input.typeRef,
    jobTemplateRef: { id: input.jobTemplateId, revision: 1 },
    displayName: input.name,
    workScope: {},
    toolOverrides: [],
    adapterOverrides: [],
    collaborationOverrides: [],
  }
  return {
    revision: {
      ref: { id: input.id, revision: input.revision },
      content: {
        schemaVersion: 1 as const,
        typeRef: input.typeRef,
        jobTemplateRef: { id: input.jobTemplateId, revision: 1 },
        displayName: input.name,
        workScopeRef: { id: `${input.id}-scope`, revision: input.revision },
        workScopeSummary: 'scope',
        exactToolBindings: [],
        exactAdapterBindings: [],
        exactCollaborationBindings: [],
        exactOrderedDispatchConfigurations: [],
        exactReactionLaneOrder: [],
        enabledWorkItemRefs: [],
        compiledClosureDigest: '3'.repeat(64),
      },
      contentDigest: `${input.revision}`.padStart(64, '4'),
      createdAt: NOW + input.revision,
      createdBy: null,
    },
    workScope: {
      ref: { id: `${input.id}-scope`, revision: input.revision },
      typeRef: input.typeRef,
      encodedScope: {},
      displaySummary: 'scope',
      contentDigest: '5'.repeat(64),
      createdAt: NOW + input.revision,
      createdBy: null,
    },
    definitionMutation:
      input.mutation === undefined
        ? {
            kind: 'create' as const,
            record: {
              id: input.id,
              name: input.name,
              typeRef: input.typeRef,
              configuration,
              currentRevision: input.revision,
              ownerUserId: input.ownerUserId,
              visibility: 'public' as const,
              createdAt: NOW,
              updatedAt: NOW,
              archivedAt: null,
            },
          }
        : {
            kind: 'update' as const,
            expectedTypeRef: input.mutation.expectedTypeRef,
            targetTypeRef: input.mutation.targetTypeRef,
            name: input.name,
            configuration,
            updatedAt: NOW + input.revision,
          },
  }
}

function executionPolicy(sameSceneAttempts: number) {
  return {
    content: {
      schemaVersion: 1 as const,
      sameSceneAttempts,
      freshSceneAttempts: 1,
      initialBackoffMs: 1_000,
      maxBackoffMs: 2_000,
      roundBudgetMs: 60_000,
      caseBudgetMs: 120_000,
      externalWaitDeadlineMs: 60_000,
      handoffOnExhausted: true,
    },
    contentDigest: `policy-${sameSceneAttempts}`,
    publishedAt: NOW + sameSceneAttempts,
    publishedBy: null,
  }
}

function actorOf(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
    additionalPermissions: [] as never,
  })
}

async function seedUser(db: ProviderNeutralDatabase): Promise<string> {
  const id = `u_d6c_${ulid()}`
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role: 'user',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  })
  return id
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

const typeRef = descriptor.typeRef
const frozenRef = { typeId: typeRef.typeId, revision: typeRef.revision - 1 }

/** 每个用例各自从 harness 拿 db（SQLite 每用例一份内存库、PG 每文件一份库）；类型包注册幂等，重复 ensure 无害。 */
async function setup(db: ProviderNeutralDatabase): Promise<DigitalEmployeeAuthoringAdapter> {
  const store = createDigitalEmployeeAuthoringPersistence(db)
  await store.ensureTypePackage(packageRecord(descriptor))
  await store.ensureTypePackage(packageRecord(descriptorAt(frozenRef.revision)))
  return store
}

describeEachProvider(
  'RFC-359 W4-D6c —— Digital Employee 作者面持久化与 employee_* foreign ACL',
  (harness) => {
    test('类型包：注册幂等、同版本改描述符即 drift 409、按 typeId / revision 定序', async () => {
      const store = await setup(harness.db)
      await store.ensureTypePackage(packageRecord(descriptor))
      await store.ensureTypePackage(packageRecord(descriptor))
      await store.ensureTypePackage(packageRecord(descriptorAt(frozenRef.revision)))
      expect((await store.listTypePackages()).map((pkg) => pkg.descriptor.typeRef)).toEqual([
        typeRef,
        frozenRef,
      ])
      expect((await store.listTypePackageRegistrations()).map((row) => row.typeRef)).toEqual([
        typeRef,
        frozenRef,
      ])
      expect((await store.listTypePackageDescriptorJsons()).length).toBe(2)
      expect((await store.getTypePackage(typeRef))?.descriptorDigest).toBe(
        packageDigest(descriptor),
      )
      expect(await store.getTypePackage({ typeId: typeRef.typeId, revision: 999 })).toBeNull()
      expect(
        await codeOf(() => store.ensureTypePackage(packageRecord(descriptor, 'f'.repeat(64)))),
      ).toBe('employee-type-revision-drift')
    })

    test('工具：登记 / 校验回写 / 发布 / 退役，退役后不再列出、revision 状态翻为 retired', async () => {
      const store = await setup(harness.db)
      const workItemRef = descriptor.authoringManifest.workItems[0]!.workItemRef
      await store.createTool(toolRecord('tool-b', typeRef, 'Bravo'))
      await store.createTool(toolRecord('tool-a', typeRef, 'Alpha'))
      expect((await store.listTools(typeRef, workItemRef)).map((tool) => tool.id)).toEqual([
        'tool-a',
        'tool-b',
      ])
      expect(await store.getToolAcl('tool-a')).toMatchObject({ name: 'Alpha', retiredAt: null })
      expect(await store.getTool('missing')).toBeNull()

      const renamed = toolRecord('tool-a', typeRef, 'Alpha 2')
      await store.updateToolValidation(
        'tool-a',
        renamed.content,
        renamed.validationReceipt,
        NOW + 1,
      )
      expect((await store.getTool('tool-a'))?.content.displayName).toBe('Alpha 2')
      expect((await store.getToolAcl('tool-a'))?.name).toBe('Alpha 2')
      expect(
        await codeOf(() =>
          store.updateToolValidation('missing', renamed.content, renamed.validationReceipt, 1),
        ),
      ).toBe('employee-tool-not-found')

      await store.publishTool({
        ref: { id: 'tool-a', revision: 1 },
        content: renamed.content,
        contentDigest: '6'.repeat(64),
        validationReceipt: renamed.validationReceipt,
        state: 'published',
        publishedAt: NOW + 2,
        publishedBy: null,
      })
      expect((await store.getTool('tool-a'))?.publishedRevision).toBe(1)
      expect(await store.getToolRevision({ id: 'tool-a', revision: 1 })).toMatchObject({
        ref: { id: 'tool-a', revision: 1 },
        state: 'published',
        contentDigest: '6'.repeat(64),
      })
      expect(await store.getToolRevision({ id: 'tool-a', revision: 2 })).toBeNull()
      expect(
        await codeOf(() =>
          store.publishTool({
            ref: { id: 'missing', revision: 1 },
            content: renamed.content,
            contentDigest: 'x',
            validationReceipt: renamed.validationReceipt,
            state: 'published',
            publishedAt: 1,
            publishedBy: null,
          }),
        ),
      ).toBe('employee-tool-not-found')

      await store.retireTool('tool-a', NOW + 3)
      expect((await store.listTools(typeRef, workItemRef)).map((tool) => tool.id)).toEqual([
        'tool-b',
      ])
      expect((await store.getToolRevision({ id: 'tool-a', revision: 1 }))?.state).toBe('retired')
      expect(await codeOf(() => store.retireTool('tool-a', NOW + 4))).toBe(
        'employee-tool-not-found',
      )
    })

    test('岗位模版：同 owner + 类型版本 + 名字撞唯一索引归成 409，发布 / 更新对缺席行判 404', async () => {
      const store = await setup(harness.db)
      await store.createJobTemplate(jobTemplateRecord('job-b', typeRef, 'Reviewer', 'owner-1'))
      await store.createJobTemplate(jobTemplateRecord('job-a', typeRef, 'Author', 'owner-1'))
      // 另一个类型版本下同名不撞（唯一分区含 type_id + type_revision）。
      await store.createJobTemplate(
        jobTemplateRecord('job-frozen', frozenRef, 'Reviewer', 'owner-1'),
      )
      expect(
        await codeOf(() =>
          store.createJobTemplate(jobTemplateRecord('job-dup', typeRef, 'Reviewer', 'owner-1')),
        ),
      ).toBe('employee-job-template-name-conflict')
      expect((await store.listJobTemplates(typeRef)).map((job) => job.id)).toEqual([
        'job-a',
        'job-b',
      ])
      expect((await store.listJobTemplatesByTypeId(typeRef.typeId)).map((job) => job.id)).toEqual([
        'job-a',
        'job-b',
        'job-frozen',
      ])
      expect(await store.getJobTemplateAcl('job-a')).toMatchObject({
        name: 'Author',
        archivedAt: null,
      })

      await store.updateJobTemplate('job-a', 'Author 2', jobDraft(typeRef), NOW + 1)
      expect((await store.getJobTemplate('job-a'))?.name).toBe('Author 2')
      expect(
        await codeOf(() =>
          store.updateJobTemplate('job-a', 'Reviewer', jobDraft(typeRef), NOW + 2),
        ),
      ).toBe('employee-job-template-name-conflict')
      expect(
        await codeOf(() => store.updateJobTemplate('missing', 'x', jobDraft(typeRef), 1)),
      ).toBe('employee-job-template-not-found')

      await store.publishJobTemplate({
        ref: { id: 'job-a', revision: 1 },
        content: jobDraft(typeRef),
        contentDigest: '7'.repeat(64),
        publishedAt: NOW + 3,
        publishedBy: 'owner-1',
      })
      expect((await store.getJobTemplate('job-a'))?.publishedRevision).toBe(1)
      expect(await store.getJobTemplateRevision({ id: 'job-a', revision: 1 })).toMatchObject({
        contentDigest: '7'.repeat(64),
        publishedBy: 'owner-1',
      })
      expect(
        await codeOf(() =>
          store.publishJobTemplate({
            ref: { id: 'missing', revision: 1 },
            content: jobDraft(typeRef),
            contentDigest: 'x',
            publishedAt: 1,
            publishedBy: null,
          }),
        ),
      ).toBe('employee-job-template-not-found')
    })

    test('员工定义：create / update 与 revision、work scope 同一事务，类型期望不符即 404，撞名归 409', async () => {
      const store = await setup(harness.db)
      await store.saveEmployeeDefinition(
        employeeSave({
          id: 'emp-a',
          revision: 1,
          typeRef,
          jobTemplateId: 'job-a',
          name: 'Alpha',
          ownerUserId: 'owner-1',
        }),
      )
      expect(await store.getEmployeeDefinition('emp-a')).toMatchObject({
        name: 'Alpha',
        currentRevision: 1,
        typeRef,
      })
      expect(await store.getEmployeeDefinitionAcl('emp-a')).toMatchObject({
        name: 'Alpha',
        ownerUserId: 'owner-1',
        archivedAt: null,
      })
      expect(await store.getEmployeeDefinitionRevision({ id: 'emp-a', revision: 1 })).toMatchObject(
        {
          ref: { id: 'emp-a', revision: 1 },
        },
      )
      expect(await store.getWorkScopeRevision({ id: 'emp-a-scope', revision: 1 })).toMatchObject({
        displaySummary: 'scope',
        typeRef,
      })
      expect(
        await codeOf(() =>
          store.saveEmployeeDefinition(
            employeeSave({
              id: 'emp-dup',
              revision: 1,
              typeRef,
              jobTemplateId: 'job-a',
              name: 'Alpha',
              ownerUserId: 'owner-1',
            }),
          ),
        ),
      ).toBe('employee-definition-name-conflict')
      // 半途失败不留半个 revision：撞名那次的 revision 行不存在。
      expect(await store.getEmployeeDefinitionRevision({ id: 'emp-dup', revision: 1 })).toBeNull()

      expect(
        await codeOf(() =>
          store.saveEmployeeDefinition(
            employeeSave({
              id: 'emp-a',
              revision: 2,
              typeRef,
              jobTemplateId: 'job-a',
              name: 'Alpha',
              ownerUserId: 'owner-1',
              mutation: { expectedTypeRef: frozenRef, targetTypeRef: typeRef },
            }),
          ),
        ),
      ).toBe('employee-definition-not-found')
      expect(await store.getEmployeeDefinitionRevision({ id: 'emp-a', revision: 2 })).toBeNull()

      await store.saveEmployeeDefinition(
        employeeSave({
          id: 'emp-a',
          revision: 2,
          typeRef,
          jobTemplateId: 'job-a',
          name: 'Alpha prime',
          ownerUserId: 'owner-1',
          mutation: { expectedTypeRef: typeRef, targetTypeRef: typeRef },
        }),
      )
      expect(await store.getEmployeeDefinition('emp-a')).toMatchObject({
        name: 'Alpha prime',
        currentRevision: 2,
      })
      expect((await store.listEmployeeDefinitions(typeRef)).map((row) => row.id)).toEqual(['emp-a'])
      expect((await store.listEmployeeDefinitions()).map((row) => row.id)).toContain('emp-a')
    })

    test('全局执行策略：同 digest 幂等返回当前 revision，新 digest 递增并翻单例指针', async () => {
      const store = await setup(harness.db)
      expect(await store.getCurrentExecutionPolicy()).toBeNull()
      const first = await store.ensureExecutionPolicy(executionPolicy(1))
      expect(first.revision).toBe(1)
      const again = await store.ensureExecutionPolicy(executionPolicy(1))
      expect(again.revision).toBe(1)
      const second = await store.ensureExecutionPolicy(executionPolicy(2))
      expect(second.revision).toBe(2)
      expect((await store.getCurrentExecutionPolicy())?.revision).toBe(2)
      expect((await store.getExecutionPolicyRevision(1))?.content.sameSceneAttempts).toBe(1)
      expect(await store.getExecutionPolicyRevision(9)).toBeNull()
    })

    test('foreign ACL：employee_* 经目录中立路径——读面、grants 替换、换 owner 撞名 409、岗位模版按类型版本分区', async () => {
      const db = harness.db
      const store = await setup(db)
      const ownerA = await seedUser(db)
      const ownerB = await seedUser(db)
      const reader = await seedUser(db)
      const definitions = composeForeignResourceAclFor({
        db,
        identity: store.resourceAclIdentities.employeeDefinition,
      })
      await store.saveEmployeeDefinition(
        employeeSave({
          id: 'acl-emp-a',
          revision: 1,
          typeRef,
          jobTemplateId: 'job-a',
          name: 'Shared employee',
          ownerUserId: ownerA,
        }),
      )
      await store.saveEmployeeDefinition(
        employeeSave({
          id: 'acl-emp-b',
          revision: 1,
          typeRef,
          jobTemplateId: 'job-a',
          name: 'Shared employee',
          ownerUserId: ownerB,
        }),
      )
      const row = {
        id: 'acl-emp-a',
        name: 'Shared employee',
        ownerUserId: ownerA,
        visibility: 'public' as const,
      }
      const initial = await definitions.getResourceAcl(actorOf(ownerA), 'employee_definition', row)
      expect(initial).toMatchObject({
        ownerUserId: ownerA,
        aclRevision: 0,
        canManage: true,
        grants: [],
      })
      expect(await store.resourceAclIdentities.employeeDefinition.getRevision('acl-emp-a')).toBe(0)

      const granted = await definitions.updateResourceAcl(
        actorOf(ownerA),
        'employee_definition',
        row,
        {
          expectedResourceId: 'acl-emp-a',
          expectedAclRevision: 0,
          visibility: 'private',
          grants: [{ userId: reader, level: 'read' }],
        },
      )
      expect(granted).toMatchObject({ visibility: 'private', aclRevision: 1 })
      expect(granted.grants.map((grant) => [grant.user.id, grant.level])).toEqual([
        [reader, 'read'],
      ])
      expect(await store.resourceAclIdentities.employeeDefinition.getRevision('acl-emp-a')).toBe(1)
      // CAS：旧 aclRevision 再写 → 409。
      expect(
        await codeOf(() =>
          definitions.updateResourceAcl(actorOf(ownerA), 'employee_definition', row, {
            expectedResourceId: 'acl-emp-a',
            expectedAclRevision: 0,
            visibility: 'public',
          }),
        ),
      ).toBe('acl-revision-conflict')
      // 换 owner 撞名：ownerB 已有同名员工定义 → 409，行不动。
      expect(
        await codeOf(() =>
          definitions.updateResourceAcl(actorOf(ownerA), 'employee_definition', row, {
            expectedResourceId: 'acl-emp-a',
            expectedAclRevision: 1,
            ownerUserId: ownerB,
          }),
        ),
      ).toBe('resource-name-conflict')
      expect((await store.getEmployeeDefinitionAcl('acl-emp-a'))?.ownerUserId).toBe(ownerA)

      // 岗位模版：目标 owner 只在另一个类型版本下有同名 → 转移成功；同分区撞名 → 409。
      const templates = composeForeignResourceAclFor({
        db,
        identity: store.resourceAclIdentities.employeeJobTemplate,
      })
      await store.createJobTemplate(jobTemplateRecord('acl-job-src', typeRef, 'Planner', ownerA))
      await store.createJobTemplate(
        jobTemplateRecord('acl-job-other', frozenRef, 'Planner', ownerB),
      )
      const templateRow = {
        id: 'acl-job-src',
        name: 'Planner',
        ownerUserId: ownerA,
        visibility: 'public' as const,
      }
      const moved = await templates.updateResourceAcl(
        actorOf(ownerA),
        'employee_job_template',
        templateRow,
        {
          expectedResourceId: 'acl-job-src',
          expectedAclRevision: 0,
          ownerUserId: ownerB,
        },
      )
      expect(moved.ownerUserId).toBe(ownerB)
      // 旧 owner 降为 read。
      expect(moved.grants.map((grant) => [grant.user.id, grant.level])).toEqual([[ownerA, 'read']])
      await store.createJobTemplate(jobTemplateRecord('acl-job-src-2', typeRef, 'Planner', ownerA))
      const secondTemplateRow = {
        id: 'acl-job-src-2',
        ownerUserId: ownerA,
        visibility: 'public' as const,
      }
      expect(
        await codeOf(() =>
          templates.updateResourceAcl(actorOf(ownerA), 'employee_job_template', secondTemplateRow, {
            expectedResourceId: 'acl-job-src-2',
            expectedAclRevision: 0,
            ownerUserId: ownerB,
          }),
        ),
      ).toBe('resource-name-conflict')

      // 工具没有 owner+name 唯一索引：换 owner 不做撞名判定。
      const tools = composeForeignResourceAclFor({
        db,
        identity: store.resourceAclIdentities.employeeTool,
      })
      await store.createTool(toolRecord('acl-tool-a', typeRef, 'Same tool', ownerA))
      await store.createTool(toolRecord('acl-tool-b', typeRef, 'Same tool', ownerB))
      const toolRow = { id: 'acl-tool-a', ownerUserId: ownerA, visibility: 'public' as const }
      const toolMoved = await tools.updateResourceAcl(actorOf(ownerA), 'employee_tool', toolRow, {
        expectedResourceId: 'acl-tool-a',
        expectedAclRevision: 0,
        ownerUserId: ownerB,
      })
      expect(toolMoved.ownerUserId).toBe(ownerB)
      // 看不见即不存在：private 资源对无 grant 的人是 not-found。
      const stranger = await seedUser(db)
      expect(
        await codeOf(() =>
          definitions.getResourceAcl(actorOf(stranger), 'employee_definition', {
            ...row,
            visibility: 'private',
          }),
        ),
      ).toBe('not-found')
    })
  },
)

test('源码锁：作者面持久化与 foreign ACL 不再有 provider 专属文件，目录也不再有同步 identity 形态', () => {
  const backend = join(import.meta.dir, '..', 'src')
  for (const legacy of [
    'modules/digital-employee/infrastructure/sqliteAuthoringStore.ts',
    'modules/digital-employee/infrastructure/postgresqlAuthoringStore.ts',
    'platform/persistence/postgresqlForeignResourceAcl.ts',
  ]) {
    expect(existsSync(join(backend, legacy))).toBe(false)
  }
  const code = (relative: string): string =>
    readFileSync(join(backend, relative), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
  const authoring = code('modules/digital-employee/infrastructure/authoringStore.ts')
  expect(authoring).not.toMatch(/PostgresqlDatabaseClient|\bDbClient\b|dbTxSync|for update/i)
  expect(authoring).toContain('lockAggregateRoot(')
  for (const relative of [
    'modules/resource-catalog/application/ports/resourceAclPersistence.ts',
    'modules/resource-catalog/composition/resourceAcl.ts',
    'modules/resource-catalog/infrastructure/sqliteResourceAclRepository.ts',
    'modules/digital-employee/application/ports/authoringStore.ts',
    'services/resourceAcl.ts',
    'server.ts',
    'cli/postgresqlDaemonApplication.ts',
  ]) {
    expect(code(relative)).not.toMatch(/SyncResourceAclIdentity|withMutation\(|identityPersistence/)
  }
})
