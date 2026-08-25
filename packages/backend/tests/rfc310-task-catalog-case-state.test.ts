import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { employeeCases, employeeContextRecords } from '@/db/schema'
import { createSqliteRuntimeStore } from '@/modules/digital-employee/infrastructure/sqliteRuntimeStore'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-310 digital-employee task catalog Case-state semantics', () => {
  test('waiting Cases stay active while only blocked Cases require operator attention', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const store = createSqliteRuntimeStore(db)

    seedCase(db, { id: 'active', state: 'active', updatedAt: 10 })
    seedCase(db, { id: 'waiting', state: 'waiting', updatedAt: 20 })
    seedCase(db, { id: 'blocked', state: 'blocked', updatedAt: 30 })
    seedCase(db, { id: 'done', state: 'terminal', terminalKind: 'merged', updatedAt: 40 })
    seedCase(db, {
      id: 'canceled',
      state: 'terminal',
      terminalKind: 'closed',
      updatedAt: 50,
    })

    const all = store.listCasesPage({ view: 'all', cursor: null, limit: 100 })
    expect(all.facets).toEqual({ all: 5, active: 2, attention: 1, finished: 2 })

    const attention = store.listCasesPage({ view: 'attention', cursor: null, limit: 100 })
    expect(attention.cases.map((item) => item.id)).toEqual(['blocked'])
  })

  test('empty and terminal TaskStatus filters are exact without copying terminal vocabulary', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const store = createSqliteRuntimeStore(db)

    seedCase(db, { id: 'waiting', state: 'waiting', updatedAt: 10 })
    seedCase(db, { id: 'done', state: 'terminal', terminalKind: 'merged', updatedAt: 20 })
    seedCase(db, {
      id: 'legacy-canceled',
      state: 'terminal',
      terminalKind: 'closed-unmerged',
      updatedAt: 30,
    })

    expect(
      store.listCasesPage({ states: [], view: 'all', cursor: null, limit: 100 }).cases,
    ).toEqual([])
    expect(
      store
        .listCasesPage({
          states: ['terminal'],
          terminalCatalogStatuses: ['done'],
          view: 'all',
          cursor: null,
          limit: 100,
        })
        .cases.map((item) => item.id),
    ).toEqual(['done'])
    expect(
      store
        .listCasesPage({
          states: ['waiting', 'terminal'],
          terminalCatalogStatuses: ['canceled'],
          view: 'all',
          cursor: null,
          limit: 100,
        })
        .cases.map((item) => item.id),
    ).toEqual(['legacy-canceled', 'waiting'])
  })
})

function seedCase(
  db: ReturnType<typeof createInMemoryDb>,
  input: {
    readonly id: string
    readonly state: 'active' | 'waiting' | 'blocked' | 'terminal'
    readonly terminalKind?: string
    readonly updatedAt: number
  },
): void {
  const contextId = `context-${input.id}`
  db.insert(employeeCases)
    .values({
      id: input.id,
      name: input.id,
      employeeId: 'employee-1',
      employeeRevision: 1,
      typeId: 'development',
      typeRevision: 10,
      primaryContextId: contextId,
      executionPolicyRevision: 1,
      ownerUserId: 'catalog-user',
      launchOrigin: 'manual',
      state: input.state,
      terminalKind: input.terminalKind ?? null,
      blockReason: input.state === 'blocked' ? 'operator-visible failure' : null,
      currentWorkItemRef: input.state === 'active' ? 'analyze' : null,
      revision: 1,
      writerGeneration: 1,
      createdAt: 1,
      updatedAt: input.updatedAt,
      terminalAt: input.state === 'terminal' ? input.updatedAt : null,
    })
    .run()
  db.insert(employeeContextRecords)
    .values({
      id: contextId,
      caseId: input.id,
      typeId: 'development.issue-handling',
      schemaVersion: 1,
      currentRevision: 1,
      lifecycleState: input.state === 'terminal' ? 'terminal' : 'active',
      stateJson: JSON.stringify({ subjectRef: input.id }),
      artifactRefsJson: '[]',
      createdAt: 1,
      updatedAt: input.updatedAt,
    })
    .run()
}
