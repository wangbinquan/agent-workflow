// RFC-398 §2.2/7.6: `start` forwards SIGINT / SIGTERM to the upgrade child and waits for it; the
// next `start` resumes the same session. Split from rfc398-start-auto-upgrade.test.ts so each file
// fits a backend CI shard.
import { expect, test } from 'bun:test'
import { autoUpgradeFixture } from './helpers/rfc398AutoUpgrade'

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
