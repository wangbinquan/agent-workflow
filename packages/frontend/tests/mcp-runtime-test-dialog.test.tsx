import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { HostExecutionStatus, McpRuntimeTestSessionDto } from '@agent-workflow/shared'
import { HostExecutionReadinessContext } from '../src/hooks/useHostExecutionAvailability'
import { McpRuntimeTestDialog } from '../src/components/mcps/McpRuntimeTestDialog'
import i18n from '../src/i18n'
import { clearToken, setBaseUrl, setToken } from '../src/stores/auth'

vi.mock('@/components/node-session/SessionConversationPanel', () => ({
  SessionConversationPanel: () => <div data-testid="mock-session-conversation" />,
}))

const HASH = 'a'.repeat(64)

function turn(
  status: McpRuntimeTestSessionDto['turns'][number]['status'],
): McpRuntimeTestSessionDto['turns'][number] {
  return {
    id: 'turn-1',
    seq: 1,
    prompt: 'first',
    status,
    captureState: status === 'running' ? 'live' : 'complete',
    hardDeadlineAt: 700_000,
    failureCode: null,
    stderrTail: null,
    durationMs: status === 'running' ? null : 5,
    createdAt: 1_000,
    startedAt: 1_001,
    finishedAt: status === 'running' ? null : 1_005,
  }
}

