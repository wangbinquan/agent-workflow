import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const backendRoot = resolve(import.meta.dir, '..')

function source(path: string): string {
  return readFileSync(resolve(backendRoot, path), 'utf8')
}

describe('RFC-349 classic resource-catalog PostgreSQL adapters', () => {
  const aggregates = [
    ['Agent', 'agentOperations'],
    ['Skill', 'skillOperations'],
    ['Workflow', 'workflowOperations'],
  ] as const

  test('repositories use the shared asynchronous transaction boundary without SQLite fallback', () => {
    for (const [aggregate] of aggregates) {
      const repository = source(
        `src/modules/resource-catalog/infrastructure/postgresql${aggregate}Repository.ts`,
      )
      expect(repository).toContain('PostgresqlDatabaseClient')
      expect(repository).toContain('runPostgresqlResourceCatalogTransaction')
      expect(repository).toContain('await ')
      expect(repository).not.toMatch(
        /\bDbClient\b|\bdbTxSync\b|bun:sqlite|drizzle-orm\/sqlite-core/,
      )
      expect(repository).not.toMatch(/createSqlite|as PostgresqlDatabaseClient|as DbClient/)
    }
  })

  test('composition keeps provider adapters injectable and the SQLite entrypoints compatible', () => {
    for (const [aggregate, file] of aggregates) {
      const composition = source(`src/modules/resource-catalog/composition/${file}.ts`)
      expect(composition).toContain(`compose${aggregate}CatalogFromAdapters`)
      expect(composition).toContain(`composePostgresql${aggregate}Catalog`)
      expect(composition).toContain(`createPostgresql${aggregate}Repository`)
      expect(composition).toContain(`export function compose${aggregate}Catalog(`)
    }
  })

  test('skill PostgreSQL content mutations require a durable lifecycle owner', () => {
    const repository = source(
      'src/modules/resource-catalog/infrastructure/postgresqlSkillRepository.ts',
    )
    expect(repository).toContain('export interface PostgresqlSkillContentLifecycle')
    expect(repository).toContain('prepareCreate(')
    expect(repository).toContain('prepareSave(')
    expect(repository).toContain('prepareDelete(')
    expect(repository).toContain('commitInTransaction(')
    expect(repository).toContain('publish()')
    expect(repository).toContain('complete()')
    expect(repository).toContain('abort(input: { readonly databaseCommitted: boolean })')
    expect(repository).not.toMatch(/createSqliteSkillRepository|@\/services\/skill/)
  })

  test('one owner-native bundle supplies all PostgreSQL classic catalog semantics', () => {
    const bundle = source('src/modules/resource-catalog/composition/postgresqlClassicCatalogs.ts')
    const agent = source(
      'src/modules/resource-catalog/infrastructure/postgresqlAgentPersistenceSemantics.ts',
    )
    const workflow = source(
      'src/modules/resource-catalog/infrastructure/postgresqlWorkflowPersistenceSemantics.ts',
    )
    const skill = source(
      'src/modules/resource-catalog/infrastructure/postgresqlSkillContentLifecycle.ts',
    )

    expect(bundle).toContain('export function composePostgresqlClassicCatalogs(')
    expect(bundle).toContain('createPostgresqlAgentPersistenceSemantics({')
    expect(bundle).toContain('createPostgresqlWorkflowPersistenceSemantics({')
    expect(bundle).toContain('createPostgresqlSkillContentLifecycle({')
    expect(bundle).toContain('memoryFusion: input.memoryFusion')
    expect(bundle).toContain('runtimeProfiles: input.runtimeProfiles')
    expect(bundle).toContain('composePostgresqlAgentCatalog({')
    expect(bundle).toContain('composePostgresqlWorkflowCatalog({')
    expect(bundle).toContain('composePostgresqlSkillCatalog({')
    expect(bundle).not.toMatch(/createSqlite|as DbClient|as PostgresqlDatabaseClient/)

    expect(agent).toContain('export function createPostgresqlAgentPersistenceSemantics(')
    expect(agent).toContain('assertReferencesUsable({')
    expect(agent).toContain('assertDependencyGraph(')
    expect(agent).toContain('readonly runtimeProfiles: AgentRuntimeProfileLookup')
    expect(agent).not.toMatch(/\bruntimes\b/)
    expect(workflow).toContain('export function createPostgresqlWorkflowPersistenceSemantics(')
    expect(workflow).toContain('assertDefinitionReferences({')
    expect(skill).toContain('export function createPostgresqlSkillContentLifecycle(')
    expect(skill).toContain("kind: input.reserve === undefined ? 'version-write' : 'reserve'")
    expect(skill).toContain('.unfuseAboveVersion({')
    expect(skill).toContain('inTransaction(transaction)')
    expect(skill).toContain(".set({ phase: 'db-committed' })")
    expect(skill).toContain('swapInStaged(state.filesDir, state.opId)')
    expect(skill).toContain("await retireOperation(db, state.opId, 'done')")
    expect(skill).not.toMatch(/createSqlite|DbClient|dbTxSync|as PostgresqlDatabaseClient/)
  })

  test('agent visibility projection consumes AgentQueries rather than a legacy ACL facade', () => {
    const route = source('src/routes/agents.ts')
    expect(route).toContain('queries.get(authority, { id: row.id })')
    expect(route).toContain('module.listDigitalEmployeeTemplates()')
    expect(route).not.toContain('filterVisibleRows')
    expect(route).not.toContain("from '@/services/resourceAcl'")
    expect(route).not.toContain("from '@/services/digitalEmployeeAgentTemplates'")
  })

  test('skill precondition tokens have one module-owned byte-compatible codec', () => {
    const token = source('src/modules/resource-catalog/application/skills/skillToken.ts')
    expect(token).toContain('export function encodeSkillToken(')
    expect(token).toContain('export function decodeSkillToken(')
    expect(token).toContain('export function skillTokenMatches(')
    expect(token).not.toMatch(/@\/services\/skillToken|DbClient|PostgresqlDatabaseClient/)
  })
})
