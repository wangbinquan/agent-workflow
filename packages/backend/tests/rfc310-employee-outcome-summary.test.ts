// RFC-310 T212 — employee cards aggregate both sides of the single-writer cutover.
//
// The regression is not merely "the endpoint returns numbers": each owner must
// issue one grouped projection for every employee, omit non-terminal work, and
// keep the two ledgers separate so the UI can combine them without a cross-domain
// table import or N+1 detail requests.

import { describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createInMemoryDb } from '../src/db/client'
import { developmentMissions, employeeCases, users } from '../src/db/schema'
import { createApp } from '../src/server'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const TOKEN = 'a'.repeat(64)
const NOW = 1_700_000_000_000

describe('RFC-310 T212 — bounded employee outcome projections', () => {
  test('EmployeeCase and legacy Mission endpoints each return terminal groups for all employees', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aw-rfc310-employee-outcomes-'))
    process.env.AGENT_WORKFLOW_HOME = home
    const db = createInMemoryDb(MIGRATIONS)
    await db.insert(users).values({
      id: 'u1',
      username: 'u1',
      displayName: 'u1',
      role: 'admin',
      createdAt: NOW,
      updatedAt: NOW,
    })

    const caseRow = (
      id: string,
      employeeId: string,
      state: 'active' | 'waiting' | 'blocked' | 'terminal',
      terminalKind: string | null,
    ) => ({
      id,
      employeeId,
      employeeRevision: 1,
      typeId: 'development',
      typeRevision: 5,
      primaryContextId: `context-${id}`,
      executionPolicyRevision: 1,
      state,
      terminalKind,
      revision: 1,
      writerGeneration: 1,
      createdAt: NOW,
      updatedAt: NOW,
      terminalAt: state === 'terminal' ? NOW : null,
    })
    await db
      .insert(employeeCases)
      .values([
        caseRow('case-merged', 'employee-1', 'terminal', 'merged'),
        caseRow('case-failed', 'employee-1', 'terminal', 'execution-failed'),
        caseRow('case-closed', 'employee-2', 'terminal', 'closed'),
        caseRow('case-active', 'employee-1', 'active', null),
      ])

    const missionRow = (id: string, employeeId: string | null, status: string) => ({
      id,
      revision: 1,
      status: status as typeof developmentMissions.$inferInsert.status,
      automationMode: 'auto' as const,
      transitionFence: 'none' as const,
      repositoryId: 'repo-1',
      sourceKind: 'direct-input' as const,
      deliveryKind: 'merge-request' as const,
      employeeId,
      createdAt: NOW,
      updatedAt: NOW,
    })
    await db
      .insert(developmentMissions)
      .values([
        missionRow('mission-merged', 'employee-1', 'merged'),
        missionRow('mission-no-change', 'employee-1', 'completed-no-change'),
        missionRow('mission-failed', 'employee-2', 'failed'),
        missionRow('mission-working', 'employee-1', 'working'),
        missionRow('mission-unassigned', null, 'merged'),
      ])

    const app: Hono = createApp({
      token: TOKEN,
      configPath: join(home, 'config.json'),
      opencodeVersion: '1.14.25',
      dbVersion: 200,
      db,
    })
    const get = async (path: string) => {
      const response = await app.request(path, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      expect(response.status).toBe(200)
      return (await response.json()) as {
        items: Array<{ employeeId: string; terminalKind: string; count: number }>
      }
    }

    const runtime = await get('/api/digital-employees/outcome-summaries')
    expect(runtime.items).toEqual([
      { employeeId: 'employee-1', terminalKind: 'execution-failed', count: 1 },
      { employeeId: 'employee-1', terminalKind: 'merged', count: 1 },
      { employeeId: 'employee-2', terminalKind: 'closed', count: 1 },
    ])

    const legacy = await get('/api/code/missions/outcome-summaries')
    expect(legacy.items).toEqual([
      { employeeId: 'employee-1', terminalKind: 'completed-no-change', count: 1 },
      { employeeId: 'employee-2', terminalKind: 'failed', count: 1 },
      { employeeId: 'employee-1', terminalKind: 'merged', count: 1 },
    ])
  })
})
