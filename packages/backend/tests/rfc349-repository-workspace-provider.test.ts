import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { cachedRepos } from '@/db/schema'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { composeRepositoryWorkspaceOperations } from '@/modules/source-control/composition'
import { PostgresqlRepositoryWorkspaceStore } from '@/modules/source-control/infrastructure/postgresqlRepositoryWorkspaceStore'
import { SQLiteRepositoryWorkspaceStore } from '@/modules/source-control/infrastructure/sqliteRepositoryWorkspaceStore'
import { invalidateRepositoryWorkspaceFacetCaches } from '@/modules/source-control/public/operations'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function rows(direct: readonly Record<string, unknown>[] = []): SqlRows {
  return Object.assign(Promise.resolve(direct), {
    async values() {
      return []
    },
  })
}

function postgresqlFixture(): {
  readonly store: PostgresqlRepositoryWorkspaceStore
  readonly executions: string[]
} {
  const executions: string[] = []
  const execute = (query: string): SqlRows => {
    executions.push(query)
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(query)) return rows()
    if (query.includes('database_generations')) {
      return rows([{ generation_id: 'dbg_repository_workspace' }])
    }
    if (/^\s*select count\(\*\)/i.test(query)) return rows([{ count: 1 }])
    return rows(/^\s*(DELETE|INSERT|UPDATE)/i.test(query) ? [{}] : [])
  }
  const connection: PostgresqlReservedConnection = {
    unsafe: execute,
    release() {},
  }
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: execute,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_repository_workspace',
    providerPool: () => pool,
    async health() {
      throw new Error('not used')
    },
    async readiness() {
      throw new Error('not used')
    },
    async acquireMigrationAdvisoryLock() {
      throw new Error('not used')
    },
    async close() {},
  }
  return {
    store: new PostgresqlRepositoryWorkspaceStore(createPostgresqlDatabaseClient(runtime)),
    executions,
  }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 repository workspace provider boundary', () => {
  test('SQLite adapter preserves cache paging, due selection and group transactions', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const store = new SQLiteRepositoryWorkspaceStore(db)
    const inserted = await store.insertCachedRepo({
      id: 'repo-1',
      urlHash: 'hash-1',
      urlEnc: null,
      urlRedacted: 'https://example.test/acme/repo.git',
      localPath: '/cache/repo-1',
      defaultBranch: 'main',
      lastFetchedAt: 200,
      createdAt: 100,
      hasSubmodules: true,
      lastSubmoduleSyncOk: false,
      lastSubmoduleSyncError: 'submodule failed',
      lastAutoRefreshAt: null,
    })
    expect(inserted).toBeTrue()
    expect(
      await store.insertCachedRepo({ ...(await store.findCachedRepoById('repo-1'))! }),
    ).toBeFalse()

    expect(await store.findCachedRepoByHash('hash-1')).toMatchObject({
      id: 'repo-1',
      hasSubmodules: true,
      lastSubmoduleSyncOk: false,
    })
    const operations = composeRepositoryWorkspaceOperations(store, undefined)
    expect(await operations.overviewQueries.countCachedRepositories()).toBe(1)
    expect(await operations.backupPreparation.prepare({ blockOnCredentialedPath: true })).toEqual({
      sealed: 0,
      linked: 0,
      scrubbed: 0,
    })
    expect(await store.listKnownRepositoryPaths()).toEqual(['/cache/repo-1'])
    expect(await store.listDueCachedRepos({ dueBefore: 500, freshAfter: 150 })).toEqual([
      { id: 'repo-1', urlRedacted: 'https://example.test/acme/repo.git' },
    ])

    const page = await store.listCachedRepoPage({ view: 'attention', limit: 20 })
    expect(page.rows.map((row) => row.id)).toEqual(['repo-1'])
    expect(page.facets).toEqual({ all: 1, referenced: 0, attention: 1, unused: 1 })
    expect(page.hasMore).toBeFalse()
    expect((await store.listCachedRepoPage({ q: 'ACME', limit: 20 })).rows).toHaveLength(1)

    expect(
      await store.createRepositoryGroup(
        {
          id: 'group-1',
          name: 'Platform',
          description: 'platform sources',
          version: 1,
          createdByUserId: null,
          createdAt: 300,
          updatedAt: 300,
          schemaVersion: 2,
        },
        [
          {
            groupId: 'group-1',
            path: '',
            attachmentKind: 'repo',
            cachedRepoId: 'repo-1',
            ref: 'main',
            subdir: '',
            childGroupId: null,
            readonly: false,
          },
        ],
      ),
    ).toBe('created')
    expect(await store.groupsReferencingRepo('repo-1')).toEqual([
      { id: 'group-1', name: 'Platform' },
    ])
    expect(
      await store.updateRepositoryGroup({
        id: 'group-1',
        name: 'Platform Sources',
        description: 'renamed',
        expectedVersion: 1,
        expectedGraphVersions: [{ id: 'group-1', version: 1 }],
        updatedAt: 400,
        nodes: [
          {
            groupId: 'group-1',
            path: '',
            attachmentKind: 'repo',
            cachedRepoId: 'repo-1',
            ref: 'main',
            subdir: '',
            childGroupId: null,
            readonly: false,
          },
        ],
      }),
    ).toEqual({ status: 'ok', version: 2 })
    expect((await store.readRepositoryGroupSnapshot()).groups[0]).toMatchObject({
      name: 'Platform Sources',
      version: 2,
    })

    await store.deleteCachedRepoAndDetachGroups('repo-1')
    expect(await store.findCachedRepoById('repo-1')).toBeNull()
    expect((await store.readRepositoryGroupSnapshot()).nodes[0]).toMatchObject({
      attachmentKind: null,
      cachedRepoId: null,
    })
    expect(db.select().from(cachedRepos).all()).toHaveLength(0)
  })

  test('production consumers contain no database mechanism and PostgreSQL has a native adapter', () => {
    const production = [
      'services/repoCredentials.ts',
      'services/repoBatchImport.ts',
      'services/gitRepoCache.ts',
      'services/repoGroup.ts',
      'services/submoduleRefresh.ts',
      'services/worktreeFileContent.ts',
      'routes/cached-repos.ts',
      'routes/repoGroups.ts',
      'routes/repos.ts',
      'routes/worktree-files.ts',
    ]
    for (const path of production) {
      const source = readFileSync(resolve(import.meta.dir, '..', 'src', path), 'utf8')
      expect(source).not.toMatch(/from ['"]@\/db(?:\/|['"])/)
      expect(source).not.toMatch(/from ['"]drizzle-orm(?:\/|['"])/)
      expect(source).not.toContain('bun:sqlite')
    }

    const postgresql = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src/modules/source-control/infrastructure/postgresqlRepositoryWorkspaceStore.ts',
      ),
      'utf8',
    )
    expect(postgresql).toContain('PostgresqlDatabaseClient')
    expect(postgresql).not.toMatch(/as\s+(?:unknown\s+as\s+)?DbClient/)
    expect(postgresql).not.toContain('createInMemoryDb')
    expect(postgresql).not.toContain('deasync')
  })

  test('facets retain the short cache and expose explicit cross-store invalidation', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const store = new SQLiteRepositoryWorkspaceStore(db)
    const record = {
      id: 'repo-cache-1',
      urlHash: 'hash-cache-1',
      urlEnc: null,
      urlRedacted: 'https://example.test/acme/cache-1.git',
      localPath: '/cache/repo-cache-1',
      defaultBranch: 'main',
      lastFetchedAt: 200,
      createdAt: 100,
      hasSubmodules: false,
      lastSubmoduleSyncOk: null,
      lastSubmoduleSyncError: null,
      lastAutoRefreshAt: null,
    } as const
    await store.insertCachedRepo(record)
    expect((await store.listCachedRepoPage({ limit: 20 })).facets.all).toBe(1)

    db.insert(cachedRepos)
      .values({
        ...record,
        id: 'repo-cache-2',
        urlHash: 'hash-cache-2',
        localPath: '/cache/repo-cache-2',
      })
      .run()
    expect((await store.listCachedRepoPage({ limit: 20 })).facets.all).toBe(1)
    invalidateRepositoryWorkspaceFacetCaches()
    expect((await store.listCachedRepoPage({ limit: 20 })).facets.all).toBe(2)
  })

  test('PostgreSQL adapter emits native unqualified mutation columns behind the same port', async () => {
    const fixture = postgresqlFixture()
    await expect(
      fixture.store.insertCachedRepo({
        id: 'repo-pg',
        urlHash: 'hash-pg',
        urlEnc: null,
        urlRedacted: 'https://example.test/acme/pg.git',
        localPath: '/cache/repo-pg',
        defaultBranch: 'main',
        lastFetchedAt: 200,
        createdAt: 100,
        hasSubmodules: false,
        lastSubmoduleSyncOk: null,
        lastSubmoduleSyncError: null,
        lastAutoRefreshAt: null,
      }),
    ).resolves.toBeTrue()
    await expect(fixture.store.countCachedRepos()).resolves.toBe(1)
    const insert = fixture.executions.find((query) => /^\s*insert into/i.test(query))
    expect(insert).toMatch(/insert into "agent_workflow"\."cached_repos" \(\s*"id", "url_hash"/i)
    expect(insert).not.toContain('("cached_repos"."id"')
    expect(fixture.executions.some((query) => query.includes('database_generations'))).toBeTrue()
  })
})
