// RFC-031 → RFC-173 T3 (new) — PluginsPicker eligibility + version subline.
//   - only ENABLED plugins are offered to add (the save-time guard rejects
//     disabled refs), but a plugin that was selected and later disabled still
//     shows CHECKED (RFC-173 §3.2 union) so it can be un-checked.
//   - resolvedVersion is surfaced in the row's muted description line.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Plugin } from '@agent-workflow/shared'
import { PluginsPicker } from '../src/components/PluginsPicker'
import { setBaseUrl, setToken } from '../src/stores/auth'

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

function fakePlugin(
  name: string,
  opts: { enabled?: boolean; resolvedVersion?: string | null; description?: string } = {},
): Plugin {
  return {
    id: name,
    name,
    spec: `${name}@1`,
    options: {},
    description: opts.description ?? '',
    enabled: opts.enabled ?? true,
    sourceKind: 'npm',
    cachedPath: `/x/${name}`,
    resolvedVersion: opts.resolvedVersion ?? null,
    installedAt: 0,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Plugin
}

function mockPlugins(rows: Plugin[]) {
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

async function openPicker() {
  const input = (await waitFor(() => screen.getByRole('combobox'))) as HTMLInputElement
  fireEvent.focus(input)
  const list = screen.getByRole('listbox')
  await waitFor(() => within(list).getAllByRole('option'))
  return list
}

describe('PluginsPicker', () => {
  test('only enabled plugins are offered; a disabled-but-selected one still shows checked', async () => {
    mockPlugins([
      fakePlugin('on', { enabled: true }),
      fakePlugin('off', { enabled: false }),
      fakePlugin('kept', { enabled: false }),
    ])
    wrap(<PluginsPicker value={['kept']} onChange={() => {}} />)
    const list = await openPicker()
    const byName = (n: string) =>
      within(list)
        .getAllByRole('option')
        .find((o) => o.textContent?.startsWith(n))
    expect(byName('on')).toBeTruthy() // enabled → offered
    expect(byName('off')).toBeUndefined() // disabled + unselected → not offered
    const kept = byName('kept')! // disabled + selected → still shown, checked
    expect(kept.getAttribute('aria-selected')).toBe('true')
  })

  test('resolvedVersion appears in the row description', async () => {
    mockPlugins([fakePlugin('vers', { resolvedVersion: '1.2.3', description: 'does things' })])
    wrap(<PluginsPicker value={[]} onChange={() => {}} />)
    const list = await openPicker()
    const row = within(list).getByRole('option')
    expect(row.textContent).toContain('v1.2.3')
    expect(row.textContent).toContain('does things')
  })
})
