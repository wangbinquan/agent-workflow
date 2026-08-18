// RFC-310 PR-8 T87/T88 —— policy 页面：builder 序列化、模拟请求形状、trace 渲染。
//
// 锁四件事：①前端静态目录（fact catalog / 谓词词表 / capability / 默认模板 /
// 硬上限）与后端 domain **直接 import 对拍**——后端加词而前端未同步立刻红，
// 不靠人肉记忆；②rule builder 的增/删/移序操作最终序列化出正确的 PUT draft
// （first-match 顺序就是数组顺序）；③simulator 发出的 preview-decision 载荷
// 与后端 route schema 同形（guards+cells+rules，决策为 pending-route 形态——
// 与生产 reconciler 的规则构造一致）；④publish 422 的 violations 逐条落地。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

import {
  AGENT_CAPABILITY_IDS,
  defaultPolicyTemplate,
  LEAF_PREDICATE_KINDS,
  POLICY_FACT_CATALOG,
  POLICY_HARD_CAPS,
} from '../src/data/policyFactCatalog'
import { draftToPredicate, predicateToDraft } from '../src/components/code/PolicyRuleBuilder'

// 后端 domain 直接相对 import（纯 zod 依赖，无 @ alias）——静态镜像的对拍源。
import {
  defaultAutomationPolicyContent,
  POLICY_HARD_CAPS as BACKEND_CAPS,
} from '../../backend/src/modules/development-automation/domain/automationPolicy'
import { FACT_CATALOG } from '../../backend/src/modules/development-automation/domain/facts'
import { factPredicateSchema } from '../../backend/src/modules/development-automation/domain/predicate'
import { AGENT_CAPABILITY_IDS as BACKEND_AGENT_IDS } from '../../backend/src/modules/development-automation/domain/capabilityDefinition'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('policy static catalog mirrors backend domain', () => {
  test('fact catalog ids, types and vocabularies match FACT_CATALOG exactly', () => {
    const mirror = new Map(POLICY_FACT_CATALOG.map((e) => [e.id, e]))
    expect(POLICY_FACT_CATALOG).toHaveLength(FACT_CATALOG.length)
    for (const leaf of FACT_CATALOG) {
      const entry = mirror.get(leaf.id)
      expect(entry, `missing mirror for ${leaf.id}`).toBeDefined()
      expect(entry!.type, leaf.id).toBe(leaf.type)
      expect(entry!.vocabulary, leaf.id).toEqual(leaf.vocabulary)
    }
  })

  test('leaf predicate kinds are accepted by the backend predicate schema', () => {
    const samples: Record<(typeof LEAF_PREDICATE_KINDS)[number], unknown> = {
      'enum-equals': { kind: 'enum-equals', fact: 'requirement.sourceKind', value: 'direct' },
      'enum-in': { kind: 'enum-in', fact: 'requirement.sourceKind', values: ['direct'] },
      'set-contains-any': {
        kind: 'set-contains-any',
        fact: 'repository.languages',
        values: ['java'],
      },
      'set-contains-all': {
        kind: 'set-contains-all',
        fact: 'repository.languages',
        values: ['java'],
      },
      'number-compare': {
        kind: 'number-compare',
        fact: 'mr.unhandledFeedbackCount',
        op: 'gte',
        value: 1,
      },
      'boolean-is': { kind: 'boolean-is', fact: 'mr.exists', value: true },
      'path-class-any': { kind: 'path-class-any', values: ['docs'] },
    }
    for (const kind of LEAF_PREDICATE_KINDS) {
      expect(factPredicateSchema.safeParse(samples[kind]).success, kind).toBe(true)
    }
  })

  test('capability ids, default template and hard caps mirror the backend', () => {
    expect([...AGENT_CAPABILITY_IDS]).toEqual([...BACKEND_AGENT_IDS])
    expect(defaultPolicyTemplate()).toEqual(defaultAutomationPolicyContent())
    for (const [key, cap] of Object.entries(POLICY_HARD_CAPS)) {
      expect(BACKEND_CAPS[key as keyof typeof BACKEND_CAPS], key).toBe(cap)
    }
  })

  test('predicate draft round-trips leaves and preserves composites as JSON', () => {
    const leaf = { kind: 'boolean-is', fact: 'mr.exists', value: true }
    expect(draftToPredicate(predicateToDraft(leaf))).toEqual(leaf)
    const composite = {
      kind: 'any',
      predicates: [{ kind: 'boolean-is', fact: 'mr.exists', value: true }],
    }
    const draft = predicateToDraft(composite)
    expect(draft.kind).toBe('json')
    expect(draftToPredicate(draft)).toEqual(composite)
    expect(draftToPredicate({ kind: 'json', raw: '{broken' })).toBeInstanceOf(Error)
  })
})

