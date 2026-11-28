// RFC-629: companion spec split from `e2e/rfc396-graph-development.spec.ts` so the
// existing-module and abrupt-restart notification recovery journeys run in their own
// Playwright worker and daemon lifecycle without reducing coverage.
import { test } from '@playwright/test'
import { createGraphDevelopmentSuite } from './helpers/rfc396GraphDevelopment'

test.setTimeout(600_000)

const suite = createGraphDevelopmentSuite('recovery')

test.beforeAll(async () => {
  await suite.setup()
})

test.afterAll(async () => {
  await suite.teardown()
})

test('RFC-396 existing-module journey preserves the interface and adds exception rules', async ({
  page,
}) => {
  await suite.journey(
    page,
    'Existing module: preserve the public interface',
    'Add an exception for incompatible responses',
  )
})

test('RFC-396 notification journey adapts graphs and observes MR close without merging', async ({
  page,
}) => {
  await suite.journey(
    page,
    'Notifications: deliver asynchronous messages',
    'Add duplicate and out-of-order handling',
    'closed',
  )
})
