// Regression for the Ubuntu coverage hang observed after commit 36a72b92:
// a synchronous fixture command can freeze bun:test before its timeout hooks
// run. The shared test boundary must stay asynchronous and reap timed-out
// children instead of merely rejecting while they continue in the background.

import { describe, expect, test } from 'bun:test'
import { runTestCommand } from './helpers/testCommand'

describe('bounded asynchronous test command boundary', () => {
  test('returns stdout for a successful child', async () => {
    const stdout = await runTestCommand([process.execPath, '-e', 'process.stdout.write("ready")'], {
      timeoutMs: 2_000,
    })

    expect(stdout).toBe('ready')
  })

  test('surfaces non-zero exits with bounded stderr', async () => {
    await expect(
      runTestCommand([process.execPath, '-e', 'console.error("fixture failed"); process.exit(7)'], {
        timeoutMs: 2_000,
        label: 'failure probe',
      }),
    ).rejects.toThrow('failure probe exited with code 7: fixture failed')
  })

  test('kills, reaps, and reports a child that crosses its deadline', async () => {
    const startedAt = Date.now()

    await expect(
      runTestCommand([process.execPath, '-e', 'await Bun.sleep(60_000)'], {
        timeoutMs: 100,
        label: 'hang probe',
      }),
    ).rejects.toThrow('hang probe timed out after 100ms')
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })
})
