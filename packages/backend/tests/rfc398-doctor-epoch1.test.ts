// RFC-398 §6: epoch-1 diagnostics never require an epoch-2 pointer.
import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { epochSourceDiagnostics } from '@/platform/persistence/epochUpgradeDiagnostics'
import { PostgresqlDatabaseConfigSchema } from '@agent-workflow/shared'
import { autoUpgradeFixture } from './helpers/rfc398AutoUpgrade'
import { postgresqlAutoUpgradeFixture } from './helpers/rfc398AutoUpgradePostgresql'
import { describeRfc398Postgresql } from './helpers/rfc398Postgresql'
import { releasedPostgresqlSources } from '@/platform/persistence/migration/epoch1/releasedPostgresql'

for (const manual of [false, true])
  test(`doctor describes epoch1 ${manual ? 'manual' : 'automatic'} startup without ENOENT`, async () => {
    const f = await autoUpgradeFixture({ manual })
    try {
      const before = readFileSync(join(f.home, 'db.sqlite'))
      const child = f.spawn(['doctor'])
      await child.exited
      expect(child.output).toContain('epoch-1 sqlite source')
      expect(child.output).toContain('source version')
      expect(child.output).toContain(
        manual ? 'db migration plan' : 'next start / migrate will automatically upgrade',
      )
      expect(child.output + child.error).not.toContain('ENOENT')
      expect(readFileSync(join(f.home, 'db.sqlite'))).toEqual(before)
      expect(f.sessions()).toEqual([])
    } finally {
      await f.close()
    }
  }, 120_000)

test('doctor describes unfinished and failed automatic sessions with the next action', async () => {
  const f = await autoUpgradeFixture()
  try {
    f.barriers(['intent'])
    const p = f.start()
    const child = await f.reached('intent')
    f.kill(child.pid)
    f.kill(p.process.pid)
    await p.exited
    const pending = f.spawn(['doctor'])
    await pending.exited
    expect(pending.output).toContain('unfinished')
    expect(pending.output).toContain('phase intent')
    f.release('intent')
    f.flag('negative-health')
    expect(await f.start().exited).toBe(1)
    const failed = f.spawn(['doctor'])
    await failed.exited
    expect(failed.output).toContain('--retry')
    expect(failed.output).toContain('verification-failed')
    expect(failed.output + failed.error).not.toContain('ENOENT')
  } finally {
    await f.close()
  }
}, 240_000)

describeRfc398Postgresql('doctor PostgreSQL upgrade diagnostics', () => {
  for (const release of [undefined, ...releasedPostgresqlSources])
    test(`source ${release?.tag ?? 'head'} reports names, permission and bridge`, async () => {
      const f = await postgresqlAutoUpgradeFixture(release)
      try {
        const child = f.spawn(['doctor'])
        await child.exited
        expect(child.output).toContain(`actual database: ${f.source.database}`)
        expect(child.output).toContain(`${f.source.database}_epoch2_scratch`)
        expect(child.output).toContain('CREATE DATABASE permission: available')
        if (release) expect(child.output).toContain('SQLite@0223 bridge')
        expect(child.output + child.error).not.toContain('ENOENT')
        expect(f.allocations()).toEqual([])
      } finally {
        await f.close()
      }
    }, 120_000)
})

// Implementation gate r1 P2-7: a source change appends a newer target for the same session;
// doctor must name the current run's target (or the latest row), never the first, retired one.
describeRfc398Postgresql('doctor names the current run target', () => {
  test('with two target allocations in one session the current run wins', async () => {
    const f = await postgresqlAutoUpgradeFixture()
    const previous = process.env.RFC398_URL
    try {
      const root = join(f.home, 'database-migrations/auto-upgrade')
      mkdirSync(join(root, 'allocations'), { recursive: true })
      const db = f.source.database
      const rows = [
        { n: 1, kind: 'target', runId: 'emr_run0', database: `${db}_epoch2` },
        { n: 2, kind: 'scratch', runId: 'emr_run0', database: `${db}_epoch2_scratch` },
        { n: 3, kind: 'target', runId: 'emr_run1', database: `${db}_epoch2_3` },
      ]
      for (const row of rows)
        writeFileSync(
          join(root, 'allocations', `${String(row.n).padStart(4, '0')}.json`),
          JSON.stringify({
            ...row,
            sessionOperationId: 'dbm_e2_doctor',
            profileRef: `env:RFC398_URL/${row.database}`,
          }),
        )
      process.env.RFC398_URL = f.source.url
      const lines = async (currentRunId?: string | null) =>
        (
          await epochSourceDiagnostics({
            appHome: f.home,
            database: PostgresqlDatabaseConfigSchema.parse({
              provider: 'postgresql',
              urlEnv: 'RFC398_URL',
            }),
            autoUpgradeRoot: root,
            session: { operationId: 'dbm_e2_doctor', unfinished: true, currentRunId },
          })
        ).join('\n')
      for (const current of [undefined, 'emr_run1'])
        expect(await lines(current)).toContain(
          `target: ${db}_epoch2_3; scratch: ${db}_epoch2_scratch`,
        )
      expect(await lines('emr_run0')).toContain(
        `target: ${db}_epoch2; scratch: ${db}_epoch2_scratch`,
      )
    } finally {
      if (previous === undefined) delete process.env.RFC398_URL
      else process.env.RFC398_URL = previous
      await f.close()
    }
  }, 120_000)
})
