// RFC-396 review R05/R08: an unrelated open question cannot block a local basis;
// large view directories remain bounded and every relation is discoverable.
import { expect, test } from 'bun:test'
import { createGraphImplementationBasis } from '@/modules/development-automation/domain/graph-development/implementationBasis'
import { bookingDesign, graphFixture } from './helpers/graphDesign'
import { describeEachProvider } from './helpers/eachProvider'

test('a partial implementation basis checks required concerns only in its dependency closure', () => {
  const document = bookingDesign()
  document.elements.push({
    id: 'notification',
    revision: 1,
    kind: 'requirement',
    description: '独立通知',
    sourceIds: ['request'],
    label: '独立通知',
    obligationIds: [],
  })
  document.concerns.push({
    ...document.concerns[0]!,
    id: 'notification-policy',
    disposition: 'open',
    resolutionIds: ['notification'],
  })
  const basis = createGraphImplementationBasis({
    id: 'basis',
    document,
    includedElementIds: ['booking'],
    createdAt: 1,
  })
  expect(basis.includedElementIds).toEqual(['booking'])
  expect(basis.excludedElementIds).toContain('notification')
  expect(
    basis.document.concerns.find((item) => item.id === 'notification-policy')?.disposition,
  ).toBe('open')
  document.relations.push({
    id: 'dependency',
    revision: 1,
    kind: 'depends-on',
    from: 'booking',
    to: 'notification',
    label: '依赖通知策略',
    sourceIds: ['request'],
  })
  expect(() =>
    createGraphImplementationBasis({
      id: 'basis',
      document,
      includedElementIds: ['booking'],
      createdAt: 1,
    }),
  ).toThrow('graph-baseline-unresolved-concern:notification-policy')
})

test('an unassociated required question is a global unknown until explicitly scoped', () => {
  const document = bookingDesign()
  document.concerns.push({
    ...document.concerns[0]!,
    id: 'global-unknown',
    disposition: 'open',
    resolutionIds: [],
  })
  expect(() =>
    createGraphImplementationBasis({
      id: 'basis',
      document,
      includedElementIds: ['booking'],
      createdAt: 1,
    }),
  ).toThrow('graph-baseline-unresolved-concern:global-unknown')
})

describeEachProvider('RFC-396 bounded large view directory', (harness) => {
  test('pages all relations, exposes exact scope, and locates or searches a late object', async () => {
    const f = await graphFixture(harness.db)
    const document = await f.commands.document('design-a')
    for (let i = 0; i < 300; i++) {
      document.elements.push({
        id: `item-${i}`,
        revision: 1,
        kind: 'behavior',
        role: 'action',
        label: `步骤 ${i}`,
        description: '大图步骤',
        sourceIds: ['request'],
      })
      document.relations.push({
        id: `edge-${i}`,
        revision: 1,
        kind: 'flow',
        from: i === 0 ? 'booking' : `item-${i - 1}`,
        to: `item-${i}`,
        label: `关系 ${i}`,
        sourceIds: ['request'],
      })
    }
    const flow = document.models[0]!
    if (flow.kind !== 'flow') throw new Error('fixture-flow')
    flow.elementIds = document.elements.map((item) => item.id)
    flow.relationIds = document.relations.map((item) => item.id)
    document.views[0]!.elementIds = flow.elementIds
    document.views[0]!.relationIds = flow.relationIds
    await f.commands.change('design-a', {
      expectedRevision: document.revision,
      requestId: 'large',
      document,
    })
    const first = await f.queries.view('design-a', 'overview', { limit: 50 })
    expect(first.elements).toHaveLength(50)
    expect(first.relations).toHaveLength(50)
    expect(first.renderings).toEqual([])
    expect(first.scope).toMatchObject({ total: 301, truncated: true })
    expect(first.relationScope).toMatchObject({ total: 300, truncated: true })
    const found = new Set<string>()
    for (let offset = 0; offset < 300; offset += 50) {
      const page = await f.queries.view('design-a', 'overview', { offset, limit: 50 })
      page.relations.forEach((relation) => found.add(relation.id))
    }
    expect(found.size).toBe(300)
    const focus = await f.queries.view('design-a', 'overview', { limit: 50, focusId: 'item-290' })
    expect(focus.scope.offset).toBe(250)
    expect(focus.elements.some((element) => element.id === 'item-290')).toBe(true)
    const search = await f.queries.view('design-a', 'overview', { search: '关系 299', limit: 50 })
    expect(search.relations.map((relation) => relation.id)).toEqual(['edge-299'])
    expect(search.scope.completeTotal).toBe(301)
  })
})
