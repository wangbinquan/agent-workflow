// RFC-464 — 无实时捕获按缺席处理、intent 自持轮次事件 sink 合同（RFC-294 W9-D 第十一步）。
//
// 锁三件事：
// ① task-execution 的 `taskAgentRun` 不再借 opencode 驱动的 no-op 句柄去补 runtime-management 合同里的可选能力：不取 `@/services/runtime`、
//    源码不含 `NOOP_HANDLE`，两处 stop 是可选调用，会话捕获的去重表只在有句柄时带上（census AST + 源码锚点，带负对照）。
// ② intent 的 application 层零取 `@/services/`；系统代理运行端口不再反取 application 层的 sink 类，`eventSink` 是端口自己声明的接口。
// ③ intent 声明的 sink 合同与 runtime-management 的会话事件 sink 是同一份：联合类型双向相等，四个成员按严格函数类型可互换（方法写法是双变的，
//    单靠赋值检查锁不住参数收窄）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type {
  IntentTurnCaptureIncompleteReason,
  IntentTurnCaptureTerminalState,
  IntentTurnEventSink,
  IntentTurnObservedEvent,
} from '@/modules/intent/application/ports/intentSystemAgent'
import type {
  SessionCaptureIncompleteReason,
  SessionCaptureTerminalState,
  SessionEventSource,
  SystemAgentEventSinkV1,
} from '@/modules/runtime-management/application/ports/agentSessionEvents'
import type { IntentTurnSessionEventSink } from '@/modules/intent/application/turnSession'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TASK_AGENT_RUN = join(SRC, 'modules/task-execution/application/taskAgentRun.ts')
const INTENT_PORT = join(SRC, 'modules/intent/application/ports/intentSystemAgent.ts')
const slash = (path: string) => path.split('\\').join('/')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

const specifiersOf = (path: string) => {
  const unit = sourceUnit(slash(relative(REPO_ROOT, path)), readFileSync(path, 'utf8'))
  return [...new Set(importEdges(unit).map((edge) => edge.specifier))]
}

describe('RFC-464 —— 无实时捕获按缺席处理', () => {
  const src = readFileSync(TASK_AGENT_RUN, 'utf8')

  test('taskAgentRun 不取 @/services/runtime，源码不含 NOOP_HANDLE', () => {
    expect(specifiersOf(TASK_AGENT_RUN)).not.toContain('@/services/runtime')
    expect(src).not.toContain('NOOP_HANDLE')
  })

  test('起捕获是可选调用、两处 stop 是可选调用，去重表只在有句柄时带上', () => {
    expect(src).toContain('const livePoller = materialEvidence.startLiveCapture?.({')
    expect(src).toContain('spawnedCleanupHooks.push(() => livePoller?.stop())')
    expect(src).toContain('liveCtrl.abort()\n    livePoller?.stop()')
    expect(src).not.toMatch(/livePoller\.stop\(\)/)
    expect(src).toContain(
      '...(livePoller === undefined\n              ? {}\n              : { alreadyInsertedPartIds: livePoller.stats().insertedPartIdsBySession }),',
    )
  })

  test('负对照：判据认得出经 services/runtime 取的写法', () => {
    const probe = sourceUnit(
      'packages/backend/src/modules/task-execution/application/probe.ts',
      "import { NOOP_HANDLE } from '@/services/runtime'\n",
    )
    expect(importEdges(probe).map((edge) => edge.specifier)).toEqual(['@/services/runtime'])
  })
})

describe('RFC-464 —— intent 自持轮次事件 sink 合同', () => {
  test('intent 的 application 层零取 @/services/', () => {
    const offenders = walk(join(SRC, 'modules/intent/application')).flatMap((path) =>
      specifiersOf(path)
        .filter((specifier) => specifier.startsWith('@/services/'))
        .map((specifier) => `${slash(relative(SRC, path))} -> ${specifier}`),
    )
    expect(offenders).toEqual([])
  })

  test('系统代理运行端口不再反取 application 层的 sink 类', () => {
    const specifiers = specifiersOf(INTENT_PORT)
    expect(specifiers).not.toContain('../turnSession')
    expect(specifiers).toContain('./intentPersistence')
    expect(readFileSync(INTENT_PORT, 'utf8')).toContain(
      '  readonly eventSink?: IntentTurnEventSink\n',
    )
  })

  test('与 runtime-management 的会话事件 sink 是同一份合同（编译期）', () => {
    type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
    const terminal: Same<IntentTurnCaptureTerminalState, SessionCaptureTerminalState> = true
    const reason: Same<IntentTurnCaptureIncompleteReason, SessionCaptureIncompleteReason> = true
    const source: Same<IntentTurnObservedEvent['source'], SessionEventSource> = true
    // Strict function types (members as function-typed values): every event / state the runner sends,
    // the intent sink accepts — and the intent sink is a complete runner sink.
    type Fn<T> = T extends (...args: infer A) => infer R ? (...args: A) => R : never
    const append: Fn<SystemAgentEventSinkV1['append']> = null as unknown as Fn<
      IntentTurnEventSink['append']
    >
    const terminalFn: Fn<SystemAgentEventSinkV1['markTerminal']> = null as unknown as Fn<
      IntentTurnEventSink['markTerminal']
    >
    const root: Fn<SystemAgentEventSinkV1['setRootSessionId']> = null as unknown as Fn<
      IntentTurnEventSink['setRootSessionId']
    >
    const reset: Fn<NonNullable<SystemAgentEventSinkV1['markRootSessionResetPending']>> =
      null as unknown as Fn<NonNullable<IntentTurnEventSink['markRootSessionResetPending']>>
    const sink: SystemAgentEventSinkV1 = null as unknown as IntentTurnSessionEventSink
    expect([terminal, reason, source]).toEqual([true, true, true])
    expect([append, terminalFn, root, reset, sink].every((value) => value === null)).toBe(true)
  })
})
