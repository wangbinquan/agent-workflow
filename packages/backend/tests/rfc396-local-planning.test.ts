// RFC-396 R06: a local assist reads a real closed subset; unrelated edits remain
// applicable and must not be dropped when its proposal is accepted.
import { expect, test } from 'bun:test'
import type { GraphDesignDocument } from '@agent-workflow/shared'
import { createGraphViewPlanning } from '@/modules/development-automation/application/graph-development/viewPlanning'
import { graphPlanningScope } from '@/modules/development-automation/domain/graph-development/localPlanningScope'
import {
  graphContentRefs,
  validateGraphDocument,
} from '@/modules/development-automation/domain/graph-development/model'
import { describeEachProvider } from './helpers/eachProvider'
import { bookingDesign, bookingView, graphFixture } from './helpers/graphDesign'

function twoBranches(): GraphDesignDocument {
  const document = bookingDesign()
  document.elements.push({
    id: 'notification',
    revision: 1,
    kind: 'behavior',
    role: 'step',
    label: '通知',
    description: '独立通知行为',
    sourceIds: ['notification-source'],
  })
  document.sources.push({
    id: 'notification-source',
    kind: 'material',
    artifactRef: 'notification-material',
    digest: '2'.repeat(64),
    label: '通知来源',
  })
  document.concerns.push({
    id: 'notification-concern',
    revision: 1,
    statement: '通知如何发出',
    purpose: 'understand',
    priority: 'optional',
    disposition: 'addressed',
    sourceIds: ['notification-source'],
    resolutionIds: ['notification'],
  })
  document.models.push({
    id: 'notification-flow',
    revision: 1,
    kind: 'flow',
    label: '通知流程',
    elementIds: ['notification'],
    relationIds: [],
    sourceIds: ['notification-source'],
  })
  document.views.push({
    ...document.views[0]!,
    id: 'notifications',
    title: '通知流程',
    elementIds: ['notification'],
    modelIds: ['notification-flow'],
    concernIds: ['notification-concern'],
    sourceIds: ['notification-source'],
  })
  return document
}
function broadOverview(): GraphDesignDocument {
  const document = twoBranches()
  document.views.push({
    ...document.views[0]!,
    id: 'combined',
    title: '综合目录',
    elementIds: ['booking', 'notification'],
    modelIds: ['flow', 'notification-flow'],
    concernIds: ['availability', 'notification-concern'],
    sourceIds: ['request', 'notification-source'],
  })
  return document
}
async function seedBranches(f: Awaited<ReturnType<typeof graphFixture>>, document = twoBranches()) {
  const before = await f.commands.document(document.id)
  // New original material enters through intake/import, never through the human
  // semantic edit command whose source records are deliberately immutable.
  await f.commands.storeProposal({
    schemaVersion: 1,
    id: 'branches-intake',
    requestId: 'branches-intake',
    designId: document.id,
    kind: 'intake',
    readSet: graphContentRefs(before),
    invocationRef: null,
    status: 'proposed',
    explanation: '受理两个独立分支及各自的原始材料',
    document,
    plan: null,
    createdAt: 1,
  })
  const result = await f.commands.applyProposal(document.id, 'branches-intake', 'accept-branches')
  if (result.status !== 'accepted') throw new Error('fixture-branches-intake-stale')
  return result.document
}
const localRequest = {
  requestId: 'local',
  expectedRevision: 1,
  action: 'update-view' as const,
  instruction: '仅细化预约说明',
  anchor: { artifactRef: 'design-a', elementIds: ['booking'], relationIds: [], viewId: 'overview' },
}

test('local material closes genuine dependencies and omits independent branch content', () => {
  const document = twoBranches()
  const scope = graphPlanningScope(document, localRequest)
  expect(scope.local).toBe(true)
  expect(scope.document.elements.map((element) => element.id)).toEqual(['booking'])
  expect(scope.document.models.map((model) => model.id)).toEqual(['flow'])
  expect(scope.document.views.map((view) => view.id)).toEqual(['overview'])
  expect(scope.document.sources.map((source) => source.id)).toEqual(['request'])
  expect(scope.readSet.some((ref) => ref.id === 'notification')).toBe(false)
  expect(validateGraphDocument(scope.document)).toEqual([])
  document.relations.push({
    id: 'requires-notification',
    revision: 1,
    from: 'booking',
    to: 'notification',
    kind: 'depends-on',
    label: '依赖通知',
    sourceIds: [],
  })
  const dependent = graphPlanningScope(document, localRequest)
  expect(dependent.document.elements.some((element) => element.id === 'notification')).toBe(true)
  expect(dependent.readSet.some((ref) => ref.id === 'notification')).toBe(true)
  expect(validateGraphDocument(dependent.document)).toEqual([])
})

test('selection scope ignores a broad locating view, while explicit update reads that whole view', () => {
  const document = broadOverview()
  const anchor = { ...localRequest.anchor, viewId: 'combined' }
  const selected = graphPlanningScope(document, { ...localRequest, action: 'explain', anchor })
  expect(selected.document.elements.map((element) => element.id)).toEqual(['booking'])
  expect(selected.document.views.map((view) => view.id)).toEqual(['overview'])
  expect(selected.readSet.some((ref) => ref.id === 'combined' || ref.id === 'notification')).toBe(
    false,
  )
  expect(validateGraphDocument(selected.document)).toEqual([])
  const updating = graphPlanningScope(document, { ...localRequest, anchor })
  expect(updating.document.elements.map((element) => element.id)).toEqual([
    'booking',
    'notification',
  ])
  expect(updating.readSet.some((ref) => ref.id === 'combined')).toBe(true)
  expect(validateGraphDocument(updating.document)).toEqual([])
})

