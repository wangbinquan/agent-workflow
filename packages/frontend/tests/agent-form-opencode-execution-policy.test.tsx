// RFC-251 — AgentForm's OpenCode execution-policy blocker banner.
//
// History this file locks: RFC-224 blocked any OpenCode agent that selected
// plugins or collaborating agents, both in this banner and at save/launch.
// RFC-251 restored both features (they are assembled into the controlled
// config instead), so the banner must NOT appear for them any more — that is
// the regression this file primarily guards, since a stray re-introduction
// would silently make the features unusable from the UI again.
//
// What remains a real blocker is an OpenCode runtime with no explicit model:
// `executionPolicyViolations` still reports `model-unresolved`, and a
// non-opencode protocol is never gated at all.

import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CreateAgent } from '@agent-workflow/shared'
import { AgentForm, emptyAgent } from '../src/components/AgentForm'
import { enUS } from '../src/i18n/en-US'
import { setBaseUrl, setToken } from '../src/stores/auth'

const BANNER = 'agent-opencode-execution-policy'
const MODEL_MSG = enUS.tasks.failure['execution-identity-model-unresolved']

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Register BOTH built-in protocols every time and vary only which one is the
 * global default (the agents under test never pin `runtime`, so the default is
 * the effective one). Two selectable rows also keep the runtime picker
 * rendered — it is this suite's "runtimes query settled" anchor, and it hides
 * itself when there is only one thing to choose (AgentForm `showRuntime`).
 */
function mockRuntimes(
  defaultProtocol: 'opencode' | 'claude-code',
  opts: { opencodeModel?: string | null } = {},
): void {
  const runtimes = [
    {
      name: 'opencode',
      protocol: 'opencode',
      enabled: true,
      isDefault: defaultProtocol === 'opencode',
      model: opts.opencodeModel === undefined ? 'openai/gpt-5.6' : opts.opencodeModel,
    },
    {
      name: 'claude-code',
      protocol: 'claude-code',
      enabled: true,
      isDefault: defaultProtocol === 'claude-code',
      model: 'anthropic/claude-opus-5',
    },
  ]
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = typeof input === 'string' ? input : new URL(String(input)).pathname
    if (path.endsWith('/api/runtimes')) return json({ runtimes })
    return json([])
  })
}

function mount(value: CreateAgent) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <AgentForm value={value} onChange={() => {}} />
    </QueryClientProvider>,
  )
}

/** Settle the runtimes query, then assert no banner ever appears. */
async function expectNoBanner(): Promise<void> {
  await screen.findByRole('combobox', { name: /Runtime/ })
  await waitFor(() => expect(screen.queryByTestId(BANNER)).toBeNull())
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RFC-251 — plugins and collaborators are no longer blocked', () => {
  test('plugins on an opencode runtime do not raise a blocker', async () => {
    mockRuntimes('opencode')
    mount({ ...emptyAgent(), plugins: ['p1'] })
    await expectNoBanner()
  })

  test('collaborating agents on an opencode runtime do not raise a blocker', async () => {
    mockRuntimes('opencode')
    mount({ ...emptyAgent(), dependsOn: ['a1'] })
    await expectNoBanner()
  })

  test('both together still do not raise a blocker', async () => {
    mockRuntimes('opencode')
    mount({ ...emptyAgent(), plugins: ['p1', 'p2'], dependsOn: ['a1', 'a2'] })
    await expectNoBanner()
  })
})

describe('RFC-251 — a missing OpenCode model is still a blocker', () => {
  test('an opencode runtime with no model reports model-unresolved', async () => {
    mockRuntimes('opencode', { opencodeModel: null })
    mount(emptyAgent())
    const banner = await screen.findByTestId(BANNER)
    expect(banner.textContent).toContain(MODEL_MSG)
  })

  test('the model blocker is unaffected by a plugin/collaborator selection', async () => {
    mockRuntimes('opencode', { opencodeModel: null })
    mount({ ...emptyAgent(), plugins: ['p1'], dependsOn: ['a1'] })
    const banner = await screen.findByTestId(BANNER)
    // Exactly the model message — the removed codes must not resurface.
    expect(banner.textContent).toBe(MODEL_MSG)
  })

  test('a resolved model clears the banner', async () => {
    mockRuntimes('opencode')
    mount(emptyAgent())
    await expectNoBanner()
  })

  test('a claude-code runtime is never gated, model or selection', async () => {
    mockRuntimes('claude-code')
    mount({ ...emptyAgent(), plugins: ['p1'], dependsOn: ['a1'] })
    await expectNoBanner()
  })
})
