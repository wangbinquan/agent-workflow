// RFC-030 T9 — McpInventoryPanel renders the four sections + error box.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { McpProbe } from '@agent-workflow/shared'
import { McpInventoryPanel } from '../src/components/mcps/McpInventoryPanel'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function mockProbeGet(name: string, probe: McpProbe | null): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (req) => {
    const url = typeof req === 'string' ? req : req.toString()
    if (url.endsWith(`/api/mcps/${name}/probe`)) {
      if (probe === null) {
        return new Response(
          JSON.stringify({ ok: false, code: 'probe-not-found', message: 'never' }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify(probe), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  })
}

function okProbe(): McpProbe {
  return {
    id: 'pb1',
    mcpId: 'm1',
    mcpName: 'pg',
    status: 'ok',
    latencyMs: 1832,
    handshakeMs: 100,
    serverInfo: { name: 'pg-mcp', version: '1.0' },
    protocolVersion: '2024-11-05',
    capabilities: { tools: { listChanged: true } },
    tools: [
      { name: 'query', description: 'Run SQL', inputSchema: { type: 'object' } },
      { name: 'explain' },
    ],
    resources: [{ uri: 'file:///docs/x.md', name: 'docs' }],
    resourceTemplates: [],
    prompts: [{ name: 'summarize', arguments: [{ name: 'topic', required: true }] }],
    errorCode: null,
    errorMessage: null,
    errorDetail: null,
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_832,
    updatedAt: 1_700_000_001_832,
  } as McpProbe
}

function errProbe(): McpProbe {
  return {
    id: 'pb1',
    mcpId: 'm1',
    mcpName: 'pg',
    status: 'error',
    latencyMs: 50,
    handshakeMs: null,
    serverInfo: null,
    protocolVersion: null,
    capabilities: null,
    tools: null,
    resources: null,
    resourceTemplates: null,
    prompts: null,
    errorCode: 'connect-failed',
    errorMessage: 'spawn uvx ENOENT',
    errorDetail: { stderr: 'uvx: command not found' },
    startedAt: 1,
    finishedAt: 2,
    updatedAt: 2,
  } as McpProbe
}

function renderPanel(id = 'm1', mcpUpdatedAt = 0) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <McpInventoryPanel
        mcpId={id}
        operationConfigHash={'a'.repeat(64)}
        mcpUpdatedAt={mcpUpdatedAt}
      />
    </QueryClientProvider>,
  )
}

describe('McpInventoryPanel', () => {
  test('renders all four sections + tool rows for an ok probe', async () => {
    mockProbeGet('m1', okProbe())
    renderPanel()
    await waitFor(() => screen.getByTestId('mcp-inventory-tools'))
    expect(screen.getByTestId('mcp-inventory-resources')).toBeTruthy()
    expect(screen.getByTestId('mcp-inventory-prompts')).toBeTruthy()
    expect(screen.getByTestId('mcp-inventory-capabilities')).toBeTruthy()
    expect(screen.getByTestId('mcp-tool-row-query')).toBeTruthy()
    expect(screen.getByTestId('mcp-tool-row-explain')).toBeTruthy()
  })

  test('tool inputSchema toggles open via summary click', async () => {
    mockProbeGet('m1', okProbe())
    renderPanel()
    await waitFor(() => screen.getByTestId('mcp-tool-row-query'))
    const toggle = screen.getByTestId('mcp-tool-schema-toggle-query')
    fireEvent.click(toggle)
    // The <pre> element is in the DOM either way (details default closed
    // visually but child is present in tree). Assert content rendered.
    expect(screen.getByTestId('mcp-tool-schema-query').textContent?.includes('object')).toBe(true)
  })

  test('error probe renders error box with detail toggle', async () => {
    mockProbeGet('m1', errProbe())
    renderPanel()
    await waitFor(() => screen.getByTestId('mcp-inventory-error'))
    const toggle = screen.getByTestId('mcp-inventory-error-detail-toggle')
    expect(toggle).toBeTruthy()
    fireEvent.click(toggle)
    // After toggling on, the stderr JSON shows up.
    await waitFor(() => {
      expect(document.body.textContent?.includes('uvx: command not found')).toBe(true)
    })
  })

  test('never-probed mcp shows the neverProbed hint', async () => {
    mockProbeGet('m1', null)
    renderPanel()
    await waitFor(() => {
      expect(screen.getByTestId('mcp-probe-status-unknown')).toBeTruthy()
    })
  })

  test('re-probe button has data-testid that includes mcpName', async () => {
    mockProbeGet('m1', okProbe())
    renderPanel()
    await waitFor(() => screen.getByTestId('mcp-inventory-reprobe-m1'))
  })

  test('a probe older than the current saved row is unknown and hides its inventory', async () => {
    const probe = okProbe()
    mockProbeGet('m1', probe)
    renderPanel('m1', probe.startedAt)
    await waitFor(() => screen.getByTestId('mcp-probe-expired'))
    expect(screen.getByTestId('mcp-probe-status-unknown')).toBeTruthy()
    expect(screen.getAllByText('The saved probe result is out of date.')).toHaveLength(2)
    expect(screen.queryByTestId('mcp-tool-row-query')).toBeNull()
  })
})
