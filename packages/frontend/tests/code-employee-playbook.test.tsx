// RFC-310 PR-11 — the business playbook is usable without leaving the draft.
//
// These regressions lock two easy-to-miss product contracts: reactive MR/CI
// duties are independent triggers instead of dead-end sequential steps, and a
// step can create, publish and select its executor on the same page.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import '../src/i18n'
import { DigitalEmployeePlaybookEditor } from '../src/components/code/DigitalEmployeePlaybookEditor'
import {
  buildInitialEmployeePlaybook,
  type PublishedResourceOption,
} from '../src/components/code/employeePlaybook'
import { setBaseUrl, setToken } from '../src/stores/auth'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('playbook-test-token')
  localStorage.setItem('aw-language', 'en-US')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const implementations: PublishedResourceOption[] = [
  ['analyze', 'requirement.analyze'],
  ['implement', 'change.implement'],
  ['review', 'change.review'],
  ['feedback', 'mr.feedback.apply'],
  ['pipeline', 'pipeline.repair'],
].map(([id, capabilityId]) => ({
  id: id!,
  name: id!,
  capabilityId: capabilityId!,
  executorKind: 'agent',
  publishedRevision: 1,
}))

describe('employee playbook defaults', () => {
  // 2026-08-20 回归：`displayName` 是**落库内容**，创建那一刻就定死了。此前它是五个
  // 中文字面量，于是英文界面创建出来的员工，工作步骤名是中文——整页英文里孤零零一行
  // 「实现修改」。功能测试从不看文字属于哪种语言，是 RFC-310 T121 的详情页视觉基线
  // 第一次截图照出来的。这条锁住「名字由调用方按语言给」，而不是由本模块写死。
  test('step display names come from the caller, not a hard-coded language', () => {
    const draft = buildInitialEmployeePlaybook({
      description: '',
      preset: 'java',
      policy: { id: 'policy-1', name: 'Rules', publishedRevision: 2 },
      implementations,
      stepName: (nameKey) => `EN ${nameKey}`,
    })
    const names = (draft.steps as Array<Record<string, unknown>>).map((step) => step.displayName)
    expect(names).toContain('EN changeImplement')
    // 一个中日韩字符都不该从本模块里漏出来。
    expect(names.every((name) => !/[\u4e00-\u9fff]/.test(String(name)))).toBe(true)
  })

  test('chains one-shot delivery work and keeps review/pipeline repair reactive', () => {
    const draft = buildInitialEmployeePlaybook({
      description: 'Java employee',
      preset: 'java',
      policy: { id: 'policy-1', name: 'Rules', publishedRevision: 2 },
      implementations,
      stepName: (nameKey) => `name:${nameKey}`,
    })
    const steps = draft.steps as Array<Record<string, unknown>>
    const byImplementation = new Map(
      steps.map((step) => [
        (step.producer as { implementationRef: { id: string } }).implementationRef.id,
        step,
      ]),
    )

    expect(byImplementation.get('analyze')?.onSuccess).toBe(
      byImplementation.get('implement')?.stepId,
    )
    expect(byImplementation.get('implement')?.onSuccess).toBe(
      byImplementation.get('review')?.stepId,
    )
    expect(byImplementation.get('review')?.onSuccess).toBe('reconcile')
    for (const id of ['feedback', 'pipeline']) {
      expect(byImplementation.get(id)).toMatchObject({
        input: { kind: 'mission-requirement' },
        onSuccess: 'reconcile',
      })
    }
  })
})

test('creates, publishes and selects an Agent executor without abandoning the employee draft', async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(request.toString()).pathname
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      calls.push({ path, method, body })
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      if (path === '/api/code/action-templates' && method === 'POST') {
        return json({ id: 'executor-inline', name: 'Inline implementer' }, 201)
      }
      if (path === '/api/code/action-templates/executor-inline/publish' && method === 'POST') {
        return json({ revision: 7 })
      }
      if (path === '/api/code/action-templates') return json({ items: [] })
      if (path === '/api/code/digital-employees') return json({ items: [] })
      if (path === '/api/code/automation-policies') return json({ items: [] })
      if (path === '/api/integrations/development-adapters') return json({ items: [] })
      if (path === '/api/agents') return json([{ id: 'agent-1', name: 'Coding Agent' }])
      return json({})
    },
  )

  const initialDraft: Record<string, unknown> = {
    schemaVersion: 1,
    description: '',
    businessStatus: 'enabled',
    supportedRepositoryFacts: [],
    steps: [
      {
        stepId: 'implement',
        displayName: 'Implement',
        description: '',
        when: [],
        producer: { kind: 'agent', implementationRef: { id: '', revision: 1 } },
        input: { kind: 'mission-requirement' },
        onSuccess: 'reconcile',
        join: null,
        onFailure: {
          retry: { sameScene: 1, freshScene: 1 },
          onExhausted: 'block',
          onRejected: null,
          onExpired: null,
        },
      },
    ],
    problemTypes: [],
    problemProducers: [],
    problemHandlers: [],
    capabilityRoutes: [],
    requirementSources: [],
    pipelineProviders: [],
    defaultPolicyRef: { id: 'policy-1', revision: 1 },
  }
  const observed: Record<string, unknown>[] = []
  function Harness() {
    const [draft, setDraft] = useState(initialDraft)
    return (
      <DigitalEmployeePlaybookEditor
        draft={draft}
        onChange={(next) => {
          observed.push(next)
          setDraft(next)
        }}
      />
    )
  }
  const root = createRootRoute()
  const route = createRoute({ getParentRoute: () => root, path: '/', component: Harness })
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )

  fireEvent.click(await screen.findByTestId('employee-step-create-executor'))
  fireEvent.change(screen.getByTestId('inline-executor-create-name'), {
    target: { value: 'Inline implementer' },
  })
  const submit = screen.getByTestId('inline-executor-create-submit')
  await waitFor(() => expect(submit.hasAttribute('disabled')).toBe(false))
  fireEvent.click(submit)

  await waitFor(() => expect(observed.length).toBeGreaterThan(0))
  const selected = observed.at(-1)!
  expect((selected.steps as Array<Record<string, unknown>>)[0]).toMatchObject({
    producer: { kind: 'agent', implementationRef: { id: 'executor-inline', revision: 7 } },
  })
  expect(selected.capabilityRoutes).toEqual([
    {
      capabilityId: 'change.implement',
      rules: [],
      fallbackTemplateRef: { id: 'executor-inline', revision: 7 },
    },
  ])
  expect(screen.getByTestId('employee-playbook-editor')).toBeTruthy()
  expect(screen.queryByTestId('inline-executor-create-submit')).toBeNull()
  expect(calls.filter((call) => call.method === 'POST').map((call) => call.path)).toEqual([
    '/api/code/action-templates',
    '/api/code/action-templates/executor-inline/publish',
  ])
})
