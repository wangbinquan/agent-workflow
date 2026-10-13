// RFC-371: the custom window was reachable only by chart drill-down. The real
// filters must accept local dates without querying while the user edits them.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ObservationFilters } from '../src/components/observability/ObservationFilters'
import {
  observationCustomRange,
  observationLocalDateInput,
} from '../src/components/observability/observationCustomRange'
import { observationPresetRange } from '../src/components/observability/observationPresetRange'
import type { ObservationSearch } from '../src/components/observability/RunObservability'
import i18n from '../src/i18n'

const to = Date.parse('2026-10-13T10:11:12.345Z')
const search: ObservationSearch = {
  period: 'week',
  from: to - 7 * 86400000,
  to,
  tab: 'usage',
  cohort: 'usage',
  q: 'original task',
  repository: '/original/repository',
  selection: JSON.stringify({
    runtime: {
      authority: 'local',
      sourceId: null,
      registrationId: 'original-runtime',
      configurationRevision: 2,
      protocol: 'opencode',
    },
  }),
  after: 'old-page',
  agent: 'old-agent',
}
beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
})
afterEach(cleanup)

test('editing both local boundaries is deferred until Apply and keeps the original filters', () => {
  const change = vi.fn()
  render(<ObservationFilters search={search} onChange={change} />)
  const from = '2026-09-01T08:15',
    until = '2026-10-01T19:30'
  fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: from } })
  fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: until } })
  expect(change).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '应用时间范围' }))
  expect(change).toHaveBeenCalledExactlyOnceWith({
    ...search,
    period: 'custom',
    from: Date.parse(from),
    to: Date.parse(until),
    after: undefined,
    agent: undefined,
    quality: undefined,
    runtime: undefined,
    model: undefined,
  })
})

test.each(['', '2026-10-14T09:30'])(
  'an empty or reversed start stays local and announces an error: %s',
  (value) => {
    const change = vi.fn()
    render(<ObservationFilters search={search} onChange={change} />)
    fireEvent.change(screen.getByLabelText('开始时间'), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: '应用时间范围' }))
    expect(change).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('结束时间必须晚于开始时间')
    expect(screen.getByLabelText('开始时间').getAttribute('aria-invalid')).toBe('true')
  },
)

test('the CS date row replaces the period dropdown and each shortcut shares the exact cutoff', () => {
  const change = vi.fn()
  render(<ObservationFilters search={search} onChange={change} />)
  const range = screen.getByRole('group', { name: '消耗发生时间' })
  expect(screen.queryByRole('combobox', { name: '消耗发生时间' })).toBeNull()
  expect(range.contains(screen.getByLabelText('开始时间'))).toBe(true)
  expect(range.contains(screen.getByLabelText('结束时间'))).toBe(true)
  expect(range.contains(screen.getByRole('button', { name: '应用时间范围' }))).toBe(true)
  expect(range.contains(screen.getByRole('combobox', { name: '执行状态' }))).toBe(false)
  expect(screen.getByRole('button', { name: '近 7 天' }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: '近 1 天' }))
  expect(change).toHaveBeenCalledWith(
    expect.objectContaining({
      period: 'day',
      ...observationPresetRange('day', to),
      tab: 'usage',
      q: search.q,
    }),
  )
})

test('untouched custom boundaries retain seconds and a shared URL restores exact dates', () => {
  const change = vi.fn(),
    custom = { ...search, period: 'custom' as const }
  render(<ObservationFilters search={custom} onChange={change} />)
  expect((screen.getByLabelText('开始时间') as HTMLInputElement).value).toBe(
    observationLocalDateInput(search.from),
  )
  fireEvent.click(screen.getByRole('button', { name: '应用时间范围' }))
  expect(change).toHaveBeenCalledWith(
    expect.objectContaining({ period: 'custom', from: search.from, to }),
  )
  expect(
    observationCustomRange({ from: '2026-02-30T10:00', to: '2026-03-02T10:00' }, search),
  ).toBeNull()
  expect(
    observationCustomRange({ from: '2026-03-02T10:00', to: '2026-03-02T10:00' }, search),
  ).toBeNull()
})

test('English date controls and Apply use the same shared form primitives', async () => {
  await i18n.changeLanguage('en')
  render(<ObservationFilters search={search} onChange={() => {}} />)
  expect(screen.getByLabelText('Started at').classList.contains('form-input')).toBe(true)
  expect(screen.getByLabelText('Ended at').classList.contains('form-input')).toBe(true)
  expect(screen.getByRole('button', { name: 'Apply time range' }).classList.contains('btn')).toBe(
    true,
  )
})

test('an edit is discarded after navigation to another exact window and cannot overwrite that range', () => {
  const change = vi.fn(),
    editing = vi.fn()
  const view = render(
    <ObservationFilters search={search} onChange={change} onEditingTimeRange={editing} />,
  )
  fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '2026-09-01T08:15' } })
  expect(editing).toHaveBeenLastCalledWith(true)
  const next = { ...search, period: 'custom' as const, from: to - 86400000, to }
  view.rerender(<ObservationFilters search={next} onChange={change} onEditingTimeRange={editing} />)
  expect((screen.getByLabelText('开始时间') as HTMLInputElement).value).toBe(
    observationLocalDateInput(next.from),
  )
  expect(editing).toHaveBeenLastCalledWith(false)
  fireEvent.click(screen.getByRole('button', { name: '应用时间范围' }))
  expect(change).toHaveBeenCalledWith(expect.objectContaining({ from: next.from, to: next.to }))
})
