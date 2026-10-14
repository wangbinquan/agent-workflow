// RFC-371 v2 §4 (design/RFC-371-run-observability/redesign-v2-20261014.md):
// the shared write path of runtime calls. A system-agent call is accepted before
// its process starts (a failed acceptance prevents the start), stdout usage is
// written in place at most once per USAGE_FLUSH_INTERVAL_MS, the final snapshot
// prefers the driver's native summary, the call ends exactly once with its
// mapped status, and system calls carry their kind, parent task and owner.
import { expect, test } from 'bun:test'
import {
  USAGE_FLUSH_INTERVAL_MS,
  callStatusOfNodeRun,
  createCallUsageWriter,
} from '@/modules/task-execution/application/callUsageWriter'
import {
  createSystemAgentUsageCapture,
  systemCallStatus,
} from '@/modules/task-execution/application/systemAgentUsageCapture'
import type { AgentInvocationBinding } from '@/modules/task-execution/application/ports/agentInvocation'
import type { SystemAgentObservationRun } from '@/modules/task-execution/application/ports/systemAgentObservation'
import { composeSystemAgentObservations } from '@/modules/task-execution/composition/systemAgentObservations'
import type {
  RuntimeUsageMeter,
  RuntimeUsageSnapshot,
} from '@/modules/runtime-management/public/participants'
import type {
  CallObservationStart,
  CallObservations,
} from '@/modules/run-observability/public/participants'
import type { Logger } from '@/util/log'

function meterWith(finish?: () => RuntimeUsageSnapshot | null) {
  let input = 0
  const events: unknown[] = []
  const meter: RuntimeUsageMeter = {
    observe(event) {
      events.push(event)
      if (typeof event.tokens !== 'number') return false
      input += event.tokens
      return true
    },
    snapshot: () => ({
      state: 'partial',
      models: [{ model: 'm', input, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }],
    }),
    ...(finish ? { finish } : {}),
  }
  return { meter, events }
}

function logger() {
  const warnings: string[] = []
  const log = {
    debug() {},
    info() {},
    warn: (message: string) => warnings.push(message),
    error() {},
    child() {
      return log
    },
  } as unknown as Logger
  return { log, warnings }
}

const line = (value: unknown) => JSON.stringify(value)

test('stdout usage is written in place at most once per interval', async () => {
  const clock = { value: 10_000 }
  const writes: number[] = []
  const { meter, events } = meterWith()
  const writer = createCallUsageWriter({
    meter,
    write: async (snapshot) => {
      writes.push(snapshot.models[0]!.input)
    },
    log: logger().log,
    callId: 'c1',
    now: () => clock.value,
  })
  writer.observeLine('not json')
  writer.observeLine('[1, 2]')
  writer.observeLine(line({ type: 'text' }))
  await writer.flush()
  expect(writes).toEqual([])

  writer.observeLine(line({ tokens: 5 }))
  await writer.flush()
  expect(writes).toEqual([5])
  writer.observeLine(line({ tokens: 7 }))
  clock.value += USAGE_FLUSH_INTERVAL_MS - 1
  await writer.flush()
  expect(writes).toEqual([5])
  clock.value += 1
  await writer.flush()
  expect(writes).toEqual([5, 12])
  // A forced flush (end of a chunk before the final write) ignores the interval.
  writer.observeLine(line({ tokens: 1 }))
  await writer.flush(true)
  expect(writes).toEqual([5, 12, 13])
  // Unchanged snapshots are never rewritten.
  await writer.flush(true)
  expect(writes).toEqual([5, 12, 13])
  // Malformed and non-object lines never reach the meter.
  expect(events).toHaveLength(4)
})

test('a failed write is logged, never thrown; the final snapshot prefers the native summary', async () => {
  const { log, warnings } = logger()
  const failing = createCallUsageWriter({
    meter: meterWith(() => ({ state: 'complete', models: [] })).meter,
    write: async () => {
      throw new Error('database unavailable')
    },
    log,
    callId: 'c1',
  })
  failing.observeLine(line({ tokens: 1 }))
  await failing.flush(true)
  expect(warnings).toEqual(['call-usage-write-failed'])
  expect(failing.final()).toEqual({ state: 'complete', models: [] })

  const unsummarized = createCallUsageWriter({
    meter: meterWith(() => null).meter,
    write: async () => {},
    log,
    callId: 'c2',
  })
  unsummarized.observeLine(line({ tokens: 3 }))
  expect(unsummarized.final()?.models[0]?.input).toBe(3)

  const throwing = createCallUsageWriter({
    meter: meterWith(() => {
      throw new Error('native store locked')
    }).meter,
    write: async () => {},
    log,
    callId: 'c3',
  })
  throwing.observeLine(line({ tokens: 4 }))
  expect(throwing.final()).toMatchObject({ state: 'partial' })

  // A runtime without a meter reports nothing (the call ends as unreported).
  const unmetered = createCallUsageWriter({
    meter: undefined,
    write: async () => {},
    log,
    callId: 'c4',
  })
  unmetered.observeLine(line({ tokens: 4 }))
  await unmetered.flush(true)
  expect(unmetered.snapshot()).toBeNull()
  expect(unmetered.final()).toBeNull()
})

