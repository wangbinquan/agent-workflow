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
    // `process.stderr.write` 而不是 `console.error`：后者在 `FORCE_COLOR` 生效时
    // 会给输出裹上 ANSI（Bun 的 console 会上色），于是 stderr 变成
    // `\u001B[0m\u001B[31mfixture failed\u001B[0m`，这条子串断言当场碎掉。
    // 实撞于 2026-08-24：某些终端 / CI 包装器（Claude Code 会设 FORCE_COLOR=3）
    // 把该变量传给子进程，本地一跑就红，而裸终端里绿——典型的「重跑就过了」形状。
    // 断言的意图是「非零退出会把 stderr 带出来」，与上不上色无关，故改用不上色的写法。
    await expect(
      runTestCommand(
        [process.execPath, '-e', 'process.stderr.write("fixture failed"); process.exit(7)'],
        {
          timeoutMs: 2_000,
          label: 'failure probe',
        },
      ),
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
