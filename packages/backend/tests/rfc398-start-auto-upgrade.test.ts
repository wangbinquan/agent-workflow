// RFC-398 §2.2/7.6: real daemon/child lifetime, including the stale pre-read race in both orders.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readPidFromLock } from '@/util/lock'
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

for (const barrier of [
  'parent-gone',
  'takeover-before-rename',
  'lock-released-before-active-remove',
])
  test(`start waits while ${barrier}, including the absent/stale/complete lock windows`, async () => {
    const f = await autoUpgradeFixture()
    try {
      f.barriers(['run-returned', barrier])
      const parent = f.start()
      const event = await f.reached('run-returned')
      f.kill(parent.process.pid)
      await parent.exited
      if (barrier === 'lock-released-before-active-remove') f.release('run-returned')
      await f.reached(barrier, event.pid)
      const next = f.start()
      await f.reached('startup-waiting-upgrade', next.process.pid)
      expect(f.events().filter((e) => e.point === 'delegated')).toHaveLength(1)
      expect(existsSync(join(f.home, '.daemon.info'))).toBe(false)
      expect(readPidFromLock(join(f.home, '.daemon.lock'))).not.toBe(next.process.pid)
      f.release(barrier)
      f.release('run-returned')
      await f.ready()
      expect(f.sessions()).toHaveLength(1)
      expect(f.sessions()[0]!.outcome).toBe('completed')
    } finally {
      await f.close()
    }
  }, 240_000)

for (const order of ['before', 'after'] as const)
  test(`N read no active; C registers; P dies; N acquires ${order} takeover`, async () => {
    const f = await autoUpgradeFixture()
    try {
      f.barriers(['startup-before-lock'])
      const newcomer = f.start()
      await f.reached('startup-before-lock', newcomer.process.pid)
      f.barriers([
        `startup-before-lock@${newcomer.process.pid}`,
        'delegated',
        'parent-gone',
        'takeover-acquired',
        'run-returned',
      ])
      const parent = f.start()
      const child = await f.reached('delegated')
      // Delegation has been validated. Child is paused before its parent watcher starts.
      f.kill(parent.process.pid)
      await parent.exited
      f.release('delegated')
      await f.reached('parent-gone', child.pid)
      if (order === 'after') {
        f.release('parent-gone')
        await f.reached('takeover-acquired', child.pid)
      }
      f.release('startup-before-lock')
      await f.reached('startup-waiting-upgrade', newcomer.process.pid)
      expect(readPidFromLock(join(f.home, '.daemon.lock'))).not.toBe(newcomer.process.pid)
      expect(f.events().filter((e) => e.point === 'delegated')).toHaveLength(1)
      f.release('parent-gone')
      f.release('takeover-acquired')
      f.release('run-returned')
      await f.ready()
      expect(f.sessions()).toHaveLength(1)
    } finally {
      await f.close()
    }
  }, 240_000)

test('takeover between run return and verify still verifies and writes the receipt', async () => {
  const f = await autoUpgradeFixture()
  try {
    f.barriers(['run-returned', 'takeover-acquired'])
    const p = f.start()
    const c = await f.reached('run-returned')
    f.kill(p.process.pid)
    await p.exited
    await f.reached('takeover-acquired', c.pid)
    expect(f.events().some((e) => e.point === 'verify-called')).toBe(false)
    f.release('takeover-acquired')
    f.release('run-returned')
    await f.wait(() => (f.sessions()[0]?.outcome === 'completed' ? true : null))
    expect(f.events().filter((e) => e.point === 'verify-called')).toHaveLength(1)
    expect(f.journals()[0]!.payload.phase).toBe('verified')
  } finally {
    await f.close()
  }
}, 240_000)

test('verification failure rolls back, start refuses another attempt, explicit retry opens a new session', async () => {
  const f = await autoUpgradeFixture()
  try {
    const original = readFileSync(join(f.home, 'db.sqlite'))
    f.flag('negative-health')
    expect(await f.start().exited).toBe(1)
    expect(f.sessions()[0]!.outcome).toBe('failed')
    expect(f.journals()[0]!.payload.status).toBe('rolled-back')
    expect(readFileSync(join(f.home, 'db.sqlite'))).toEqual(original)
    f.flag('negative-health', false)
    const refused = f.start()
    expect(await refused.exited).toBe(1)
    expect(refused.error).toContain('--retry')
    expect(f.sessions()).toHaveLength(1)
    const retry = f.spawn(['db', 'migration', 'auto', '--retry', '--json'])
    expect(await retry.exited).toBe(0)
    expect(f.sessions().map((s) => s.outcome)).toEqual(['failed', 'completed'])
    expect(f.journals()).toHaveLength(2)
    f.start()
    await f.ready()
  } finally {
    await f.close()
  }
}, 240_000)

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  test(`start forwards ${signal} and waits for child exit`, async () => {
    const f = await autoUpgradeFixture()
    try {
      f.barriers(['intent'])
      const p = f.start()
      await f.reached('intent')
      p.process.kill(signal)
      expect(await p.exited).not.toBe(0)
      f.release('intent')
      f.start()
      await f.ready()
      expect(f.sessions()).toHaveLength(1)
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
