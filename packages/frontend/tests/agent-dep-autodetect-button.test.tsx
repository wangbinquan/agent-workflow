// RFC-038 T3 (+ RFC-173 follow-up) — locks DependencyAutodetectButton behavior:
//   (1) ALWAYS clickable (RFC-173 follow-up, user request): an empty/whitespace
//       body no longer disables it — clicking just opens the "nothing detected"
//       empty-state dialog, clearer than a greyed button.
//   (2) clicking with a body that contains an inventory name opens the
//       dialog with one section pre-populated; Import flow calls onApply
//       with the detected selection

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DependencyAutodetectButton } from '../src/components/agents/DependencyAutodetectButton'
import { emptyAgent } from '../src/components/AgentForm'
import { setBaseUrl, setToken } from '../src/stores/auth'

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  const utils = render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
  return { ...utils, qc }
}

async function waitForInventoryLoaded(qc: QueryClient) {
  await waitFor(() => {
    for (const key of [['agents'], ['skills'], ['mcps'], ['plugins']] as const) {
      const state = qc.getQueryState(key)
      if (!state || state.status !== 'success') throw new Error(`${key[0]} not settled`)
    }
  })
}

function fakeFetchAll() {
  const bodies: Record<string, unknown> = {
    '/api/agents': [{ id: 'agent-helper', name: 'helper-agent', description: 'helps' }],
    '/api/skills': [{ id: 'skill-playwright', name: 'playwright-runner', description: '' }],
    '/api/mcps': [{ id: 'mcp-code-review', name: 'code-review-mcp', description: '' }],
    '/api/plugins': [{ id: 'plugin-schema', name: 'schema-validator', description: '' }],
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    if (path && path in bodies) {
      return new Response(JSON.stringify(bodies[path]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('[]', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DependencyAutodetectButton', () => {
  test('whitespace-only body → still clickable; opens the empty-state dialog', async () => {
    fakeFetchAll()
    const { qc } = wrap(
      <DependencyAutodetectButton bodyMd={'   \n\t'} value={emptyAgent()} onApply={vi.fn()} />,
    )
    const btn = (await waitFor(() =>
      screen.getByTestId('agent-dep-autodetect-button'),
    )) as HTMLButtonElement
    // RFC-173 follow-up: always clickable — no longer disabled on empty body.
    expect(btn.disabled).toBe(false)
    await waitForInventoryLoaded(qc)
    fireEvent.click(btn)
    await waitFor(() => {
      expect(screen.getByTestId('agent-dep-autodetect-dialog')).toBeTruthy()
      expect(screen.getByTestId('empty-state')).toBeTruthy()
    })
    expect(screen.getByTestId('autodetect-close')).toBeTruthy()
  })

  test('click → dialog opens with detected candidates, apply forwards selection', async () => {
    fakeFetchAll()
    const onApply = vi.fn()
    const { qc } = wrap(
      <DependencyAutodetectButton
        bodyMd="use playwright-runner and helper-agent here"
        value={emptyAgent()}
        onApply={onApply}
      />,
    )
    await waitForInventoryLoaded(qc)
    // Retry the click + section check together so React has a chance to
    // re-render with the now-cached query data before detect runs.
    await waitFor(() => {
      fireEvent.click(screen.getByTestId('agent-dep-autodetect-button'))
      expect(screen.getByTestId('autodetect-section-agents')).toBeTruthy()
    })
    expect(screen.getByTestId('autodetect-section-skills')).toBeTruthy()
    // MCPs not in body → section absent.
    expect(screen.queryByTestId('autodetect-section-mcps')).toBeNull()
    expect(screen.queryByTestId('autodetect-section-plugins')).toBeNull()
    fireEvent.click(screen.getByTestId('autodetect-apply'))
    expect(onApply).toHaveBeenCalledTimes(1)
    const selection = onApply.mock.calls[0]![0]
    expect(selection.agents).toEqual(['agent-helper'])
    expect(selection.skills).toEqual(['skill-playwright'])
    expect(selection.mcps).toEqual([])
    expect(selection.plugins).toEqual([])
  })

  test('body with no matches → empty-state dialog, Close button only', async () => {
    fakeFetchAll()
    const { qc } = wrap(
      <DependencyAutodetectButton
        bodyMd="this body matches nothing in inventory"
        value={emptyAgent()}
        onApply={vi.fn()}
      />,
    )
    await waitForInventoryLoaded(qc)
    await waitFor(() => {
      fireEvent.click(screen.getByTestId('agent-dep-autodetect-button'))
      expect(screen.getByTestId('agent-dep-autodetect-dialog')).toBeTruthy()
      expect(screen.getByTestId('empty-state')).toBeTruthy()
    })
    expect(screen.queryByTestId('autodetect-apply')).toBeNull()
    expect(screen.getByTestId('autodetect-close')).toBeTruthy()
  })

  test('click while queries still pending → opens dialog with EmptyState (does not block user)', async () => {
    // Slow fetch: never resolves. Tests that the button is clickable even
    // when inventory queries are pending — body-empty is the only block.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise(() => {}) as Promise<Response>,
    )
    wrap(
      <DependencyAutodetectButton bodyMd="non-empty body" value={emptyAgent()} onApply={vi.fn()} />,
    )
    const btn = screen.getByTestId('agent-dep-autodetect-button') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByTestId('agent-dep-autodetect-dialog')).toBeTruthy())
    expect(screen.getByTestId('empty-state')).toBeTruthy()
  })
})
