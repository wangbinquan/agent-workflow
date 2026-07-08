// RFC-151 PR-1 — form-invalid sentinel 判别化回归锁（四页一格）。
//
// mcps.new / mcps.detail / plugins.new / plugins.detail used to run
// buildCreatePayload/buildUpdatePayload INSIDE mutationFn and throw
// `new Error('form-invalid')` on validation failure. Only mcps.new filtered
// the sentinel out of its form-actions banner by message comparison — the
// other three pages leaked the raw untranslated string "form-invalid" into
// the error banner (flag-audit §3-8 bug). The fix: builders' discriminated
// union `{ok:true,payload}|{ok:false,errors}` is branched BEFORE mutate, so
// an invalid submit
//   (a) fires NO network call,
//   (b) surfaces inline field errors,
//   (c) leaves the form-actions banner EMPTY (no sentinel, no stale error).
// A valid submit still posts the built payload (mutate now takes it as its
// variable).

import type { ComponentType } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: {} as Record<string, string>,
}))
vi.mock('@tanstack/react-router', () => ({
  createRoute: (o: unknown) => ({
    ...(o as Record<string, unknown>),
    useParams: () => h.params,
  }),
  useNavigate: () => h.navigate,
}))
vi.mock('../src/routes/__root', () => ({ Route: {} }))

// Imported AFTER the mocks so createRoute/useNavigate resolve to the stubs.
import { Route as McpNewRoute } from '../src/routes/mcps.new'
import { Route as McpDetailRoute } from '../src/routes/mcps.detail'
import { Route as PluginNewRoute } from '../src/routes/plugins.new'
import { Route as PluginDetailRoute } from '../src/routes/plugins.detail'

interface FetchCall {
  url: string
  method: string
  body: Record<string, unknown> | null
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function installFetch(handler: (call: FetchCall) => Response): FetchCall[] {
  const calls: FetchCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      let body: Record<string, unknown> | null = null
      if (typeof init?.body === 'string' && init.body.length > 0) {
        try {
          body = JSON.parse(init.body) as Record<string, unknown>
        } catch {
          body = null
        }
      }
      const call: FetchCall = { url, method, body }
      calls.push(call)
      return handler(call)
    },
  )
  return calls
}

const LOCAL_MCP = {
  id: 'mcp_1',
  name: 'm1',
  description: '',
  type: 'local',
  enabled: true,
  config: { command: ['uvx', 'x'] },
  schemaVersion: 1,
  createdAt: 0,
  updatedAt: 0,
}

const PLUGIN = {
  id: 'p1',
  name: 'myplugin',
  spec: 'dd-trace',
  options: {},
  description: '',
  enabled: true,
}

function renderRoute(route: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Comp = (route as { component: ComponentType }).component
  return render(
    <QueryClientProvider client={qc}>
      <Comp />
    </QueryClientProvider>,
  )
}

