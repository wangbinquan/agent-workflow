// RFC-214 T2 — locks the <QueryState> gate: loading → error(+retry) → empty
// → data, plus the two design-gate corrections:
//   - MAJOR-4: isLoading-first, so an enabled:false query (isPending=true,
//     isLoading=false) does NOT spin forever;
//   - BLOCKER-1: keepDataOnError overlays ErrorBanner on top of cached rows
//     instead of short-circuiting (memory panels' contract).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { EmptyState } from '../src/components/EmptyState'
import { QueryState } from '../src/components/QueryState'
import '../src/i18n'

afterEach(() => cleanup())

const rows = (data: string[]) => (
  <ul data-testid="rows">
    {data.map((d) => (
      <li key={d}>{d}</li>
    ))}
  </ul>
)

describe('<QueryState />', () => {
  test('isLoading → LoadingState (with testid passthrough)', () => {
    const { getByTestId } = render(
      <QueryState query={{ isLoading: true }} data={[]} testid="tasks-loading">
        {rows}
      </QueryState>,
    )
    expect(getByTestId('tasks-loading')).not.toBeNull()
  })

  test('MAJOR-4: disabled query (isPending=true, isLoading=false) does NOT show LoadingState', () => {
    const { queryByTestId, getByText } = render(
      <QueryState query={{ isPending: true, isLoading: false }} data={[]} emptyText="Nothing">
        {rows}
      </QueryState>,
    )
    expect(queryByTestId('loading-state')).toBeNull()
    expect(getByText('Nothing')).not.toBeNull()
  })

  test('error → ErrorBanner with retry; retry calls refetch by default', () => {
    const refetch = vi.fn()
    const { getByRole } = render(
      <QueryState query={{ error: new Error('boom'), refetch }} data={[]}>
        {rows}
      </QueryState>,
    )
    fireEvent.click(getByRole('button', { name: 'Retry' }))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  test('BLOCKER-1: keepDataOnError overlays ErrorBanner on top of cached rows', () => {
    const refetch = vi.fn()
    const { getByRole, getByTestId } = render(
      <QueryState query={{ error: new Error('boom'), refetch }} data={['a', 'b']} keepDataOnError>
        {rows}
      </QueryState>,
    )
    expect(getByRole('button', { name: 'Retry' })).not.toBeNull() // banner present
    expect(getByTestId('rows')).not.toBeNull() // cached rows survive the error
  })

  test('without keepDataOnError, an error short-circuits (no rows)', () => {
    const { queryByTestId } = render(
      <QueryState query={{ error: new Error('boom') }} data={['a', 'b']}>
        {rows}
      </QueryState>,
    )
    expect(queryByTestId('rows')).toBeNull()
  })

  test('empty lightweight: emptyText → div.muted', () => {
    const { container, getByText } = render(
      <QueryState query={{}} data={[]} emptyText="No items">
        {rows}
      </QueryState>,
    )
    expect(container.querySelector('.muted')).not.toBeNull()
    expect(getByText('No items')).not.toBeNull()
  })

  test('empty heavyweight: empty=<EmptyState> wins over emptyText', () => {
    const { getByTestId, queryByText } = render(
      <QueryState
        query={{}}
        data={[]}
        emptyText="ignored"
        empty={<EmptyState title="Nothing here" />}
      >
        {rows}
      </QueryState>,
    )
    expect(getByTestId('empty-state')).not.toBeNull()
    expect(queryByText('ignored')).toBeNull()
  })

  test('empty with neither emptyText nor empty → renders null', () => {
    const { container } = render(
      <QueryState query={{}} data={[]}>
        {rows}
      </QueryState>,
    )
    expect(container.innerHTML).toBe('')
  })

  test('custom isEmpty is honored (data non-null but semantically empty)', () => {
    const { getByText } = render(
      <QueryState query={{}} data={{ count: 0 }} isEmpty={(d) => d.count === 0} emptyText="Zero">
        {(d) => <span>{d.count}</span>}
      </QueryState>,
    )
    expect(getByText('Zero')).not.toBeNull()
  })

  test('data → children receives the value', () => {
    const { getByTestId } = render(
      <QueryState query={{}} data={['x', 'y']}>
        {rows}
      </QueryState>,
    )
    expect(getByTestId('rows').textContent).toContain('x')
    expect(getByTestId('rows').textContent).toContain('y')
  })
})
