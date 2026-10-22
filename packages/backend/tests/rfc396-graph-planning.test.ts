import { expect, test } from 'bun:test'
import {
  createGraphViewPlanning,
  graphDesignAssistPrompt,
} from '@/modules/development-automation/application/graph-development/viewPlanning'
import { GRAPH_DESIGN_AUTHORING_RULES } from '@/modules/development-automation/application/graph-development/toolContracts'
import { describeEachProvider } from './helpers/eachProvider'
import { graphFixture, bookingView } from './helpers/graphDesign'
describeEachProvider('RFC-396 observed short design calls', (harness) => {
  test('assist generates a reviewable proposal without editing the current document or releasing a human gate', async () => {
    const f = await graphFixture(harness.db),
      document = await f.commands.document('design-a')
    const planner = createGraphViewPlanning({
      ...f,
      budget: { reading: 4, generation: 5 },
      assist: {
        async generate(input) {
          const material = JSON.parse(graphDesignAssistPrompt(input))
          expect(material.planningBudget).toEqual({ reading: 4, generation: 5 })
          expect(material.authoringRules).toEqual(GRAPH_DESIGN_AUTHORING_RULES)
          expect(material.document).toEqual(document)
          expect(material.outputSchema).toBeDefined()
          return {
            invocationRef: 'observed-run',
            outputJson: JSON.stringify({
              document,
              candidates: [bookingView()],
              explanation: '一个视图覆盖当前问题',
            }),
          }
        },
      },
    })
    await planner.start(document.id, {
      requestId: 'one',
      expectedRevision: document.revision,
      action: 'replan',
      instruction: '最少必要视图',
      anchor: null,
    })
    await planner.settled(document.id, 'one')
    expect((await f.commands.document(document.id)).revision).toBe(document.revision)
    expect((await f.queries.proposal(document.id, 'action:one')).invocationRef).toBe('observed-run')
    expect(f.requests).toEqual([])
    await f.commands.applyProposal(document.id, 'action:one', 'apply')
    expect((await f.commands.document(document.id)).revision).toBe(document.revision + 1)
  })
  test('a concurrent design edit leaves the result stale and preserves the human edit', async () => {
    const f = await graphFixture(harness.db),
      document = await f.commands.document('design-a')
    let finish!: (value: { invocationRef: string; outputJson: string }) => void
    const planner = createGraphViewPlanning({
      ...f,
      assist: {
        generate: () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      },
    })
    await planner.start(document.id, {
      requestId: 'slow',
      expectedRevision: document.revision,
      action: 'replan',
      instruction: '',
      anchor: null,
    })
    const changed = structuredClone(document)
    changed.elements[0]!.description = '人补充的条件'
    await f.commands.change(document.id, {
      requestId: 'human',
      expectedRevision: document.revision,
      document: changed,
    })
    finish({
      invocationRef: 'slow',
      outputJson: JSON.stringify({ document, candidates: [bookingView()], explanation: '旧提案' }),
    })
    await planner.settled(document.id, 'slow')
    expect((await f.queries.proposal(document.id, 'action:slow')).status).toBe('stale')
    expect((await f.commands.document(document.id)).elements[0]!.description).toBe('人补充的条件')
  })
  test('cancel interrupts the selected runtime and restart marks in-flight calls interrupted for explicit retry', async () => {
    const f = await graphFixture(harness.db),
      document = await f.commands.document('design-a')
    let aborted = false
    const planner = createGraphViewPlanning({
      ...f,
      assist: {
        generate: ({ signal }) =>
          new Promise((_, reject) =>
            signal.addEventListener('abort', () => {
              aborted = true
              reject(new Error('aborted'))
            }),
          ),
      },
    })
    await planner.start(document.id, {
      requestId: 'cancel',
      expectedRevision: document.revision,
      action: 'explain',
      instruction: '',
      anchor: null,
    })
    await planner.cancel(document.id, 'cancel')
    await planner.settled(document.id, 'cancel')
    expect(aborted).toBe(true)
    expect((await f.store.record(document.id, 'action:cancel'))?.status).toBe('canceled')
    const row = await f.commands.beginRecord(document.id, 'action:restart', 'action', {})
    await f.commands.finishRecord(row, 'running', {
      request: {
        requestId: 'restart',
        expectedRevision: document.revision,
        action: 'replan',
        instruction: '',
        anchor: null,
      },
    })
    await planner.recoverInterrupted()
    expect((await f.store.record(document.id, 'action:restart'))?.status).toBe('interrupted')
    expect((await f.commands.document(document.id)).revision).toBe(document.revision)
  })
  test('cleanup of a canceled call cannot detach its immediate retry from cancellation', async () => {
    const f = await graphFixture(harness.db),
      document = await f.commands.document('design-a')
    let finishFirst!: () => void
    let count = 0,
      retriedAborted = false
    const planner = createGraphViewPlanning({
      ...f,
      assist: {
        generate: ({ signal }) =>
          new Promise((_, reject) => {
            if (++count === 1) finishFirst = () => reject(new Error('old cancellation drained'))
            else
              signal.addEventListener('abort', () => {
                retriedAborted = true
                reject(new Error('new cancellation'))
              })
          }),
      },
    })
    await planner.start(document.id, {
      requestId: 'retry-race',
      expectedRevision: document.revision,
      action: 'replan',
      instruction: '',
      anchor: null,
    })
    const firstSettled = planner.settled(document.id, 'retry-race')
    await planner.cancel(document.id, 'retry-race')
    await planner.retry(document.id, 'retry-race')
    finishFirst()
    await firstSettled
    await planner.cancel(document.id, 'retry-race')
    await planner.settled(document.id, 'retry-race')
    expect(retriedAborted).toBe(true)
    expect((await f.store.record(document.id, 'action:retry-race'))?.status).toBe('canceled')
  })
})
