// RFC-412: the automatic commit&push tail and the read-only member inspection run on ports the composition binds
// over the execution state. These cases lock the binding (facts and configuration read from the current state, the
// commit session carries exactly the task-level run fields the scheduler passed, the commit runner receives the
// task's persistence and one workspace factory) and drive the inspection engine through fabricated ports.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  createAutoCommitPushPorts,
  createReadonlyInspectionPorts,
} from '@/modules/task-execution/composition/commitPushBinding'
import type { TaskMechanicsState } from '@/modules/task-execution/composition/taskMechanicsState'
import { inspectReadonlyRepos } from '@/modules/task-execution/engine/task/readonlyInspection'

const log = { info() {}, warn() {}, error() {}, debug() {}, child: () => log } as never

function state() {
  const calls: unknown[] = []
  const raw = {
    task: { id: 'task-1' },
    repos: [{ ordinal: 0, readonly: true, worktreePath: '/wt', repoPath: '/repo', mountPath: '' }],
    repoGroupName: null as string | null,
    opts: {
      signal: undefined as AbortSignal | undefined,
      executionContext: undefined as unknown,
      commitPushLang: 'zh-CN' as string | undefined,
      commitPushMaxRepairRetries: 2 as number | undefined,
      persistence: {
        scheduler: {
          recordReadonlyDirty: async (input: unknown) => {
            calls.push(input)
          },
        },
      },
    },
  }
  return { raw, calls, state: raw as unknown as TaskMechanicsState }
}

test('the commit&push ports read the task facts and configuration from the current state', () => {
  const { raw, state: current } = state()
  const ports = createAutoCommitPushPorts(current)
  expect(ports.task).toBe(raw.task as never)
  expect(ports.repos).toBe(raw.repos as never)
  expect(ports.config.commitPushLang).toBe('zh-CN')
  raw.opts.commitPushLang = 'en-US'
  expect(ports.config.commitPushLang).toBe('en-US')
  expect(ports.config.commitPushMaxRepairRetries).toBe(2)
  expect(ports.signal).toBeUndefined()
  const controller = new AbortController()
  raw.opts.signal = controller.signal
  expect(ports.signal).toBe(controller.signal)
  raw.repoGroupName = 'group-a'
  expect(ports.repoGroupName).toBe('group-a')
})

test('the commit session and the commit runner receive exactly the fields the scheduler passed', () => {
  const binding = readFileSync(
    resolve(import.meta.dir, '../src/modules/task-execution/composition/commitPushBinding.ts'),
    'utf8',
  )
  const runAgent = binding.slice(
    binding.indexOf('runAgent: (request, launch) =>'),
    binding.indexOf('commitAgent: {'),
  )
  for (const field of [
    'observationInvocations: state.opts.observationInvocations,',
    'memorySnapshots: state.opts.memorySnapshots,',
    'memoryInjectionQueries: state.opts.memoryInjectionQueries,',
    'runtimeSessionLeases: state.opts.runtimeSessionLeases,',
    'runtimeRegistry: state.opts.runtimeRegistry,',
    'persistence: state.opts.persistence,',
    '...(state.opts.signal ? { signal: state.opts.signal } : {}),',
  ])
    expect(runAgent).toContain(field)
  expect(runAgent).not.toContain('subagentLiveCapture')
  const runner = binding.slice(binding.indexOf('runCommitPush: (request, deps) =>'))
  for (const field of [
    'nodeRuns: state.opts.persistence.nodeRuns,',
    'nodeExecution: state.opts.persistence.nodeExecution,',
    'effects: state.opts.persistence.effects,',
    'repositoryGitWorkspaces,',
  ])
    expect(runner).toContain(field)
})

test('the inspection records a modified read-only member through its ports and skips writable ones', async () => {
  const recorded: unknown[] = []
  const repos = [
    { ordinal: 0, readonly: true, worktreePath: '/wt-a', repoPath: '/a', mountPath: '' },
    { ordinal: 1, readonly: false, worktreePath: '/wt-b', repoPath: '/b', mountPath: 'b' },
  ]
  const statuses: string[] = []
  await inspectReadonlyRepos(
    {
      taskId: 'task-1',
      repos: repos as never,
      execution: undefined,
      statusPorcelain: async (repo) => {
        statuses.push(repo.worktreePath)
        return { stdout: ' M file.txt\n?? other.txt\n' }
      },
      recordReadonlyDirty: async (input) => {
        recorded.push(input)
      },
    },
    log,
  )
  expect(statuses).toEqual(['/wt-a'])
  expect(recorded).toEqual([
    { taskId: 'task-1', repoIndex: 0, changedCount: 2, now: expect.any(Number) },
  ])
})

test('the inspection ports forward the record and read the execution context on use', async () => {
  const { raw, calls, state: current } = state()
  const ports = createReadonlyInspectionPorts(current)
  expect(ports.taskId).toBe('task-1')
  expect(ports.execution).toBeUndefined()
  raw.opts.executionContext = { sentinel: 'context-1' }
  expect(ports.execution).toEqual({ sentinel: 'context-1' } as never)
  await ports.recordReadonlyDirty({ taskId: 'task-1', repoIndex: 0, changedCount: 1, now: 1 })
  expect(calls).toEqual([{ taskId: 'task-1', repoIndex: 0, changedCount: 1, now: 1 }])
})
