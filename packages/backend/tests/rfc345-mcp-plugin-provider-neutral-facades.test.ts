import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sourceRoot = resolve(import.meta.dir, '../src')
const source = (relative: string): string => readFileSync(resolve(sourceRoot, relative), 'utf8')

function publicInterface(sourceText: string, name: string): string {
  const start = sourceText.indexOf(`export interface ${name} {`)
  expect(start, `${name} interface start`).toBeGreaterThanOrEqual(0)
  const end = sourceText.indexOf('\n}', start)
  expect(end, `${name} interface end`).toBeGreaterThan(start)
  return sourceText.slice(start, end + 2)
}

const DATABASE_MECHANISM = /(?:@\/db(?:\/|['"])|drizzle-orm|dbTxSync|DbClient|DbTxSync)/

describe('RFC-345 MCP and Plugin provider-neutral compatibility facades', () => {
  test('remaining business facades consume only injected Resource Catalog contracts', () => {
    for (const relative of [
      'services/mcpClosure.ts',
      'services/mcpProbeStore.ts',
      'services/pluginClosure.ts',
      'services/pluginGenerationGc.ts',
      'services/mcpRuntimeTestTransitions.ts',
    ]) {
      expect(source(relative), relative).not.toMatch(DATABASE_MECHANISM)
    }

    expect(existsSync(resolve(sourceRoot, 'services/mcp.ts'))).toBe(false)
    expect(existsSync(resolve(sourceRoot, 'services/plugin.ts'))).toBe(false)
    expect(source('routes/plugins.ts')).toContain('PluginOperationDescriptors')
    expect(source('routes/plugins.ts')).toContain('PluginQueries')
    expect(source('services/mcpClosure.ts')).toContain('query: McpClosureQuery')
    expect(source('services/pluginClosure.ts')).toContain('query: PluginClosureQuery')
    expect(source('services/mcpRuntimeTestTransitions.ts')).toContain(
      '@/modules/resource-catalog/infrastructure/legacy/mcpRuntimeTestTransitions',
    )
  })

  test('probe persistence has closed public DTOs and real SQLite/PostgreSQL adapters', () => {
    const types = source('modules/resource-catalog/public/types.ts')
    const participants = source('modules/resource-catalog/public/participants.ts')
    const composition = source('modules/resource-catalog/composition/mcpProbeStore.ts')
    const sqlite = source('modules/resource-catalog/infrastructure/sqliteMcpProbeStore.ts')
    const postgresql = source('modules/resource-catalog/infrastructure/postgresqlMcpProbeStore.ts')

    expect(types).toContain('export interface McpProbeRecord')
    expect(types).toContain('export interface McpProbeWrite')
    expect(participants).toContain('export interface McpProbeStore')
    const probeContracts = [
      publicInterface(types, 'McpProbeRecord'),
      publicInterface(types, 'McpProbeWrite'),
      publicInterface(participants, 'McpProbeStore'),
    ].join('\n')
    expect(probeContracts).not.toMatch(
      /\b(?:Omit|Pick|Partial|Record|unknown|object|DbClient|DbTxSync)\b/,
    )
    expect(composition).toContain('composeSqliteMcpProbeStore')
    expect(composition).toContain('composePostgresqlMcpProbeStore')
    expect(sqlite).toContain('createSqliteMcpProbeStore')
    expect(sqlite).toContain('dbTxSync(db,')
    expect(postgresql).toContain('createPostgresqlMcpProbeStore')
    expect(postgresql).toContain('runPostgresqlResourceCatalogTransaction(db,')
    expect(postgresql).not.toContain('createSqliteMcpProbeStore')
  })

  test('generation GC delegates provider reads to the module-owned command', () => {
    const facade = source('services/pluginGenerationGc.ts')

    expect(facade).toContain('command: PluginGenerationGcCommand')
    expect(facade).toContain('await opts.command.run({')
    expect(facade).toContain('createPluginGenerationFilesystemGcPort(')
    expect(facade).not.toMatch(DATABASE_MECHANISM)
  })

  test('runtime-test leases are injected and awaited through the provider-neutral participant', () => {
    const runtimeTest = source('services/mcpRuntimeTest.ts')

    expect(runtimeTest).toContain('leaseOperations: McpRuntimeTestLeaseOperations')
    expect(runtimeTest).toContain('loadMcp: (mcpId: string) => Promise<Mcp | null>')
    expect(runtimeTest).toContain('return this.deps.loadMcp(mcpId)')
    expect(runtimeTest).not.toContain('McpServiceBinding')
    expect(runtimeTest).not.toContain('this.deps.mcp.catalog')
    expect(runtimeTest).not.toContain('getMcpById(this.deps.db')
    for (const operation of [
      'claimNewMcpRuntimeTestSessionLease',
      'preclaimMcpRuntimeTestSessionLease',
      'rotateMcpRuntimeTestSessionLease',
      'releaseMcpRuntimeTestSessionLease',
      'repairMcpRuntimeTestSessionLeaseAfterReap',
    ]) {
      expect(runtimeTest, operation).toContain(`await ${operation}(`)
      expect(runtimeTest, operation).not.toContain(`${operation}(this.deps.db`)
    }
    expect(runtimeTest).toContain('previousSessionId?: string,\n    ) => Promise<void>')
  })
})
