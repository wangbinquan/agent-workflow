import type { Agent, CreateAgent } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import {
  createDigitalEmployeeAgentTemplateCatalogPersistence,
  type DigitalEmployeeAgentTemplateRepository,
  type UpdateDigitalEmployeeAgentTemplateRecord,
} from '@/modules/resource-catalog/application/agents/digitalEmployeeAgentTemplateCatalog'

const resourceCatalogRoot = resolve(import.meta.dir, '../src/modules/resource-catalog')
const digitalEmployeeRoot = resolve(import.meta.dir, '../src/modules/digital-employee')
const resourceCatalogSource = (path: string): string =>
  readFileSync(resolve(resourceCatalogRoot, path), 'utf8')
const digitalEmployeeSource = (path: string): string =>
  readFileSync(resolve(digitalEmployeeRoot, path), 'utf8')

const definition: CreateAgent = {
  name: 'digital-employee-template',
  description: 'current definition',
  outputs: ['result'],
  inputs: [],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [],
  mcp: [],
  plugins: [],
  frontmatterExtra: {},
  bodyMd: 'body',
}

const existing: Agent = {
  ...definition,
  id: 'digital-template-id',
  ownerUserId: SYSTEM_USER_ID,
  visibility: 'private',
  aclRevision: 4,
  builtin: true,
  outputKinds: { result: 'markdown' },
  branchPorts: ['result'],
  outputWrapperPortNames: { result: 'wrapped-result' },
  role: 'aggregator',
  runtime: 'stale-runtime',
  schemaVersion: 1,
  createdAt: 1,
  updatedAt: 7,
}

function repositoryReturning(agent: Agent | null): DigitalEmployeeAgentTemplateRepository {
  return {
    get: async () => agent,
    createBuiltin: async () => undefined,
    renameBuiltin: async () => undefined,
    updateBuiltin: async () => undefined,
  }
}

describe('RFC-345 provider-neutral Digital Employee Agent template catalog', () => {
  test('turns a complete code-owned definition into a drift-clearing fenced update', async () => {
    let observed: UpdateDigitalEmployeeAgentTemplateRecord | undefined
    const repository: DigitalEmployeeAgentTemplateRepository = {
      ...repositoryReturning(existing),
      async updateBuiltin(input) {
        observed = input
      },
    }
    const persistence = createDigitalEmployeeAgentTemplateCatalogPersistence(repository)
    const { name: _name, ...content } = definition

    await persistence.updateBuiltin(existing.id, content)

    expect(Object.isFrozen(persistence)).toBe(true)
    expect(observed).toMatchObject({
      id: existing.id,
      expectedUpdatedAt: existing.updatedAt,
      expectedAclRevision: existing.aclRevision,
      patch: {
        description: definition.description,
        outputKinds: {},
        branchPorts: [],
        outputWrapperPortNames: {},
        role: 'normal',
        runtime: null,
      },
    })
  })

  test('uses exact fences for rename and refuses stable ids not owned as system builtins', async () => {
    let renamed: Parameters<DigitalEmployeeAgentTemplateRepository['renameBuiltin']>[0] | undefined
    const persistence = createDigitalEmployeeAgentTemplateCatalogPersistence({
      ...repositoryReturning(existing),
      async renameBuiltin(input) {
        renamed = input
      },
    })

    await persistence.renameBuiltin(existing.id, 'renamed-template')
    expect(renamed?.id).toBe(existing.id)
    expect(renamed?.newName).toBe('renamed-template')
    expect(renamed?.expectedUpdatedAt).toBe(existing.updatedAt)
    expect(renamed?.expectedAclRevision).toBe(existing.aclRevision)

    for (const occupied of [
      { ...existing, builtin: false },
      { ...existing, ownerUserId: 'user-owned' },
    ]) {
      const occupiedPersistence = createDigitalEmployeeAgentTemplateCatalogPersistence(
        repositoryReturning(occupied),
      )
      await expect(
        occupiedPersistence.renameBuiltin(occupied.id, 'must-not-overwrite'),
      ).rejects.toMatchObject({ code: 'builtin-agent-id-collision' })
    }
  })

  test('岗位模版目录只由 Digital Employee 铸造句柄，写面是一份中立实现', () => {
    const publicParticipant = digitalEmployeeSource('public/participants.ts')
    const ownerFactory = digitalEmployeeSource('composition/agentTemplateCatalog.ts')
    const composition = resourceCatalogSource('composition/digitalEmployeeAgentTemplateCatalog.ts')
    const repository = resourceCatalogSource(
      'infrastructure/digitalEmployeeAgentTemplateCatalog.ts',
    )

    expect(publicParticipant).toContain(
      'readonly [digitalEmployeeAgentTemplateCatalogParticipantBrand]',
    )
    expect(ownerFactory).toContain('composeDigitalEmployeeAgentTemplateCatalogParticipant(')
    // RFC-359 W4-D22：装配只剩一份，两个 bootstrap 共用；provider 前缀的两份实现都已退役。
    expect(composition).toContain('composeDigitalEmployeeAgentTemplateCatalogFor(')
    expect(composition).toContain('DigitalEmployeeAgentTemplateCatalogParticipantMint')
    expect(composition).toContain('return mint(')
    expect(composition).not.toMatch(
      /digital-employee\/(?:application|composition|infrastructure)|as unknown/,
    )
    for (const retired of [
      'infrastructure/sqliteDigitalEmployeeAgentTemplateCatalog.ts',
      'infrastructure/postgresqlDigitalEmployeeAgentTemplateCatalog.ts',
    ]) {
      expect(() => resourceCatalogSource(retired)).toThrow()
    }

    // builtin 模版的写面判据：系统 owner + builtin 双条件定位、更新走 updatedAt + aclRevision 双 OCC，
    // 唯一冲突经能力矩阵映射（不认某一个方言的约束名）。
    expect(repository).toContain('runResourceCatalogTransaction(db, async (transaction) =>')
    expect(repository).toContain("visibility: 'public', builtin: true")
    expect(repository).toContain('eq(agents.ownerUserId, SYSTEM_USER_ID)')
    expect(repository).toContain('eq(agents.builtin, true)')
    expect(repository).toContain('eq(agents.updatedAt, input.expectedUpdatedAt)')
    expect(repository).toContain('eq(agents.aclRevision, input.expectedAclRevision)')
    expect(repository).toContain('engine.uniqueViolationTarget(error)')
    expect(repository).not.toMatch(
      /@\/services\/|\.\/legacy\/|createSqlite|\bDbClient\b|PostgresqlDatabaseClient|bun:sqlite|as unknown/,
    )
  })
})
