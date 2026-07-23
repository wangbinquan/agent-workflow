// RFC-151 PR-2 → RFC-173 T3 — ResourcePicker<T> config surface, re-locked for
// the <MultiSelect> rewrite. New contract (design §3):
//   1. labelFn drives row titles; value identity is always item.name (the old
//      `nameOf` generalization is gone).
//   2. candidates = eligible ∪ already-selected: a selected row stays in the
//      dropdown CHECKED (not filtered out), so it can be un-checked — including
//      one that has since lost eligibility.
//   3. eligibility `filter` narrows which UN-selected rows may be added.
//   4. loading / empty show as dropdown rows; load failure shows labels.loadFailed
//      and (allowCustom) still lets you type a name.
//   5. testid lands on the combobox input; getByRole('combobox') is it.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ResourcePicker, type ResourcePickerLabels } from '../src/components/ResourcePicker'
import { setBaseUrl, setToken } from '../src/stores/auth'

// RFC-223 (PR-1): rows carry an id distinct from the name so the tests prove
// the picker stores the ID (value identity) while the label shows the name.
interface Row {
  id: string
  name: string
  description: string
  enabled: boolean
  ownerUserId?: string | null
}

const LABELS: ResourcePickerLabels = {
  loading: 'picker loading…',
  empty: 'picker empty',
  loadFailed: 'row list failed to load',
}

function row(name: string, description = '', enabled = true): Row {
  return { id: `id-${name}`, name, description, enabled }
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
  cleanup()
  vi.restoreAllMocks()
})

const combo = () => screen.getByRole('combobox') as HTMLInputElement
async function openPicker() {
  const input = (await waitFor(() => screen.getByRole('combobox'))) as HTMLInputElement
  fireEvent.focus(input)
  const list = screen.getByRole('listbox')
  // The query may still be resolving when we open — wait for the option rows to
  // render (until then the listbox only holds the loading/empty presentation row).
  await waitFor(() => within(list).getAllByRole('option'))
  return list
}
function optionRows(list: HTMLElement) {
  return within(list).getAllByRole('option')
}

const baseProps = {
  ariaLabel: 'Rows',
  labelFn: (r: Row) => r.name,
  labels: LABELS,
} as const

