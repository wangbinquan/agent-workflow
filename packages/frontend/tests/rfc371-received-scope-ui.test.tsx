// RFC-371: each actual scope exposes its received nullable buckets without an oversized warning panel.
import { cleanup, render, within } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import type { CompleteObservationMetrics } from '@agent-workflow/shared'
import {
  CompleteMetrics,
  CompleteTokens,
} from '../src/components/observability/CompleteObservationMetrics'
import { CompleteObservationTrend } from '../src/components/observability/CompleteObservationTrend'
import i18n from '../src/i18n'

afterEach(cleanup)
const value: CompleteObservationMetrics = {
  state: 'not-ready',
  gaps: ['usage-unobserved'],
  tokenCoverage: {
    invocations: '2',
    observedInvocations: '1',
    records: '2',
    bucketRecords: { input: '1', cacheRead: '0', cacheWrite: '1', output: '1' },
  },
  recordedUsage: {
    invocations: '2',
    observedInvocations: '1',
    records: '2',
    bucketRecords: { input: '1', cacheRead: '0', cacheWrite: '1', output: '1' },
    tokens: {
      input: '9007199254740993',
      cacheRead: null,
      cacheWrite: '0',
      output: '7',
      total: '9007199254741000',
    },
  },
  costCoverage: { records: '2', pricedRecords: '0', visibility: 'visible' },
}

for (const language of ['zh', 'en'])
  test('scope received bins and compact coverage remain exact in ' + language, async () => {
    await i18n.changeLanguage(language)
    const page = render(<CompleteMetrics value={value} />)
    expect(page.container.querySelector('.detail-grid')).not.toBeNull()
    expect(page.container.querySelector('.notice-banner')).toBeNull()
    expect(
      [...page.container.querySelectorAll('[data-token-bucket] dd')].map(
        (node) => node.textContent,
      ),
    ).toEqual([
      '9,007,199,254,740,993 · 1 / 2',
      i18n.t('runObservability.unknown') + ' · 0 / 2',
      '0 · 1 / 2',
      '7 · 1 / 2',
    ])
    expect(page.container.textContent).toContain('9,007,199,254,741,000')
    expect(page.container.textContent).toContain('1 / 2')
    expect(page.container.textContent).not.toContain('¥0')
  })

test('the scope metrics own received values take priority over a different old overview subset', () => {
  const page = render(
    <CompleteTokens
      value={value}
      recordedUsage={{
        invocations: '9',
        observedInvocations: '9',
        records: '9',
        tokens: { input: '999', cacheRead: '999', cacheWrite: '999', output: '999', total: '3996' },
      }}
    />,
  )
  expect(page.container.textContent).toContain('9,007,199,254,741,000')
  expect(page.container.textContent).not.toContain('3,996')
  expect(page.container.textContent).toContain(i18n.t('runObservability.reportNotReady'))
  expect(page.container.textContent).not.toContain(i18n.t('runObservability.recordedUsageWarning'))
})

test('nullable received trend draws only actual known segments and prints exact classification values', () => {
  const page = render(
    <CompleteObservationTrend
      rows={[{ key: 'original', from: 1, to: 2, tasks: '1', metrics: value }]}
      onRange={() => {}}
    />,
  )
  const column = page.container.querySelector<HTMLButtonElement>('[data-observation-trend] button')!
  expect(column.getAttribute('aria-label')).toContain('9,007,199,254,741,000')
  expect(column.querySelector('[data-positive="true"]')).not.toBeNull()
  expect((column.querySelector('[data-token-color="cacheRead"]') as HTMLElement).style.height).toBe(
    '0%',
  )
  expect(
    within(page.getByRole('group', { name: i18n.t('runObservability.trendInterval') })).getByText(
      '9,007,199,254,741,000',
    ),
  ).toBeTruthy()
})
