// LOCKS: RFC-218 — port-driven single-agent launch form (design §9-12/13/21/22).
//
//   P1 ported agent: step 3 renders one field per declared port, NO
//      description textarea; the POST body carries `inputs` and NO
//      `description` (AC-1).
//   P2 zero-port agent keeps the RFC-165 description form + wire (AC-2).
//   P3 required gating: a blank required port holds Next disabled on the
//      content step (AC-5).
//   P4 blocker agent (signal port): reason banner + Next disabled (AC-4).
//   P5 list<string> port renders ChipsInput; committed items join with
//      newline on the wire (AC-3).
//   P6 switching agents A→B prunes A's port keys from the wire (design P1-4).
//   P7 relaunch of a ported task prefills port values and re-launches with
//      `inputs` (AC-9; discriminator = indexed input-node id, design P1-1).
//   P8 deep link + slow agents list: the content step shows a loading state,
//      never the description form, until the row is known (design P1-5).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

vi.mock('../src/hooks/useActor', () => ({
  useActor: () => ({
    data: {
      user: { id: 'me', username: 'me', displayName: 'Me', role: 'user', status: 'active' },
      source: 'session',
      permissions: [],
      linkedIdentities: [],
      pats: [],
    },
  }),
  usePermission: () => false,
}))

const AGENTS = [
  { name: 'auditor' },
  {
    name: 'ported',
    inputs: [
      { name: 'report', kind: 'markdown', description: '周报正文' },
      { name: 'style_guide', kind: 'string', required: false },
    ],
  },
  { name: 'chipper', inputs: [{ name: 'tags', kind: 'list<string>' }] },
  { name: 'blocked', inputs: [{ name: 'go', kind: 'signal' }] },
  { name: 'other', inputs: [{ name: 'brief', kind: 'string' }] },
]

const RELAUNCH_PORTED_TASK = {
  id: 'relaunch-ported',
  name: 'prior ported run',
  status: 'done',
  spaceKind: 'scratch',
  repos: [],
  repoCount: 1,
  inputs: { report: 'old report body', style_guide: 'terse' },
  sourceAgentName: 'ported',
  sourceAgentId: null,
  workgroupId: null,
  workgroupName: null,
  goal: null,
  workflowId: null,
  workflowSnapshot: {
    inputs: [
      { kind: 'text', key: 'report', label: 'report' },
      { kind: 'text', key: 'style_guide', label: 'style_guide' },
    ],
    nodes: [{ id: '__agent_input_0__', kind: 'input' }, { kind: 'agent-single' }],
  },
  errorSummary: null,
  errorMessage: null,
  failedNodeId: null,
  gitUserName: null,
  gitUserEmail: null,
  workingBranch: null,
  autoCommitPush: false,
  maxDurationMs: null,
  maxTotalTokens: null,
}
const RELAUNCH_MEMBERS = {
  owner: { id: 'me', username: 'me', displayName: 'Me', role: 'user', status: 'active' },
  users: [],
}

interface FetchCall {
  url: string
  method: string
  body: unknown
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function installFetch(opts: { agentsPromise?: Promise<Response> } = {}): FetchCall[] {
  const calls: FetchCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString()
      const method = init?.method ?? 'GET'
      let body: unknown = undefined
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body)
        } catch {
          body = init.body
        }
      }
      calls.push({ url, method, body })
      if (url.includes('/api/tasks/relaunch-ported/members')) return jsonResponse(RELAUNCH_MEMBERS)
      if (url.includes('/api/tasks/relaunch-ported')) return jsonResponse(RELAUNCH_PORTED_TASK)
      if (url.includes('/api/users/lookup')) return jsonResponse([])
      if (url.includes('/api/cached-repos')) return jsonResponse({ items: [] })
      if (url.includes('/api/workflows')) return jsonResponse([])
      if (/\/api\/agents\/[^/]+\/tasks$/.test(url) && method === 'POST')
        return jsonResponse({ id: 'task-a' }, 201)
      if (url.includes('/api/agents'))
        return opts.agentsPromise !== undefined ? opts.agentsPromise : jsonResponse(AGENTS)
      if (url.includes('/api/workgroups')) return jsonResponse([])
      return jsonResponse({})
    },
  )
  return calls
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  window.localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function renderWizard(initialUrl: string) {
  const mod = await import('../src/routes/tasks.new')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const wizard = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/new',
    component: mod.TaskWizardRoute.options.component,
    validateSearch: mod.TaskWizardRoute.options.validateSearch,
  })
  const taskPage = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id',
    component: () => <div data-testid="task-page" />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([wizard, taskPage]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  await screen.findByTestId('task-wizard')
}

