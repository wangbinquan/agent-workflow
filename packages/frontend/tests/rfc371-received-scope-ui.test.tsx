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
    ).toEqual(['9,007,199,254,740,993', i18n.t('runObservability.unknown'), '0', '7'])
    expect(page.container.textContent).toContain('9,007,199,254,741,000')
    const coverage = page.getByRole('group', {
      name: i18n.t('runObservability.bucketCoverage'),
      hidden: true,
    })
    expect(
      [...coverage.querySelectorAll('[data-token-coverage] dd')].map((row) => row.textContent),
    ).toEqual(['1 / 2', '0 / 2', '1 / 2', '1 / 2'])
    expect(coverage.querySelector('[data-token-bucket]')).toBeNull()
    expect(page.container.querySelector('[data-token-buckets]')?.contains(coverage)).toBe(false)
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
  expect(page.container.textContent).toContain(i18n.t('runObservability.usageIncomplete'))
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

// The actual summary must keep values readable at narrow widths; category record
// counts remain labelled below them, with complete and incomplete states intact.
test('the summary separates exact category values from record coverage and sizes its columns for the longest value', async () => {
  await i18n.changeLanguage('zh')
  const page = render(<CompleteTokens value={value} compact />)
  const buckets = page.container.querySelector<HTMLElement>('[data-token-buckets]')!
  expect(buckets.classList.contains('observation-token-buckets--summary')).toBe(true)
  expect([...buckets.querySelectorAll('dd')].map((row) => row.textContent)).toEqual([
    '9,007,199,254,740,993',
    i18n.t('runObservability.unknown'),
    '0',
    '7',
  ])
  expect(buckets.textContent).not.toContain('1 / 2')
  const coverage = page.getByRole('group', { name: '分类用量采集情况', hidden: true })
  expect(coverage.textContent).toContain('0 / 2')
  expect(coverage.closest('details')?.parentElement).toBe(buckets.parentElement)
  expect(coverage.closest('details')?.open).toBe(false)
  expect(buckets.style.getPropertyValue('--observation-token-value-width')).toBe('21ch')
})

test('fully collected categories retain their labelled record note inside the collapsed collection details', async () => {
  await i18n.changeLanguage('zh')
  const original = value.state === 'not-ready' ? value.recordedUsage! : undefined
  if (!original) throw new Error('Original recorded bins missing')
  const completeCategories: CompleteObservationMetrics = {
    ...value,
    recordedUsage: {
      ...original,
      tokens: { ...original.tokens, cacheRead: '0' },
      bucketRecords: { input: '2', cacheRead: '2', cacheWrite: '2', output: '2' },
    },
  }
  const page = render(<CompleteTokens value={completeCategories} compact />)
  expect(page.getByRole('group', { name: '分类用量采集情况', hidden: true }).textContent).toBe(
    '2 条记录的四类用量均已采集',
  )
  expect(page.container.querySelector('[data-token-buckets]')?.textContent).not.toContain('/ 2')
  expect(page.container.textContent).toContain(
    i18n.t('runObservability.recordedUsageCompact', { observed: '1', calls: '2' }),
  )
})
