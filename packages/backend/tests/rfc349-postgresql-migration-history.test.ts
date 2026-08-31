// RFC-349 T4/T10 — the PostgreSQL history is a production runtime contract,
// not a source-tree ornament. These checks cover the same verifier used by
// logical target preparation and by the standalone schema migrator.

import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { verifyPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import { buildPostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'

const committedHistory = resolve(import.meta.dir, '..', 'db', 'postgresql-migrations')
const roots: string[] = []

function copyHistory(): string {
  const root = mkdtempSync(join(tmpdir(), 'rfc349-pg-history-'))
  roots.push(root)
  const history = join(root, 'postgresql-migrations')
  cpSync(committedHistory, history, { recursive: true })
  return history
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-349 PostgreSQL migration history admission', () => {
  test('accepts the committed baseline and exact statement journal', async () => {
    const plan = buildPostgresqlSchemaPlan()
    await expect(
      verifyPostgresqlMigrationHistory({ plan, migrationsFolder: committedHistory }),
    ).resolves.toEqual({
      migrationsFolder: committedHistory,
      baselineId: plan.baselineId,
      contractDigest: plan.contractDigest,
      planDigest: plan.digest,
      statementCount: plan.statements.length,
    })
  })

  test('fails closed when the baseline or journal is absent', async () => {
    const history = copyHistory()
    rmSync(join(history, '0000_rfc349_baseline.sql'))
    await expect(
      verifyPostgresqlMigrationHistory({
        plan: buildPostgresqlSchemaPlan(),
        migrationsFolder: history,
      }),
    ).rejects.toMatchObject({
      code: 'postgresql-migration-history-missing',
    })
  })

  test('rejects malformed journal content without entering target DDL', async () => {
    const history = copyHistory()
    writeFileSync(join(history, 'meta', '_journal.json'), '{broken')
    await expect(
      verifyPostgresqlMigrationHistory({
        plan: buildPostgresqlSchemaPlan(),
        migrationsFolder: history,
      }),
    ).rejects.toMatchObject({
      code: 'postgresql-migration-history-invalid',
    })
  })

  test('rejects baseline bytes or journal digests that drift from the projector', async () => {
    const plan = buildPostgresqlSchemaPlan()
    const baselineHistory = copyHistory()
    const baselinePath = join(baselineHistory, '0000_rfc349_baseline.sql')
    writeFileSync(baselinePath, `${readFileSync(baselinePath, 'utf8')}-- drift\n`)
    await expect(
      verifyPostgresqlMigrationHistory({ plan, migrationsFolder: baselineHistory }),
    ).rejects.toMatchObject({
      code: 'postgresql-migration-history-drift',
    })

    const journalHistory = copyHistory()
    const journalPath = join(journalHistory, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Record<string, unknown>
    journal.planDigest = `sha256:${'0'.repeat(64)}`
    writeFileSync(journalPath, JSON.stringify(journal))
    await expect(
      verifyPostgresqlMigrationHistory({ plan, migrationsFolder: journalHistory }),
    ).rejects.toMatchObject({
      code: 'postgresql-migration-history-drift',
    })
  })
})
