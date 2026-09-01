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

  test('mints the public handle only through Digital Employee and binds native provider writers', () => {
    const publicParticipant = digitalEmployeeSource('public/participants.ts')
    const ownerFactory = digitalEmployeeSource('composition/agentTemplateCatalog.ts')
    const composition = resourceCatalogSource('composition/digitalEmployeeAgentTemplateCatalog.ts')
    const sqlite = resourceCatalogSource(
      'infrastructure/sqliteDigitalEmployeeAgentTemplateCatalog.ts',
    )
    const postgresql = resourceCatalogSource(
      'infrastructure/postgresqlDigitalEmployeeAgentTemplateCatalog.ts',
    )

    expect(publicParticipant).toContain(
      'readonly [digitalEmployeeAgentTemplateCatalogParticipantBrand]',
    )
    expect(ownerFactory).toContain('composeDigitalEmployeeAgentTemplateCatalogParticipant(')
    expect(composition).toContain('composeSqliteDigitalEmployeeAgentTemplateCatalogParticipant(')
    expect(composition).toContain(
      'composePostgresqlDigitalEmployeeAgentTemplateCatalogParticipant(',
    )
    expect(composition).toContain('DigitalEmployeeAgentTemplateCatalogParticipantMint')
    expect(composition).toContain('return mint(')
    expect(composition).not.toMatch(
      /digital-employee\/(?:application|composition|infrastructure)|as unknown/,
    )

    expect(sqlite).toContain("from './legacy/agent'")
    expect(sqlite).toContain('ownerUserId: SYSTEM_USER_ID')
    expect(sqlite).toContain('builtin: true')
    expect(sqlite).not.toContain("from '@/services/")

    expect(postgresql).toContain(
      'runPostgresqlResourceCatalogTransaction(db, async (transaction) =>',
    )
    expect(postgresql).toContain("visibility: 'public', builtin: true")
    expect(postgresql).toContain('eq(agents.ownerUserId, SYSTEM_USER_ID)')
    expect(postgresql).toContain('eq(agents.builtin, true)')
    expect(postgresql).toContain('eq(agents.updatedAt, input.expectedUpdatedAt)')
    expect(postgresql).toContain('eq(agents.aclRevision, input.expectedAclRevision)')
    expect(postgresql).not.toMatch(
      /@\/services\/|\.\/legacy\/|createSqlite|\bDbClient\b|bun:sqlite|as unknown| as Postgresql/,
    )
  })
})
