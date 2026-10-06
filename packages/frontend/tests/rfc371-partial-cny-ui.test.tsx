// RFC-371: actual partial CNY remains explicit beside nullable buckets in the original amount component.
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import type { CompleteObservationMetrics } from '@agent-workflow/shared'
import {
  CompleteMetrics,
  CompleteCost,
} from '../src/components/observability/CompleteObservationMetrics'
import i18n from '../src/i18n'
afterEach(cleanup)
const value: CompleteObservationMetrics = {
  state: 'not-ready',
  gaps: ['usage-incomplete'],
  tokenCoverage: {
    invocations: '1',
    observedInvocations: '1',
    records: '1',
    bucketRecords: { input: '1', cacheRead: '0', cacheWrite: '1', output: '0' },
  },
  recordedUsage: {
    invocations: '1',
    observedInvocations: '1',
    records: '1',
    bucketRecords: { input: '1', cacheRead: '0', cacheWrite: '1', output: '0' },
    tokens: { input: '120', cacheRead: null, cacheWrite: '0', output: null, total: '120' },
  },
  costCoverage: {
    records: '1',
    pricedRecords: '0',
    partiallyPricedRecords: '1',
    visibility: 'visible',
  },
  recordedCost: {
    currency: 'CNY',
    amount: '0.00012',
    records: '1',
    pricedRecords: '0',
    partiallyPricedRecords: '1',
  },
}
for (const language of ['zh', 'en'])
  test('known partial amount and both record classes remain visible in ' + language, async () => {
    await i18n.changeLanguage(language)
    const page = render(<CompleteMetrics value={value} />)
    expect(page.container.textContent).toContain('¥0.00012')
    expect(page.container.textContent).toContain(
      i18n.t('runObservability.recordedPartialCostCoverage', {
        priced: '0',
        partial: '1',
        records: '1',
      }),
    )
    expect(
      [...page.container.querySelectorAll('[data-token-bucket] dd')].map(
        (node) => node.textContent,
      ),
    ).toEqual([
      '120 · 1 / 1',
      i18n.t('runObservability.unknown') + ' · 0 / 1',
      '0 · 1 / 1',
      i18n.t('runObservability.unknown') + ' · 0 / 1',
    ])
    expect(page.container.querySelector('.notice-banner')).toBeNull()
  })
test('actual partial zero is visible and does not become a full estimate', () => {
  const zero: CompleteObservationMetrics = {
    ...value,
    recordedCost: { ...value.recordedCost!, amount: '0' },
  }
  const page = render(<CompleteCost value={zero} />)
  expect(page.container.textContent).toContain('¥0')
  expect(page.container.textContent).toContain(
    i18n.t('runObservability.recordedPartialCostCoverage', {
      priced: '0',
      partial: '1',
      records: '1',
    }),
  )
})
