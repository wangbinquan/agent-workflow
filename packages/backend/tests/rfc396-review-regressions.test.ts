// RFC-396 review R02/R03/R04/R07: pinned views are not coverage proof and visible
// behavior must retain the conditions that the executable model actually uses.
import { expect, test } from 'bun:test'
import type { GraphSubmodel } from '@agent-workflow/shared'
import {
  materializeGraphViewPlan,
  selectGraphViews,
} from '@/modules/development-automation/domain/graph-development/selectViews'
import { renderGraphModel } from '@/modules/development-automation/domain/graph-development/renderViews'
import { enumerateGraphStatePaths } from '@/modules/development-automation/domain/graph-development/behaviorChecks'
import { bookingDesign, bookingView, graphFixture } from './helpers/graphDesign'
import { describeEachProvider } from './helpers/eachProvider'
import { graphContentRefs } from '@/modules/development-automation/domain/graph-development/model'
import { readAcceptedGraphViewPlan } from '@/modules/development-automation/application/graph-development/viewPlanningHistory'
import { createGraphViewPlanning } from '@/modules/development-automation/application/graph-development/viewPlanning'
import { createGraphExecutionConsumption } from '@/modules/development-automation/application/graph-development/executionConsumption'
import { graphEmployeeRuntimeCodec } from '@/modules/development-automation/application/graph-development/employeeCodec'

const budget = { reading: 12, generation: 24 }

test('pinning a partially covered view retains the gap and leaves room for a useful complementary view', () => {
  const document = bookingDesign()
  const partial = { ...bookingView(), readingCost: 4, generationCost: 3 }
  partial.coverage[0]!.contribution = 0.4
  const previous = selectGraphViews(document, [partial], budget)
  document.views[0]!.pinned = true
  const result = selectGraphViews(document, [bookingView('complete')], budget, previous)
  expect(result.selectedIds).toContain('overview')
  expect(result.selectedIds).toContain('complete')
  const retained = result.candidates.find((candidate) => candidate.id === 'overview')!
  expect(retained.coverage[0]!.contribution).toBe(0.4)
  expect(retained.readingCost).toBe(4)
  expect(retained.generationCost).toBe(3)
  expect(selectGraphViews(document, [], budget, previous).uncoveredConcernIds).toEqual([
    'availability',
  ])
})

test('a pinned view without a matching assessment never invents full coverage', () => {
  const document = bookingDesign()
  document.views[0]!.pinned = true
  const withoutHistory = selectGraphViews(document, [], budget)
  expect(withoutHistory.uncoveredConcernIds).toEqual(['availability'])
  expect(withoutHistory.candidates[0]!.coverage[0]!.contribution).toBe(0)
  const previous = selectGraphViews(document, [bookingView()], budget)
  document.elements[0]!.description = '含新增并发规则，旧覆盖尚未重评'
  expect(selectGraphViews(document, [], budget, previous).uncoveredConcernIds).toEqual([
    'availability',
  ])
  document.views[0]!.status = 'needs-update'
  expect(selectGraphViews(document, [bookingView()], budget, previous).uncoveredConcernIds).toEqual(
    ['availability'],
  )
})

test('materialization uses the selected valid fallback, never the rejected same-id candidate', () => {
  const document = bookingDesign()
  document.views[0]!.pinned = true
  document.views[0]!.status = 'needs-update'
  const invalid = { ...bookingView(), capabilityRef: { id: 'flow', version: 999 } }
  const plan = selectGraphViews(document, [invalid], budget)
  expect(
    plan.decisions.some((decision) => decision.reason === 'unsupported-capability-version'),
  ).toBe(true)
  const views = materializeGraphViewPlan(document, plan)
  expect(views[0]!.capabilityRef).toEqual({ id: 'flow', version: 1 })
  expect(views[0]!.status).toBe('needs-update')
  expect(views[0]!.pinned).toBe(true)
})

test('assessment matching follows explicitly referenced concern resolutions even without element projections', () => {
  const document = bookingDesign()
  document.views[0]!.elementIds = []
  document.views[0]!.modelIds = []
  document.views[0]!.pinned = true
  const candidate = { ...bookingView(), elementIds: [], modelIds: [] }
  const previous = selectGraphViews(document, [candidate], budget)
  document.elements[0]!.description = '改变该关注点对应的语义内容'
  expect(selectGraphViews(document, [], budget, previous).uncoveredConcernIds).toEqual([
    'availability',
  ])
})

test('flow branch conditions remain visible even when the relation label is unchanged', () => {
  const document = bookingDesign()
  document.relations.push({
    id: 'retry',
    revision: 1,
    from: 'booking',
    to: 'booking',
    kind: 'flow',
    label: '重试',
    condition: '剩余名额大于 0',
    sourceIds: ['request'],
  })
  const model: GraphSubmodel = {
    ...document.models[0]!,
    kind: 'flow',
    elementIds: ['booking'],
    relationIds: ['retry'],
  }
  const available = renderGraphModel(document, model).source
  document.relations[0]!.condition = '剩余名额等于 0'
  const full = renderGraphModel(document, model).source
  expect(available).toContain('剩余名额大于 0')
  expect(full).toContain('剩余名额等于 0')
  expect(available).not.toBe(full)
})

