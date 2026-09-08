// RFC-359 W20: Main 34223843004 returned no PG row for the existing ACME
// repository search. Both providers must preserve the original ASCII search,
// literal wildcard escaping, NULL fallback, ordering and page cursor behavior.
// The separate compiler probe returns no PostgreSQL rows or network evidence.
import { expect, test } from 'bun:test'
import type { SQLWrapper } from 'drizzle-orm'
import { cachedRepos } from '@/db/schema'
import { currentDatabaseSchemaProvider, selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { RepositoryWorkspaceSqlStore } from '@/modules/source-control/infrastructure/repositoryWorkspaceSqlStore'
import { DrizzleRepositoryWorkspaceStore } from '@/modules/source-control/infrastructure/repositoryWorkspaceStore'
import type { CachedRepositoryRecord } from '@/modules/source-control/ports/repositoryWorkspaceStore'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlPool,
} from '@/platform/persistence/postgresqlRuntime'
import { describeEachProvider } from './helpers/eachProvider'

function repository(
  id: string,
  lastFetchedAt: number,
  urlRedacted: string | null,
  localPath: string,
  defaultBranch: string | null,
): CachedRepositoryRecord {
  return {
    id,
    urlHash: `hash-${id}`,
    urlEnc: null,
    urlRedacted,
    localPath,
    defaultBranch,
    lastFetchedAt,
    createdAt: 1,
    hasSubmodules: false,
    lastSubmoduleSyncOk: null,
    lastSubmoduleSyncError: null,
    lastAutoRefreshAt: null,
  }
}

const repositories = [
  repository('search-z', 40, 'https://example.test/AcMe/project.git', '/cache/z', 'main'),
  repository('search-y', 40, 'https://example.test/org/project.git', '/Cache/aCmE/work', 'main'),
  repository('search-x', 30, null, '/cache/x', 'FEATURE/acme'),
  repository('search-w', 20, 'https://example.test/AcMe/secondary.git', '/cache/w', null),
  repository('search-null', 10, null, '/cache/null', null),
  repository(
    'search-literal',
    5,
    'https://example.test/Literal%_\\leaf.git',
    '/cache/literal',
    'main',
  ),
  repository('search-decoy', 4, 'https://example.test/LiteralAXleaf.git', '/cache/decoy', 'main'),
  repository('search-other', 3, 'https://other.test/else.git', '/cache/other', null),
]

interface Statement {
  readonly sql: string
  readonly parameters: readonly unknown[]
}

function postgresqlCompilerProbe() {
  const statements: Statement[] = []
  const stop = new Error('repository-search-stopped-before-postgresql-execution')
  const pool: PostgresqlPool = {
    unsafe(sql, parameters = []) {
      statements.push({ sql, parameters })
      throw stop
    },
    async reserve() {
      throw new Error('repository-search-unexpected-reservation')
    },
    async close() {},
  }
  const runtime = createPostgresqlDatabaseRuntime({
    config: {
      provider: 'postgresql',
      urlEnv: 'RFC359_REPOSITORY_SEARCH_PROBE_URL',
      poolMax: 1,
      connectTimeoutMs: 1_000,
      statementTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
    },
    generationId: 'dbg_rfc359_repository_search_probe',
    env: {
      RFC359_REPOSITORY_SEARCH_PROBE_URL: 'postgresql://fixture:fixture@localhost/fixture',
    },
    poolFactory: () => pool,
  })
  const provider = currentDatabaseSchemaProvider()
  const db = createPostgresqlDatabaseClient(runtime)
  selectDatabaseSchemaProvider(provider)
  return { db, runtime, stop, statements }
}

