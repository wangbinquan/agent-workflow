// RFC-370 M0 (design/RFC-370-crewstation-hosted-deployment/redesign-v2-20261014.md §5.1):
// behind the CrewStation gateway the SPA holds no local credential. The served
// page states the deployment; every "signed in?" check holds, no request
// carries a bearer credential, a rejected platform session reloads through the
// gateway (throttled), the local sign-in / sign-out and provider controls are
// hidden, and the standby banner names the M0 reason. Standalone pages behave
// exactly as before.
//
// The platform-account cases lock the first CrewStation browser acceptance
// (2026-10-15): the shell was labelled with the synthesized `cs-<uuid>`
// username, the account overview called a platform account "local, password
// managed by Agent Workflow", the Users page offered local accounts and
// password resets nobody could use, and a refused plugin install rendered as a
// bare "request failed" instead of the hosted reason.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import type { AdminUserView } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ApiError, apiRequest } from '../src/api/client'
import { AccountOverviewPanel } from '../src/components/account/AccountOverviewPanel'
import { ExecutionStandbyBanner } from '../src/components/shell/ExecutionStandbyBanner'
import { EditUserDialog } from '../src/components/users/EditUserDialog'
import type { MeResponse } from '../src/hooks/useActor'
import { ExecutionStatusContext } from '../src/hooks/useExecutionAvailability'
import i18n from '../src/i18n'
import { resolveApiError } from '../src/i18n/errors'
import { accountCredentialManager, accountMenuLabel } from '../src/lib/account-user-presentation'
import { validateSettingsSearch } from '../src/routes/settings'
import {
  authorizationHeaderFor,
  clearToken,
  GATEWAY_SESSION_TOKEN,
  getToken,
  setGatewayReloadForTest,
  setToken,
} from '../src/stores/auth'
import {
  DEPLOYMENT_META_NAME,
  deploymentMode,
  isGatewayIdentity,
  readDeploymentMode,
  resetDeploymentModeForTest,
} from '../src/stores/deployment'

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

const realFetch = globalThis.fetch

beforeEach(() => {
  window.sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  stateDeployment(null)
  globalThis.fetch = realFetch
  setGatewayReloadForTest(() => window.location.reload())
})

describe('the deployment marker', () => {
  test('only an explicit crewstation marker selects the gateway identity', () => {
    const doc = (content: string | null) => ({
      querySelector: () => (content === null ? null : { getAttribute: () => content }),
    })
    expect(readDeploymentMode(doc(null) as never)).toBe('standalone')
    expect(readDeploymentMode(doc('cloud') as never)).toBe('standalone')
    expect(readDeploymentMode(doc('crewstation') as never)).toBe('crewstation')
    stateDeployment('crewstation')
    expect(deploymentMode()).toBe('crewstation')
    expect(isGatewayIdentity()).toBe(true)
    stateDeployment(null)
    expect(isGatewayIdentity()).toBe(false)
  })
})

describe('the gateway session', () => {
  test('standalone keeps the stored credential and its bearer header', () => {
    setToken('local-token')
    expect(getToken()).toBe('local-token')
    expect(authorizationHeaderFor(getToken())).toEqual({ Authorization: 'Bearer local-token' })
    clearToken()
    expect(getToken()).toBeNull()
    expect(authorizationHeaderFor(null)).toEqual({})
  })

  test('behind the gateway the session always holds and is never sent as a credential', () => {
    stateDeployment('crewstation')
    expect(getToken()).toBe(GATEWAY_SESSION_TOKEN)
    expect(authorizationHeaderFor(getToken())).toEqual({})
  })

  test('a rejected platform session reloads through the gateway at most once per interval', () => {
    stateDeployment('crewstation')
    let reloads = 0
    setGatewayReloadForTest(() => {
      reloads += 1
    })
    clearToken()
    clearToken()
    expect(reloads).toBe(1)
    expect(getToken()).toBe(GATEWAY_SESSION_TOKEN)
  })

  test('API requests behind the gateway carry no Authorization header', async () => {
    stateDeployment('crewstation')
    const seen: Array<Record<string, string>> = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string>) })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    await apiRequest('/api/agents')
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toHaveProperty('Authorization')
  })
})

