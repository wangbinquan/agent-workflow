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

  test('SQLite and PostgreSQL resolve one coherent provider snapshot', () => {
    const composition = source('composition/agentImportQueries.ts')
    const sqlite = source('infrastructure/sqliteAgentImportQueries.ts')
    const postgresql = source('infrastructure/postgresqlAgentImportQueries.ts')

    expect(composition).toContain('composeSqliteAgentImportQueries')
    expect(composition).toContain('composePostgresqlAgentImportQueries')
    expect(sqlite).toContain('dbTxSync(db')
    expect(postgresql).toContain('runPostgresqlResourceCatalogTransaction')
    expect(sqlite).not.toMatch(/as unknown|Postgresql|fallback/)
    expect(postgresql).not.toMatch(/as unknown|DbClient|SQLite|fallback/)
  })

  test('portable import fences bind to the caller-owned provider transaction', () => {
    const application = source('application/portableImportReferences.ts')
    const composition = source('composition/portableImportReferences.ts')

    expect(application).toContain('createPortableImportReferenceApplication')
    expect(application).toContain('createPortableImportReferenceSyncFence')
    expect(application).toContain("'workflow',")
    expect(application).toContain("'workgroup',")
    expect(composition).toContain('composeSqlitePortableImportReferenceSyncFence')
    expect(composition).toContain('composePostgresqlPortableImportReferencesInTransaction')
    expect(composition).not.toMatch(/as unknown|deasync|fallback/)
  })
})
