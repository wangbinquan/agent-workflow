import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../src/modules/resource-catalog')
const source = (path: string): string => readFileSync(resolve(root, path), 'utf8')

describe('RFC-345 Agent import queries', () => {
  test('the application consumes only a closed provider snapshot', () => {
    const application = source('application/agents/agentImportQueries.ts')
    const ports = source('application/agents/importPorts.ts')

    expect(application).toContain('createAgentImportQueries')
    expect(application).toContain('reads.snapshot(authority')
    expect(application).not.toMatch(/DbClient|DbTxSync|drizzle|schema|infrastructure/)
    expect(ports).toContain('AgentImportResolutionSnapshot')
    expect(ports).not.toMatch(/DbClient|DbTxSync|Postgresql|drizzle|schema/)
  })

  test('one provider-neutral snapshot serves both engines (RFC-359 W4-D14)', () => {
    const composition = source('composition/agentImportQueries.ts')
    const infrastructure = source('infrastructure/agentImportQueries.ts')

    expect(composition).toContain('composeAgentImportQueries')
    expect(composition).not.toMatch(/composeSqlite|composePostgresql/)
    expect(infrastructure).toContain('runResourceCatalogTransaction')
    expect(infrastructure).not.toMatch(/as unknown|DbClient|dbTxSync|Postgresql|fallback/)
  })

  test('portable import fences bind to the caller-owned provider transaction', () => {
    const application = source('application/portableImportReferences.ts')
    const composition = source('composition/portableImportReferences.ts')

    expect(application).toContain('createPortableImportReferenceApplication')
    // RFC-359 W4-D14：SQLite 专属的同步终写围栏（无生产消费方）退役，只剩绑定统一事务的一份。
    expect(application).not.toContain('createPortableImportReferenceSyncFence')
    expect(application).toContain("'workflow',")
    expect(application).toContain("'workgroup',")
    expect(composition).toContain('composePortableImportReferencesInTransaction')
    expect(composition).not.toMatch(/as unknown|deasync|fallback|Sqlite|Postgresql/)
  })
})
