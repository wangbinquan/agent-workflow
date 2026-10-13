// RFC-370: HTTP and bound operations read the exact root status before new
// execution, without closing resource edits or receipt/cancel handlers.
import { expect, test } from 'bun:test'
import type { HostExecutionStatus } from '@agent-workflow/shared'
import {
  bindHttpHostExecutionAvailability,
  requireHttpHostExecutionGroup,
  runHttpHostExecutionRequest,
  tryRunHttpHostExecutionRequest,
} from '@/platform/http/hostExecutionAvailability'
import type {
  HostExecutionAdmission,
  HostExecutionStopReason,
} from '@/modules/system-operations/public/participants'
import { DomainError } from '@/util/errors'

// Complete transport-admission port for these isolated query/selection cases.
// Actual SO lease retirement is exercised with real providers in the barrier suite.
const requests = new Set<object>()
const admission: HostExecutionAdmission = {
  acquire() {
    const reference = Object.freeze({})
    requests.add(reference)
    return {
      kind: 'admitted',
      lease: {
        generation: 'http-unit-generation',
        reference,
        stopped: new Promise<HostExecutionStopReason>(() => {}),
        complete: () => {
          requests.delete(reference)
        },
      },
    }
  },
}
const selected = (queries: { readCurrent(): HostExecutionStatus }) => ({ queries, admission })

test('separate roots keep their own live query and original receiver, without starting any owner', () => {
  const first = {},
    second = {}
  let view: HostExecutionStatus = {
    mode: 'execution',
    status: { phase: 'preparing', generation: 'first-root', readyGroups: [], reason: 'preparing' },
  }
  let firstReads = 0,
    secondReads = 0
  const query = {
    readCurrent() {
      expect(this).toBe(query)
      firstReads += 1
      return view
    },
  }
  bindHttpHostExecutionAvailability(first, selected(query))
  bindHttpHostExecutionAvailability(
    second,
    selected({
      readCurrent() {
        secondReads += 1
        return {
          mode: 'resource-only',
          status: {
            phase: 'standby',
            generation: 'second-root',
            readyGroups: [],
            reason: 'resource-only',
          },
        }
      },
    }),
  )
  expect(() => requireHttpHostExecutionGroup(first, 'task')).toThrow(DomainError)
  view = {
    ...view,
    status: { ...view.status, phase: 'active', readyGroups: ['task'], reason: null },
  }
  query.readCurrent = () => {
    throw new Error('replacement query must not be consumed')
  }
  requireHttpHostExecutionGroup(first, 'task')!.complete()
  expect(() => requireHttpHostExecutionGroup(first, 'diagnostics')).toThrow('not ready')
  expect(() => requireHttpHostExecutionGroup(second, 'task')).toThrow('not ready')
  expect(firstReads).toBe(3)
  expect(secondReads).toBe(1)
  expect(requests.size).toBe(0)
})

test('resource, receipt and cancellation paths do not read or change host state', () => {
  const root = {}
  bindHttpHostExecutionAvailability(
    root,
    selected({
      readCurrent() {
        throw new Error('not an execution admission')
      },
    }),
  )
  requireHttpHostExecutionGroup(root, undefined)
})

test('loss and normal draining report the actual unavailable group instead of admitting another execution', () => {
  const root = {}
  bindHttpHostExecutionAvailability(
    root,
    selected({
      readCurrent: () => ({
        mode: 'execution',
        status: {
          phase: 'draining',
          generation: 'original-generation',
          readyGroups: [],
          reason: 'original-loss-reason',
        },
      }),
    }),
  )
  let failure: unknown
  try {
    requireHttpHostExecutionGroup(root, 'task')
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(DomainError)
  expect((failure as DomainError).status).toBe(503)
  expect((failure as DomainError).toPayload()).toMatchObject({
    code: 'host-execution-unavailable',
    details: {
      group: 'task',
      mode: 'execution',
      status: { phase: 'draining', reason: 'original-loss-reason' },
    },
  })
})

test('native roots retain their original caller admission and selected roots cannot be rebound', () => {
  const native = {},
    selectedRoot = {}
  bindHttpHostExecutionAvailability(native, undefined)
  requireHttpHostExecutionGroup(native, 'task')
  const query = { readCurrent: (): HostExecutionStatus => ({ mode: 'native', status: null }) }
  bindHttpHostExecutionAvailability(selectedRoot, selected(query))
  expect(() => bindHttpHostExecutionAvailability(selectedRoot, selected(query))).toThrow(
    'already-bound',
  )
})

test('an unavailable continuation does not undo a business cancellation or admit another request', async () => {
  const root = {}
  let calls = 0
  bindHttpHostExecutionAvailability(
    root,
    selected({
      readCurrent: () => ({
        mode: 'resource-only',
        status: {
          phase: 'standby',
          generation: 'cancel-generation',
          readyGroups: [],
          reason: 'resource-only',
        },
      }),
    }),
  )
  let cancellations = 0
  await runHttpHostExecutionRequest(root, undefined, async () => {
    cancellations += 1
  })
  expect(
    await tryRunHttpHostExecutionRequest(root, 'intent', async () => {
      calls += 1
    }),
  ).toBe(false)
  expect(cancellations).toBe(1)
  expect(calls).toBe(0)
  expect(requests.size).toBe(0)
})

test('an optional admitted continuation holds its original lease and propagates business errors', async () => {
  const root = {}
  bindHttpHostExecutionAvailability(
    root,
    selected({
      readCurrent: () => ({
        mode: 'execution',
        status: {
          phase: 'active',
          generation: 'continuation-generation',
          readyGroups: ['intent'],
          reason: null,
        },
      }),
    }),
  )
  let release!: () => void
  const pending = tryRunHttpHostExecutionRequest(
    root,
    'intent',
    () =>
      new Promise<void>((done) => {
        release = done
      }),
  )
  expect(requests.size).toBe(1)
  release()
  expect(await pending).toBe(true)
  expect(requests.size).toBe(0)
  const failure = new Error('original-business-failure')
  await expect(
    tryRunHttpHostExecutionRequest(root, 'intent', async () => {
      throw failure
    }),
  ).rejects.toBe(failure)
  expect(requests.size).toBe(0)
  let nativeCalls = 0
  expect(
    await tryRunHttpHostExecutionRequest({}, 'intent', async () => {
      nativeCalls += 1
    }),
  ).toBe(true)
  expect(nativeCalls).toBe(1)
})
