// RFC-001 tests for ModelSelect.
// - Pure helpers (isCustomValue / groupByProvider) cover the value-mode logic
//   independently of React.
// - One render test verifies the failed-list fallback + custom-value branch.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { OpencodeModel, RuntimeModelsResponse } from '@agent-workflow/shared'
import { groupByProvider, isCustomValue, ModelSelect } from '../src/components/ModelSelect'
import i18n from '../src/i18n'
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
  // Unmount via testing-library first — the Select listbox is portaled to
  // document.body, so wiping innerHTML before cleanup() races React's
  // removeChild and crashes happy-dom.
  cleanup()
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
    expect(grouped[1]?.[1]).toHaveLength(2)
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

  test('untrusted-binary model load uses localized title + hint and hides wire text', async () => {
    await i18n.changeLanguage('en-US')
    const raw = 'RAW_BACKEND_SECRET /private/sealed/opencode'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          code: 'execution-identity-untrusted-binary',
          message: raw,
        }),
        {
          status: 502,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )

    wrap(<ModelSelect value={undefined} onChange={() => {}} />)
    expect(
      await screen.findByText('The selected OpenCode executable is not a trusted official build.'),
    ).toBeTruthy()
    expect(
      screen.getByText(
        'Install the supported official OpenCode build or select its verified executable.',
      ),
    ).toBeTruthy()
    const banner = screen.getByTestId('model-select-load-error')
    expect(banner.textContent).not.toContain(raw)
    expect(banner.textContent).not.toContain('execution-identity-untrusted-binary')
  })

  test('persisted value not in list switches to custom mode', async () => {
    const payload: RuntimeModelsResponse = {
      binary: 'opencode',
      cached: false,
      models: [{ id: 'anthropic/sonnet', provider: 'anthropic', modelID: 'sonnet' }],
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const onChange = vi.fn()
    wrap(<ModelSelect value="future/new-model" onChange={onChange} />)
    // Wait for the list query to resolve. The model options now live in the
    // shared Select's portaled listbox (only mounted when open), so we can't
    // assert on an inline <option>; the Refresh button re-enabling is the
    // observable "models loaded" signal instead.
    await waitFor(() =>
      expect((screen.getByRole('button', { name: /refresh/i }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    // Custom input should appear pre-filled with the unknown value.
    const customInput = screen.getByDisplayValue('future/new-model')
    fireEvent.change(customInput, { target: { value: 'future/v2' } })
    expect(onChange).toHaveBeenLastCalledWith('future/v2')
  })

  test('grouped dropdown renders provider headers and selecting a model emits its id', async () => {
    const payload: RuntimeModelsResponse = {
      binary: 'opencode',
      cached: false,
      models: [
        { id: 'anthropic/sonnet', provider: 'anthropic', modelID: 'sonnet' },
        { id: 'openai/gpt', provider: 'openai', modelID: 'gpt' },
      ],
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const onChange = vi.fn()
    wrap(<ModelSelect value={undefined} onChange={onChange} />)
    const trigger = (await waitFor(() => screen.getByRole('combobox'))) as HTMLButtonElement
    await waitFor(() => expect(trigger.disabled).toBe(false))
    fireEvent.click(trigger)
    const list = screen.getByRole('listbox')
    // Provider names render as non-interactive group headers (was <optgroup>).
    expect(within(list).getByText('anthropic')).toBeTruthy()
    expect(within(list).getByText('openai')).toBeTruthy()
    // Picking a model row emits its canonical "provider/modelID".
    fireEvent.mouseDown(within(list).getByText('sonnet'))
    expect(onChange).toHaveBeenCalledWith('anthropic/sonnet')
  })
})
