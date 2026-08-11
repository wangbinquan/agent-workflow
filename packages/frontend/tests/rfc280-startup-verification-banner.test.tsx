// RFC-280 T3 — StartupVerificationBanner: the node-detail warning face for
// declared-injection × runtime-startup-report gaps. Locks in that an unusable
// MCP renders an ERROR banner with the runtime's own reason, declaration-only
// findings (disabled refs / dropped params) render a WARNING, and a clean or
// unavailable record renders nothing/warning respectively — ending the silent
// degradation behind the two 2026-08 "agent says the MCP does not exist"
// incidents.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { StartupVerificationResponse } from '@agent-workflow/shared'

vi.mock('@/api/client', () => ({
  api: { get: vi.fn() },
}))

import '../src/i18n'
import { StartupVerificationBanner } from '../src/components/inventory/StartupVerificationBanner'
import { api } from '@/api/client'

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

function renderBanner(response: StartupVerificationResponse) {
  vi.mocked(api.get).mockResolvedValue(response)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <StartupVerificationBanner taskId="T1" nodeRunId="NR1" enabled={true} />
    </QueryClientProvider>,
  )
}

const cleanRecord = {
  declared: {
    mcpServers: ['rag-search'],
    skippedDisabledMcps: [],
    skills: [],
    subagents: [],
    plugins: [],
    tools: null,
    droppedParams: [],
    unsupported: [],
    unobservable: [],
  },
  observation: {
    state: 'verified' as const,
    source: 'claude-init' as const,
    mcpServers: [{ name: 'rag-search', status: 'connected' }],
  },
  verification: {
    observation: 'verified' as const,
    mcpUnusable: [],
    skillsMissing: [],
    subagentsMissing: [],
    toolsMissing: [],
    pluginsMissing: [],
  },
}

describe('<StartupVerificationBanner />', () => {
  test('unusable MCP → error banner carrying the runtime reason', async () => {
    renderBanner({
      available: true,
      record: {
        ...cleanRecord,
        verification: {
          ...cleanRecord.verification,
          mcpUnusable: [{ name: 'rag-search', status: 'failed', hint: 'spawn ENOENT' }],
        },
      },
    })
    const banner = await screen.findByTestId('startup-verification-banner')
    expect(banner.className).toContain('notice-banner--error')
    expect(banner.textContent).toContain('rag-search')
    expect(banner.textContent).toContain('spawn ENOENT')
  })

  test('declaration-only findings (disabled ref / dropped params) → warning banner', async () => {
    renderBanner({
      available: true,
      record: {
        ...cleanRecord,
        declared: {
          ...cleanRecord.declared,
          skippedDisabledMcps: ['old-mcp'],
          droppedParams: ['variant'],
        },
      },
    })
    const banner = await screen.findByTestId('startup-verification-banner')
    expect(banner.className).toContain('notice-banner--warning')
    expect(banner.textContent).toContain('old-mcp')
    expect(banner.textContent).toContain('variant')
  })

  test('unavailable observation → warning banner saying it could not verify', async () => {
    renderBanner({
      available: true,
      record: {
        ...cleanRecord,
        observation: { state: 'unavailable' as const, reason: 'no-init-event' },
        verification: {
          ...cleanRecord.verification,
          observation: 'unavailable' as const,
          observationReason: 'no-init-event',
        },
      },
    })
    const banner = await screen.findByTestId('startup-verification-banner')
    expect(banner.className).toContain('notice-banner--warning')
    expect(banner.textContent).toContain('no-init-event')
  })

  test('clean record renders nothing; unavailable response renders nothing', async () => {
    const { container } = renderBanner({ available: true, record: cleanRecord })
    await vi.waitFor(() => {
      expect(vi.mocked(api.get)).toHaveBeenCalled()
    })
    expect(container.querySelector('[data-testid="startup-verification-banner"]')).toBeNull()

    document.body.innerHTML = ''
    vi.clearAllMocks()
    const second = renderBanner({ available: false })
    await vi.waitFor(() => {
      expect(vi.mocked(api.get)).toHaveBeenCalled()
    })
    expect(second.container.querySelector('[data-testid="startup-verification-banner"]')).toBeNull()
  })
})
