import { DEFAULT_CONFIG, type DatabaseConfig } from '@agent-workflow/shared'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackupManifestV2 } from '@/services/backupManifest'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { createPostgresqlProviderRestoreApplicationAssets } from '@/modules/system-operations/infrastructure/postgresqlProviderRestoreApplicationAssets'

const TARGET_DATABASE = Object.freeze({
  provider: 'postgresql',
  urlEnv: 'RESTORE_TARGET_DATABASE_URL',
  poolMax: 23,
  connectTimeoutMs: 12_000,
  statementTimeoutMs: 34_000,
  idleTimeoutMs: 56_000,
} satisfies Extract<DatabaseConfig, { provider: 'postgresql' }>)

const temporaryRoots: string[] = []

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function manifest(includesWorktrees: boolean): BackupManifestV2 {
  return {
    manifestVersion: 2,
    kind: 'manual',
    createdAt: 1,
    appVersion: 'test',
    includesWorktrees,
    migration: { lastHash: null, lastCreatedAt: null },
    database: {
      format: 'agent-workflow-logical-database-v1',
      provider: 'sqlite',
      sourceGenerationId: 'dbg_sqlite_source_01',
      schemaDigest: `sha256:${'a'.repeat(64)}`,
      logicalPath: 'database/logical',
      envelopeFileDigest: `sha256:${'b'.repeat(64)}`,
      rawSqlitePath: 'db.sqlite',
    },
  }
}

describe('RFC-349 PostgreSQL portable restore application assets', () => {
  test('restores config and skills without replacing the admitted target profile', async () => {
    const appHome = temporaryRoot('rfc349-pg-restore-assets-')
    const stagingDirectory = temporaryRoot('rfc349-pg-restore-staging-')
    writeFileSync(
      join(stagingDirectory, 'config.json'),
      JSON.stringify({ ...DEFAULT_CONFIG, database: { provider: 'sqlite' } }),
    )
    mkdirSync(join(stagingDirectory, 'skills', 'restored-skill'), { recursive: true })
    writeFileSync(join(stagingDirectory, 'skills', 'restored-skill', 'SKILL.md'), 'restored')
    mkdirSync(join(appHome, 'skills', 'newer-skill'), { recursive: true })
    writeFileSync(join(appHome, 'skills', 'newer-skill', 'SKILL.md'), 'must disappear')

    const assets = createPostgresqlProviderRestoreApplicationAssets({
      appHome,
      databaseConfig: TARGET_DATABASE,
      runtime: { provider: 'postgresql' } as PostgresqlDatabaseRuntime,
    })
    await expect(assets.apply({ stagingDirectory, manifest: manifest(false) })).resolves.toEqual({
      config: true,
      skills: true,
    })

    const restoredConfig = JSON.parse(readFileSync(join(appHome, 'config.json'), 'utf8')) as {
      database: unknown
    }
    expect(restoredConfig.database).toEqual(TARGET_DATABASE)
    expect(existsSync(join(appHome, 'skills', 'newer-skill'))).toBe(false)
    expect(readFileSync(join(appHome, 'skills', 'restored-skill', 'SKILL.md'), 'utf8')).toBe(
      'restored',
    )
  })

  test('binds worktree reconstruction to rows from the restored PostgreSQL target', async () => {
    const appHome = temporaryRoot('rfc349-pg-restore-worktree-')
    const stagingDirectory = temporaryRoot('rfc349-pg-restore-worktree-staging-')
    const queries: Array<{ query: string; parameters: readonly unknown[] | undefined }> = []
    let reconstructed: unknown
    const runtime = {
      provider: 'postgresql',
      providerPool() {
        return {
          unsafe(query: string, parameters?: readonly unknown[]) {
            queries.push({ query, parameters })
            return Promise.resolve([
              {
                id: '01J00000000000000000000000',
                status: 'running',
                worktreePath: '/tmp/worktree',
                branch: 'work',
                repoPath: '/tmp/repo',
              },
            ])
          },
        }
      },
    } as unknown as PostgresqlDatabaseRuntime
    const assets = createPostgresqlProviderRestoreApplicationAssets({
      appHome,
      databaseConfig: TARGET_DATABASE,
      runtime,
      async reconstructWorktrees(rows, extractedDirectory) {
        reconstructed = {
          row: await rows.findById('01J00000000000000000000000'),
          extractedDirectory,
        }
        return { reconstructed: [], skipped: [] }
      },
    })

    await assets.apply({ stagingDirectory, manifest: manifest(true) })
    expect(queries).toHaveLength(1)
    expect(queries[0]?.query).toContain('FROM "agent_workflow"."tasks"')
    expect(queries[0]?.parameters).toEqual(['01J00000000000000000000000'])
    expect(reconstructed).toEqual({
      row: {
        id: '01J00000000000000000000000',
        status: 'running',
        worktreePath: '/tmp/worktree',
        branch: 'work',
        repoPath: '/tmp/repo',
      },
      extractedDirectory: stagingDirectory,
    })
  })
})
