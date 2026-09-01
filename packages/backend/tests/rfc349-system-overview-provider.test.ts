import { describe, expect, test } from 'bun:test'

import type { Actor } from '@/auth/actor'
import type { MemoryScopeAuthority, MemoryScopeRef } from '@/modules/memory/public/catalog'
import { composeSystemOverviewQuery } from '@/modules/system-operations/application/overview'
import type { RequestAuthority } from '@/modules/identity-access/public/participants'

function actor(permissions: readonly string[]): Actor {
  return {
    user: {
      id: 'usr_overview_fixture',
      username: 'overview',
      email: null,
      displayName: 'Overview',
      gitName: 'Overview',
      passwordHash: null,
      role: 'user',
      status: 'active',
      forcePasswordChange: false,
      createdBy: null,
      createdAt: 1,
    },
    permissions: new Set(permissions),
    source: 'session',
  } as Actor
}

const authority = {} as RequestAuthority

describe('RFC-349 provider-neutral system overview', () => {
  test('assembles owner projections with one clock and exact permission nulls', async () => {
    const calls: string[] = []
    const query = composeSystemOverviewQuery({
      now: () => Date.UTC(2026, 7, 31),
      resourceCatalog: {
        async load(received) {
          expect(received).toBe(authority)
          calls.push('resource-catalog')
          return {
            agents: 1,
            skills: 2,
            mcps: null,
            plugins: 4,
            workflows: 5,
            workgroups: 6,
          }
        },
      },
      repositories: {
        async countCachedRepositories() {
          calls.push('repositories')
          return 7
        },
      },
      integration: {
        async countScheduled() {
          calls.push('integration')
          return 8
        },
      },
      memories: {
        queries: {
          async list() {
            calls.push('memory-list')
            return [
              { id: 'mem_visible', scopeType: 'global', scopeId: null },
              { id: 'mem_hidden', scopeType: 'global', scopeId: null },
            ] as never
          },
          async filterVisible<T extends MemoryScopeRef>(
            _scope: MemoryScopeAuthority,
            rows: readonly T[],
          ) {
            calls.push('memory-visible')
            return rows.slice(0, 1)
          },
        } as never,
      },
      tasks: {
        async load(input) {
          calls.push('tasks')
          expect(input.since).toBe(Date.UTC(2026, 7, 24))
          return { running: 1, awaiting: 2, done7d: 3, failed7d: 4 }
        },
      },
    })

    expect(
      await query.execute({
        authority,
        actor: actor(['repos:read', 'memory:read', 'tasks:read:own']),
      }),
    ).toEqual({
      resources: {
        agents: 1,
        skills: 2,
        mcps: null,
        plugins: 4,
        workflows: 5,
        workgroups: 6,
        repos: 7,
        scheduled: 8,
        memories: 1,
      },
      tasks: { running: 1, awaiting: 2, done7d: 3, failed7d: 4 },
      generatedAt: '2026-08-31T00:00:00.000Z',
    })
    expect(calls).toEqual([
      'resource-catalog',
      'repositories',
      'integration',
      'memory-list',
      'tasks',
      'memory-visible',
    ])
  })

  test('does not invoke repository, memory, or task queries without permissions', async () => {
    let forbiddenCalls = 0
    const query = composeSystemOverviewQuery({
      now: () => 0,
      resourceCatalog: {
        async load() {
          return {
            agents: null,
            skills: null,
            mcps: null,
            plugins: null,
            workflows: null,
            workgroups: null,
          }
        },
      },
      repositories: {
        async countCachedRepositories() {
          forbiddenCalls += 1
          return 0
        },
      },
      integration: {
        async countScheduled() {
          return null
        },
      },
      memories: {
        queries: {
          async list() {
            forbiddenCalls += 1
            return []
          },
        } as never,
      },
      tasks: {
        async load() {
          forbiddenCalls += 1
          return { running: 0, awaiting: 0, done7d: 0, failed7d: 0 }
        },
      },
    })

    expect(await query.execute({ authority, actor: actor([]) })).toMatchObject({
      resources: { repos: null, memories: null },
      tasks: null,
    })
    expect(forbiddenCalls).toBe(0)
  })
})