function writeCount(calls: FetchCall[]): number {
  return calls.filter((c) => c.method === 'POST' || c.method === 'PUT').length
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  h.navigate.mockReset()
  h.params = {}
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('invalid submit → inline field error only, no form-actions banner, no wire call', () => {
  test('/mcps/new: name set but local command empty', async () => {
    const calls = installFetch(() => json([]))
    renderRoute(McpNewRoute)
    fireEvent.change(await screen.findByPlaceholderText('postgres-prod'), {
      target: { value: 'm1' },
    })
    fireEvent.click(screen.getByTestId('mcp-save-button'))
    await waitFor(() => {
      expect(document.querySelector('.form-field__error')).not.toBeNull()
    })
    expect(document.querySelector('.form-actions__error')).toBeNull()
    expect(document.body.textContent ?? '').not.toContain('form-invalid')
    expect(writeCount(calls)).toBe(0)
  })

  test('/mcps/new: valid submit still posts the built payload and navigates', async () => {
    const calls = installFetch((c) => (c.method === 'POST' ? json(LOCAL_MCP, 201) : json([])))
    renderRoute(McpNewRoute)
    fireEvent.change(await screen.findByPlaceholderText('postgres-prod'), {
      target: { value: 'm1' },
    })
    fireEvent.change(screen.getByPlaceholderText('uvx postgres-mcp'), {
      target: { value: 'uvx x' },
    })
    fireEvent.click(screen.getByTestId('mcp-save-button'))
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST')
      expect(post).toBeDefined()
      expect(post!.body).toMatchObject({ name: 'm1', type: 'local' })
    })
    await waitFor(() => expect(h.navigate).toHaveBeenCalledTimes(1))
    expect(document.querySelector('.form-actions__error')).toBeNull()
  })

  test('/mcps/$name: clearing the command then Save shows no banner (was: raw "form-invalid")', async () => {
    h.params = { name: 'm1' }
    const calls = installFetch((c) => {
      if (c.method === 'GET' && c.url.endsWith('/api/mcps/m1')) return json(LOCAL_MCP)
      if (c.url.includes('/probes')) return json([])
      return json({})
    })
    renderRoute(McpDetailRoute)
    const commandInput = (await screen.findByPlaceholderText(
      'uvx postgres-mcp',
    )) as HTMLInputElement
    await waitFor(() => expect(commandInput.value).toBe('uvx x'))
    fireEvent.change(commandInput, { target: { value: '' } })
    fireEvent.click(screen.getByTestId('mcp-save-button'))
    await waitFor(() => {
      expect(document.querySelector('.form-field__error')).not.toBeNull()
    })
    expect(document.querySelector('.form-actions__error')).toBeNull()
    expect(document.body.textContent ?? '').not.toContain('form-invalid')
    expect(calls.filter((c) => c.method === 'PUT').length).toBe(0)
  })

  test('/plugins/new: empty spec shows inline error, no banner', async () => {
    const calls = installFetch(() => json([]))
    renderRoute(PluginNewRoute)
    fireEvent.change(await screen.findByPlaceholderText('dd-trace'), {
      target: { value: 'myplugin' },
    })
    fireEvent.click(screen.getByTestId('plugin-save-button'))
    await waitFor(() => expect(screen.getByText(/spec is required/i)).toBeTruthy())
    expect(document.querySelector('.form-actions__error')).toBeNull()
    expect(document.body.textContent ?? '').not.toContain('form-invalid')
    expect(writeCount(calls)).toBe(0)
  })

  test('/plugins/$id: clearing the spec then Save shows no banner (was: raw "form-invalid")', async () => {
    h.params = { id: 'p1' }
    const calls = installFetch((c) => {
      if (c.method === 'GET' && c.url.endsWith('/api/plugins/p1')) return json(PLUGIN)
      return json({})
    })
    renderRoute(PluginDetailRoute)
    const specInput = (await screen.findByPlaceholderText(/@scope\/pkg/)) as HTMLInputElement
    await waitFor(() => expect(specInput.value).toBe('dd-trace'))
    fireEvent.change(specInput, { target: { value: '' } })
    fireEvent.click(screen.getByTestId('plugin-save-button'))
    await waitFor(() => expect(screen.getByText(/spec is required/i)).toBeTruthy())
    expect(document.querySelector('.form-actions__error')).toBeNull()
    expect(document.body.textContent ?? '').not.toContain('form-invalid')
    expect(calls.filter((c) => c.method === 'PUT').length).toBe(0)
  })
})

describe('source-level: the sentinel protocol is gone', () => {
  test("no route builds or filters new Error('form-invalid') anymore", async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    for (const rel of [
      'routes/mcps.new.tsx',
      'routes/mcps.detail.tsx',
      'routes/plugins.new.tsx',
      'routes/plugins.detail.tsx',
    ]) {
      const body = readFileSync(join(__dirname, '..', 'src', rel), 'utf8')
      expect(body.includes("'form-invalid'"), `${rel} still references the sentinel`).toBe(false)
    }
  })
})
