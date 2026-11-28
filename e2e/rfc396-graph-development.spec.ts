// Model output and the code host are controlled fixtures. The daemon, Case, native
// clarify/review, Git, MR publication and external-state observation use production paths.
// Actual model-quality and hosted-provider acceptance are recorded separately in RFC-396.
// UI acceptance guards the automatic MR source-branch summary and narrow-screen HTML
// readability; document width alone misses content clipped by an internal scroll container.
//
// RFC-629: split with `e2e/rfc396-graph-development-recovery.spec.ts` so parallel Playwright
// workers execute the four long RFC-396 journeys concurrently without lowering coverage.
import { expect, test } from '@playwright/test'
import type { GraphDesignDocument } from '../packages/shared/src/schemas/graphDesign'
import {
  createGraphDevelopmentSuite,
  type GraphDevelopmentWorkspace,
} from './helpers/rfc396GraphDevelopment'

// Windows CI runs these journeys several times slower than macOS: on candidate 8481557c9 the
// notification journey took 29.8 s on a local macOS run and 3.0 min in the passing Windows retry of
// run 40512067066. The two external-observation waits and this limit leave room for that host.
test.setTimeout(600_000)

const suite = createGraphDevelopmentSuite('primary')

test.beforeAll(async () => {
  await suite.setup()
})

test.afterAll(async () => {
  await suite.teardown()
})

test('RFC-396 booking journey adapts graphs, publishes the accepted candidate and observes MR merge', async ({
  page,
}) => {
  await suite.journey(
    page,
    'Booking: prevent double reservation',
    'Add a priority rule for concurrent requests',
  )
})

// RFC-396: Mermaid edge IDs contain both endpoint render IDs. Matching any ID
// substring bound both actions to a path, overwrote labels and left nodes inert.
// Use actual connected renders for all four SVG adapters, including sequence mirrors.
test('RFC-396 connected diagrams select only their semantic nodes by mouse and keyboard', async ({
  page,
}) => {
  const caseId = (
    await suite.api<{ case: { id: string } }>(
      `/api/digital-employees/${suite.getEmployeeId()}/cases`,
      {
        name: 'Connected graph interaction',
        kind: 'body',
        body: 'Inspect connected diagrams while the original questions remain open.',
        externalId: null,
        target: { repositoryId: suite.getRepositoryId() },
        uploads: [],
        executionOptions: {},
        advanced: { typeOptions: {} },
        idempotencyKey: `${suite.tag}:connected-diagrams`,
      },
    )
  ).case.id
  let designId = ''
  await expect
    .poll(
      async () => {
        designId =
          (await suite.api<{ id: string } | null>(`/api/employee-cases/${caseId}/design`))?.id ?? ''
        return designId
      },
      { timeout: 60_000 },
    )
    .not.toBe('')
  const base = `/api/development-designs/${encodeURIComponent(designId)}`
  await expect
    .poll(async () => (await suite.api<GraphDevelopmentWorkspace>(base)).host.editableClarify, {
      timeout: 90_000,
    })
    .toBeTruthy()
  const original = (await suite.api<{ document: GraphDesignDocument }>(base)).document
  const sourceIds = original.sources.filter((source) => source.kind === 'material').map((s) => s.id)
  const document: GraphDesignDocument = {
    ...original,
    concerns: [],
    obligations: [],
    elements: [],
    relations: [],
    models: [],
    views: [],
  }
  for (const kind of ['flow', 'state', 'sequence', 'data'] as const) {
    const ids = [`${kind}-first`, `${kind}-second`]
    const relationId = `${kind}-edge`
    document.elements.push(
      ...ids.map((id, index) => {
        const common = {
          id,
          revision: 1,
          label: `${kind} node ${index + 1}`,
          description: 'Connected diagram interaction fixture',
          sourceIds,
        }
        return kind === 'data'
          ? { ...common, kind: 'entity' as const, fields: [] }
          : {
              ...common,
              kind: 'behavior' as const,
              role:
                kind === 'state'
                  ? ('state' as const)
                  : kind === 'sequence'
                    ? ('actor' as const)
                    : ('step' as const),
            }
      }),
    )
    document.relations.push({
      id: relationId,
      revision: 1,
      from: ids[0]!,
      to: ids[1]!,
      kind:
        kind === 'state'
          ? 'transition'
          : kind === 'sequence'
            ? 'message'
            : kind === 'data'
              ? 'data-reference'
              : 'flow',
      label: 'next',
      sourceIds,
    })
    const model = { id: `${kind}-model`, revision: 1, label: `Connected ${kind}`, sourceIds }
    if (kind === 'flow') {
      document.models.push({ ...model, kind, elementIds: ids, relationIds: [relationId] })
    } else if (kind === 'state') {
      document.models.push({
        ...model,
        kind,
        stateIds: ids,
        initialStateId: ids[0]!,
        terminalStateIds: [ids[1]!],
        transitions: [
          { relationId, event: 'advance', guards: [], actionRef: null, assertionRefs: [] },
        ],
      })
    } else if (kind === 'sequence') {
      document.models.push({
        ...model,
        kind,
        participantIds: ids,
        messageIds: [relationId],
        fragments: [],
      })
    } else {
      document.models.push({
        ...model,
        kind,
        entityIds: ids,
        relationships: [{ relationId, cardinality: 'one-many', required: true }],
      })
    }
    document.views.push({
      id: `${kind}-view`,
      revision: 1,
      title: `Connected ${kind}`,
      purpose: 'Inspect connected node interactions',
      concernIds: [],
      capabilityRef: { id: kind, version: 1 },
      modelIds: [model.id],
      elementIds: ids,
      relationIds: [relationId],
      sourceIds,
      status: 'current',
      pinned: false,
      explanation: 'Exercise real SVG containers without starting implementation.',
      limitations: ['Deterministic UI regression fixture'],
    })
  }
  await suite.api(`${base}/changes`, {
    expectedRevision: original.revision,
    requestId: `${suite.tag}:connected-diagrams`,
    document,
  })
  await suite.open(page, caseId)
  for (const kind of ['flow', 'state', 'sequence', 'data'] as const) {
    await page
      .getByRole('button', { name: `Connected ${kind}`, exact: true })
      .first()
      .click()
    const graph = page.getByRole('region', { name: `${kind}-model`, exact: true })
    const first = graph.getByRole('button', { name: `${kind} node 1`, exact: true })
    const second = graph.getByRole('button', { name: `${kind} node 2`, exact: true })
    const copies = kind === 'sequence' ? 2 : 1
    await expect(first).toHaveCount(copies)
    await expect(second).toHaveCount(copies)
    await expect(graph.locator('path[role="button"], line[role="button"]')).toHaveCount(0)
    const pressed = async (firstPressed: boolean, secondPressed: boolean) => {
      for (let index = 0; index < copies; index++) {
        await expect(first.nth(index)).toHaveAttribute('aria-pressed', String(firstPressed))
        await expect(second.nth(index)).toHaveAttribute('aria-pressed', String(secondPressed))
      }
    }
    await pressed(false, false)
    await first.first().click()
    await pressed(true, false)
    await expect(
      page
        .locator('.graph-design__list')
        .getByRole('button', { name: `✓ ${kind} node 1`, exact: true }),
    ).toBeVisible()
    await first.first().press('Enter')
    await pressed(false, false)
    await second.last().press('Space')
    await pressed(false, true)
    await expect(
      page
        .locator('.graph-design__list')
        .getByRole('button', { name: `✓ ${kind} node 2`, exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Clear selection', exact: true }).click()
    await pressed(false, false)
  }
})
