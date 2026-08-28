// RFC-315 — both Webhook trigger rules and source-neutral Event Center rules
// consume the same owner-aware presentation projection. These tests lock the
// actual Event Center controls, not only the permission helper.

import type { Permission } from '@agent-workflow/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { EventResponseRulesPanel } from '../src/components/events/EventResponseRulesPanel'
import {
  canCreateEventAutomationRule,
  canWriteEventAutomationRule,
} from '../src/components/events/eventAutomationRulePermissions'
import type { MeResponse } from '../src/hooks/useActor'
import i18n from '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function actor(userId: string, permissions: Permission[]): MeResponse {
  return {
    user: {
      id: userId,
      username: userId,
      displayName: userId,
      role: 'user',
      status: 'active',
    },
    profile: {
      displayName: userId,
      gitName: userId,
      email: `${userId}@example.test`,
      gitCommitIdentity: { name: userId, email: `${userId}@example.test` },
    },
    source: 'session',
    permissions,
    linkedIdentities: [],
    pats: [],
  }
}

const CATALOG = {
  sources: [
    {
      sourceRef: { id: 'test.source', revision: 1 },
      displayName: { 'zh-CN': '测试来源', 'en-US': 'Test source' },
    },
  ],
  eventTypes: [
    {
      eventTypeRef: { id: 'test.work.requested', revision: 1 },
      sourceRef: { id: 'test.source', revision: 1 },
      subjectTypeId: 'test.work',
      displayName: { 'zh-CN': '工作已请求', 'en-US': 'Work requested' },
      description: { 'zh-CN': '工作已请求', 'en-US': 'Work requested' },
      triggerParameters: {
        namespace: 'test',
        fields: [
          {
            fieldId: 'work_id',
            displayName: { 'zh-CN': '工作 ID', 'en-US': 'Work ID' },
            description: { 'zh-CN': '工作 ID', 'en-US': 'Work ID' },
          },
        ],
      },
    },
  ],
}

function rule(id: string, ownerUserId: string) {
  return {
    id,
    ownerUserId,
    name: `${id} rule`,
    enabled: true,
    eventTypeRef: { id: 'test.work.requested', revision: 1 },
    sourceRef: { id: 'test.source', revision: 1 },
    subjectTypeId: 'test.work',
    subjectMatch: 'all',
    subjectPattern: null,
    target: {
      kind: 'workflow',
      refId: 'workflow-1',
      nameTemplate: '{{trigger.test.work_id}}',
      inputs: {},
    },
    lastFiredAt: null,
    lastStatus: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

let currentActor = actor('manager-1', [
  'event-automation-rules:read',
  'event-automation-rules:create',
  'event-automation-rules:update',
  'event-automation-rules:delete',
  'users:search',
])

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <EventResponseRulesPanel catalog={CATALOG} language="en-US" />
    </QueryClientProvider>,
  )
  return client
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  setBaseUrl(`http://rfc315-ui-${crypto.randomUUID()}.test`)
  setToken('rfc315-session')
  currentActor = actor('manager-1', [
    'event-automation-rules:read',
    'event-automation-rules:create',
    'event-automation-rules:update',
    'event-automation-rules:delete',
    'users:search',
  ])
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    if (url.includes('/api/auth/me')) return jsonResponse(currentActor)
    if (url.includes('/api/event-center/response-rules')) {
      return jsonResponse({ items: [rule('mine', 'manager-1'), rule('other', 'admin-1')] })
    }
    if (url.includes('/api/users/lookup')) {
      return jsonResponse([
        {
          id: 'manager-1',
          username: 'manager',
          displayName: 'Manager One',
          role: 'manager',
          status: 'active',
        },
        {
          id: 'admin-1',
          username: 'admin',
          displayName: 'Admin One',
          role: 'admin',
          status: 'active',
        },
      ])
    }
    if (url.includes('/api/workflows')) return jsonResponse([{ id: 'workflow-1', name: 'Repair' }])
    if (url.includes('/api/digital-employees')) return jsonResponse({ items: [] })
    return jsonResponse([])
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RFC-315 event automation rule presentation permissions', () => {
  test('the shared helper is owner-scoped unless override-owner is present', () => {
    const manager = currentActor
    expect(canCreateEventAutomationRule(manager)).toBe(true)
    expect(canWriteEventAutomationRule(manager, 'manager-1', 'event-automation-rules:update')).toBe(
      true,
    )
    expect(canWriteEventAutomationRule(manager, 'admin-1', 'event-automation-rules:update')).toBe(
      false,
    )
    expect(
      canWriteEventAutomationRule(
        actor('manager-1', [
          'event-automation-rules:update',
          'event-automation-rules:override-owner',
        ]),
        'admin-1',
        'event-automation-rules:update',
      ),
    ).toBe(true)
  })

  test('manager sees create and own-row controls but another owner stays read-only', async () => {
    renderPanel()
    expect(await screen.findByTestId('event-response-rule-list')).toBeTruthy()
    expect(screen.getByTestId('event-response-rule-new')).toBeTruthy()
    expect(screen.getByTestId('event-response-rule-edit-mine')).toBeTruthy()
    expect(screen.queryByTestId('event-response-rule-edit-other')).toBeNull()
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1)
    await waitFor(() => expect(document.body.textContent).toContain('Manager One'))
    expect(document.body.textContent).toContain('Admin One')
    expect(document.body.textContent).toContain('My rule')
  })

  test('ordinary user gets the full read view with no mutation controls', async () => {
    currentActor = actor('user-1', ['event-automation-rules:read', 'users:search'])
    renderPanel()
    expect(await screen.findByTestId('event-response-rule-list')).toBeTruthy()
    expect(screen.queryByTestId('event-response-rule-new')).toBeNull()
    expect(screen.queryByTestId('event-response-rule-edit-mine')).toBeNull()
    expect(screen.queryByTestId('event-response-rule-edit-other')).toBeNull()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: 'Delete' })).toHaveLength(0)
    expect(document.body.textContent).toContain('mine rule')
    expect(document.body.textContent).toContain('other rule')
  })

  test('authority withdrawal closes authoring and a later grant uses a fresh write generation', async () => {
    const client = renderPanel()
    fireEvent.click(await screen.findByTestId('event-response-rule-new'))
    expect(screen.getByRole('dialog')).toBeTruthy()

    currentActor = actor('manager-1', ['event-automation-rules:read', 'users:search'])
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['auth', 'me'] })
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByTestId('event-response-rule-new')).toBeNull()

    currentActor = actor('manager-1', [
      'event-automation-rules:read',
      'event-automation-rules:create',
      'event-automation-rules:update',
      'event-automation-rules:delete',
      'users:search',
    ])
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['auth', 'me'] })
    })
    fireEvent.click(await screen.findByTestId('event-response-rule-new'))
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})