function invocationWith(meter: RuntimeUsageMeter, order: string[]): AgentInvocationBinding {
  return {
    evidence: { prepareUsageMeter: () => meter },
    protocol: {},
    lifecycle: {
      beforeStart: () => {
        order.push('lifecycle')
      },
    },
  } as unknown as AgentInvocationBinding
}

test('a system call is accepted before its process starts and ends exactly once', async () => {
  const order: string[] = []
  const outcomes: unknown[] = []
  const run: SystemAgentObservationRun = {
    callId: 'sys-1',
    accept: async () => {
      order.push('accept')
    },
    usage: async (snapshot) => {
      order.push(`usage:${snapshot.models[0]?.input}`)
    },
    finish: async (outcome) => {
      order.push('finish')
      outcomes.push(outcome)
    },
  }
  const capture = createSystemAgentUsageCapture({
    run,
    invocation: invocationWith(meterWith().meter, order),
    log: logger().log,
    now: () => 50,
  })
  // Output before acceptance cannot belong to a recorded call.
  await capture.line(line({ tokens: 2 }))
  await capture.beforeStart()
  await capture.line(line({ tokens: 4 }))
  await capture.finish('done')
  await capture.finish('failed')
  await capture.line(line({ tokens: 9 }))
  expect(order).toEqual(['accept', 'lifecycle', 'usage:4', 'finish'])
  expect(outcomes).toEqual([
    {
      status: 'done',
      endedAt: 50,
      usage: {
        state: 'partial',
        models: [{ model: 'm', input: 4, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }],
      },
    },
  ])
})

test('a failed acceptance prevents the start and records nothing', async () => {
  const order: string[] = []
  let finishes = 0
  const capture = createSystemAgentUsageCapture({
    run: {
      callId: 'sys-2',
      accept: async () => {
        throw new Error('database unavailable')
      },
      usage: async () => {},
      finish: async () => {
        finishes++
      },
    },
    invocation: invocationWith(meterWith().meter, order),
    log: logger().log,
  })
  await expect(capture.beforeStart()).rejects.toThrow('database unavailable')
  expect(order).toEqual([])
  await capture.finish('failed')
  expect(finishes).toBe(0)
})

test('run results map onto call statuses', () => {
  expect(['ok', 'aborted', 'unreaped', 'error', undefined].map(systemCallStatus)).toEqual([
    'done',
    'canceled',
    'interrupted',
    'failed',
    'failed',
  ])
  expect(['done', 'failed', 'canceled', 'interrupted'].map(callStatusOfNodeRun)).toEqual([
    'done',
    'failed',
    'canceled',
    'interrupted',
  ])
})

test('system calls carry their kind, label, parent task, owner and runtime identity', async () => {
  const accepted: CallObservationStart[] = []
  const calls: CallObservations = {
    accept: async (call) => {
      accepted.push(call)
    },
    usage: async () => {},
    finish: async () => {},
  }
  const factory = composeSystemAgentObservations({ calls })
  const memory = await factory.open({
    feature: 'memory',
    agentName: 'aw-memory-distiller',
    protocol: 'opencode',
    runtimeObservationIdentity: {
      registrationId: 'rt-1',
      configurationRevision: 3,
      acceptedName: 'main',
    },
    demand: {
      kind: 'memory-distill',
      originalId: 'job-1',
      originalAttempt: '1',
      name: '记忆提取',
      parentTaskId: 't-1',
      ownerUserId: 'u-1',
    },
    startedAt: 7,
  })
  await memory.accept()
  const smoke = await factory.open({
    feature: 'runtime-smoke',
    agentName: 'aw-runtime-smoke',
    protocol: 'claude-code',
    startedAt: 8,
  })
  await smoke.accept()
  expect(accepted).toEqual([
    {
      id: memory.callId,
      purpose: 'system',
      taskId: 't-1',
      nodeRunId: null,
      systemKind: 'memory-distill',
      systemLabel: '记忆提取',
      ownerUserId: 'u-1',
      agentId: null,
      agentName: 'aw-memory-distiller',
      runtimeId: 'rt-1',
      runtimeName: 'main',
      protocol: 'opencode',
      startedAt: 7,
    },
    {
      id: smoke.callId,
      purpose: 'system',
      taskId: null,
      nodeRunId: null,
      systemKind: 'runtime-smoke',
      systemLabel: null,
      ownerUserId: null,
      agentId: null,
      agentName: 'aw-runtime-smoke',
      runtimeId: null,
      runtimeName: null,
      protocol: 'claude-code',
      startedAt: 8,
    },
  ])
  expect(memory.callId).not.toBe(smoke.callId)
})
