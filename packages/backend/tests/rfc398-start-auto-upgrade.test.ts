// RFC-398 §2.2/7.6: real daemon/child lifetime. The `start` cases are split across
// rfc398-start-auto-upgrade{,-barriers,-takeover,-signals,-retry}.test.ts so each file fits a
// backend CI shard (the combined file ran about 6.5 minutes; CI run 41287820486, shard 36/36).
import { expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { autoUpgradeFixture, businessRoundTrip } from './helpers/rfc398AutoUpgrade'
import { describeRfc398Postgresql, rfc398Postgresql } from './helpers/rfc398Postgresql'

test('start upgrades then boots; status is auto; receipt and business API survive restart', async () => {
  const f = await autoUpgradeFixture()
  try {
    const daemon = f.start({ AGENT_WORKFLOW_BUILD: 'rfc398-test-candidate' })
    await f.ready()
    expect(f.sessions()).toHaveLength(1)
    expect(f.sessions()[0]!.outcome).toBe('completed')
    expect(f.sessions()[0]!.records[0]!.data.candidateBuild).toBe('rfc398-test-candidate')
    const id = f.sessions()[0]!.operationId
    const receipt = JSON.parse(
      readFileSync(
        join(f.home, 'database-migrations/auto-upgrade/sessions', id, 'receipt.json'),
        'utf8',
      ),
    )
    expect(receipt.sourceFingerprint).toStartWith('sha256:')
    expect(receipt.backup).not.toBeNull()
    expect(receipt.phaseTimings.length).toBeGreaterThan(2)
    expect(existsSync(join(f.home, 'database-migrations/auto-upgrade/active.json'))).toBe(false)
    const status = f.spawn(['db', 'migration', 'status', id, '--json'])
    expect(await status.exited).toBe(0)
    expect(JSON.parse(status.output).mode).toBe('auto')
    await businessRoundTrip(f)
    daemon.process.kill('SIGTERM')
    await daemon.exited
    f.start()
    await f.ready()
    expect(f.sessions()).toHaveLength(1)
  } finally {
    await f.close()
  }
}, 180_000)

describeRfc398Postgresql('fresh PostgreSQL startup', () => {
  test('an empty configured database installs epoch 2 without allocating an automatic conversion session', async () => {
    const pg = await rfc398Postgresql()
    let f: Awaited<ReturnType<typeof autoUpgradeFixture>> | undefined
    try {
      const source = await pg.create()
      writeFileSync(
        join(pg.root, 'config.json'),
        JSON.stringify({ database: { provider: 'postgresql', urlEnv: 'RFC398_URL' } }),
      )
      f = await autoUpgradeFixture({ home: pg.root, env: { RFC398_URL: source.url } })
      f.start()
      await f.ready()
      expect(f.sessions()).toEqual([])
      expect(f.events().filter((e) => e.point === 'delegated')).toEqual([])
      expect(existsSync(join(pg.root, 'database-migrations/auto-upgrade/allocations'))).toBe(false)
      expect(
        JSON.parse(readFileSync(join(pg.root, 'database-generation.json'), 'utf8')).payload.version,
      ).toBe(2)
    } finally {
      await f?.close()
      await pg.close()
    }
  }, 180_000)
})

for (const manual of [true, false])
  test(`start ${manual ? 'manual mode' : 'blocked plan'} refuses without changing source`, async () => {
    const f = await autoUpgradeFixture({ manual, blocked: !manual })
    try {
      const before = readFileSync(join(f.home, 'db.sqlite'))
      const process = f.start()
      expect(await process.exited).toBe(1)
      expect(readFileSync(join(f.home, 'db.sqlite'))).toEqual(before)
      expect(existsSync(join(f.home, 'database-generation.json'))).toBe(false)
      expect(process.error).toContain(manual ? 'db migration plan' : 'acknowledge')
      expect(f.sessions()).toHaveLength(manual ? 0 : 1)
    } finally {
      await f.close()
    }
  }, 180_000)

test('migrate upgrades in process before native history, without a delegated auto child', async () => {
  const f = await autoUpgradeFixture()
  try {
    const command = f.spawn(['migrate'])
    expect(await command.exited).toBe(0)
    expect(f.sessions()[0]!.outcome).toBe('completed')
    expect(f.events().filter((e) => e.point === 'delegated')).toEqual([])
    expect(existsSync(join(f.home, '.daemon.lock'))).toBe(false)
    expect(f.journals()[0]!.payload.phase).toBe('verified')
  } finally {
    await f.close()
  }
}, 180_000)