// ---------------------------------------------------------------- page tests

interface Recorded {
  calls: Array<{ url: string; method: string; body: unknown }>
}

const ME = {
  user: { id: 'u-1', username: 'admin', displayName: 'Admin', role: 'admin', status: 'active' },
  source: 'session',
  linkedIdentities: [],
  pats: [],
  permissions: [
    'automation-policies:read',
    'automation-policies:create',
    'automation-policies:update',
  ],
}

const POLICY_ROW = {
  id: '01POLICY000000000000000001',
  name: 'java-default',
  publishedRevision: 2,
  ownerUserId: 'u-1',
  visibility: 'private',
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
  archivedAt: null,
}

function installFetch(overrides: { publishStatus?: number; publishBody?: unknown } = {}): Recorded {
  const rec: Recorded = { calls: [] }
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = req.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      rec.calls.push({ url, method, body })
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      if (url.includes('/api/auth/me')) return json(ME)
      if (url.includes('/preview-decision')) {
        return json({
          selected: { kind: 'block', reason: 'no-policy-match' },
          selectedBy: 'no-match',
          matchedRuleId: null,
          guardTrace: [
            { guard: 'terminal', outcome: 'pass', detail: null },
            { guard: 'lease-epoch', outcome: 'pass', detail: null },
          ],
          ruleTrace: [{ ruleId: 'default-analyze', matched: false, stoppedOn: null }],
        })
      }
      if (url.includes('/publish') && method === 'POST') {
        return json(overrides.publishBody ?? { revision: 3 }, overrides.publishStatus ?? 200)
      }
      if (/\/api\/code\/automation-policies\/[^/]+$/.test(url) && method === 'GET') {
        return json({ ...POLICY_ROW, draft: defaultPolicyTemplate() })
      }
      if (/\/api\/code\/automation-policies\/[^/]+$/.test(url) && method === 'PUT') {
        return json({ ok: true })
      }
      if (url.includes('/api/code/automation-policies') && method === 'POST') {
        return json({ ...POLICY_ROW, publishedRevision: null }, 201)
      }
      if (url.includes('/api/code/automation-policies')) {
        return json({ items: [POLICY_ROW] })
      }
      return json({})
    },
  )
  return rec
}

async function renderPolicies(initial: string) {
  const listPage = await import('../src/routes/code.policies')
  const detailPage = await import('../src/routes/code.policies.$id')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/code/policies',
    component: listPage.Route.options.component,
  })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/code/policies/$policyId',
    component: detailPage.Route.options.component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([detailRoute, listRoute]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  })
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return router
}

describe('/code/policies list', () => {
  test('renders policies and creates one seeded with the default template', async () => {
    const rec = installFetch()
    await renderPolicies('/code/policies')
    await screen.findByText('java-default')
    expect(screen.getByText(/rev 2/)).toBeTruthy()

    fireEvent.click(await screen.findByTestId('policy-create-open'))
    fireEvent.change(screen.getByTestId('policy-create-name'), {
      target: { value: 'cpp-default' },
    })
    fireEvent.click(screen.getByTestId('policy-create-submit'))
    await waitFor(() => {
      const create = rec.calls.find(
        (c) => c.method === 'POST' && /automation-policies$/.test(new URL(c.url).pathname),
      )
      expect(create).toBeDefined()
      expect(create!.body).toMatchObject({ name: 'cpp-default' })
      expect((create!.body as { draft: unknown }).draft).toEqual(defaultPolicyTemplate())
    })
  })
})