function session(mode: 'idle' | 'running' | 'ended'): McpRuntimeTestSessionDto {
  const active = mode !== 'ended'
  return {
    id: 'session-1',
    mcpId: 'mcp-1',
    status: active ? 'active' : 'ended',
    endReason: active ? null : 'user',
    runtime: { name: 'opencode', protocol: 'opencode' },
    mcpConfigHash: HASH,
    nativeSessionReady: true,
    continuationBlockedReason: null,
    inFlightTurnId: mode === 'running' ? 'turn-1' : null,
    sessionVersion: mode === 'running' ? 2 : mode === 'idle' ? 3 : 4,
    idleDeadlineAt: mode === 'idle' ? Date.now() + 600_000 : null,
    cleanupState: mode === 'ended' ? 'complete' : 'not-started',
    turns: [turn(mode === 'running' ? 'running' : 'succeeded')],
    eventCursor: 1,
    createdAt: 1_000,
    updatedAt: 1_005,
    endedAt: mode === 'ended' ? 1_010 : null,
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function runtimes(): Response {
  return json({
    runtimes: [
      {
        name: 'opencode',
        protocol: 'opencode',
        enabled: true,
        isDefault: true,
        capabilities: { mcpRuntimeTestV1: true },
      },
      {
        name: 'claude-code',
        protocol: 'claude-code',
        enabled: true,
        isDefault: false,
        capabilities: { mcpRuntimeTestV1: true },
      },
      {
        name: 'unsupported',
        protocol: 'opencode',
        enabled: true,
        isDefault: false,
        capabilities: { mcpRuntimeTestV1: false },
      },
    ],
  })
}

function requestPath(request: RequestInfo | URL): string {
  const url =
    typeof request === 'string'
      ? request
      : request instanceof URL
        ? request.toString()
        : request.url
  return new URL(url).pathname
}

function renderDialog(
  props: Partial<ComponentProps<typeof McpRuntimeTestDialog>> = {},
  execution: HostExecutionStatus = { mode: 'native', status: null },
): void {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  render(
    <QueryClientProvider client={client}>
      <HostExecutionReadinessContext.Provider value={execution}>
        <McpRuntimeTestDialog mcpId="mcp-1" operationConfigHash={HASH} {...props} />
      </HostExecutionReadinessContext.Provider>
    </QueryClientProvider>,
  )
}

async function openDialog(): Promise<void> {
  fireEvent.click(screen.getByTestId('mcp-runtime-test-open'))
  await waitFor(() => screen.getByTestId('mcp-runtime-test-dialog'))
}

beforeEach(() => {
  setBaseUrl(`http://mcp-runtime-test-${crypto.randomUUID()}.test`)
  setToken('token')
  void i18n.changeLanguage('en-US')
})

afterEach(() => {
  cleanup()
  clearToken()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('McpRuntimeTestDialog', () => {
  test('resource-only can recover the exact quarantined session without creating another test', async () => {
    let current: McpRuntimeTestSessionDto = { ...session('ended'), cleanupState: 'quarantined' }
    const posts: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
      const path = requestPath(request),
        method = init?.method ?? 'GET'
      if (method === 'POST') posts.push(path)
      if (path === '/api/runtimes') return runtimes()
      if (
        path === '/api/mcps/mcp-1/runtime-test-session' ||
        path === '/api/mcps/mcp-1/runtime-test-sessions/session-1'
      )
        return json(current)
      if (path === '/api/mcps/mcp-1/runtime-test-sessions/session-1/recover' && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({})
        current = {
          ...current,
          cleanupState: 'complete',
          sessionVersion: current.sessionVersion + 1,
        }
        return json({ session: current })
      }
      return json({ ok: false, code: 'not-found', message: path }, 404)
    })
    renderDialog(
      {},
      {
        mode: 'resource-only',
        status: {
          phase: 'standby',
          generation: 'resource-only-recovery',
          readyGroups: [],
          reason: null,
        },
      },
    )
    await openDialog()
    const recover = await screen.findByTestId('mcp-runtime-test-recover')
    expect(screen.queryByTestId('mcp-runtime-test-start')).toBeNull()
    fireEvent.click(recover)
    await waitFor(() => expect(screen.queryByTestId('mcp-runtime-test-recover')).toBeNull())
    expect(posts).toEqual(['/api/mcps/mcp-1/runtime-test-sessions/session-1/recover'])
    expect((screen.getByTestId('mcp-runtime-test-start') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('mock-session-conversation')).toBeTruthy()
  })

  test('an unproven recovery keeps the original quarantined result visible and prevents a new test', async () => {
    const current: McpRuntimeTestSessionDto = { ...session('ended'), cleanupState: 'quarantined' }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
      const path = requestPath(request)
      if (path === '/api/runtimes') return runtimes()
      if (path === '/api/mcps/mcp-1/runtime-test-session') return json(current)
      if (path.endsWith('/recover') && init?.method === 'POST')
        return json(
          {
            ok: false,
            code: 'mcp-test-recovery-unproven',
            message: 'Original execution is not confirmed reaped',
          },
          409,
        )
      return json({ ok: false, code: 'not-found', message: path }, 404)
    })
    renderDialog()
    await openDialog()
    fireEvent.click(await screen.findByTestId('mcp-runtime-test-recover'))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('not confirmed reaped'),
    )
    expect(screen.getByTestId('mcp-runtime-test-recover')).toBeTruthy()
    expect(screen.queryByTestId('mcp-runtime-test-start')).toBeNull()
    expect(screen.getByTestId('mock-session-conversation')).toBeTruthy()
  })

  test('resource-only keeps saved session reads open but cannot create a native test turn', async () => {
    const posts: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
      const path = requestPath(request)
      if ((init?.method ?? 'GET') === 'POST') posts.push(path)
      if (path === '/api/runtimes') return runtimes()
      if (path === '/api/mcps/mcp-1/runtime-test-session')
        return new Response(null, { status: 204 })
      return json({ ok: false, code: 'not-found', message: path }, 404)
    })
    renderDialog(
      {},
      {
        mode: 'resource-only',
        status: {
          phase: 'standby',
          generation: 'actual-resource-only',
          readyGroups: [],
          reason: 'host-execution-resource-only',
        },
      },
    )
    await openDialog()
    await screen.findByRole('combobox', { name: i18n.t('mcps.runtimeTest.runtime') })
    fireEvent.change(await screen.findByTestId('mcp-runtime-test-composer'), {
      target: { value: 'Keep this draft' },
    })
    const start = screen.getByTestId('mcp-runtime-test-start') as HTMLButtonElement
    expect(start.disabled).toBe(true)
    fireEvent.click(start)
    expect(posts).toEqual([])
    expect((screen.getByTestId('mcp-runtime-test-composer') as HTMLTextAreaElement).value).toBe(
      'Keep this draft',
    )
    expect(
      screen.getByText(
        i18n.t('hostExecution.unavailable', { groups: i18n.t('hostExecution.group.diagnostics') }),
      ),
    ).toBeTruthy()
  })

  test('selects a declared-capability runtime and starts with the saved MCP hash', async () => {
    const createBodies: Array<Record<string, unknown>> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
      const path = requestPath(request)
      const method = init?.method ?? 'GET'
      if (path === '/api/runtimes') return runtimes()
      if (path === '/api/mcps/mcp-1/runtime-test-session') {
        return new Response(null, { status: 204 })
      }
      if (path === '/api/mcps/mcp-1/runtime-test-sessions' && method === 'POST') {
        createBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return json({ sessionId: 'session-1', acceptedTurnId: 'turn-1' }, 202)
      }
      if (path === '/api/mcps/mcp-1/runtime-test-sessions/session-1') {
        return json(session('running'))
      }
      return json({ ok: false, code: 'not-found', message: path }, 404)
    })
    renderDialog()
    await openDialog()
    const runtimePicker = await screen.findByRole('combobox', {
      name: i18n.t('mcps.runtimeTest.runtime'),
    })
    fireEvent.click(runtimePicker)
    expect(await screen.findByRole('option', { name: 'opencode' })).toBeTruthy()
    fireEvent.mouseDown(screen.getByRole('option', { name: 'claude-code' }))
    const composer = await screen.findByTestId('mcp-runtime-test-composer')
    fireEvent.change(composer, { target: { value: 'exercise this MCP' } })
    const start = screen.getByTestId('mcp-runtime-test-start')
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(start)

    await waitFor(() => expect(createBodies).toHaveLength(1))
    expect(createBodies[0]?.expectedMcpConfigHash).toBe(HASH)
    expect(createBodies[0]?.runtimeName).toBe('claude-code')
    expect(createBodies[0]?.message).toBe('exercise this MCP')
    expect(typeof createBodies[0]?.clientCreateId).toBe('string')
    expect(typeof createBodies[0]?.clientMessageId).toBe('string')
  })

  // Regression: LAN HTTP is not a secure context, so Web Crypto exposes
  // getRandomValues() but may omit randomUUID(). Starting an MCP runtime test
  // must still mint stable idempotency keys instead of failing before the POST.
  test('starts when crypto.randomUUID is unavailable in an insecure context', async () => {
    const originalCrypto = globalThis.crypto
    vi.stubGlobal('crypto', {
      getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
    })
    const createBodies: Array<Record<string, unknown>> = []
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
        const path = requestPath(request)
        const method = init?.method ?? 'GET'
        if (path === '/api/runtimes') return runtimes()
        if (path === '/api/mcps/mcp-1/runtime-test-session') {
          return new Response(null, { status: 204 })
        }
        if (path === '/api/mcps/mcp-1/runtime-test-sessions' && method === 'POST') {
          createBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
          return json({ sessionId: 'session-1', acceptedTurnId: 'turn-1' }, 202)
        }
        if (path === '/api/mcps/mcp-1/runtime-test-sessions/session-1') {
          return json(session('running'))
        }
        return json({ ok: false, code: 'not-found', message: path }, 404)
      })
      renderDialog()
      await openDialog()
      const composer = await screen.findByTestId('mcp-runtime-test-composer')
      fireEvent.change(composer, { target: { value: 'exercise this MCP over LAN HTTP' } })
      const start = screen.getByTestId('mcp-runtime-test-start')
      await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false))
      fireEvent.click(start)

      await waitFor(() => expect(createBodies).toHaveLength(1))
      expect(createBodies[0]?.clientCreateId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
      expect(createBodies[0]?.clientMessageId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
      expect(createBodies[0]?.clientCreateId).not.toBe(createBodies[0]?.clientMessageId)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('retries a response-lost next message without crypto.randomUUID', async () => {
    const originalCrypto = globalThis.crypto
    vi.stubGlobal('crypto', {
      getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
    })
    const messageBodies: Array<Record<string, unknown>> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
      const path = requestPath(request)
      const method = init?.method ?? 'GET'
      if (path === '/api/runtimes') return runtimes()
      if (path === '/api/mcps/mcp-1/runtime-test-session') return json(session('idle'))
      if (path.endsWith('/messages') && method === 'POST') {
        messageBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        if (messageBodies.length === 1) throw new TypeError('Failed to fetch')
        return json(
          {
            sessionId: 'session-1',
            acceptedTurnId: 'turn-2',
            sessionVersion: 4,
          },
          202,
        )
      }
      if (path === '/api/mcps/mcp-1/runtime-test-sessions/session-1') {
        return json(session('running'))
      }
      return json({ ok: false, code: 'not-found', message: path }, 404)
    })
    renderDialog()
    await openDialog()
    const composer = await screen.findByTestId('mcp-runtime-test-composer')
    fireEvent.change(composer, { target: { value: 'continue with context' } })
    const send = screen.getByTestId('mcp-runtime-test-send')
    fireEvent.click(send)
    await waitFor(() => expect(messageBodies).toHaveLength(1))
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(send)
    await waitFor(() => expect(messageBodies).toHaveLength(2))

    expect(messageBodies[1]?.clientMessageId).toBe(messageBodies[0]?.clientMessageId)
    expect(messageBodies[1]?.message).toBe('continue with context')
  })

  test('shows the latest session without replaying a replaced create receipt', async () => {
    let latestReads = 0
    let createCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
      const path = requestPath(request)
      const method = init?.method ?? 'GET'
      if (path === '/api/runtimes') return runtimes()
      if (path === '/api/mcps/mcp-1/runtime-test-session') {
        latestReads += 1
        return latestReads === 1 ? new Response(null, { status: 204 }) : json(session('ended'))
      }
      if (path === '/api/mcps/mcp-1/runtime-test-sessions' && method === 'POST') {
        createCalls += 1
        return json({ sessionId: 'replaced-session', acceptedTurnId: 'old-turn' }, 202)
      }
      if (path === '/api/mcps/mcp-1/runtime-test-sessions/replaced-session') {
        return json(
          {
            ok: false,
            code: 'mcp-test-session-not-found',
            message: 'MCP test session not found',
          },
          404,
        )
      }
      return json({ ok: false, code: 'not-found', message: path }, 404)
    })
    renderDialog()
    await openDialog()
    const composer = await screen.findByTestId('mcp-runtime-test-composer')
    fireEvent.change(composer, { target: { value: 'run once only' } })
    const start = screen.getByTestId('mcp-runtime-test-start')
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(start)

    expect(await screen.findByText(i18n.t('mcps.runtimeTest.receiptReplaced'))).toBeTruthy()
    expect(createCalls).toBe(1)
    expect(latestReads).toBe(2)
  })

  test('surfaces a save-basis race instead of silently swallowing it', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
      const path = requestPath(request)
      if (path === '/api/runtimes') return runtimes()
      if (path === '/api/mcps/mcp-1/runtime-test-session') {
        return new Response(null, { status: 204 })
      }
      return json({ ok: false, code: 'not-found', message: path }, 404)
    })
    const draftChanged = i18n.t('mcps.runtimeTest.draftChangedDuringSave')
    renderDialog({
      dirty: true,
      onSaveForRuntimeTest: async () => {
        throw new Error(draftChanged)
      },
    })
    await openDialog()
    fireEvent.change(await screen.findByTestId('mcp-runtime-test-composer'), {
      target: { value: 'test the saved draft' },
    })
    const saveAndStart = screen.getByTestId('mcp-runtime-test-save-start')
    await waitFor(() => expect((saveAndStart as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(saveAndStart)
    expect(await screen.findByText(draftChanged)).toBeTruthy()
  })

  test('surfaces the latest failed turn diagnostic instead of showing only ended', async () => {
    const failedSession = session('ended')
    failedSession.endReason = 'session-unusable'
    failedSession.nativeSessionReady = false
    failedSession.continuationBlockedReason = 'capture-incomplete'
    failedSession.turns = [
      {
        ...turn('failed'),
        failureCode: 'runtime-result-error',
      },
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
      const path = requestPath(request)
      if (path === '/api/runtimes') return runtimes()
      if (path === '/api/mcps/mcp-1/runtime-test-session') return json(failedSession)
      return json({ ok: false, code: 'not-found', message: path }, 404)
    })

    renderDialog()
    await openDialog()

    const issue = await screen.findByTestId('mcp-runtime-test-turn-issue')
    expect(within(issue).getByText(i18n.t('mcps.runtimeTest.turnOutcome.failed'))).toBeTruthy()
    expect(
      within(issue).getByText(
        i18n.t('mcps.runtimeTest.turnOutcome.diagnostic', {
          code: 'runtime-result-error',
        }),
      ),
    ).toBeTruthy()
  })

  test('closing is non-mutating, while the separate end action calls the end endpoint', async () => {
    const mutationPaths: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
      const path = requestPath(request)
      const method = init?.method ?? 'GET'
      if (path === '/api/runtimes') return runtimes()
      if (path === '/api/mcps/mcp-1/runtime-test-session') return json(session('running'))
      if (method === 'POST') {
        mutationPaths.push(path)
        if (path.endsWith('/end')) return json({ session: session('ended') })
      }
      return json({ ok: false, code: 'not-found', message: path }, 404)
    })
    renderDialog()
    await openDialog()
    const closeButtons = screen.getAllByRole('button', { name: i18n.t('common.close') })
    fireEvent.click(closeButtons.at(-1)!)
    await waitFor(() => expect(screen.queryByTestId('mcp-runtime-test-dialog')).toBeNull())
    expect(mutationPaths).toEqual([])

    await openDialog()
    fireEvent.click(screen.getByTestId('mcp-runtime-test-end'))
    const confirm = await screen.findByRole('dialog', {
      name: i18n.t('mcps.runtimeTest.endConfirmTitle'),
    })
    fireEvent.click(
      within(confirm).getByRole('button', { name: i18n.t('mcps.runtimeTest.endNow') }),
    )
    await waitFor(() =>
      expect(mutationPaths).toEqual(['/api/mcps/mcp-1/runtime-test-sessions/session-1/end']),
    )
  })
})
