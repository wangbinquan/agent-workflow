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
    const src = read(
      'packages/backend/src/modules/task-execution/composition/taskEngineRuntimeOptions.ts',
    )
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
    // RFC-359 AC-1（plan §5hn 批次二 ⑤）：`sqliteChildExecutionLaunchOperations.ts` 已随
    // 子任务启动合一删除，两个引擎共用 `childExecutionLaunchOperations.ts`。
    // 这份清单锁的是「每一条子启动路都把 runConfig 透传下去」，少一个文件不代表少一条路。
    const childLaunchAdapters = [
      'packages/backend/src/modules/task-execution/infrastructure/taskExecutionRuntimeParticipants.ts',
      'packages/backend/src/modules/task-execution/infrastructure/childTaskLifecycleParticipant.ts',
      'packages/backend/src/modules/task-execution/infrastructure/childExecutionLaunchOperations.ts',
    ]
      .map(read)
      .join('\n')
    expect(childLaunchAdapters).toMatch(/\.\.\.(?:input|request)\.runtime\.runConfig/)
    expect(childLaunchAdapters).toContain('resolveTaskDriveConfig(request.runtime.runConfig)')
  })

  test('StartTaskDeps declares the field and the coordinator freezes it once for every drive path', () => {
    const src = read('packages/backend/src/services/task.ts')
    expect(src).toContain(
      'subagentLiveCapture?: { pollMs: number; consecutiveFailureLimit: number }',
    )
    // RFC-332 folds the former three hand-written runTask spreads into one
    // coordinator construction. The resolved immutable runtime profile is the
    // sole hand-off, so start/resume/retry cannot drift independently.
    // 2026-09-19：解析体里把 `input.deps` 与 refresher 合成局部 `deps` 之后，这个旋钮的
    // 唯一 spread 点改名为 `deps.subagentLiveCapture`。判据意图不变——**只能有一处**。
    expect(src.match(/subagentLiveCapture: deps\.subagentLiveCapture/g)).toHaveLength(1)
    // 2026-09-19 改锚（意图不变）：解析点仍然只有一处，但它从「构造时解析一次」变成
    // 「每次 drive 现读一次」——长驻协调器（daemon 的路由启动）把配置冻在 boot 那一刻，
    // 会让设置页改完默认运行时之后的新任务照旧按老档案派发（e2e CFG-45）。判据仍钉
    // 「唯一解析点」这一点：`resolveRuntime()` 只有一个定义，协调器只从它取值。
    expect(src).toContain('const resolveRuntime = (): taskDriveComposition.ResolvedTaskDriveConfig')
    expect(src.match(/return resolveTaskDriveConfig\(\{/g)).toHaveLength(1)
    expect(src).toContain('return frozen ?? resolveRuntime()')
    // 构造时解析一次的旧形状不许回来。
    expect(src).not.toContain('const runtime = resolveTaskDriveConfig({')
  })

  test('bootstrap assembles subagentLiveCapture while the route stays provider-neutral', () => {
    // RFC-159 T2: resolveSubagentLiveCapture + buildStartTaskDeps moved to
    // @/services/startTaskDeps (shared with the scheduled-task scheduler). The wire
    // is unchanged — buildStartTaskDeps resolves the value and conditionally spreads
    // it into StartTaskDeps.
    const deps = read('packages/backend/src/services/startTaskDeps.ts')
    expect(deps).toContain('function resolveSubagentLiveCapture(')
    expect(deps).toContain('...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {})')
    // RFC-359 AC-1（2026-09-17，plan §5hn 批次二 ①②）：`services/scheduleLaunch.ts` 已删除；
    // 两个组合根仍各自 `buildStartTaskDeps(...)`，本条判据面不变。
    const assembly = ['packages/backend/src/server.ts', 'packages/backend/src/cli/start.ts']
      .map(read)
      .join('\n')
    expect(assembly).toContain('buildStartTaskDeps(')

    // RFC-359 AC-1（plan §5hn 批次二 ⑥⑦）改锚：multipart 那条路原本自己
    // `resolveSubagentLiveCapture(deps.configPath)` 一次、喂给两条交接
    //（`services/multipartTaskStart.ts`，已整份删除）。它现在与 PostgreSQL 共用启动参与者，
    // 这个旋钮随协调器的依赖束走（`buildStartTaskDeps` / `resolveLaunchRuntimeConfig`），
    // 装配方解析一次交给协调器——路由仍然一个字都不自解析（下面那条负锁不变）。
    const startTaskDeps = read('packages/backend/src/services/startTaskDeps.ts')
    expect(startTaskDeps).toContain('resolveSubagentLiveCapture(configPath)')
    const route = read('packages/backend/src/routes/tasks.ts')
    expect(route).not.toContain('DbClient')
    expect(route).not.toContain('buildStartTaskDeps(')
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
