// RFC-398 §2.2/7.6: the stale pre-read race in both orders, and a takeover between run return and
// verify. Split from rfc398-start-auto-upgrade.test.ts so each file fits a backend CI shard.
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { readPidFromLock } from '@/util/lock'
import { autoUpgradeFixture } from './helpers/rfc398AutoUpgrade'

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