test('state guards render the same comparison, set membership and existence used by path enumeration', () => {
  const document = bookingDesign()
  document.elements = ['pending', 'accepted'].map((id) => ({
    id,
    revision: 1,
    kind: 'behavior',
    role: 'state',
    label: id,
    description: '',
    sourceIds: [],
  }))
  document.relations = [
    {
      id: 'accept',
      revision: 1,
      from: 'pending',
      to: 'accepted',
      kind: 'transition',
      label: '',
      condition: '已审批',
      sourceIds: [],
    },
  ]
  const model: Extract<GraphSubmodel, { kind: 'state' }> = {
    id: 'states',
    revision: 1,
    kind: 'state',
    label: '',
    sourceIds: [],
    stateIds: ['pending', 'accepted'],
    initialStateId: 'pending',
    terminalStateIds: ['accepted'],
    transitions: [
      {
        relationId: 'accept',
        event: 'submit',
        guards: [
          { field: 'amount', operator: 'gt', value: 10 },
          { field: 'region', operator: 'in', value: ['CN', 'US'] },
          { field: 'approvedBy', operator: 'exists' },
        ],
        actionRef: 'submit',
        assertionRefs: ['accepted'],
      },
    ],
  }
  const opposite = structuredClone(model)
  opposite.transitions[0]!.guards[0]!.operator = 'lt'
  const rendered = renderGraphModel(document, model).source
  expect(rendered).toContain('amount > 10')
  expect(rendered).toContain('region in')
  expect(rendered).toContain('approvedBy exists')
  expect(rendered).toContain('已审批')
  expect(rendered).not.toBe(renderGraphModel(document, opposite).source)
  const bounds = { depth: 2, paths: 10, inputs: [{ amount: 5, region: 'CN', approvedBy: 'human' }] }
  expect(
    enumerateGraphStatePaths(document, model, bounds).paths.map((path) => path.stateIds),
  ).not.toEqual(
    enumerateGraphStatePaths(document, opposite, bounds).paths.map((path) => path.stateIds),
  )
})

