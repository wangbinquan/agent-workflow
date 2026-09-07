// RFC-359 W12 — locks the shared scan/settlement sequence while each provider
// retains its own per-target transaction and post-commit effects.
import { describe, expect, test } from 'bun:test'

import { executeSourceTermination } from '@/modules/task-execution/application/sourceTerminationExecution'
import type {
  TaskSourceTerminationEffectInput,
  TaskSourceTerminationReceipt,
} from '@/modules/task-execution/application/applySourceTerminationEffect'

const effect: TaskSourceTerminationEffectInput = {
  effectId: 'effect',
  binding: 'gitlab:group/proj!42',
  streamRevision: 5,
  kind: 'fence-closed',
  deliveryId: 'delivery',
}

function target(taskId: string, ownerWithoutLocalToken = false) {
  const receipt: TaskSourceTerminationReceipt = Object.freeze({
    taskId,
    priorStatus: 'running',
    fenceOutcome: 'fenced-closed',
    cancelOutcome: 'canceled',
    releaseOutcome: 'pending',
    errorCode: null,
  })
  return { receipt, ownerWithoutLocalToken }
}

function signal() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('RFC-359 source termination execution', () => {
  test('rescans to a fixed point and applies each discovered target once, including skipped rows', async () => {
    const rounds = [
      ['parent', 'gone'],
      ['parent', 'gone', 'child'],
      ['parent', 'gone', 'child'],
    ]
    const events: string[] = []
    let scans = 0
    const receipts = await executeSourceTermination(
      effect,
      async () => {
        events.push('scan')
        const rows = rounds[scans++]
        if (rows === undefined) throw new Error('fixed point was not reached')
        return rows.map((id) => ({ id }))
      },
      async (id) => {
        events.push(`apply:${id}`)
        return id === 'gone' ? null : target(id)
      },
      async ({ receipt }) => {
        events.push(`complete:${receipt.taskId}`)
        return null
      },
      async (id) => {
        events.push(`finalize:${id}`)
      },
    )
    expect(receipts.map((receipt) => receipt.taskId)).toEqual(['parent', 'child'])
    expect(events).toEqual([
      'scan',
      'apply:parent',
      'complete:parent',
      'finalize:parent',
      'apply:gone',
      'scan',
      'apply:child',
      'complete:child',
      'finalize:child',
      'scan',
    ])
  })

  test('awaits completion of the current target before applying the next target', async () => {
    const stopping = signal()
    const stopped = signal()
    const events: string[] = []
    const execution = executeSourceTermination(
      effect,
      async () => [{ id: 'parent' }, { id: 'child' }],
      async (id) => {
        events.push(`apply:${id}`)
        return target(id)
      },
      async ({ receipt }) => {
        events.push(`complete:${receipt.taskId}`)
        if (receipt.taskId === 'parent') {
          stopping.resolve()
          await stopped.promise
        }
        return { kind: 'released' }
      },
    )
    await stopping.promise
    expect(events).toEqual(['apply:parent', 'complete:parent'])
    stopped.resolve()
    expect((await execution).map((receipt) => receipt.releaseOutcome)).toEqual([
      'released',
      'released',
    ])
    expect(events).toEqual(['apply:parent', 'complete:parent', 'apply:child', 'complete:child'])
  })

  for (const stage of ['list', 'apply', 'complete', 'finalize'] as const) {
    test(`${stage} failure propagates the exact rejection and does not start the next target`, async () => {
      const failure = new Error(`${stage} failed`)
      const events: string[] = []
      const step = (name: typeof stage) => {
        events.push(name)
        if (stage === name) throw failure
      }
      await expect(
        executeSourceTermination(
          effect,
          async () => {
            step('list')
            return [{ id: 'first' }, { id: 'second' }]
          },
          async (id) => {
            expect(id).toBe('first')
            step('apply')
            return target(id)
          },
          async () => {
            step('complete')
            return null
          },
          async () => step('finalize'),
        ),
      ).rejects.toBe(failure)
      expect(events).toEqual(
        ['list', 'apply', 'complete', 'finalize'].slice(
          0,
          ['list', 'apply', 'complete', 'finalize'].indexOf(stage) + 1,
        ),
      )
    })
  }

  const outcomes: ReadonlyArray<{
    name: string
    kind: TaskSourceTerminationEffectInput['kind']
    stopped: { kind: 'released' } | { kind: 'unreaped'; code: string } | null
    missing: boolean
    release: TaskSourceTerminationReceipt['releaseOutcome']
    error: string | null
    finalized: boolean
  }> = [
    {
      name: 'released driver',
      kind: 'fence-closed',
      stopped: { kind: 'released' },
      missing: false,
      release: 'released',
      error: null,
      finalized: false,
    },
    {
      name: 'unreaped driver',
      kind: 'fence-closed',
      stopped: { kind: 'unreaped', code: 'child-still-running' },
      missing: false,
      release: 'unreaped',
      error: 'child-still-running',
      finalized: false,
    },
    {
      name: 'driver unavailable locally',
      kind: 'fence-closed',
      stopped: null,
      missing: true,
      release: 'unreaped',
      error: 'task-execution-recovery-required',
      finalized: false,
    },
    {
      name: 'no active driver',
      kind: 'fence-closed',
      stopped: null,
      missing: false,
      release: 'no-active-owner',
      error: null,
      finalized: true,
    },
    {
      name: 'clear closed',
      kind: 'clear-closed',
      stopped: null,
      missing: false,
      release: 'not-required',
      error: null,
      finalized: false,
    },
  ]
  for (const outcome of outcomes) {
    test(`${outcome.name}: projects the release receipt and only finalizes the no-driver case`, async () => {
      const applied = target('task', outcome.missing)
      const receipt: TaskSourceTerminationReceipt = {
        ...applied.receipt,
        ...(outcome.kind === 'clear-closed'
          ? {
              releaseOutcome: 'not-required',
              cancelOutcome: 'not-applicable',
              fenceOutcome: 'cleared-closed',
            }
          : {}),
      }
      const finalized: string[] = []
      const receipts = await executeSourceTermination(
        { ...effect, kind: outcome.kind },
        async () => [{ id: 'task' }],
        async () => ({ ...applied, receipt }),
        async () => outcome.stopped,
        async (id) => {
          finalized.push(id)
        },
      )
      expect(receipts).toEqual([
        { ...receipt, releaseOutcome: outcome.release, errorCode: outcome.error },
      ])
      expect(finalized).toEqual(outcome.finalized ? ['task'] : [])
    })
  }
})
