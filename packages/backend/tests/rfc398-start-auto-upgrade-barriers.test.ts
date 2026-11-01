// RFC-398 §2.2/7.6: a second `start` only waits while the parent is gone, the child takes over, or
// the lock is released before active.json is removed. Split from rfc398-start-auto-upgrade.test.ts
// so each file fits a backend CI shard.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readPidFromLock } from '@/util/lock'
import { autoUpgradeFixture } from './helpers/rfc398AutoUpgrade'

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