describe('hosted presentation', () => {
  test('a platform-owned Settings tab is not a tab behind the gateway; standalone keeps it', () => {
    expect(validateSettingsSearch({ tab: 'database', q: 1 })).toEqual({ tab: 'database', q: 1 })
    stateDeployment('crewstation')
    // Dropped from the search, so the page shows Runtime and canonicalizes the URL (RFC-198).
    for (const tab of ['database', 'authentication']) {
      expect(validateSettingsSearch({ tab, q: 1 })).toEqual({ q: 1 })
    }
    expect(validateSettingsSearch({ tab: 'limits' })).toEqual({ tab: 'limits' })
    // RFC-370 v3 V10: Network stays behind the gateway (external-access switch only).
    expect(validateSettingsSearch({ tab: 'network' })).toEqual({ tab: 'network' })
  })

  test('the platform-owned Settings tabs are hidden', () => {
    const settings = readFileSync(resolve(__dirname, '..', 'src/routes/settings.tsx'), 'utf8')
    expect(settings).toMatch(
      /GATEWAY_HIDDEN_SETTINGS_TABS: ReadonlySet<SettingsTab> = new Set<SettingsTab>\(\[\s*'database',\s*'authentication',\s*\]\)/,
    )
    expect(settings).toContain('groups={visibleSectionGroups}')
  })

  test('local sign-in, setup, sign-out and credential sections are gated on the gateway identity', () => {
    const source = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8')
    expect(source('src/routes/__root.tsx')).toMatch(
      /isGatewayIdentity\(\) &&\s*\(location\.pathname === '\/auth' \|\| location\.pathname === '\/setup\/admin'\)/,
    )
    expect(source('src/components/UserMenu.tsx')).toMatch(/\{!isGatewayIdentity\(\) && \(/)
    // RFC-370 v3 V10: integration tokens stay available behind the gateway.
    expect(source('src/routes/account.tsx')).toMatch(/gateway && requested === 'security' \?/)
    expect(source('src/hooks/useWebSocket.ts')).toContain(
      "if (token !== GATEWAY_SESSION_TOKEN) u.searchParams.set('token', token)",
    )
  })

  test('the standby banner names why a hosted M0 instance does not execute', async () => {
    await i18n.changeLanguage('zh-CN')
    render(
      <ExecutionStatusContext.Provider
        value={{ mode: 'crewstation', state: 'standby', reason: 'remote-execution-not-available' }}
      >
        <ExecutionStandbyBanner />
      </ExecutionStatusContext.Provider>,
    )
    expect(screen.getByTestId('execution-status').textContent).toContain(
      '本部署尚未接入 CrewStation 远程执行',
    )
    cleanup()
    render(
      <ExecutionStatusContext.Provider
        value={{ mode: 'crewstation', state: 'standby', reason: 'lease-held-elsewhere' }}
      >
        <ExecutionStandbyBanner />
      </ExecutionStatusContext.Provider>,
    )
    expect(screen.getByTestId('execution-status').textContent).toContain('CrewStation 激活本实例后')
  })
})

describe('the platform account', () => {
  const platformUser = {
    id: 'u_platform',
    username: 'cs-01a0c12a-de09-7005-b0f9-d55a8676540b',
    displayName: 'Ada',
    role: 'admin' as const,
    status: 'active' as const,
  }

  test('the account menu is labelled with the platform display name behind the gateway', () => {
    expect(
      accountMenuLabel({ source: 'session', user: platformUser, gatewayIdentity: true }),
    ).toEqual({ label: 'Ada', secondary: null })
    // Standalone keeps the username it signs in with, display name below.
    expect(
      accountMenuLabel({ source: 'session', user: platformUser, gatewayIdentity: false }),
    ).toEqual({ label: platformUser.username, secondary: { kind: 'name', text: 'Ada' } })
    expect(
      accountMenuLabel({
        source: 'pat',
        user: { username: 'ada', displayName: 'ada' },
        gatewayIdentity: false,
      }),
    ).toEqual({ label: 'ada', secondary: null })
    expect(
      accountMenuLabel({
        source: 'daemon',
        user: { username: '__system__', displayName: 'System' },
        gatewayIdentity: false,
      }),
    ).toEqual({ label: 'System', secondary: { kind: 'daemon-access' } })
  })

  test('behind the gateway every account signs in through the platform', () => {
    expect(accountCredentialManager({ gatewayIdentity: true, hasOidcIdentity: false })).toBe(
      'platform',
    )
    expect(accountCredentialManager({ gatewayIdentity: true, hasOidcIdentity: true })).toBe(
      'platform',
    )
    expect(accountCredentialManager({ gatewayIdentity: false, hasOidcIdentity: true })).toBe('oidc')
    expect(accountCredentialManager({ gatewayIdentity: false, hasOidcIdentity: false })).toBe(
      'local',
    )
  })

  test('the account overview states the platform identity instead of a local password', async () => {
    await i18n.changeLanguage('zh-CN')
    const me: MeResponse = {
      user: platformUser,
      profile: { displayName: 'Ada', gitName: 'Ada', email: null, gitCommitIdentity: null },
      source: 'session',
      permissions: [],
      linkedIdentities: [],
      pats: [],
    }
    stateDeployment('crewstation')
    render(<AccountOverviewPanel me={me} />)
    const hosted = document.body.textContent ?? ''
    expect(hosted).toContain('CrewStation 平台账户')
    expect(hosted).toContain('CrewStation 平台')
    expect(screen.getByTestId('account-platform-identity').textContent).toContain(
      '登录由 CrewStation 平台管理',
    )
    expect(hosted).not.toContain('本地账户')
    expect(hosted).not.toContain('密码由 Agent Workflow 管理')
    expect(hosted).not.toContain('Web 会话')
    cleanup()

    stateDeployment(null)
    render(<AccountOverviewPanel me={me} />)
    const standalone = document.body.textContent ?? ''
    expect(standalone).toContain('本地账户')
    expect(standalone).toContain('Web 会话')
    expect(screen.queryByTestId('account-platform-identity')).toBeNull()
  })

  test('the user editor offers no password reset to a platform account', async () => {
    await i18n.changeLanguage('zh-CN')
    const user: AdminUserView = {
      ...platformUser,
      email: null,
      forcePasswordChange: false,
      createdBy: null,
      createdAt: 1,
      updatedAt: 1,
      lastLoginAt: null,
      hasOidcIdentity: false,
      additionalPermissions: [],
      accessRevision: 0,
    }
    const props = {
      user,
      isSelf: false,
      triggerRef: { current: null },
      busy: false,
      error: null,
      onClose: vi.fn(),
      onSubmit: vi.fn(),
      onResetPassword: vi.fn(),
      onDisable: vi.fn(),
      onEnable: vi.fn(),
      onReloadLatest: vi.fn(),
    }
    stateDeployment('crewstation')
    render(<EditUserDialog {...props} />)
    expect(document.body.textContent).toContain('此账户通过 CrewStation 平台身份登录')
    expect(screen.queryByRole('button', { name: '重置密码' })).toBeNull()
    cleanup()

    stateDeployment(null)
    render(<EditUserDialog {...props} />)
    expect(document.body.textContent).toContain('此账户使用由本系统管理的本地密码')
    expect(screen.getByRole('button', { name: '重置密码' })).toBeTruthy()
  })

  test('the Users page creates no local accounts behind the gateway', () => {
    const users = readFileSync(resolve(__dirname, '..', 'src/routes/users.tsx'), 'utf8')
    expect(users).toContain('const canCreate = canWrite && !platformMembers')
    expect(users).toContain('actions={hasHumanData && canCreate ? createAction : undefined}')
    expect(users).toContain('canCreate={canCreate}')
    expect(users).toContain("{canCreate && dialog?.kind === 'create' && (")
    expect(users).toMatch(/canWrite &&\s*!platformMembers &&\s*dialog\?\.kind === 'reset'/)
    expect(users).toContain('testid="users-platform-members"')
    const directory = readFileSync(
      resolve(__dirname, '..', 'src/components/users/UserDirectory.tsx'),
      'utf8',
    )
    expect(directory).toContain('(props.canCreate ?? props.canManage) ? (')
  })

  test('hosted refusals read as sentences with the next step', async () => {
    for (const language of ['zh-CN', 'en-US'] as const) {
      await i18n.changeLanguage(language)
      const plugin = resolveApiError(
        new ApiError(
          503,
          'hosted-capability-unavailable',
          'Installing plugins is not available on this CrewStation-hosted deployment yet',
          { capability: 'plugin-install' },
        ),
      )
      expect(plugin.matched).toBe('exact')
      expect(plugin.title).toContain('CrewStation')
      expect(plugin.hint).toBeDefined()
      for (const code of ['execution-standby', 'setting-managed-by-deployment']) {
        expect(resolveApiError(new ApiError(503, code, 'raw')).matched).toBe('exact')
      }
    }
    await i18n.changeLanguage('zh-CN')
    expect(resolveApiError(new ApiError(503, 'hosted-capability-unavailable', 'raw')).title).toBe(
      '本 CrewStation 托管部署暂不支持这项操作。',
    )
  })
})
