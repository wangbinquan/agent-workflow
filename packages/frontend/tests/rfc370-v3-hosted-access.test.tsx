// RFC-370 v3 V8/V10 (design/RFC-370-crewstation-hosted-deployment/redesign-v2-20261014.md §9)
// — the hosted presentation of API automation, code-host events and hosted
// refusals. Regression intent, one finding each:
// - docs/crewstation-automation.md told users to create a token and an admin to
//   flip the external-API switch, but behind the gateway both the integration
//   tokens section and the whole Network tab were hidden. The tokens section is
//   reachable again (with how hosted automation presents it), and Network shows
//   only the external-access switch — never the listener.
// - The hosted endpoint card showed a direct webhook address (and a cutover
//   dialog offering a "direct" transport) a DigitalWorker can never receive; it
//   now says events arrive through CrewStation and names the endpoint id to bind.
// - A write refused during a platform migration or restore read as an English
//   fallback; the new code and every hosted standby reason have zh / en copy.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '../src/api/client'
import { AccountTokensPanel } from '../src/components/account/AccountTokensPanel'
import { ExecutionStandbyBanner } from '../src/components/shell/ExecutionStandbyBanner'
import { WebhookEndpointCard } from '../src/components/WebhookEndpointCard'
import type { MeResponse } from '../src/hooks/useActor'
import { ExecutionStatusContext } from '../src/hooks/useExecutionAvailability'
import i18n from '../src/i18n'
import { resolveApiError } from '../src/i18n/errors'
import { executionEn, executionZh } from '../src/i18n/execution'
import { NetworkTab } from '../src/routes/settings'
import { clearToken, setBaseUrl, setToken } from '../src/stores/auth'
import { DEPLOYMENT_META_NAME, resetDeploymentModeForTest } from '../src/stores/deployment'

function stateDeployment(mode: 'crewstation' | null): void {
  document.head.querySelector(`meta[name="${DEPLOYMENT_META_NAME}"]`)?.remove()
  if (mode !== null) {
    const meta = document.createElement('meta')
    meta.setAttribute('name', DEPLOYMENT_META_NAME)
    meta.setAttribute('content', mode)
    document.head.appendChild(meta)
  }
  resetDeploymentModeForTest()
}

function inRouter(
  children: React.ReactNode,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const root = createRootRoute({ component: Outlet })
  const index = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => <>{children}</>,
  })
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return (
    <QueryClientProvider client={client}>
      {/* Test route types intentionally differ from the generated app tree. */}
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>
  )
}

const ACTOR: MeResponse = {
  user: { id: 'u1', username: 'cs-user', displayName: 'Ada', role: 'admin', status: 'active' },
  profile: { displayName: 'Ada', gitName: 'Ada', email: null, gitCommitIdentity: null },
  source: 'session',
  permissions: ['webhook-endpoints:manage', 'webhook-endpoints:read'],
  linkedIdentities: [],
  pats: [],
}
const ENDPOINT = {
  id: 'ep-hosted',
  name: 'Platform GitLab',
  provider: 'gitlab',
  urlToken: 'aw_whk_tok',
  enabled: true,
  preferredCloneProtocol: 'http',
  hasSecret: true,
  secretHint: 'ab12',
  lastDeliveryAt: null,
  createdAt: 1,
  updatedAt: 1,
  ingressUrl: 'https://aw.example.com/webhooks/gitlab/aw_whk_tok',
}
let requests: string[] = []

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
  setBaseUrl(`http://rfc370-hosted-access-${crypto.randomUUID()}.test`)
  setToken('tok')
  requests = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    requests.push(new URL(url).pathname)
    const body = url.includes('/api/auth/me')
      ? ACTOR
      : url.includes('/api/webhook-endpoints')
        ? [ENDPOINT]
        : url.includes('/api/daemon')
          ? {
              pid: 1,
              host: '127.0.0.1',
              port: 51111,
              url: 'http://127.0.0.1:51111/',
              startedAt: '',
            }
          : {}
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
})

afterEach(() => {
  cleanup()
  stateDeployment(null)
  clearToken()
  vi.restoreAllMocks()
})

const config = (): Config => ({ ...DEFAULT_CONFIG, language: 'zh-CN', theme: 'system' })

