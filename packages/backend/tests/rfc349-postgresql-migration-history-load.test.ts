// RFC-349 PostgreSQL migration history in a running daemon.
//
// WHY THIS EXISTS: reading, replaying and checking the history costs about two
// seconds of CPU, and every default caller (migration preparation, schema
// finalization, the cutover's session composition) used to replay it again in one
// synchronous block. postgresql-evidence 38613687770 measured 2.2 s event-loop gaps
// at migration start and at cutover (gate 2 s) and 3 s status latency behind the
// cutover barrier (gate 2.5 s), rising with every appended migration. The runtime
// history is now checked once per process, and the replay yields between versions.
//
// Budgets below are wall-clock allowances for a ~2 s replay on a loaded runner,
// not a tolerance for the replay getting slower.
import { buildFrozenEpoch1LogicalSchemaContract as buildLogicalSchemaContract } from '@/platform/persistence/migration/epoch1/contract'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadPostgresqlMigrationHistory,
  readPostgresqlMigrationHistoryPrefix,
  verifyPostgresqlMigrationHistory,
} from '@/platform/persistence/migration/legacy/postgresqlMigrationHistory'
import {
  replayPostgresqlMigrationHistory,
  replayPostgresqlMigrationHistoryYielding,
} from '@/platform/persistence/migration/legacy/postgresqlMigrationSequence'
import { buildPostgresqlSchemaPlan } from '@/platform/persistence/migration/legacy/postgresqlSchema'
import { canonicalSchemaJson } from '@/platform/persistence/schemaContract'
import { resolvePostgresqlMigrationsFolder } from '@/util/migrationsFolder'

test('default callers share one checked runtime history; explicit folders read fresh', async () => {
  const first = await loadPostgresqlMigrationHistory({ headContract: buildLogicalSchemaContract() })
  expect(await loadPostgresqlMigrationHistory({ headContract: buildLogicalSchemaContract() })).toBe(
    first,
  )
  const receipt = await verifyPostgresqlMigrationHistory({
    headContract: buildLogicalSchemaContract(),
    plan: buildPostgresqlSchemaPlan(buildLogicalSchemaContract()),
  })
  expect(receipt.planDigest).toBe(first.head.plan.digest)

  const copy = mkdtempSync(join(tmpdir(), 'aw-rfc349-history-'))
  try {
    await cp(await resolvePostgresqlMigrationsFolder(), copy, { recursive: true })
    const fresh = await loadPostgresqlMigrationHistory({
      headContract: buildLogicalSchemaContract(),
      migrationsFolder: copy,
    })
    expect(fresh).not.toBe(first)
    expect(canonicalSchemaJson(fresh.head.plan)).toBe(canonicalSchemaJson(first.head.plan))
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
}, 60_000)

test('the daemon replay yields between versions and reaches the same history', async () => {
  const { root, steps } = await readPostgresqlMigrationHistoryPrefix({
    migrationsFolder: await resolvePostgresqlMigrationsFolder(),
  })
  expect(steps.length).toBeGreaterThan(10)
  let turns = 0
  const yielding = await replayPostgresqlMigrationHistoryYielding(root, steps, async () => {
    turns += 1
  })
  expect(turns).toBe(steps.length)
  const blocking = replayPostgresqlMigrationHistory(root, steps)
  expect(yielding.versions.map((version) => version.contract.digest)).toEqual(
    blocking.versions.map((version) => version.contract.digest),
  )
  expect(canonicalSchemaJson(yielding.head)).toBe(canonicalSchemaJson(blocking.head))
}, 60_000)
