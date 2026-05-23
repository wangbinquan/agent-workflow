// RFC-061 PR-B T9-extra — ProductionRunnerAdapter scaffold tests.
//
// The production adapter is intentionally a throw-on-use stub until
// the T10/T11 cutover wires it to services/runner.ts. These tests
// lock that contract: methods throw with a clear NOT_YET_WIRED message
// pointing at the file header's integration checklist.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb } from '../src/db/client'
import {
  ProductionRunnerAdapter,
  createProductionRunnerAdapter,
} from '../src/scheduler-v2/runnerAdapterProduction'
import { WakeQueue } from '../src/scheduler-v2/wakeQueue'
import type { SpawnRequest } from '../src/scheduler-v2/taskActorTick'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function makeAdapter(): ProductionRunnerAdapter {
  return createProductionRunnerAdapter({
    db: createInMemoryDb(MIGRATIONS),
    worktreePath: '/tmp/wt',
    appHome: '/tmp/aw',
    wakeProducer: new WakeQueue('t1'),
  })
}

describe('ProductionRunnerAdapter (scaffold)', () => {
  test('implements RunnerAdapter interface (compile-time shape)', () => {
    const a = makeAdapter()
    expect(typeof a.spawn).toBe('function')
    expect(typeof a.cancel).toBe('function')
  })

  test('spawn throws NOT_YET_WIRED with file-header pointer', async () => {
    const a = makeAdapter()
    const req: SpawnRequest = {
      scope: { nodeId: 'n', loopIter: 0, shardKey: '', iter: 0 },
      attemptId: 'att_x',
      prompt: 'p',
      agentName: 'mAlice',
    }
    await expect(a.spawn(req)).rejects.toThrow(/T10\/T11 cutover/)
  })

  test('cancel throws NOT_YET_WIRED with file-header pointer', async () => {
    const a = makeAdapter()
    await expect(a.cancel('att_x', 'test')).rejects.toThrow(/T10\/T11 cutover/)
  })

  test('factory returns a ProductionRunnerAdapter instance', () => {
    const a = makeAdapter()
    expect(a).toBeInstanceOf(ProductionRunnerAdapter)
  })
})