describeEachProvider('RFC-359 W20 repository search conformance', (harness) => {
  test('all three text fields preserve mixed ASCII case, literal patterns, NULLs and full pages', async () => {
    await harness.db.insert(cachedRepos).values(repositories)
    const store = new DrizzleRepositoryWorkspaceStore(harness.db)
    const matching = ['search-z', 'search-y', 'search-x', 'search-w']
    const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['ACME', matching],
      ['acme', matching],
      ['  aCmE  ', matching],
      ['FEATURE/ACME', ['search-x']],
      ['/CACHE/ACME', ['search-y']],
      ['URL UNAVAILABLE', ['search-x', 'search-null']],
      ['%_\\', ['search-literal']],
      ['Literal%_', ['search-literal']],
      ['Literal_', []],
      ['\\leaf', ['search-literal']],
      ['%', ['search-literal']],
      ['_', ['search-literal']],
      ['no-such-repository', []],
      ['   ', repositories.map((row) => row.id)],
    ]
    const expectedRows = (ids: readonly string[]) =>
      ids.map((id) => {
        const row = repositories.find((item) => item.id === id)
        if (row === undefined) throw new Error(`missing repository fixture ${id}`)
        return row
      })
    const facets = { all: 8, referenced: 0, attention: 0, unused: 8 }
    for (const [q, ids] of cases) {
      const page = await store.listCachedRepoPage({ q, limit: 20 })
      expect(page.rows).toEqual(expectedRows(ids))
      expect(page.hasMore).toBe(false)
      expect([...page.referenceCounts]).toEqual([])
      expect(page.facets).toEqual(facets)
    }

    const first = await store.listCachedRepoPage({ q: 'ACME', limit: 2 })
    expect(first.rows).toEqual(expectedRows(matching.slice(0, 2)))
    expect(first.hasMore).toBe(true)
    expect(first.facets).toEqual(facets)
    const last = first.rows.at(-1)
    if (last === undefined) throw new Error('missing first-page cursor')
    const second = await store.listCachedRepoPage({
      q: 'ACME',
      limit: 2,
      cursor: { lastFetchedAt: last.lastFetchedAt, id: last.id },
    })
    expect(second.rows).toEqual(expectedRows(matching.slice(2)))
    expect(second.hasMore).toBe(false)
    expect(second.facets).toEqual(facets)
    expect([...first.rows, ...second.rows]).toEqual(expectedRows(matching))
  })

  test('the shared page emitter reaches the real PG compiler with three insensitive predicates', async () => {
    const probe = postgresqlCompilerProbe()
    let reads = 0
    // The prerequisite scheduled-reference read uses this selected real DB.
    // The next read is the actual page SQL, sent through the real PG client to
    // a pool that always throws. No PostgreSQL result rows are fabricated.
    const store = new RepositoryWorkspaceSqlStore(
      {
        async all<T extends Record<string, unknown>>(query: SQLWrapper): Promise<readonly T[]> {
          reads += 1
          if (reads === 1) return await harness.db.all<T>(query)
          const restore = selectDatabaseSchemaProvider('postgresql')
          try {
            return await probe.db.all<T>(query)
          } finally {
            restore()
          }
        },
        async run() {
          throw new Error('repository-search-unexpected-write')
        },
        async cachedRepoFacets() {
          throw new Error('repository-search-unexpected-facets')
        },
      },
      engineOf(probe.db),
    )
    try {
      let observed: unknown
      try {
        await store.listCachedRepoPage({ q: '  ACME%_\\  ', limit: 2 })
      } catch (error) {
        observed = error
      }
      while (observed instanceof Error && observed.cause !== undefined) observed = observed.cause
      expect(observed).toBe(probe.stop)
      expect(reads).toBe(2)
      expect(probe.statements).toHaveLength(1)
      const statement = probe.statements[0]
      if (statement === undefined) throw new Error('missing real PG page statement')
      expect(statement.sql).toContain('FROM "agent_workflow"."cached_repos"')
      expect(statement.sql.match(/\silike\s/gi) ?? []).toHaveLength(3)
      expect(statement.sql).not.toMatch(/\slike\s/i)
      const { pattern, escape } = harness.capabilities.likeEscape('ACME%_\\')
      expect(statement.parameters).toEqual([pattern, escape, pattern, escape, pattern, escape, 3])
    } finally {
      await probe.runtime.close()
    }
  })
})