const next = () => fireEvent.click(screen.getByTestId('stepper-next'))
const nextButton = () => screen.getByTestId('stepper-next') as HTMLButtonElement

async function toContentStep(agent: string) {
  await renderWizard(`/tasks/new?kind=agent&agent=${agent}`)
  // Deep link lands on the space step (scratch default) → next is content.
  next()
  await screen.findByTestId('wizard-task-name')
}

function launchBody(calls: FetchCall[], agent: string): Record<string, unknown> {
  const call = calls.find(
    (c) => c.url.includes(`/api/agents/${agent}/tasks`) && c.method === 'POST',
  )
  expect(call).toBeDefined()
  return call!.body as Record<string, unknown>
}

describe('RFC-218 — port-driven agent launch form', () => {
  test('P1 ported agent: port fields, no description; wire carries inputs only', async () => {
    const calls = installFetch()
    await toContentStep('ported')

    expect(screen.queryByTestId('wizard-description')).toBeNull()
    fireEvent.change(screen.getByTestId('wizard-task-name'), { target: { value: 'T1' } })
    fireEvent.change(await screen.findByLabelText(/^report/), {
      target: { value: 'weekly {{report}} literal' },
    })
    // Optional port left blank on purpose.
    next() // content → confirm
    fireEvent.click(await screen.findByTestId('wizard-launch'))
    await screen.findByTestId('task-page')

    const body = launchBody(calls, 'ported')
    expect(body.inputs).toEqual({ report: 'weekly {{report}} literal', style_guide: '' })
    expect(body.description).toBeUndefined()
    expect(body.scratch).toBe(true)
  })

  test('P2 zero-port agent keeps the description form and wire', async () => {
    const calls = installFetch()
    await toContentStep('auditor')

    fireEvent.change(screen.getByTestId('wizard-task-name'), { target: { value: 'T2' } })
    fireEvent.change(await screen.findByTestId('wizard-description'), {
      target: { value: 'audit it' },
    })
    next()
    fireEvent.click(await screen.findByTestId('wizard-launch'))
    await screen.findByTestId('task-page')

    const body = launchBody(calls, 'auditor')
    expect(body.description).toBe('audit it')
    expect(body.inputs).toBeUndefined()
  })

  test('P3 required port gates Next on the content step', async () => {
    installFetch()
    await toContentStep('ported')
    fireEvent.change(screen.getByTestId('wizard-task-name'), { target: { value: 'T3' } })
    await screen.findByLabelText(/^report/)
    expect(nextButton().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/^report/), { target: { value: 'x' } })
    await waitFor(() => expect(nextButton().disabled).toBe(false))
  })

  test('P4 blocker agent shows the reason banner and stays unlaunchable', async () => {
    installFetch()
    await toContentStep('blocked')
    fireEvent.change(screen.getByTestId('wizard-task-name'), { target: { value: 'T4' } })
    await screen.findByTestId('wizard-agent-blockers')
    expect(screen.queryByTestId('wizard-description')).toBeNull()
    expect(nextButton().disabled).toBe(true)
  })

  test('P5 list<string> port renders chips; items join with newline on the wire', async () => {
    const calls = installFetch()
    await toContentStep('chipper')
    fireEvent.change(screen.getByTestId('wizard-task-name'), { target: { value: 'T5' } })
    const chips = await screen.findByTestId('wizard-input-tags-input')
    fireEvent.change(chips, { target: { value: 'alpha' } })
    fireEvent.keyDown(chips, { key: 'Enter' })
    fireEvent.change(chips, { target: { value: 'beta' } })
    fireEvent.keyDown(chips, { key: 'Enter' })
    next()
    fireEvent.click(await screen.findByTestId('wizard-launch'))
    await screen.findByTestId('task-page')
    const body = launchBody(calls, 'chipper')
    expect((body.inputs as Record<string, string>).tags).toBe('alpha\nbeta')
  })

  test('P6 switching agent A→B prunes A’s keys from the wire', async () => {
    const calls = installFetch()
    await toContentStep('ported')
    fireEvent.change(await screen.findByLabelText(/^report/), { target: { value: 'A value' } })

    // Back to step 1 and pick the other agent.
    fireEvent.click(screen.getByTestId('stepper-back'))
    fireEvent.click(screen.getByTestId('stepper-back'))
    fireEvent.click(await screen.findByTestId('wizard-object-agent'))
    const listbox = await screen.findByRole('listbox')
    fireEvent.mouseDown(within(listbox).getByRole('option', { name: /other/ }))
    next()
    next()
    fireEvent.change(await screen.findByTestId('wizard-task-name'), { target: { value: 'T6' } })
    fireEvent.change(await screen.findByLabelText(/^brief/), { target: { value: 'B value' } })
    next()
    fireEvent.click(await screen.findByTestId('wizard-launch'))
    await screen.findByTestId('task-page')

    const body = launchBody(calls, 'other')
    expect(body.inputs).toEqual({ brief: 'B value' })
  })

  test('P7 relaunch of a ported task prefills ports and re-launches with inputs', async () => {
    const calls = installFetch()
    await renderWizard('/tasks/new?relaunchFrom=relaunch-ported')
    // Seed applied → wizard rests on step 1 with every step reachable; walk
    // to the content step to inspect the prefilled port form.
    await waitFor(() => expect(nextButton().disabled).toBe(false))
    next() // mode → space
    next() // space → content
    const report = (await screen.findByLabelText(/^report/)) as HTMLTextAreaElement
    expect(report.value).toBe('old report body')
    expect(screen.queryByTestId('wizard-description')).toBeNull()
    next() // content → confirm
    fireEvent.click(await screen.findByTestId('wizard-launch'))
    await screen.findByTestId('task-page')
    const body = launchBody(calls, 'ported')
    expect(body.inputs).toEqual({ report: 'old report body', style_guide: 'terse' })
    expect(body.description).toBeUndefined()
  })

  test('P8 deep link + slow agents list: loading state, never a guessed form', async () => {
    let resolveAgents!: (r: Response) => void
    const agentsPromise = new Promise<Response>((res) => {
      resolveAgents = res
    })
    installFetch({ agentsPromise })
    await renderWizard('/tasks/new?kind=agent&agent=ported')
    next() // space → content while the list is still pending
    await screen.findByTestId('wizard-task-name')
    expect(screen.queryByTestId('wizard-description')).toBeNull()
    expect(screen.queryByLabelText(/^report/)).toBeNull()
    expect(nextButton().disabled).toBe(true)

    resolveAgents(jsonResponse(AGENTS))
    await screen.findByLabelText(/^report/)
    expect(screen.queryByTestId('wizard-description')).toBeNull()
  })
})

describe('RFC-218 — source guard', () => {
  test('the wizard derives agent defs from the shared layer (no fork)', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.new.tsx'),
      'utf-8',
    )
    expect(src).toContain('deriveAgentLaunchForm')
    expect(src).toContain('agentLaunchForm?.inputs')
    // The old workflow-only restriction must not come back verbatim.
    expect(src).not.toContain(
      "kind === 'workflow' ? (normalizedWorkflowDefinition?.inputs ?? []) : []",
    )
  })
})
