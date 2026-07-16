// RFC-201 T10.1 — frontend probe receipts settle only against the current
// local request and the resource hash currently held by React Query.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { McpOperationResource, McpProbeOperationReceipt } from '@agent-workflow/shared'
import { mcpProbeKey, mcpResourceKey, useProbeMcpMutation } from '../src/lib/mcp-probe-query'
import { setBaseUrl, setToken } from '../src/stores/auth'

const H1 = '1'.repeat(64)
const H2 = '2'.repeat(64)

function resource(hash: string): McpOperationResource {
  return {
    id: 'm1',
    name: 'pg',
    description: '',
    ownerUserId: null,
    visibility: 'public',
    aclRevision: 0,
    type: 'local',
    config: { command: ['fake'] },
    enabled: true,
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: hash === H1 ? 1 : 2,
    operationConfigHash: hash,
  }
}

function receipt(id: string, hash = H1): McpProbeOperationReceipt {
  return {
    id,
    mcpId: 'm1',
    mcpName: 'pg',
    status: 'ok',
    latencyMs: 1,
    handshakeMs: 1,
    serverInfo: null,
    protocolVersion: null,
    capabilities: {},
    tools: [{ name: id }],
    resources: [],
    resourceTemplates: [],
    prompts: [],
    errorCode: null,
    errorMessage: null,
    errorDetail: null,
    startedAt: 2,
    finishedAt: 3,
    updatedAt: 3,
    configHashUsed: hash,
  }
}

function Harness() {
  const probe = useProbeMcpMutation('pg')
  return (
    <>
      <button type="button" onClick={() => probe.run(H1)}>
        run
      </button>
      {probe.resultStale && <span data-testid="stale">stale</span>}
    </>
  )
}

function mount(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>,
  )
}

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('MCP probe frontend request/hash CAS', () => {
  test('matching current request and resource publishes the result', async () => {
    setBaseUrl('http://daemon.test')
    setToken('tok')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(mcpResourceKey('pg'), resource(H1))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(receipt('current')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    mount(qc)
    fireEvent.click(screen.getByRole('button', { name: 'run' }))
    await waitFor(() => expect(qc.getQueryData(mcpProbeKey('pg'))).toMatchObject({ id: 'current' }))
    expect(screen.queryByTestId('stale')).toBeNull()
  })

  test('operation 200 after a newer PUT cache receipt cannot roll result back', async () => {
    setBaseUrl('http://daemon.test')
    setToken('tok')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(mcpResourceKey('pg'), resource(H1))
    const pending = deferredResponse()
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => pending.promise)
    mount(qc)
    fireEvent.click(screen.getByRole('button', { name: 'run' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    qc.setQueryData(mcpResourceKey('pg'), resource(H2))
    await act(async () => {
      pending.resolve(
        new Response(JSON.stringify(receipt('old')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    })
    await waitFor(() => expect(screen.getByTestId('stale')).toBeTruthy())
    expect(qc.getQueryData(mcpProbeKey('pg'))).toBeUndefined()
    expect(qc.getQueryData<McpOperationResource>(mcpResourceKey('pg'))?.operationConfigHash).toBe(
      H2,
    )
  })

  test('late receipt from an older local request cannot replace the newer request result', async () => {
    setBaseUrl('http://daemon.test')
    setToken('tok')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(mcpResourceKey('pg'), resource(H1))
    const first = deferredResponse()
    const second = deferredResponse()
    let call = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      call += 1
      return call === 1 ? first.promise : second.promise
    })
    mount(qc)
    fireEvent.click(screen.getByRole('button', { name: 'run' }))
    fireEvent.click(screen.getByRole('button', { name: 'run' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    await act(async () => {
      second.resolve(
        new Response(JSON.stringify(receipt('newer')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    })
    await waitFor(() => expect(qc.getQueryData(mcpProbeKey('pg'))).toMatchObject({ id: 'newer' }))
    await act(async () => {
      first.resolve(
        new Response(JSON.stringify(receipt('older')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    })
    await waitFor(() => expect(qc.getQueryData(mcpProbeKey('pg'))).toMatchObject({ id: 'newer' }))
    expect(screen.queryByTestId('stale')).toBeNull()
  })

  test('backend stale 409 marks the result expired and keeps old cache untouched', async () => {
    setBaseUrl('http://daemon.test')
    setToken('tok')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(mcpResourceKey('pg'), resource(H1))
    qc.setQueryData(mcpProbeKey('pg'), { id: 'existing' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          code: 'resource-operation-stale',
          message: 'resource changed',
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    )
    mount(qc)
    fireEvent.click(screen.getByRole('button', { name: 'run' }))
    await waitFor(() => expect(screen.getByTestId('stale')).toBeTruthy())
    expect(qc.getQueryData(mcpProbeKey('pg'))).toEqual({ id: 'existing' })
  })
})