describe('API automation is reachable behind the gateway', () => {
  test('hosted Network shows only the external-access switch and never asks for the listener', async () => {
    stateDeployment('crewstation')
    render(inRouter(<NetworkTab config={config()} />))
    expect(await screen.findByTestId('settings-mcp-surface')).toBeTruthy()
    expect(screen.queryByTestId('settings-bind-port')).toBeNull()
    expect(document.body.textContent).not.toContain(
      i18n.t('settings.cardGroups.networkListenerTitle'),
    )
    await new Promise((done) => setTimeout(done, 20))
    expect(requests).not.toContain('/api/daemon')
  })

  test('standalone Network keeps the listener next to the switch', async () => {
    render(inRouter(<NetworkTab config={config()} />))
    expect(await screen.findByTestId('settings-bind-port')).toBeTruthy()
    expect(screen.getByTestId('settings-mcp-surface')).toBeTruthy()
    await waitFor(() => expect(requests).toContain('/api/daemon'))
  })

  test('hosted integration tokens explain that a token goes with the platform session', async () => {
    stateDeployment('crewstation')
    render(inRouter(<AccountTokensPanel me={ACTOR} />))
    const notice = await screen.findByTestId('token-hosted-usage')
    expect(notice.textContent).toContain(i18n.t('account.token.hostedUsageTitle'))
    expect(notice.textContent).toContain('Authorization: Bearer')
    expect(screen.getByTestId('token-create-open')).toBeTruthy()
    cleanup()
    stateDeployment(null)
    render(inRouter(<AccountTokensPanel me={ACTOR} />))
    await screen.findByTestId('token-create-open')
    expect(screen.queryByTestId('token-hosted-usage')).toBeNull()
  })

  test('the account page keeps the tokens section behind the gateway (only local security is hidden)', () => {
    const account = readFileSync(resolve(__dirname, '..', 'src/routes/account.tsx'), 'utf8')
    expect(account).toContain(
      "const section = gateway && requested === 'security' ? 'overview' : requested",
    )
    // The tokens item sits outside the gateway-only exclusion.
    expect(account).toMatch(/\]\),\s*\{\s*key: 'tokens',/)
  })

  test('the automation guide names the hosted UI paths it relies on', () => {
    const guide = readFileSync(
      resolve(__dirname, '..', '..', '..', 'docs/crewstation-automation.md'),
      'utf8',
    )
    expect(guide).toContain('我的账户 → 外部对接令牌')
    expect(guide).toContain('设置 → 网络 → 外部访问')
  })
})

describe('code-host events behind the gateway', () => {
  test('a hosted endpoint names the endpoint id to bind instead of a direct webhook address', async () => {
    stateDeployment('crewstation')
    render(inRouter(<WebhookEndpointCard canManage />))
    const notice = await screen.findByTestId('webhook-endpoint-hosted-ep-hosted')
    expect(notice.textContent).toContain(i18n.t('hostedEvents.endpointTitle'))
    expect(notice.textContent).toContain('AW_EVENT_SOURCES')
    expect(screen.getByTestId('webhook-endpoint-id-ep-hosted').textContent).toBe('ep-hosted')
    expect(screen.queryByTestId('webhook-endpoint-url-ep-hosted')).toBeNull()
    expect(document.body.textContent).not.toContain(ENDPOINT.ingressUrl)
  })

  test('a standalone endpoint keeps its direct webhook address', async () => {
    render(inRouter(<WebhookEndpointCard canManage />))
    expect((await screen.findByTestId('webhook-endpoint-url-ep-hosted')).textContent).toBe(
      ENDPOINT.ingressUrl,
    )
    expect(screen.queryByTestId('webhook-endpoint-hosted-ep-hosted')).toBeNull()
  })
})

describe('hosted refusals and standby reasons read as sentences with the next step', () => {
  test('a write refused while the platform migrates or restores the database', async () => {
    for (const language of ['zh-CN', 'en-US'] as const) {
      await i18n.changeLanguage(language)
      const resolved = resolveApiError(
        new ApiError(503, 'hosted-database-write-unavailable', 'raw', { operationId: 'op' }),
      )
      expect(resolved.matched).toBe('exact')
      expect(resolved.title).toContain('CrewStation')
      expect(resolved.hint).toBeDefined()
    }
  })

  test('every hosted standby reason has copy in both languages', () => {
    expect(Object.keys(executionEn.reasons).sort()).toEqual(Object.keys(executionZh.reasons).sort())
    for (const messages of [executionZh, executionEn]) {
      for (const text of Object.values(messages.reasons)) expect(text.length).toBeGreaterThan(10)
    }
    expect(Object.keys(executionZh.reasons)).toContain('database-frozen-by-platform')
  })

  test('a database freeze reads as read-only maintenance, not as a handover', async () => {
    render(
      <ExecutionStatusContext.Provider
        value={{ mode: 'crewstation', state: 'frozen', reason: 'database-frozen-by-platform' }}
      >
        <ExecutionStandbyBanner />
      </ExecutionStatusContext.Provider>,
    )
    const banner = screen.getByTestId('execution-status').textContent ?? ''
    expect(banner).toContain(executionZh.reasonTitles['database-frozen-by-platform']!)
    expect(banner).toContain(executionZh.reasons['database-frozen-by-platform'])
    expect(banner).not.toContain(executionZh.frozen)
    cleanup()
    render(
      <ExecutionStatusContext.Provider
        value={{ mode: 'crewstation', state: 'frozen', reason: 'execution-frozen-by-platform' }}
      >
        <ExecutionStandbyBanner />
      </ExecutionStatusContext.Provider>,
    )
    expect(screen.getByTestId('execution-status').textContent).toContain(executionZh.frozen)
  })
})