describe('/code/policies/$policyId detail', () => {
  test('builder edits (add rule, reorder) serialize into the PUT draft in first-match order', async () => {
    const rec = installFetch()
    await renderPolicies(`/code/policies/${POLICY_ROW.id}`)
    // 默认模板两条规则可见（顺序即优先级）。
    await screen.findByTestId('policy-action-rule-0')
    expect(screen.getByTestId('policy-action-rule-1')).toBeTruthy()
    expect(screen.getByTestId('policy-fixed-guards').textContent).toContain('terminal')

    // 加一条规则 → 末尾；上移一格 → 顺序 [default-analyze, rule-3, default-implement]。
    fireEvent.click(screen.getByTestId('policy-action-add-rule'))
    await screen.findByTestId('policy-action-rule-2')
    fireEvent.click(screen.getByTestId('policy-action-rule-2-up'))

    fireEvent.click(screen.getByTestId('policy-save'))
    await waitFor(() => {
      const put = rec.calls.find((c) => c.method === 'PUT')
      expect(put).toBeDefined()
      const draft = (put!.body as { draft: { actionPriority: { rules: { ruleId: string }[] } } })
        .draft
      expect(draft.actionPriority.rules.map((r) => r.ruleId)).toEqual([
        'default-analyze',
        'rule-3',
        'default-implement',
      ])
      // 其余段随默认模板原样保留（builder 不动 settings）。
      expect(draft).toMatchObject({ conflict: { mode: 'report-only' } })
    })
  })

  test('publish violations from a 422 are listed item by item', async () => {
    installFetch({
      publishStatus: 422,
      publishBody: {
        code: 'automation-policy-publish-blocked',
        message: 'policy publish checks failed',
        details: {
          violations: [
            {
              code: 'duplicate-rule-id',
              where: 'actionPriority/rules',
              detail: "ruleId 'x' appears twice",
            },
          ],
        },
      },
    })
    await renderPolicies(`/code/policies/${POLICY_ROW.id}`)
    await screen.findByTestId('policy-action-rule-0')
    fireEvent.click(screen.getByTestId('policy-publish'))
    await screen.findByTestId('policy-violations')
    expect(screen.getByText('duplicate-rule-id')).toBeTruthy()
    expect(screen.getByText(/appears twice/)).toBeTruthy()
  })

  test('simulator posts the exact preview payload and renders guard/rule traces with no-match diagnosis', async () => {
    const rec = installFetch()
    await renderPolicies(`/code/policies/${POLICY_ROW.id}`)
    await screen.findByTestId('policy-action-rule-0')

    fireEvent.click(screen.getByText('Simulate'))
    await screen.findByTestId('policy-simulator')
    fireEvent.click(screen.getByTestId('sim-run'))
    await screen.findByTestId('sim-trace')

    const call = rec.calls.find((c) => c.url.includes('/preview-decision'))
    expect(call).toBeDefined()
    const body = call!.body as {
      guards: Record<string, unknown>
      cells: Record<string, { state: string; value: unknown }>
      rules: { ruleId: string; decision: { kind: string; capabilityId: string } }[]
    }
    // guards fixture 完整形状（后端 strict schema 同形）。
    expect(body.guards).toMatchObject({
      missionTerminal: false,
      mrTerminal: 'not-applicable',
      transitionFence: 'none',
      uploadPlanRef: null,
    })
    // 默认 cells 行：boolean 值按目录类型解析。
    expect(body.cells['requirement.bundleComplete']).toEqual({
      state: 'known',
      value: true,
      sourceRevision: 'fixture',
    })
    // 规则决策与生产 reconciler 构造一致（pending-route 形态）。
    expect(body.rules[0]).toMatchObject({
      ruleId: 'default-analyze',
      decision: {
        kind: 'run-agent-action',
        capabilityId: 'requirement.analyze',
        templateRef: 'pending-route',
        workSetRef: 'none',
      },
    })
    // trace 渲染：守卫逐条 + 规则 miss + no-match 明确诊断。
    expect(screen.getByTestId('sim-guard-trace').textContent).toContain('terminal')
    expect(screen.getByTestId('sim-rule-trace').textContent).toContain('default-analyze')
    expect(screen.getByTestId('sim-selected').textContent).toContain('no-policy-match')
  })
})