describeEachProvider('RFC-396 accepted planning evidence', (harness) => {
  test.each([1, 999])(
    'explicit update refreshes a stale pinned view only with a valid candidate (capability=%s)',
    async (capabilityVersion) => {
      const f = await graphFixture(harness.db)
      const original = await f.commands.document('design-a')
      original.views[0]!.pinned = true
      original.views[0]!.status = 'needs-update'
      const document = await f.commands.change(original.id, {
        requestId: 'pin-stale',
        expectedRevision: original.revision,
        document: original,
      })
      const fresh = {
        ...bookingView(),
        title: '已重新生成的预约流程',
        capabilityRef: { id: 'flow', version: capabilityVersion },
      }
      const planner = createGraphViewPlanning({
        ...f,
        assist: {
          async generate(input) {
            return {
              invocationRef: 'refresh',
              outputJson: JSON.stringify({
                document: input.document,
                candidates: [fresh],
                explanation: '明确更新这张固定图',
              }),
            }
          },
        },
      })
      await planner.start(document.id, {
        requestId: 'refresh',
        expectedRevision: document.revision,
        action: 'update-view',
        instruction: '更新此图',
        anchor: { artifactRef: document.id, elementIds: [], relationIds: [], viewId: 'overview' },
      })
      await planner.settled(document.id, 'refresh')
      const applied = await f.commands.applyProposal(
        document.id,
        'action:refresh',
        'accept-refresh',
      )
      if (applied.status !== 'accepted') throw new Error('refresh-proposal-unexpectedly-stale')
      const actual = applied.document.views.find((view) => view.id === 'overview')!
      expect(actual.pinned).toBe(true)
      expect(actual.capabilityRef).toEqual({ id: 'flow', version: 1 })
      expect(actual.status).toBe(capabilityVersion === 1 ? 'current' : 'needs-update')
      expect(actual.title).toBe(capabilityVersion === 1 ? fresh.title : document.views[0]!.title)
      const proposal = await f.queries.proposal(document.id, 'action:refresh')
      expect(proposal.plan?.uncoveredConcernIds).toEqual(
        capabilityVersion === 1 ? [] : ['availability'],
      )
    },
  )

  test.each(['assist', 'workflow'])(
    'the %s production path cannot materialize a rejected same-id pinned candidate',
    async (path) => {
      const f = await graphFixture(harness.db)
      const before = await f.commands.document('design-a')
      before.views[0]!.pinned = true
      before.views[0]!.status = 'needs-update'
      const document = await f.commands.change(before.id, {
        requestId: 'pin-for-replan',
        expectedRevision: before.revision,
        document: before,
      })
      const invalid = { ...bookingView(), capabilityRef: { id: 'flow', version: 999 } }
      if (path === 'assist') {
        const planner = createGraphViewPlanning({
          ...f,
          assist: {
            async generate() {
              return {
                invocationRef: 'invalid-view',
                outputJson: JSON.stringify({
                  document,
                  candidates: [invalid],
                  explanation: '固定图不支持候选新版本',
                }),
              }
            },
          },
        })
        await planner.start(document.id, {
          requestId: 'invalid',
          expectedRevision: document.revision,
          action: 'replan',
          instruction: '保留人的图',
          anchor: null,
        })
        await planner.settled(document.id, 'invalid')
        await f.commands.applyProposal(document.id, 'action:invalid', 'apply-invalid')
      } else {
        const initial = JSON.parse(
          graphEmployeeRuntimeCodec.buildInitialCaseJson(
            JSON.stringify({
              caseRef: document.caseId,
              employeeRef: { id: 'employee-a', revision: 1 },
              workScopeJson: '{"kind":"task"}',
              intake: {
                target: { repositoryId: document.repositoryId },
                kind: 'body',
                body: '预约',
                uploads: [],
              },
            }),
          ),
        )
        const work = { ...JSON.parse(initial.primaryContextJson), designId: document.id }
        const plan = {
          roundRef: 'import-round',
          executionNonce: 'nonce',
          caseRef: { id: document.caseId },
          employeeTypeRef: { typeId: 'graph-development', revision: 1 },
          workItemRef: 'design-and-clarify',
          inputEnvelopeJson: JSON.stringify({
            contextsJson: JSON.stringify([
              {
                id: 'graph-context',
                typeId: initial.primaryContextTypeId,
                revision: 1,
                stateJson: JSON.stringify(work),
                artifactRefs: [],
              },
            ]),
          }),
        }
        const scene = await f.commands.beginRecord(document.id, 'scene:import-round:1', 'scene', {})
        await f.commands.finishRecord(scene, 'ready', { projection: { materials: { document } } })
        const consumption = createGraphExecutionConsumption({
          ...f,
          rounds: { frozenPlan: async () => null, lastSettledRound: async () => null },
          executions: { read: async () => null },
          humanInputs: { clarificationRounds: async () => [], reviewDecision: async () => null },
        })
        await consumption.consume({
          planJson: JSON.stringify(plan),
          outputJson: JSON.stringify({
            summary: '保留固定视图',
            result: { document, candidates: [invalid] },
          }),
        })
      }
      const actual = await f.commands.document(document.id)
      expect(actual.views[0]!.capabilityRef).toEqual({ id: 'flow', version: 1 })
      expect(actual.views[0]!.status).toBe('needs-update')
    },
  )

  test('only accepted assessments with unchanged semantics survive a later pin or unrelated edit', async () => {
    const f = await graphFixture(harness.db)
    const document = await f.commands.document('design-a')
    const candidate = bookingView()
    candidate.coverage[0]!.contribution = 0.4
    candidate.readingCost = 4
    const plan = selectGraphViews(document, [candidate], budget)
    await f.commands.storeProposal({
      schemaVersion: 1,
      id: 'assessed',
      requestId: 'assessed',
      designId: document.id,
      kind: 'view-plan',
      readSet: graphContentRefs(document),
      invocationRef: 'model',
      status: 'proposed',
      explanation: '部分覆盖仍有缺口',
      document: { ...document, views: materializeGraphViewPlan(document, plan) },
      plan,
      createdAt: 1,
    })
    expect(await readAcceptedGraphViewPlan({ ...f, document })).toBeNull()
    const applied = await f.commands.applyProposal(document.id, 'assessed', 'apply-assessed')
    if (applied.status !== 'accepted') throw new Error('fixture-assessment-not-accepted')
    const pinned = structuredClone(applied.document)
    pinned.views[0]!.pinned = true
    const current = await f.commands.change(document.id, {
      requestId: 'pin',
      expectedRevision: pinned.revision,
      document: pinned,
    })
    const history = await readAcceptedGraphViewPlan({ ...f, document: current })
    expect(history?.candidates[0]!.coverage[0]!.contribution).toBe(0.4)
    expect(selectGraphViews(current, [], budget, history).candidates[0]!.readingCost).toBe(4)
    const independent = structuredClone(current)
    independent.elements.push({
      id: 'unrelated',
      revision: 1,
      kind: 'behavior',
      role: 'step',
      label: '独立行为',
      description: '',
      sourceIds: [],
    })
    const unrelated = await f.commands.change(document.id, {
      requestId: 'independent-edit',
      expectedRevision: independent.revision,
      document: independent,
    })
    const retained = await readAcceptedGraphViewPlan({ ...f, document: unrelated })
    expect(
      selectGraphViews(unrelated, [], budget, retained).candidates[0]!.coverage[0]!.contribution,
    ).toBe(0.4)
    const changed = structuredClone(unrelated)
    changed.elements[0]!.description = '新的业务约束'
    const newer = await f.commands.change(document.id, {
      requestId: 'semantic-change',
      expectedRevision: changed.revision,
      document: changed,
    })
    expect((await readAcceptedGraphViewPlan({ ...f, document: newer }))?.candidates ?? []).toEqual(
      [],
    )
  })
})
