// RFC-159 T2 — buildStartTaskDeps reads LIVE config per-call.
//
// The scheduled-task scheduler builds StartTaskDeps via this factory so its fires
// behave identically to manual launches after a config edit (design.md finding 4):
// every call re-reads the config file rather than freezing values at daemon boot.
// Also locks the opencodeCmd/subagentLiveCapture conditional spreads that the JSON
// launch relied on (byte-equivalence).
import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../src/config'
import { describeEachProvider } from './helpers/eachProvider'
import { buildStartTaskDeps } from '../src/services/startTaskDeps'
import { createNoopSchedulerDriver } from './helpers/taskExecutionTestTopology'

function configWith(cfgPath: string, subagentLiveCapture: unknown): void {
  const base = loadConfig(cfgPath) // creates the file with defaults if missing
  writeFileSync(cfgPath, JSON.stringify({ ...base, subagentLiveCapture }, null, 2))
}

// RFC-359 AC-6（命名债清完后的下一刀）转双引擎：被测的 `buildStartTaskDeps` 只是把库句柄
// **原样透传**（用例自己就断言 `expect(withCmd.db).toBe(db)`），零方言、零 provider 分支。
// 它当年留在单引擎上没有任何机械理由，只是没人迁。
describeEachProvider('buildStartTaskDeps (RFC-159 T2)', (provider) => {
  test('passes db + actorUserId through; threads configPath (RFC-282 C1-2: the scheduler resolves)', () => {
    const db = provider.db
    const dir = mkdtempSync(join(tmpdir(), 'rfc159-deps-'))
    const cfgPath = join(dir, 'config.json')
    configWith(cfgPath, { pollMs: 999, consecutiveFailureLimit: 7 })

    const driver = createNoopSchedulerDriver()
    const withCmd = buildStartTaskDeps(db, driver, cfgPath, 'alice')
    expect(withCmd.db).toBe(db)
    expect(withCmd.actorUserId).toBe('alice')
    expect(withCmd.configPath).toBe(cfgPath)

    const noCmd = buildStartTaskDeps(db, driver, cfgPath, 'bob')
    expect(noCmd.actorUserId).toBe('bob')
    expect('opencodeCmd' in noCmd).toBe(false) // conditional spread: absent when omitted
  })

  test('reads subagentLiveCapture from LIVE config (re-read every call)', () => {
    const db = provider.db
    const dir = mkdtempSync(join(tmpdir(), 'rfc159-deps-'))
    const cfgPath = join(dir, 'config.json')

    configWith(cfgPath, { pollMs: 999, consecutiveFailureLimit: 7 })
    const driver = createNoopSchedulerDriver()
    expect(buildStartTaskDeps(db, driver, cfgPath, 'alice').subagentLiveCapture).toEqual({
      pollMs: 999,
      consecutiveFailureLimit: 7,
    })

    // Edit the config → the very next build reflects it (no boot-time freeze).
    configWith(cfgPath, { pollMs: 111, consecutiveFailureLimit: 2 })
    expect(buildStartTaskDeps(db, driver, cfgPath, 'alice').subagentLiveCapture).toEqual({
      pollMs: 111,
      consecutiveFailureLimit: 2,
    })
  })
})
