import { writeGenerationPointerV2 } from '@/platform/persistence/generationPointerV2'
import { persistenceHead } from '@/bootstrap/persistenceHead'
// RFC-349 T6 — `db compact` must dispatch by the verified live provider.
// A retained pre-cutover db.sqlite is recovery material after PostgreSQL
// activation; the CLI must not open, validate or rewrite it as live state.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dbCompactCommand } from '@/cli/dbCompact'
import { applyConfigPatch, loadConfig } from '@/config'
import { digestDatabaseArtifact } from '@/platform/persistence/generationStore'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'

const roots: string[] = []
const savedHome = process.env.AGENT_WORKFLOW_HOME

afterEach(() => {
  if (savedHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
  else process.env.AGENT_WORKFLOW_HOME = savedHome
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-349 db compact provider dispatch', () => {
  test('reports a missing SQLite database without materializing default config', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc349-db-compact-no-database-'))
    roots.push(appHome)
    process.env.AGENT_WORKFLOW_HOME = appHome

    expect(dbCompactCommand(logicalSchemaContract)).toEqual({
      status: 'no-db',
      output: `no database at ${join(appHome, 'db.sqlite')}\n`,
    })
    expect(readdirSync(appHome)).toEqual([])
  })

  test('leaves the retained SQLite file untouched when PostgreSQL is live', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc349-db-compact-provider-'))
    roots.push(appHome)
    process.env.AGENT_WORKFLOW_HOME = appHome

    const configPath = join(appHome, 'config.json')
    loadConfig(configPath)
    applyConfigPatch(configPath, {
      database: {
        provider: 'postgresql',
        urlEnv: 'RFC349_COMPACT_DATABASE_URL',
        poolMax: 8,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
        idleTimeoutMs: 30_000,
      },
    })

    const operationId = 'dbm_compact_provider_01'
    const operationsRoot = join(appHome, 'database-migrations')
    const operationRoot = join(operationsRoot, operationId)
    mkdirSync(operationRoot, { recursive: true })
    const manifest = '{"fixture":"rfc349-db-compact-provider"}\n'
    writeFileSync(join(operationRoot, 'manifest.json'), manifest)
    writeGenerationPointerV2({
      pointerPath: join(appHome, 'database-generation.json'),
      payload: {
        version: 2,
        schemaEpoch: 2,
        role: 'installed',
        previous: null,
        database: { kind: 'postgresql-target', profileRef: 'env:RFC349_COMPACT_DATABASE_URL' },
        generationId: 'dbg_pg_compact_provider_01',
        provider: 'postgresql',
        operationId,
        contractDigest: persistenceHead().contract.contract.digest,
        planDigest: persistenceHead().postgresql.digest,
        manifestDigest: digestDatabaseArtifact(manifest),
        activatedAt: 1,
      },
    })

    const retainedSqlite = join(appHome, 'db.sqlite')
    const retainedBytes = 'not even a SQLite database; compact must not open it\n'
    writeFileSync(retainedSqlite, retainedBytes)

    const result = dbCompactCommand(logicalSchemaContract)

    expect(result).toEqual({
      status: 'ok',
      output:
        'live database is PostgreSQL generation dbg_pg_compact_provider_01; ' +
        '`db compact` is SQLite-only. PostgreSQL storage reclamation is owned by autovacuum/operator policy.\n',
    })
    expect(readFileSync(retainedSqlite, 'utf8')).toBe(retainedBytes)
  })
})