describe('ResourcePicker — config surface (MultiSelect)', () => {
  test('labelFn drives row titles; toggling commits item.id', async () => {
    mockRows([row('alpha', 'first'), row('beta')])
    const onChange = vi.fn()
    wrap(
      <ResourcePicker<Row>
        {...baseProps}
        value={[]}
        onChange={onChange}
        queryKey={['rp-test', 'labelfn']}
        endpoint="/api/rows"
        descriptionFn={(r) => r.description || undefined}
      />,
    )
    const list = await openPicker()
    expect(optionRows(list).map((o) => o.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('alpha'), expect.stringContaining('beta')]),
    )
    fireEvent.mouseDown(optionRows(list).find((o) => o.textContent?.includes('alpha'))!)
    // RFC-223 (PR-1): commits the resource ID, not the name.
    expect(onChange).toHaveBeenCalledWith(['id-alpha'])
  })

  test('duplicate names are disambiguated by owner while selection remains id-based', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input.toString()
      const payload = url.includes('/api/users/lookup')
        ? [
            { id: 'owner-a', username: 'alice', displayName: 'Alice' },
            { id: 'owner-b', username: 'bob', displayName: 'Bob' },
          ]
        : [
            {
              id: 'row-a',
              name: 'shared',
              description: '',
              enabled: true,
              ownerUserId: 'owner-a',
            },
            {
              id: 'row-b',
              name: 'shared',
              description: '',
              enabled: true,
              ownerUserId: 'owner-b',
            },
          ]
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const onChange = vi.fn()
    wrap(
      <ResourcePicker<Row>
        {...baseProps}
        value={[]}
        onChange={onChange}
        queryKey={['rp-test', 'duplicate-owner']}
        endpoint="/api/rows"
      />,
    )
    const list = await openPicker()
    const alice = await within(list).findByRole('option', { name: /shared · Alice/ })
    expect(within(list).getByRole('option', { name: /shared · Bob/ })).toBeTruthy()
    fireEvent.mouseDown(alice)
    expect(onChange).toHaveBeenCalledWith(['row-a'])
  })

  test('selected rows stay in the dropdown, CHECKED (not filtered out)', async () => {
    mockRows([row('a'), row('b'), row('c')])
    wrap(
      <ResourcePicker<Row>
        {...baseProps}
        value={['id-b']}
        onChange={() => {}}
        queryKey={['rp-test', 'selected-checked']}
        endpoint="/api/rows"
      />,
    )
    const list = await openPicker()
    const rows = optionRows(list)
    expect(rows.map((o) => o.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('a'),
        expect.stringContaining('b'),
        expect.stringContaining('c'),
      ]),
    )
    const b = rows.find((o) => o.textContent?.includes('b'))!
    expect(b.getAttribute('aria-selected')).toBe('true')
  })

  test('eligibility filter narrows UN-selected rows; a selected-ineligible row still shows checked', async () => {
    mockRows([row('on', '', true), row('off', '', false), row('picked-off', '', false)])
    wrap(
      <ResourcePicker<Row>
        {...baseProps}
        value={['id-picked-off']}
        onChange={() => {}}
        queryKey={['rp-test', 'eligibility']}
        endpoint="/api/rows"
        filter={(r) => r.enabled}
      />,
    )
    const list = await openPicker()
    const texts = optionRows(list).map((o) => o.textContent ?? '')
    // 'on' is eligible → offered; 'off' is ineligible + unselected → excluded;
    // 'picked-off' is ineligible but selected → still shown (checked).
    expect(texts.some((t) => t.includes('on'))).toBe(true)
    expect(texts.some((t) => t === 'off' || t.startsWith('off'))).toBe(false)
    const picked = optionRows(list).find((o) => o.textContent?.includes('picked-off'))!
    expect(picked.getAttribute('aria-selected')).toBe('true')
  })

  test('loading shows labels.loading as a dropdown row', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}))
    wrap(
      <ResourcePicker<Row>
        {...baseProps}
        value={[]}
        onChange={() => {}}
        queryKey={['rp-test', 'loading']}
        endpoint="/api/rows"
      />,
    )
    fireEvent.focus(combo())
    await waitFor(() => expect(screen.getByText(LABELS.loading)).toBeTruthy())
  })

  test('settled-but-empty shows labels.empty', async () => {
    mockRows([])
    wrap(
      <ResourcePicker<Row>
        {...baseProps}
        value={[]}
        onChange={() => {}}
        queryKey={['rp-test', 'empty']}
        endpoint="/api/rows"
      />,
    )
    fireEvent.focus(await waitFor(() => screen.getByRole('combobox')))
    await waitFor(() => expect(screen.getByText(LABELS.empty)).toBeTruthy())
  })

  test('load failure shows labels.loadFailed and rejects non-canonical free text', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const onChange = vi.fn()
    wrap(
      <ResourcePicker<Row>
        {...baseProps}
        value={[]}
        onChange={onChange}
        queryKey={['rp-test', 'failed']}
        endpoint="/api/rows"
      />,
    )
    await waitFor(() => screen.getByText(LABELS.loadFailed))
    // Resource references are canonical ids from visible options only.
    const input = combo()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'typed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
  })

  test('testid lands on the combobox input', async () => {
    mockRows([row('a')])
    wrap(
      <ResourcePicker<Row>
        {...baseProps}
        value={[]}
        onChange={() => {}}
        queryKey={['rp-test', 'testid']}
        endpoint="/api/rows"
        testid="rp-under-test"
      />,
    )
    const el = await waitFor(() => screen.getByTestId('rp-under-test'))
    expect(el).toBe(screen.getByRole('combobox'))
  })
})
