// Received usage must stay numeric; repeated coverage prose belongs behind a
// compact disclosure, and 0 registered calls must not read as proven 0/0 use.
import { afterEach, expect, test } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import type { CompleteObservationMetrics } from '@agent-workflow/shared'
import {
  CompleteCost,
  CompleteMetrics,
  CompleteTokens,
} from '../src/components/observability/CompleteObservationMetrics'
import { FormSection } from '../src/components/FormSection'
import { CompleteObservationTrend } from '../src/components/observability/CompleteObservationTrend'
import i18n from '../src/i18n'
afterEach(cleanup)

const value: CompleteObservationMetrics = {
  state: 'not-ready',
  gaps: ['usage-incomplete'],
  tokenCoverage: {
    invocations: '0',
    observedInvocations: '0',
    records: '1',
    bucketRecords: { input: '1', cacheRead: '1', cacheWrite: '1', output: '1' },
    historicalReferences: '1',
    observedHistoricalReferences: '1',
  },
  recordedUsage: {
    invocations: '0',
    observedInvocations: '0',
    historicalReferences: '1',
    observedHistoricalReferences: '1',
    records: '1',
    bucketRecords: { input: '1', cacheRead: '1', cacheWrite: '1', output: '1' },
    tokens: {
      input: '9007199254740993',
      cacheRead: '0',
      cacheWrite: '0',
      output: '7',
      total: '9007199254741000',
    },
  },
  recordedCost: {
    currency: 'CNY',
    amount: '0.007',
    records: '1',
    pricedRecords: '0',
    partiallyPricedRecords: '1',
  },
}

test('all repeated measurements retain exact values and one initially collapsed collection marker', async () => {
  await i18n.changeLanguage('zh-CN')
  const page = render(
    <table>
      <tbody>
        {[1, 2, 3].map((id) => (
          <tr key={id}>
            <td>
              <CompleteTokens value={value} />
            </td>
            <td>
              <CompleteCost value={value} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>,
  )
  for (const row of page.container.querySelectorAll('tr')) {
    const cells = row.querySelectorAll('td')
    expect(cells[0]!.firstElementChild?.textContent).toBe('9,007,199,254,741,000')
    expect(
      [...cells[0]!.querySelectorAll('[data-token-buckets] dd')].map((e) => e.textContent),
    ).toEqual(['9,007,199,254,740,993', '0', '0', '7'])
    expect(cells[1]!.firstElementChild?.textContent).toBe('¥0.007')
    const details = cells[0]!.querySelector('details')!
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toBe('记录不完整')
    expect(cells[0]!.textContent).not.toContain('0 / 0')
    // The four-category and historical proofs remain reachable without
    // becoming another line of visible text in every table row.
    fireEvent.click(details.querySelector('summary')!)
    expect(details.open).toBe(true)
    expect(
      within(details).getByRole('group', { name: i18n.t('runObservability.bucketCoverage') })
        .textContent,
    ).toContain('1 条记录')
    expect(details.textContent).toContain(
      i18n.t('runObservability.historicalObservedCoverage', { observed: '1', references: '1' }),
    )
    fireEvent.click(details.querySelector('summary')!)
    expect(details.open).toBe(false)
  }
})

test('the shared compact disclosure retains native open/close semantics and does not add a heading per table cell', () => {
  const page = render(
    <FormSection collapsible size="compact" title="Collection details">
      <p>Original record</p>
    </FormSection>,
  )
  const details = page.container.querySelector('details')!
  expect(details.open).toBe(false)
  expect(page.queryByRole('heading')).toBeNull()
  fireEvent.click(details.querySelector('summary')!)
  expect(details.open).toBe(true)
  expect(details.textContent).toContain('Original record')
})

test('a historical record with no registered call is explicit in the full metric details without a fabricated 0/0 coverage', () => {
  const page = render(<CompleteMetrics value={value} />)
  expect(page.container.textContent).toContain(i18n.t('runObservability.noRegisteredCalls'))
  expect(page.container.textContent).not.toContain('0 / 0')
  expect(page.container.textContent).toContain('9,007,199,254,741,000')
  expect(page.container.textContent).toContain('¥0.007')
})

test('trend selection preserves a valid disclosure container for partial CNY instead of nesting block details in a paragraph', () => {
  const page = render(
    <CompleteObservationTrend
      rows={[{ key: 'original', from: 1, to: 2, tasks: '1', metrics: value }]}
      onRange={() => {}}
    />,
  )
  const interval = page.getByRole('group', { name: i18n.t('runObservability.trendInterval') })
  expect(interval.querySelector('p details')).toBeNull()
  expect(interval.querySelector('.observation-trend__cost strong')?.textContent).toBe('¥0.007')
  expect([...interval.querySelectorAll('details')].every((details) => !details.open)).toBe(true)
})
