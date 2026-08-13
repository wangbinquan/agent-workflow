import { describe, expect, test } from 'bun:test'
import { JS_TIMER_MAX_MS } from '@agent-workflow/shared'
import { runManagedProcess } from '../src/services/execution/managedProcess'

describe('Settings timeout consumer boundary', () => {
  test('an overflowing timeout is rejected before spawning a child', async () => {
    let spawned = false
    const result = await runManagedProcess({
      argv: ['this-command-must-not-run'],
      cwd: process.cwd(),
      env: {},
      timeoutMs: JS_TIMER_MAX_MS + 1,
      onSpawned: () => {
        spawned = true
      },
    })

    expect(spawned).toBe(false)
    expect(result).toMatchObject({
      outcome: 'spawn-failed',
      pid: null,
      spawnError: `timeoutMs must be an integer from 0 to ${JS_TIMER_MAX_MS}`,
    })
  })
})
