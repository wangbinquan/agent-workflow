/**
 * RFC-310 PR-28 regression: a Type Package bump must upgrade every provably
 * compatible published employee closure without creating a user migration job.
 * The old implementation only registered the new type and left a disabled
 * "Upgrade to current version" button, so these tests intentionally start from
 * a real v1 tool -> job -> employee closure and then restart on v2.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import {
  employeeDefinitionRevisions,
  employeeDefinitions,
  employeeJobTemplates,
  employeeToolRegistrations,
} from '@/db/schema'
import { composeDigitalEmployee } from '@/modules/digital-employee/composition'
import { contentDigest } from '@/modules/digital-employee/domain/model'
import type {
  DigitalEmployeePlatformToolCatalogParticipant,
  EmployeeTypePackageRegistration,
} from '@/modules/digital-employee/public/types'
import type { ExecutionContractParticipant } from '@/modules/execution-contract/public/types'
import { designEmployeeTypePackage } from './fixtures/digitalEmployeeTypePackages'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const executionContracts: ExecutionContractParticipant = {
  list: () => [],
  get: () => {
    throw new Error('auto-upgrade fixture does not execute work')
  },
  async validateExecutor({ contractRef }) {
    return {
      schemaVersion: 1,
      contractRef,
      status: 'valid',
      checks: [{ code: 'fixture-contract', ok: true, detail: 'exact fixture contract' }],
    }
  },
  async validateAgentCandidates() {
    return []
  },
  validateEnvelope() {
    throw new Error('auto-upgrade fixture does not settle work')
  },
}

function versionedDesignPackage(
  revision: number,
  mutate?: (descriptor: Record<string, unknown>) => void,
): EmployeeTypePackageRegistration {
  const descriptor = JSON.parse(designEmployeeTypePackage.descriptorJson) as Record<string, unknown>
  descriptor.typeRef = { typeId: 'design', revision }
  mutate?.(descriptor)
  return {
    descriptorJson: JSON.stringify(descriptor),
    parseWorkScopeJson: (inputJson) => designEmployeeTypePackage.parseWorkScopeJson(inputJson),
    summarizeWorkScopeJson: (scopeJson, locale) =>
      designEmployeeTypePackage.summarizeWorkScopeJson(scopeJson, locale),
    validateContractFixtureJson: (requestJson) =>
      designEmployeeTypePackage.validateContractFixtureJson(requestJson),
  }
}

function createFixtureModule(input: {
  db: ReturnType<typeof createInMemoryDb>
  appHome: string
  typePackage: EmployeeTypePackageRegistration
  platformTools?: DigitalEmployeePlatformToolCatalogParticipant
  issues?: Array<{ reasonCode: string; resourceId: string }>
  idPrefix?: string
}) {
  let ordinal = 0
  return composeDigitalEmployee({
    db: input.db,
    appHome: input.appHome,
    typePackages: [input.typePackage],
    executionContracts,
    ...(input.platformTools === undefined ? {} : { platformTools: input.platformTools }),
    id: () => `${input.idPrefix ?? 'auto-upgrade-resource'}-${++ordinal}`,
    now: () => 10_000 + ordinal,
    onAutomaticUpgradeIssue: (issue) => input.issues?.push(issue),
  })
}

function platformToolCatalog(): DigitalEmployeePlatformToolCatalogParticipant {
  const record = (typeRevision: number) => {
    const content = {
      schemaVersion: 1 as const,
      typeRef: { typeId: 'design', revision: typeRevision },
      workItemRef: 'design-work',
      workContractRef: { contractId: 'design.perform-work', version: 1 },
      roleRef: 'primary',
      displayName: '平台设计 Agent',
      description: '由 provider 按稳定 Agent identity 解析 successor',
      implementation: {
        kind: 'agent' as const,
        agentRef: { id: 'platform-design-agent', revision: 99 },
      },
      connectionRef: null,
    }
    const receiptCore = {
      schemaVersion: 1 as const,
      status: 'valid' as const,
      contractRef: content.workContractRef,
      implementationDigest: contentDigest(content.implementation),
      checks: [{ code: 'platform-contract', ok: true, detail: 'provider validated successor' }],
      checkedAt: 99,
    }
    const id = `platform-fixture:design:${typeRevision}:design-work:platform-design-agent`
    const publishedRevision = 100 + typeRevision
    return {
      draft: {
        id,
        typeRef: content.typeRef,
        workItemRef: content.workItemRef,
        content,
        validationReceipt: { ...receiptCore, receiptDigest: contentDigest(receiptCore) },
        publishedRevision,
        ownerUserId: null,
        createdAt: 99,
        updatedAt: 99,
        retiredAt: null,
        origin: 'platform' as const,
        selection: 'selectable' as const,
      },
      revision: {
        ref: { id, revision: publishedRevision },
        content,
        contentDigest: contentDigest(content),
        validationReceipt: { ...receiptCore, receiptDigest: contentDigest(receiptCore) },
        state: 'published' as const,
        publishedAt: 99,
        publishedBy: null,
      },
    }
  }
  const records = [record(1), record(2), record(3)]
  return {
    listJson(typeRefJson, workItemRef) {
      const typeRef = JSON.parse(typeRefJson) as { typeId: string; revision: number }
      return JSON.stringify(
        records
          .map((candidate) => candidate.draft)
          .filter(
            (candidate) =>
              candidate.typeRef.typeId === typeRef.typeId &&
              candidate.typeRef.revision === typeRef.revision &&
              candidate.workItemRef === workItemRef,
          ),
      )
    },
    getRevisionJson(refJson) {
      const ref = JSON.parse(refJson) as { id: string; revision: number }
      const found = records.find(
        (candidate) =>
          candidate.revision.ref.id === ref.id && candidate.revision.ref.revision === ref.revision,
      )
      return found === undefined ? null : JSON.stringify(found.revision)
    },
    resolveCompatibleRevisionJson(sourceRefJson, targetTypeRefJson, workItemRef) {
      const sourceRef = JSON.parse(sourceRefJson) as { id: string; revision: number }
      const targetTypeRef = JSON.parse(targetTypeRefJson) as {
        typeId: string
        revision: number
      }
      const source = records.find(
        (candidate) =>
          candidate.revision.ref.id === sourceRef.id &&
          candidate.revision.ref.revision === sourceRef.revision,
      )
      if (
        source === undefined ||
        source.revision.content.implementation.agentRef.id !== 'platform-design-agent' ||
        targetTypeRef.typeId !== 'design' ||
        workItemRef !== 'design-work'
      ) {
        return null
      }
      const target = records.find(
        (candidate) => candidate.revision.content.typeRef.revision === targetTypeRef.revision,
      )
      return target === undefined ? null : JSON.stringify(target.revision)
    },
    isPlatformTool: (toolId) => toolId.startsWith('platform-fixture:'),
  }
}

async function seedPublishedEmployee(input: {
  db: ReturnType<typeof createInMemoryDb>
  appHome: string
}) {
  const module = createFixtureModule({
    ...input,
    typePackage: versionedDesignPackage(1),
  })
  const typeRef = { typeId: 'design', revision: 1 }
  const tool = await module.commands.createTool({
    typeRef,
    workItemRef: 'design-work',
    actorUserId: 'owner-1',
    body: {
      displayName: '设计执行工具',
      description: '精确绑定设计合同',
      roleRef: 'primary',
      implementation: { kind: 'agent', agentRef: { id: 'design-agent', revision: 7 } },
    },
  })
  const toolRef = await module.commands.publishTool({
    typeRef,
    workItemRef: 'design-work',
    toolId: tool.id,
    actorUserId: 'owner-1',
  })
  const job = module.commands.createJobTemplate({
    typeRef,
    actorUserId: 'owner-1',
    body: {
      name: '产品设计岗位',
      description: '稳定的单职责岗位',
      defaultToolBindings: [
        { workItemRef: 'design-work', slotRef: 'primary', registrationRef: toolRef },
      ],
    },
  })
  const jobRef = module.commands.publishJobTemplate({ id: job.id, actorUserId: 'owner-1' })
  return module.commands.createEmployee({
    typeRef,
    actorUserId: 'owner-1',
    body: {
      name: '产品设计数字员工',
      jobTemplateRef: jobRef,
      workScope: { kind: 'global' },
    },
  })
}

describe('RFC-310 Type Package automatic compatible upgrades', () => {
  test('restarts upgrade custom tool -> job -> stable employee exactly once', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc310-auto-upgrade-'))
    try {
      const db = createInMemoryDb(MIGRATIONS)
      const original = await seedPublishedEmployee({ db, appHome })
      const issues: Array<{ reasonCode: string; resourceId: string }> = []
      const targetPackage = versionedDesignPackage(2, (descriptor) => {
        descriptor.description = {
          'zh-CN': '只增加展示说明的设计数字员工',
          'en-US': 'Design employee with a presentation-only update',
        }
      })

      const upgradedModule = createFixtureModule({
        db,
        appHome,
        typePackage: targetPackage,
        issues,
      })
      const upgraded = upgradedModule.queries.listLaunchableEmployees()

      expect(issues).toEqual([])
      expect(upgraded).toHaveLength(1)
      expect(upgraded[0]).toMatchObject({
        id: original.id,
        revision: 2,
        typeRef: { typeId: 'design', revision: 2 },
        ownerUserId: 'owner-1',
        visibility: 'private',
        workScope: { kind: 'global' },
      })
      expect(
        db
          .select()
          .from(employeeDefinitions)
          .all()
          .find((row) => row.id === original.id),
      ).toMatchObject({
        ownerUserId: 'owner-1',
        visibility: 'private',
        aclRevision: 0,
      })
      expect(
        upgradedModule.queries.listJobTemplates({ typeId: 'design', revision: 2 }),
      ).toHaveLength(1)
      expect(
        upgradedModule.queries.listTools({ typeId: 'design', revision: 2 }, 'design-work'),
      ).toHaveLength(1)

      const countsAfterUpgrade = {
        tools: db.select().from(employeeToolRegistrations).all().length,
        jobs: db.select().from(employeeJobTemplates).all().length,
        employees: db.select().from(employeeDefinitions).all().length,
        revisions: db.select().from(employeeDefinitionRevisions).all().length,
      }
      const replayedModule = createFixtureModule({
        db,
        appHome,
        typePackage: targetPackage,
        issues,
      })
      expect(replayedModule.queries.listLaunchableEmployees()[0]?.revision).toBe(2)
      expect({
        tools: db.select().from(employeeToolRegistrations).all().length,
        jobs: db.select().from(employeeJobTemplates).all().length,
        employees: db.select().from(employeeDefinitions).all().length,
        revisions: db.select().from(employeeDefinitionRevisions).all().length,
      }).toEqual(countsAfterUpgrade)

      const frozenRevisions = db
        .select()
        .from(employeeDefinitionRevisions)
        .all()
        .filter((row) => row.employeeId === original.id)
        .map((row) => ({
          revision: row.revision,
          typeRevision: JSON.parse(row.contentJson).typeRef.revision,
        }))
      expect(frozenRevisions).toEqual([
        { revision: 1, typeRevision: 1 },
        { revision: 2, typeRevision: 2 },
      ])
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })

  test('published standalone jobs migrate automatically while user drafts remain drafts', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc310-auto-upgrade-standalone-job-'))
    try {
      const db = createInMemoryDb(MIGRATIONS)
      const v1 = createFixtureModule({
        db,
        appHome,
        typePackage: versionedDesignPackage(1),
      })
      const typeRef = { typeId: 'design', revision: 1 }
      const tool = await v1.commands.createTool({
        typeRef,
        workItemRef: 'design-work',
        actorUserId: 'standalone-owner',
        body: {
          displayName: '独立岗位工具',
          description: '尚未被数字员工采用',
          roleRef: 'primary',
          implementation: { kind: 'agent', agentRef: { id: 'standalone-agent', revision: 1 } },
        },
      })
      const toolRef = await v1.commands.publishTool({
        typeRef,
        workItemRef: 'design-work',
        toolId: tool.id,
        actorUserId: 'standalone-owner',
      })
      const published = v1.commands.createJobTemplate({
        typeRef,
        actorUserId: 'standalone-owner',
        body: {
          name: '待采用的已发布岗位',
          description: '发布后即属于可迁移闭包',
          defaultToolBindings: [
            { workItemRef: 'design-work', slotRef: 'primary', registrationRef: toolRef },
          ],
        },
      })
      v1.commands.publishJobTemplate({ id: published.id, actorUserId: 'standalone-owner' })
      v1.commands.createJobTemplate({
        typeRef,
        actorUserId: 'standalone-owner',
        body: {
          name: '用户尚未发布的岗位草稿',
          description: '平台不得替用户发布',
          defaultToolBindings: [
            { workItemRef: 'design-work', slotRef: 'primary', registrationRef: toolRef },
          ],
        },
      })
      const issues: Array<{ reasonCode: string; resourceId: string }> = []

      const v2 = createFixtureModule({
        db,
        appHome,
        typePackage: versionedDesignPackage(2),
        issues,
      })

      expect(issues).toEqual([])
      expect(v2.queries.listLaunchableEmployees()).toEqual([])
      expect(
        v2.queries.listJobTemplates({ typeId: 'design', revision: 2 }).map((job) => job.name),
      ).toEqual(['待采用的已发布岗位'])
      expect(
        db
          .select()
          .from(employeeJobTemplates)
          .all()
          .find((job) => job.name === '用户尚未发布的岗位草稿'),
      ).toMatchObject({ typeRevision: 1, publishedRevision: null })
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })

  test('target name collisions migrate under a deterministic name without user work', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc310-auto-upgrade-name-collision-'))
    try {
      const db = createInMemoryDb(MIGRATIONS)
      const current = createFixtureModule({
        db,
        appHome,
        typePackage: versionedDesignPackage(2),
        idPrefix: 'current-resource',
      })
      const currentTypeRef = { typeId: 'design', revision: 2 }
      const currentTool = await current.commands.createTool({
        typeRef: currentTypeRef,
        workItemRef: 'design-work',
        actorUserId: 'current-owner',
        body: {
          displayName: '当前版本独立工具',
          description: '同名岗位已有另一份合法内容',
          roleRef: 'primary',
          implementation: { kind: 'agent', agentRef: { id: 'current-agent', revision: 1 } },
        },
      })
      const currentToolRef = await current.commands.publishTool({
        typeRef: currentTypeRef,
        workItemRef: 'design-work',
        toolId: currentTool.id,
        actorUserId: 'current-owner',
      })
      const existingTarget = current.commands.createJobTemplate({
        typeRef: currentTypeRef,
        actorUserId: 'current-owner',
        body: {
          name: '产品设计岗位',
          description: '目标版本已有岗位，不允许自动覆盖',
          defaultToolBindings: [
            {
              workItemRef: 'design-work',
              slotRef: 'primary',
              registrationRef: currentToolRef,
            },
          ],
        },
      })
      current.commands.publishJobTemplate({
        id: existingTarget.id,
        actorUserId: 'current-owner',
      })
      const original = await seedPublishedEmployee({ db, appHome })
      const issues: Array<{ reasonCode: string; resourceId: string }> = []

      const upgraded = createFixtureModule({
        db,
        appHome,
        typePackage: versionedDesignPackage(2),
        issues,
      })
      const jobs = upgraded.queries.listJobTemplates(currentTypeRef)
      const employee = upgraded.queries.getEmployee(original.id)
      const migratedJob = jobs.find(
        (candidate) => candidate.id === employee.configuration.jobTemplateRef.id,
      )

      expect(issues).toEqual([])
      expect(employee).toMatchObject({
        id: original.id,
        revision: 2,
        typeRef: currentTypeRef,
      })
      expect(jobs.find((candidate) => candidate.id === existingTarget.id)?.draft.description).toBe(
        '目标版本已有岗位，不允许自动覆盖',
      )
      expect(migratedJob?.name).toMatch(/^产品设计岗位 · migrated design@1-[0-9a-f]{8}$/)
      expect(migratedJob?.publishedRevision).toBe(1)
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })

  test('changed WorkContract stays pinned and reports a machine issue without partial writes', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc310-auto-upgrade-blocked-'))
    try {
      const db = createInMemoryDb(MIGRATIONS)
      const original = await seedPublishedEmployee({ db, appHome })
      const issues: Array<{ reasonCode: string; resourceId: string }> = []
      const incompatiblePackage = versionedDesignPackage(2, (descriptor) => {
        const contracts = descriptor.workContracts as Array<Record<string, unknown>>
        contracts[0]!.outputSchemaId = 'design.output.v2'
      })

      const module = createFixtureModule({
        db,
        appHome,
        typePackage: incompatiblePackage,
        issues,
      })

      expect(module.queries.listLaunchableEmployees()).toEqual([])
      expect(issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reasonCode: 'work-contract-changed',
            resourceId: original.id,
          }),
        ]),
      )
      expect(db.select().from(employeeDefinitions).all()).toEqual([
        expect.objectContaining({
          id: original.id,
          typeRevision: 1,
          currentRevision: 1,
        }),
      ])
      expect(db.select().from(employeeDefinitionRevisions).all()).toHaveLength(1)
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })

  test('a target scope codec rejection is diagnostic-only and never asks the user to upgrade', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc310-auto-upgrade-scope-blocked-'))
    try {
      const db = createInMemoryDb(MIGRATIONS)
      const original = await seedPublishedEmployee({ db, appHome })
      const issues: Array<{ reasonCode: string; resourceId: string }> = []
      const targetPackage = versionedDesignPackage(2)
      const incompatibleScopePackage: EmployeeTypePackageRegistration = {
        ...targetPackage,
        parseWorkScopeJson() {
          throw new Error('global scope was removed from the target codec')
        },
      }

      const module = createFixtureModule({
        db,
        appHome,
        typePackage: incompatibleScopePackage,
        issues,
      })

      expect(module.queries.listLaunchableEmployees()).toEqual([])
      expect(issues).toEqual([
        expect.objectContaining({
          reasonCode: 'work-scope-incompatible',
          resourceId: original.id,
        }),
      ])
      // The independently valid published job closure still migrates; only the
      // employee definition is pinned by its incompatible scope.
      expect(db.select().from(employeeJobTemplates).all()).toHaveLength(2)
      expect(db.select().from(employeeToolRegistrations).all()).toHaveLength(2)
      expect(db.select().from(employeeDefinitionRevisions).all()).toHaveLength(1)
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })

  test('platform tools migrate only through a provider successor under an unchanged WorkContract', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc310-auto-upgrade-platform-'))
    try {
      const db = createInMemoryDb(MIGRATIONS)
      const platformTools = platformToolCatalog()
      const v1 = createFixtureModule({
        db,
        appHome,
        typePackage: versionedDesignPackage(1),
        platformTools,
      })
      const sourceRef = JSON.parse(
        platformTools.getRevisionJson(
          JSON.stringify({
            id: 'platform-fixture:design:1:design-work:platform-design-agent',
            revision: 101,
          }),
        )!,
      ).ref as { id: string; revision: number }
      const job = v1.commands.createJobTemplate({
        typeRef: { typeId: 'design', revision: 1 },
        actorUserId: 'owner-platform',
        body: {
          name: '平台工具岗位',
          description: '不允许公共层解析 provider 私有 ID',
          defaultToolBindings: [
            { workItemRef: 'design-work', slotRef: 'primary', registrationRef: sourceRef },
          ],
        },
      })
      const jobRef = v1.commands.publishJobTemplate({
        id: job.id,
        actorUserId: 'owner-platform',
      })
      const employee = v1.commands.createEmployee({
        typeRef: { typeId: 'design', revision: 1 },
        actorUserId: 'owner-platform',
        body: {
          name: '平台工具数字员工',
          jobTemplateRef: jobRef,
          workScope: { kind: 'global' },
        },
      })

      const v2 = createFixtureModule({
        db,
        appHome,
        typePackage: versionedDesignPackage(2),
        platformTools,
      })
      expect(v2.queries.listLaunchableEmployees()).toEqual([
        expect.objectContaining({
          id: employee.id,
          revision: 2,
          typeRef: { typeId: 'design', revision: 2 },
        }),
      ])
      expect(db.select().from(employeeToolRegistrations).all()).toEqual([])
      expect(
        v2.queries.listJobTemplates({ typeId: 'design', revision: 2 })[0]?.draft
          .defaultToolBindings[0]?.registrationRef,
      ).toEqual({
        id: 'platform-fixture:design:2:design-work:platform-design-agent',
        revision: 102,
      })

      const issues: Array<{ reasonCode: string; resourceId: string }> = []
      const v3 = createFixtureModule({
        db,
        appHome,
        typePackage: versionedDesignPackage(3, (descriptor) => {
          const contracts = descriptor.workContracts as Array<Record<string, unknown>>
          contracts[0]!.outputSchemaId = 'design.output.v3'
        }),
        platformTools,
        issues,
      })
      expect(v3.queries.listLaunchableEmployees()).toEqual([])
      expect(issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reasonCode: 'work-contract-changed',
            resourceId: employee.id,
          }),
        ]),
      )
      expect(v3.queries.getEmployee(employee.id)).toMatchObject({
        id: employee.id,
        revision: 2,
        typeRef: { typeId: 'design', revision: 2 },
      })
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })
})
