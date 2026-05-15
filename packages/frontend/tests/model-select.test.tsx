// RFC-001 tests for ModelSelect.
// - Pure helpers (isCustomValue / groupByProvider) cover the value-mode logic
//   independently of React.
// - One render test verifies the failed-list fallback + custom-value branch.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { OpencodeModel, RuntimeModelsResponse } from '@agent-workflow/shared'
import {
  groupByProvider,
  isCustomValue,
  ModelSelect,
} from '../src/components/ModelSelect'
import { setBaseUrl, setToken } from '../src/stores/auth'

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('isCustomValue', () => {
  const known = new Set(['anthropic/foo', 'openai/bar'])

  test('empty or undefined is not custom', () => {
    expect(isCustomValue(undefined, known, false)).toBe(false)
    expect(isCustomValue('', known, false)).toBe(false)
  })

  test('value in known set is not custom', () => {
    expect(isCustomValue('anthropic/foo', known, false)).toBe(false)
  })

  test('unknown value is custom', () => {
    expect(isCustomValue('anthropic/unknown', known, false)).toBe(true)
  })

  test('failed list disables custom detection (text input fallback owns the value)', () => {
    expect(isCustomValue('anthropic/unknown', known, true)).toBe(false)
  })
})

describe('groupByProvider', () => {
  test('groups by provider and sorts opencode providers first', () => {
    const models: OpencodeModel[] = [
      { id: 'anthropic/x', provider: 'anthropic', modelID: 'x' },
      { id: 'opencode/foo', provider: 'opencode', modelID: 'foo' },
      { id: 'openai/y', provider: 'openai', modelID: 'y' },
      { id: 'anthropic/z', provider: 'anthropic', modelID: 'z' },
    ]
    const grouped = groupByProvider(models)
    expect(grouped.map(([p]) => p)).toEqual(['opencode', 'anthropic', 'openai'])
    expect(grouped[1][1]).toHaveLength(2)
  })

  test('empty input → empty output', () => {
    expect(groupByProvider([])).toEqual([])
  })
})

describe('ModelSelect render', () => {
  test('falls back to text input when models fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, code: 'opencode-models-failed' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const onChange = vi.fn()
    wrap(<ModelSelect value="anthropic/custom-thing" onChange={onChange} />)
    await waitFor(() => screen.getByRole('alert'))
    const input = screen.getByDisplayValue('anthropic/custom-thing')
    fireEvent.change(input, { target: { value: 'openai/foo' } })
    expect(onChange).toHaveBeenLastCalledWith('openai/foo')
  })

  test('persisted value not in list switches to custom mode', async () => {
    const payload: RuntimeModelsResponse = {
      binary: 'opencode',
      cached: false,
      models: [
        { id: 'anthropic/sonnet', provider: 'anthropic', modelID: 'sonnet' },
      ],
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const onChange = vi.fn()
    wrap(<ModelSelect value="future/new-model" onChange={onChange} />)
    // Wait for list to load.
    await waitFor(() => screen.getByText(/sonnet/i))
    // Custom input should appear pre-filled with the unknown value.
    const customInput = screen.getByDisplayValue('future/new-model')
    fireEvent.change(customInput, { target: { value: 'future/v2' } })
    expect(onChange).toHaveBeenLastCalledWith('future/v2')
  })
})
