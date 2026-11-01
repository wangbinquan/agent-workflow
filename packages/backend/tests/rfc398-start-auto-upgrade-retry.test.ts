// RFC-398 §2.6 / AC-10: a failed verification rolls back, `start` refuses another attempt, and an
// explicit `--retry` opens a new session. Split from rfc398-start-auto-upgrade.test.ts so each file
// fits a backend CI shard.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { autoUpgradeFixture } from './helpers/rfc398AutoUpgrade'

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
