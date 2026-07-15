import type { Page, Route } from '@playwright/test'

interface PopulatedInboxOptions {
  rows?: number
  workgroupError?: boolean
}

const LONG_TITLE = 'MigrationReadinessWithoutBreaks'.repeat(5).slice(0, 128)
const LONG_TASK_NAME = 'CustomerMigrationTaskWithoutBreaks'.repeat(5).slice(0, 128)

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })

/** Route stable, task-focused inbox data without creating full workflow runs. */
export async function routePopulatedInbox(
  page: Page,
  { rows = 32, workgroupError = false }: PopulatedInboxOptions = {},
): Promise<void> {
  const reviewCount = Math.ceil(rows / 2)
  const clarifyCount = Math.floor(rows / 2)
  const now = Date.now()
  const reviews = Array.from({ length: reviewCount }, (_, index) => ({
    nodeRunId: `visual-review-${index}`,
    taskId: `task-review-${index}`,
    taskName: index === 0 ? LONG_TASK_NAME : `Migration task ${index + 1}`,
    workflowId: 'wf-visual-review',
    workflowName: 'Release readiness workflow',
    reviewNodeId: `review-node-${index}`,
    title: index === 0 ? LONG_TITLE : `Review deployment evidence ${index + 1}`,
    description: '',
    currentVersionIndex: 1,
    reviewIteration: 0,
    decision: 'awaiting',
    awaitingReview: true,
    shardKey: null,
    createdAt: now - (index + 5) * 60_000,
    decidedAt: null,
  }))
  const clarify = Array.from({ length: clarifyCount }, (_, index) => ({
    id: `visual-clarify-${index}`,
    taskId: `task-clarify-${index}`,
    taskName: `Billing reconciliation task ${index + 1}`,
    kind: 'self',
    askingNodeId: `agent-${index}`,
    askingNodeTitle: index === 0 ? 'Implementation Coder with extended context' : 'Coder',
    askingShardKey: null,
    intermediaryNodeId: `clarify-node-${index}`,
    intermediaryNodeTitle:
      index === 0
        ? 'Confirm the rollout window and the exact approval owner before deployment'
        : `Clarify rollout detail ${index + 1}`,
    intermediaryNodeRunId: `clarify-run-${index}`,
    targetConsumerNodeId: null,
    loopIter: 0,
    iteration: index,
    questionCount: 2,
    status: 'awaiting_human',
    directive: null,
    createdAt: now - (index + 6) * 60_000 - 30_000,
    answeredAt: null,
  }))

  await page.route('**/api/reviews**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/reviews/pending-count') return json(route, { count: reviewCount })
    if (url.pathname === '/api/reviews' && url.searchParams.get('status') === 'pending') {
      return json(route, reviews)
    }
    return route.fallback()
  })
  await page.route('**/api/clarify**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/clarify/pending-count') return json(route, { count: clarifyCount })
    if (url.pathname === '/api/clarify' && url.searchParams.get('status') === 'awaiting_human') {
      return json(route, clarify)
    }
    return route.fallback()
  })
  await page.route('**/api/workgroup-tasks/pending-count', (route) => {
    if (workgroupError) {
      return json(route, { code: 'workgroup_unavailable', message: 'fixture failure' }, 500)
    }
    return json(route, { deliveries: 2, gates: 1, total: 3 })
  })
}