describeEachProvider('RFC-396 local assist semantic scope', (harness) => {
  test.each([false, true])(
    'a concurrent edit is stale only when read by the local assist (related=%s)',
    async (related) => {
      const f = await graphFixture(harness.db)
      const seeded = await seedBranches(f, broadOverview())
      let finish!: (value: { invocationRef: string; outputJson: string }) => void
      let material!: GraphDesignDocument
      const planner = createGraphViewPlanning({
        ...f,
        assist: {
          generate(input) {
            material = input.document
            return new Promise((resolve) => {
              finish = resolve
            })
          },
        },
      })
      await planner.start(seeded.id, {
        ...localRequest,
        action: 'explain',
        anchor: { ...localRequest.anchor, viewId: 'combined' },
        expectedRevision: seeded.revision,
      })
      expect(material.elements.some((element) => element.id === 'notification')).toBe(false)
      const concurrent = structuredClone(seeded)
      concurrent.elements.find(
        (element) => element.id === (related ? 'booking' : 'notification'),
      )!.description = '人的同时修改'
      const newest = await f.commands.change(seeded.id, {
        requestId: 'human-change',
        expectedRevision: seeded.revision,
        document: concurrent,
      })
      const output = structuredClone(material)
      output.elements[0]!.description = '预约的细化说明'
      finish({
        invocationRef: 'local-assist',
        outputJson: JSON.stringify({
          document: output,
          candidates: [bookingView()],
          explanation: '只修改选中分支',
        }),
      })
      await planner.settled(seeded.id, 'local')
      const proposal = await f.queries.proposal(seeded.id, 'action:local')
      expect(proposal.status).toBe(related ? 'stale' : 'proposed')
      if (!related) {
        const applied = await f.commands.applyProposal(seeded.id, proposal.id, 'accept-local')
        if (applied.status !== 'accepted') throw new Error('local-proposal-unexpectedly-stale')
        expect(
          applied.document.elements.find((element) => element.id === 'notification')!.description,
        ).toBe('人的同时修改')
        expect(
          applied.document.elements.find((element) => element.id === 'booking')!.description,
        ).toBe('预约的细化说明')
        expect(applied.document.views.find((view) => view.id === 'notifications')).toEqual(
          newest.views.find((view) => view.id === 'notifications'),
        )
        expect(applied.document.models.find((model) => model.id === 'notification-flow')).toEqual(
          newest.models.find((model) => model.id === 'notification-flow'),
        )
      }
    },
  )

  test('local output cannot replace an unseen existing identity or silently delete an unrelated view', async () => {
    const f = await graphFixture(harness.db)
    const seeded = await seedBranches(f)
    const planner = createGraphViewPlanning({
      ...f,
      assist: {
        async generate(input) {
          const output = structuredClone(input.document)
          output.elements.push({
            ...seeded.elements.find((element) => element.id === 'notification')!,
            description: '未读取却覆盖',
          })
          return {
            invocationRef: 'invalid-local',
            outputJson: JSON.stringify({
              document: output,
              candidates: [bookingView()],
              explanation: '非法范围',
            }),
          }
        },
      },
    })
    await planner.start(seeded.id, { ...localRequest, expectedRevision: seeded.revision })
    await planner.settled(seeded.id, 'local')
    const action = await f.store.record(seeded.id, 'action:local')
    expect(action?.status).toBe('failed')
    expect(action?.payloadJson).toContain('graph-local-undeclared-object:notification')
    expect(await f.commands.document(seeded.id)).toEqual(seeded)
  })

  test('an unrelated edit after the local proposal is stored still survives later acceptance', async () => {
    const f = await graphFixture(harness.db)
    const seeded = await seedBranches(f)
    const planner = createGraphViewPlanning({
      ...f,
      assist: {
        async generate(input) {
          const document = structuredClone(input.document)
          document.elements[0]!.description = '细化预约'
          return {
            invocationRef: 'scoped',
            outputJson: JSON.stringify({
              document,
              candidates: [bookingView()],
              explanation: '仅预约',
            }),
          }
        },
      },
    })
    await planner.start(seeded.id, { ...localRequest, expectedRevision: seeded.revision })
    await planner.settled(seeded.id, 'local')
    const proposal = await f.queries.proposal(seeded.id, 'action:local')
    expect(proposal.document.elements.some((element) => element.id === 'notification')).toBe(false)
    const concurrent = structuredClone(seeded)
    concurrent.elements.find((element) => element.id === 'notification')!.description =
      '提案形成后的人修改'
    await f.commands.change(seeded.id, {
      requestId: 'after-proposal',
      expectedRevision: seeded.revision,
      document: concurrent,
    })
    const applied = await f.commands.applyProposal(seeded.id, proposal.id, 'accept-after-human')
    if (applied.status !== 'accepted') throw new Error('unrelated-edit-staled-local-proposal')
    expect(
      applied.document.elements.find((element) => element.id === 'notification')!.description,
    ).toBe('提案形成后的人修改')
    expect(applied.document.elements.find((element) => element.id === 'booking')!.description).toBe(
      '细化预约',
    )
  })
})
