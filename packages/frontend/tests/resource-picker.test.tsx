// RFC-151 PR-2 — ResourcePicker<T> configuration contract.
//
// The four resource pickers (Skills/Mcps/Plugins/AgentDepends) are thin
// config shells over this one component; their behavior tests keep running
// unchanged against the wrappers. This file locks the config surface itself:
//   1. labelFn drives dropdown row labels; nameOf defaults to `item.name`.
//   2. default filter excludes already-selected names; a custom filter
//      receives (item, existing) and fully replaces the default.
//   3. trigger label three-state: labels.loading while the query is in
//      flight, labels.empty when nothing survives the filter, labels.pick
//      otherwise; labels.loadFailed shows (and the dropdown hides) on error.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ResourcePicker, type ResourcePickerLabels } from '../src/components/ResourcePicker'
import { setBaseUrl, setToken } from '../src/stores/auth'

interface Row {
  name: string
  description: string
  enabled: boolean
}

const LABELS: ResourcePickerLabels = {
  loading: 'picker loading…',
  empty: 'picker empty',
  pick: 'pick a row',
  loadFailed: 'row list failed to load',
}

function row(name: string, description = '', enabled = true): Row {
  return { name, description, enabled }
}

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

function mockRows(rows: Row[]) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(rows), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  // Unmount via testing-library first — the Select listbox is portaled to
  // document.body, so wiping innerHTML before cleanup() races React's
  // removeChild and crashes happy-dom.
  cleanup()
  vi.restoreAllMocks()
})

async function openPicker() {
  const trigger = (await waitFor(() => screen.getByRole('combobox'))) as HTMLButtonElement
  await waitFor(() => expect(trigger.disabled).toBe(false))
  fireEvent.click(trigger)
  return screen.getByRole('listbox')
}

function optionLabels(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole('option')
    .map((o) => o.textContent ?? '')
}

describe('ResourcePicker — config surface', () => {
  test('labelFn drives option labels; default nameOf commits item.name', async () => {
    mockRows([row('alpha', 'first'), row('beta')])
    const onChange = vi.fn()
    wrap(
      <ResourcePicker<Row>
        value={[]}
        onChange={onChange}
        queryKey={['rp-test', 'labelfn']}
        endpoint="/api/rows"
        labelFn={(r) => (r.description ? `${r.name} :: ${r.description}` : r.name)}
        labels={LABELS}
      />,
    )
    const list = await openPicker()
    expect(optionLabels(list)).toEqual(['alpha :: first', 'beta'])
    // Picking commits nameOf(item) (default: .name), not the display label.
    fireEvent.mouseDown(within(list).getByText('alpha :: first'))
    expect(onChange).toHaveBeenCalledWith(['alpha'])
  })

  test('default filter drops names already in value', async () => {
    mockRows([row('a'), row('b'), row('c')])
    wrap(
      <ResourcePicker<Row>
        value={['b']}
        onChange={() => {}}
        queryKey={['rp-test', 'default-filter']}
        endpoint="/api/rows"
        labelFn={(r) => r.name}
        labels={LABELS}
      />,
    )
    const list = await openPicker()
    expect(optionLabels(list)).toEqual(['a', 'c'])
  })

  test('custom filter replaces the default and receives the existing set', async () => {
    mockRows([row('on', '', true), row('off', '', false), row('picked', '', true)])
    wrap(
      <ResourcePicker<Row>
        value={['picked']}
        onChange={() => {}}
        queryKey={['rp-test', 'custom-filter']}
        endpoint="/api/rows"
        labelFn={(r) => r.name}
        filter={(r, existing) => r.enabled && !existing.has(r.name)}
        labels={LABELS}
      />,
    )
    const list = await openPicker()
    // 'off' fails the enabled predicate, 'picked' fails the existing set.
    expect(optionLabels(list)).toEqual(['on'])
  })

  test('custom nameOf switches the committed identity', async () => {
    mockRows([row('display-a', 'ID_A'), row('display-b', 'ID_B')])
    const onChange = vi.fn()
    wrap(
      <ResourcePicker<Row>
        value={['ID_B']}
        onChange={onChange}
        queryKey={['rp-test', 'nameof']}
        endpoint="/api/rows"
        labelFn={(r) => r.name}
        nameOf={(r) => r.description}
        labels={LABELS}
      />,
    )
    const list = await openPicker()
    // Default filter keys off nameOf → 'display-b' (ID_B) is excluded.
    expect(optionLabels(list)).toEqual(['display-a'])
    fireEvent.mouseDown(within(list).getByText('display-a'))
    expect(onChange).toHaveBeenCalledWith(['ID_B', 'ID_A'])
  })

  test('loading state pins labels.loading on the disabled trigger', async () => {
    // Never-resolving fetch keeps the query in flight for the whole test.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}))
    wrap(
      <ResourcePicker<Row>
        value={[]}
        onChange={() => {}}
        queryKey={['rp-test', 'loading']}
        endpoint="/api/rows"
        labelFn={(r) => r.name}
        labels={LABELS}
      />,
    )
    const trigger = (await waitFor(() => screen.getByRole('combobox'))) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    expect(trigger.textContent).toContain(LABELS.loading)
  })

  test('settled-but-empty state pins labels.empty on the disabled trigger', async () => {
    mockRows([row('only')])
    wrap(
      <ResourcePicker<Row>
        value={['only']}
        onChange={() => {}}
        queryKey={['rp-test', 'empty']}
        endpoint="/api/rows"
        labelFn={(r) => r.name}
        labels={LABELS}
      />,
    )
    const trigger = (await waitFor(() => screen.getByRole('combobox'))) as HTMLButtonElement
    await waitFor(() => expect(trigger.textContent).toContain(LABELS.empty))
    expect(trigger.disabled).toBe(true)
  })

  test('load failure hides the dropdown and shows labels.loadFailed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, code: 'boom' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    )
    wrap(
      <ResourcePicker<Row>
        value={[]}
        onChange={() => {}}
        queryKey={['rp-test', 'failed']}
        endpoint="/api/rows"
        labelFn={(r) => r.name}
        labels={LABELS}
      />,
    )
    await waitFor(() => screen.getByText(LABELS.loadFailed))
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  test('testid lands on the Select trigger', async () => {
    mockRows([row('a')])
    wrap(
      <ResourcePicker<Row>
        value={[]}
        onChange={() => {}}
        queryKey={['rp-test', 'testid']}
        endpoint="/api/rows"
        labelFn={(r) => r.name}
        testid="rp-under-test"
        labels={LABELS}
      />,
    )
    const trigger = await waitFor(() => screen.getByTestId('rp-under-test'))
    expect(trigger).toBe(screen.getByRole('combobox'))
  })
})
