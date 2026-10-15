// RFC-370 M0 (design/RFC-370-crewstation-hosted-deployment/redesign-v2-20261014.md §5.1):
// behind the CrewStation gateway the SPA holds no local credential. The served
// page states the deployment; every "signed in?" check holds, no request
// carries a bearer credential, a rejected platform session reloads through the
// gateway (throttled), the local sign-in / sign-out and provider controls are
// hidden, and the standby banner names the M0 reason. Standalone pages behave
// exactly as before.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { apiRequest } from '../src/api/client'
import { ExecutionStandbyBanner } from '../src/components/shell/ExecutionStandbyBanner'
import { ExecutionStatusContext } from '../src/hooks/useExecutionAvailability'
import i18n from '../src/i18n'
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
    for (const tab of ['database', 'authentication', 'network']) {
      expect(validateSettingsSearch({ tab, q: 1 })).toEqual({ q: 1 })
    }
    expect(validateSettingsSearch({ tab: 'limits' })).toEqual({ tab: 'limits' })
  })

  test('the platform-owned Settings tabs are hidden', () => {
    const settings = readFileSync(resolve(__dirname, '..', 'src/routes/settings.tsx'), 'utf8')
    expect(settings).toMatch(
      /GATEWAY_HIDDEN_SETTINGS_TABS: ReadonlySet<SettingsTab> = new Set<SettingsTab>\(\[\s*'database',\s*'authentication',\s*'network',\s*\]\)/,
    )
    expect(settings).toContain('groups={visibleSectionGroups}')
  })

  test('local sign-in, setup, sign-out and credential sections are gated on the gateway identity', () => {
    const source = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8')
    expect(source('src/routes/__root.tsx')).toMatch(
      /isGatewayIdentity\(\) &&\s*\(location\.pathname === '\/auth' \|\| location\.pathname === '\/setup\/admin'\)/,
    )
    expect(source('src/components/UserMenu.tsx')).toMatch(/\{!isGatewayIdentity\(\) && \(/)
    expect(source('src/routes/account.tsx')).toMatch(
      /gateway && \(requested === 'security' \|\| requested === 'tokens'\)/,
    )
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
