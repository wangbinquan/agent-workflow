// Unified external-infrastructure E2E.
//
// Every request below crosses a real compiled daemon process. The mock gateway
// itself is started once by Playwright globalSetup and is controlled over its
// authenticated HTTP control plane, exactly as parallel worker processes use it.

import { expect, test } from '@playwright/test'

import {
  MOCK_OIDC_CLIENT_ID,
  MOCK_OIDC_CLIENT_SECRET,
  SYSTEM_MOCK_CODE_HOST_TOKEN,
  SystemMockClient,
} from '@agent-workflow/system-mocks'

import { runCommand } from './command'
import { defaultSystemMockToolPath, startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })

let daemon: DaemonHandle
let mocks: SystemMockClient

test.beforeAll(async () => {
  const controlUrl = requiredEnv('AW_SYSTEM_MOCK_CONTROL_URL')
  const controlToken = requiredEnv('AW_SYSTEM_MOCK_CONTROL_TOKEN')
  mocks = new SystemMockClient(controlUrl, controlToken)
  await mocks.reset()
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('GitLab and GitHub connections use the real REST clients; webhook emitter signs both providers', async () => {
  for (const provider of ['gitlab', 'github'] as const) {
    const baseUrl = requiredEnv(
      provider === 'gitlab'
        ? 'AW_SYSTEM_MOCK_GITLAB_API_BASE_URL'
        : 'AW_SYSTEM_MOCK_GITHUB_API_BASE_URL',
    )
    await requestJson(`/api/code-hosts/${provider}`, {
      method: 'PUT',
      body: { baseUrl, token: SYSTEM_MOCK_CODE_HOST_TOKEN },
    })
    const probe = await requestJson<{ ok: boolean; login?: string }>(
      `/api/code-hosts/${provider}/test`,
      { method: 'POST', body: {} },
    )
    expect(probe).toMatchObject({ ok: true, login: 'system-mock-user' })

    const projectPath = `system-e2e/${provider}-project`
    await mocks.seedCodeHost({ provider, projectPath })
    const endpoint = await requestJson<{ urlToken: string; secret: string }>(
      '/api/webhook-endpoints',
      {
        method: 'POST',
        body: { name: `${provider} unified mock`, provider },
      },
    )
    const delivered = await mocks.deliverWebhook({
      provider,
      callbackUrl: `${daemon.baseUrl}/webhooks/${provider}/${endpoint.urlToken}`,
      secret: endpoint.secret,
      projectPath,
      number: 1,
      event: 'mr_opened',
    })
    expect(delivered.status).toBe(200)
    expect(JSON.parse(delivered.body) as Record<string, unknown>).toHaveProperty('deliveryId')
  }

  const gitlabRequests = await mocks.requests('gitlab')
  const githubRequests = await mocks.requests('github')
  expect(gitlabRequests.some((request) => request.path.endsWith('/user'))).toBe(true)
  expect(githubRequests.some((request) => request.path.endsWith('/user'))).toBe(true)
})

test('daemon probes the unified MCP mock over Streamable HTTP and compiled stdio', async () => {
  const tool = defaultSystemMockToolPath()
  expect(runCommand(tool, ['--version'])).toContain('system-mock-scip 1.0.0')

  const fixtures = [
    {
      name: 'system-mock-http',
      type: 'remote' as const,
      config: { url: requiredEnv('AW_SYSTEM_MOCK_MCP_URL'), timeoutMs: 5_000, oauth: false },
    },
    {
      name: 'system-mock-stdio',
      type: 'local' as const,
      config: { command: [tool, 'mcp-stdio'], timeoutMs: 5_000 },
    },
  ]
  for (const fixture of fixtures) {
    const mcp = await requestJson<{ id: string; operationConfigHash: string }>('/api/mcps', {
      method: 'POST',
      body: { ...fixture, description: 'unified system mock', enabled: true },
    })
    const probe = await requestJson<{
      status: string
      tools: Array<{ name: string }> | null
      resources: Array<{ uri: string }> | null
    }>(`/api/mcps/${mcp.id}/probe`, {
      method: 'POST',
      body: { expectedConfigHash: mcp.operationConfigHash },
    })
    expect(probe.status).toBe('ok')
    expect(probe.tools?.map((toolInfo) => toolInfo.name).sort()).toEqual([
      'echo',
      'fail',
      'ping',
      'query',
    ])
    expect(probe.resources?.[0]?.uri).toBe('file:///system-mock/README.md')
  }
})

test('daemon PlantUML proxy renders through the unified external renderer', async () => {
  await requestJson('/api/config', {
    method: 'PUT',
    body: { plantumlEndpoint: requiredEnv('AW_SYSTEM_MOCK_PLANTUML_ENDPOINT') },
  })
  const rendered = await requestJson<{ svg?: string; host?: string }>('/api/plantuml/render', {
    method: 'POST',
    body: { source: '@startuml\nAlice -> Bob: hello\n@enduml' },
  })
  expect(rendered.svg).toContain('system mock PlantUML renderer')
  expect(rendered.host).toMatch(/^127\.0\.0\.1:\d+$/)
})

test('browser completes a real OIDC authorization-code login against the unified identity provider', async ({
  page,
}) => {
  const issuerUrl = requiredEnv('AW_SYSTEM_MOCK_OIDC_ISSUER_URL')
  const provider = await requestJson<{ id: string }>('/api/oidc/providers', {
    method: 'POST',
    body: {
      slug: 'system-mock',
      displayName: 'System Mock Identity',
      issuerUrl,
      clientId: MOCK_OIDC_CLIENT_ID,
      clientSecret: MOCK_OIDC_CLIENT_SECRET,
      scopes: 'openid profile email',
      provisioning: 'auto',
      allowedEmailDomains: [],
      iconUrl: null,
      enabled: true,
      userinfoRequestStyle: 'get_bearer',
      trustEmailVerified: true,
      usernameClaim: null,
      subjectClaim: null,
    },
  })
  const providerProbe = await requestJson<{ ok: boolean }>(
    `/api/oidc/providers/${provider.id}/test`,
    {
      method: 'POST',
    },
  )
  expect(providerProbe.ok).toBe(true)

  const loginStart = await fetch(`${daemon.baseUrl}/api/auth/oidc/system-mock/login/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ postLoginRedirect: '/agents' }),
  })
  expect(loginStart.status).toBe(200)
  const { authorizeUrl } = (await loginStart.json()) as { authorizeUrl: string }
  await page.goto(authorizeUrl)
  await expect(
    page.getByRole('heading', { name: 'Choose a mock identity', exact: true }),
  ).toBeVisible()
  await page.getByTestId('oidc-user-mock-alice').click()
  await page.waitForURL(`${daemon.baseUrl}/agents`)

  const sessionToken = await page.evaluate(() =>
    window.localStorage.getItem('agent-workflow.token'),
  )
  expect(sessionToken).toBeTruthy()
  const whoami = await page.evaluate(async () => {
    const token = window.localStorage.getItem('agent-workflow.token') ?? ''
    const response = await fetch('/api/whoami', { headers: { authorization: `Bearer ${token}` } })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  })
  expect(whoami.status).toBe(200)
  expect(whoami.body).toMatchObject({ user: { username: 'alice' }, source: 'session' })
})

test('registry endpoints and fault injection stay reachable from worker processes', async () => {
  const oauthDiscovery = await fetch(
    `${requiredEnv('AW_SYSTEM_MOCK_OAUTH_ISSUER_URL')}/.well-known/oauth-authorization-server`,
  )
  expect(await oauthDiscovery.json()).toMatchObject({
    issuer: requiredEnv('AW_SYSTEM_MOCK_OAUTH_ISSUER_URL'),
  })
  const npm = await fetch(`${requiredEnv('AW_SYSTEM_MOCK_NPM_REGISTRY_URL')}system-mock-package`)
  expect(npm.status).toBe(200)
  const pypi = await fetch(`${requiredEnv('AW_SYSTEM_MOCK_PYPI_INDEX_URL')}system-mock-python/`)
  expect(pypi.status).toBe(200)
  expect(await pypi.text()).toContain('.whl')

  await mocks.addFault({
    service: 'github',
    pathPrefix: '/github/api/v3/user',
    status: 503,
    times: 1,
  })
  const failed = await requestJson<{ ok: boolean; code?: string }>('/api/code-hosts/github/test', {
    method: 'POST',
    body: {},
  })
  expect(failed).toMatchObject({ ok: false, code: 'not-found' })
})

async function requestJson<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${daemon.token}`,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} returned ${response.status}: ${text}`)
  }
  return (text.length === 0 ? null : JSON.parse(text)) as T
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is unset`)
  return value
}
