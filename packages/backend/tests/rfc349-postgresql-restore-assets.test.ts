import { DEFAULT_CONFIG, type DatabaseConfig } from '@agent-workflow/shared'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackupManifestV2 } from '@/services/backupManifest'
import type { ProviderNeutralDatabase } from '@/db/query'
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
      // config / skills 那一半完全不碰库；`includesWorktrees: false` 时 db 一次也不用。
      db: {} as ProviderNeutralDatabase,
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

  test('binds worktree reconstruction to the composed provider-neutral client', async () => {
    // RFC-359 W9：这一条此前断的是**手写 SQL 的文本**（`FROM "agent_workflow"."tasks"` +
    // `$1` 绑定），而那条语句在真 PostgreSQL 上一行都没跑过。行选择合一之后，判据是
    // 「还原资产把组合根给它的中立客户端与 staging 目录**原样**交给中立重建实现」；
    // 真实的取行行为（找不到 / 终态 / 已存在的三条 skip 理由）在
    // `rfc359-w9-system-operations-application-assets-conformance.test.ts` ⑤ 上对**两个真引擎**跑。
    const appHome = temporaryRoot('rfc349-pg-restore-worktree-')
    const stagingDirectory = temporaryRoot('rfc349-pg-restore-worktree-staging-')
    const composed = {} as ProviderNeutralDatabase
    let reconstructed: unknown
    const assets = createPostgresqlProviderRestoreApplicationAssets({
      appHome,
      databaseConfig: TARGET_DATABASE,
      db: composed,
      async reconstructWorktrees(db, extractedDirectory) {
        reconstructed = { sameClient: db === composed, extractedDirectory }
        return { reconstructed: [], skipped: [] }
      },
    })

    await assets.apply({ stagingDirectory, manifest: manifest(true) })
    expect(reconstructed).toEqual({ sameClient: true, extractedDirectory: stagingDirectory })
  })
})
