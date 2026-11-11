import type { TaskNodeOutputReads, TaskNodeRunReads } from '@/modules/task-execution/public/types'
// RFC-461 — application 层的 WS 推送改经端口、运行时类型改取 owner 的出口（RFC-294 W9-D 第八步）。
//
// 锁四件事：
// ① task-execution `taskAgentRun`、memory 蒸馏与调度不再取 `@/ws/broadcaster`；三个类型文件不再经 `services/` 转手；memory 的
//    application 层零取 `@/services/` 与 `@/ws/`（census AST）。
// ② `taskAgentRun` 的三处 `node.status: running` 都经端口包的 `status`；生产的三个端口包构造处接的就是 infrastructure 的
//    `broadcastNodeStatus`，它发出的消息与原来的字面量相同（同频道、`id: -1`）。
// ③ memory 工作存储的 `events` 把两类消息原样发到原来的两个频道。
// ④ 端口包构造仍不读任何选项（native 兼容路径的「构造不做 IO」不变）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { MemoryDistillJobWsMessage, MemoryWsMessage } from '@agent-workflow/shared'
import {
  MEMORY_CHANNEL,
  MEMORY_DISTILL_JOB_CHANNEL,
  TASK_CHANNEL,
  memoryBroadcaster,
  memoryDistillJobBroadcaster,
  taskBroadcaster,
} from '@/ws/broadcaster'
import { broadcastNodeStatus } from '@/modules/task-execution/infrastructure/nodeStatusEvents'
import { bindNativeTaskAgentRunPurpose } from '@/modules/task-execution/infrastructure/local/nativeTaskAgentRun'
import type { RunNodeOptions } from '@/modules/task-execution/infrastructure/local/nativeTaskAgentRunOptions'
import { DrizzleMemoryDistillWorkStore } from '@/modules/memory/infrastructure/memoryDistillWorkStore'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { ClarifyAnswerQueries } from '@/modules/collaboration/public/queries'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const slash = (path: string) => path.split('\\').join('/')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

const specifiersOf = (path: string) =>
  [
    ...new Set(
      importEdges(sourceUnit(slash(relative(REPO_ROOT, path)), readFileSync(path, 'utf8'))).map(
        (edge) => edge.specifier,
      ),
    ),
  ].sort()

const TASK_AGENT_RUN = join(SRC, 'modules/task-execution/application/taskAgentRun.ts')
const DISTILLER = join(SRC, 'modules/memory/application/distill/memoryDistiller.ts')
const SCHEDULE = join(SRC, 'modules/memory/application/distill/schedule.ts')
const DISTILL_WORK_STORE = join(SRC, 'modules/memory/application/ports/distillWorkStore.ts')
const AGENT_SESSION_EVENTS = join(
  SRC,
  'modules/runtime-management/application/ports/agentSessionEvents.ts',
)

describe('RFC-461 —— application 层不再直推 WS、不再经 services/ 转手类型', () => {
  test('三个推送文件不取 @/ws/broadcaster，三个类型文件不取 services/ 的运行时类型与会话 sink', () => {
    for (const path of [TASK_AGENT_RUN, DISTILLER, SCHEDULE])
      expect([path, specifiersOf(path).includes('@/ws/broadcaster')]).toEqual([path, false])
    for (const path of [DISTILLER, DISTILL_WORK_STORE, AGENT_SESSION_EVENTS])
      expect([
        path,
        specifiersOf(path).filter(
          (s) => s === '@/services/runtime/types' || s === '@/services/sessionEventSink',
        ),
      ]).toEqual([path, []])
    expect(specifiersOf(AGENT_SESSION_EVENTS)).toContain('./agentObservations')
  })

  test('memory 的 application 层零取 @/services/ 与 @/ws/', () => {
    const offenders = walk(join(SRC, 'modules/memory/application')).flatMap((path) =>
      specifiersOf(path)
        .filter((s) => s.startsWith('@/services/') || s.startsWith('@/ws/'))
        .map((s) => `${slash(relative(SRC, path))} -> ${s}`),
    )
    expect(offenders).toEqual([])
  }, 30_000)

  test('负对照：判据认得出直取 broadcaster 与 services/ 的写法', () => {
    const probe = sourceUnit(
      'packages/backend/src/modules/memory/application/probe.ts',
      "import { memoryBroadcaster } from '@/ws/broadcaster'\nimport type { X } from '@/services/sessionEventSink'\n",
    )
    expect(importEdges(probe).map((edge) => edge.specifier)).toEqual([
      '@/ws/broadcaster',
      '@/services/sessionEventSink',
    ])
  })
})

describe('RFC-461 —— agent 运行的 node.status 经端口包', () => {
  test('三处 running ping 都经 purpose.status，没有别的 taskBroadcaster', () => {
    const text = readFileSync(TASK_AGENT_RUN, 'utf8')
    const ping =
      "purpose.status.broadcastNodeStatus(opts.taskId, opts.nodeRunId, opts.nodeId, 'running')"
    expect(text.split(ping).length - 1).toBe(3)
    expect(text).not.toContain('taskBroadcaster')
  })

  test('生产的端口包接 infrastructure 的 broadcastNodeStatus，构造仍不读任何选项', () => {
    const noRead = (): never => {
      throw new Error('premature native options read')
    }
    const purpose = bindNativeTaskAgentRunPurpose(new Proxy({} as RunNodeOptions, { get: noRead }))
    expect(purpose.status.broadcastNodeStatus).toBe(broadcastNodeStatus)
  })

  test('broadcastNodeStatus 发出的就是原来的 node.status 字面量', () => {
    const received: unknown[] = []
    const unsubscribe = taskBroadcaster.subscribe(TASK_CHANNEL('rfc461-task'), (msg) =>
      received.push(msg),
    )
    try {
      broadcastNodeStatus('rfc461-task', 'run-1', 'node-1', 'running')
    } finally {
      unsubscribe()
    }
    expect(received).toEqual([
      { id: -1, type: 'node.status', nodeRunId: 'run-1', nodeId: 'node-1', status: 'running' },
    ])
  })
})

describe('RFC-461 —— memory 工作存储的 events 发到原来的频道', () => {
  test('候选记忆消息与蒸馏作业消息原样到达', () => {
    const store = new DrizzleMemoryDistillWorkStore(
      {} as PersistenceDb,
      {} as ClarifyAnswerQueries,
      {} as TaskNodeRunReads,
      {} as TaskNodeOutputReads,
      () => {
        throw new Error('the session sink is not used here')
      },
    )
    const memories: MemoryWsMessage[] = []
    const jobs: MemoryDistillJobWsMessage[] = []
    const offMemories = memoryBroadcaster.subscribe(MEMORY_CHANNEL, (msg) => memories.push(msg))
    const offJobs = memoryDistillJobBroadcaster.subscribe(MEMORY_DISTILL_JOB_CHANNEL, (msg) =>
      jobs.push(msg),
    )
    const memory: MemoryWsMessage = { type: 'memory.deleted', memoryId: 'rfc461-memory' }
    const job: MemoryDistillJobWsMessage = {
      type: 'distill.queued',
      jobId: 'rfc461-job',
      debounceKey: 'rfc461-key',
    }
    try {
      store.events.memory(memory)
      store.events.distillJob(job)
    } finally {
      offMemories()
      offJobs()
    }
    expect(memories).toEqual([memory])
    expect(jobs).toEqual([job])
  })
})
