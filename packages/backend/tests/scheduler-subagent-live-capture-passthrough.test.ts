// RFC-048 — scheduler/runner passthrough source-level guard.
//
// Locks the data path that carries `config.subagentLiveCapture` from the
// HTTP / multipart route → StartTaskDeps → RunTaskOptions →
// runNode(opts.subagentLiveCapture). A runtime end-to-end already runs in
// runner-subagent-live-capture.test.ts; this file pins down the wire so a
// future refactor can't silently drop the field somewhere in the middle of
// the chain.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..', '..', '..')

function read(p: string): string {
  return readFileSync(resolve(REPO, p), 'utf-8')
}

describe('RFC-048 subagentLiveCapture passthrough', () => {
  test('task engine RunTaskOptions declares the field', () => {
    const src = read('packages/backend/src/services/execution/taskEngineRuntimeOptions.ts')
    expect(src).toContain(
      'subagentLiveCapture?: { pollMs: number; consecutiveFailureLimit: number }',
    )
  })

  test('scheduler forwards opts.subagentLiveCapture into runNode (every call site)', () => {
    const src =
      read('packages/backend/src/services/scheduler.ts') +
      read('packages/backend/src/modules/task-execution/composition/wrapperMechanics.ts') +
      read('packages/backend/src/modules/task-execution/composition/nodeMechanics.ts')
    const topology = read(
      'packages/backend/src/modules/task-execution/application/ports/taskExecutionTopology.ts',
    )
    const matches = src.match(/subagentLiveCapture: opts\.subagentLiveCapture/g) ?? []
    // RFC-060 PR-D added wrapper-fanout dispatch sites (dispatchFanoutShard +
    // dispatchFanoutAggregator); RFC-060 PR-E removed agent-multi's
    // runFanOutNode call site. RFC-164 added buildWorkgroupHooks.runHostNode.
    // Currently: agent-single + dispatchFanoutShard + dispatchFanoutAggregator
    // + workgroup runHostNode = 4. RFC-243 buildChildDeps 的第 5 处字面展开
    // 随 RFC-284 T20 收进 INHERITABLE_RUN_CONFIG_KEYS；RFC-331 再把 child resume
    // envelope 切成 buildChildRuntime.runConfig，下面同时锁登记、picker 与展开三段，
    // 保证子任务继承语义不变，计数仍是 4 个 runNode 直传点。
    expect(matches.length).toBe(4)
    expect(topology).toContain("'subagentLiveCapture',")
    expect(src).toContain('runConfig: pickInheritableRunConfig(state.opts)')
    expect(src).toContain('...runtime.runConfig')
  })

  test('StartTaskDeps declares the field and the coordinator freezes it once for every drive path', () => {
    const src = read('packages/backend/src/services/task.ts')
    expect(src).toContain(
      'subagentLiveCapture?: { pollMs: number; consecutiveFailureLimit: number }',
    )
    // RFC-332 folds the former three hand-written runTask spreads into one
    // coordinator construction. The resolved immutable runtime profile is the
    // sole hand-off, so start/resume/retry cannot drift independently.
    expect(src.match(/subagentLiveCapture: input\.deps\.subagentLiveCapture/g)).toHaveLength(1)
    expect(src).toContain('const runtime = resolveTaskDriveConfig({')
    expect(src).toContain('new DefaultTaskDriveCoordinator({\n    runtime,')
  })

  test('subagentLiveCapture is assembled into StartTaskDeps and every launch path carries it', () => {
    // RFC-159 T2: resolveSubagentLiveCapture + buildStartTaskDeps moved to
    // @/services/startTaskDeps (shared with the scheduled-task scheduler). The wire
    // is unchanged — buildStartTaskDeps resolves the value and conditionally spreads
    // it into StartTaskDeps.
    const deps = read('packages/backend/src/services/startTaskDeps.ts')
    expect(deps).toContain('function resolveSubagentLiveCapture(')
    expect(deps).toContain('...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {})')
    // tasks.ts carries it on every launch path: JSON via buildStartTaskDeps; multipart
    // (fallback + success) + resume + retry via the imported resolveSubagentLiveCapture.
    const src = read('packages/backend/src/routes/tasks.ts')
    expect(src).toMatch(
      /buildStartTaskDeps\(\s*deps\.db,\s*requireSchedulerDriver\(deps\.schedulerDriver\),\s*deps\.configPath,/,
    )
    const callCount = (src.match(/resolveSubagentLiveCapture\(deps\.configPath\)/g) ?? []).length
    expect(callCount).toBeGreaterThanOrEqual(3)
  })

  test('runner declares the option and falls back to compile-time defaults when omitted', () => {
    const src = read('packages/backend/src/services/runner.ts')
    expect(src).toContain(
      'subagentLiveCapture?: { pollMs: number; consecutiveFailureLimit: number }',
    )
    // The fallback chain — both literal defaults must be present so omitted
    // callers degrade to the same numbers the shared DEFAULT_SUBAGENT_LIVE_CAPTURE
    // const locks in.
    expect(src).toContain('opts.subagentLiveCapture?.pollMs ?? 1500')
    expect(src).toContain('opts.subagentLiveCapture?.consecutiveFailureLimit ?? 5')
  })
})
