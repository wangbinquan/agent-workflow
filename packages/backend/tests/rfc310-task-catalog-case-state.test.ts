import { expect, test } from 'bun:test'

import type { ProviderNeutralDatabase } from '@/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import { employeeCases, employeeContextRecords } from '@/db/schema'
import { createRuntimePersistence } from '@/modules/digital-employee/infrastructure/runtimeStore'

describeEachProvider('RFC-310 digital-employee task catalog Case-state semantics', (harness) => {
  test('waiting Cases stay active while only blocked Cases require operator attention', async () => {
    const db = harness.db
    const store = createRuntimePersistence(db)

    await seedCase(db, { id: 'active', state: 'active', updatedAt: 10 })
    await seedCase(db, { id: 'waiting', state: 'waiting', updatedAt: 20 })
    await seedCase(db, { id: 'blocked', state: 'blocked', updatedAt: 30 })
    await seedCase(db, { id: 'done', state: 'terminal', terminalKind: 'merged', updatedAt: 40 })
    await seedCase(db, {
      id: 'canceled',
      state: 'terminal',
      terminalKind: 'closed',
      updatedAt: 50,
    })

    const all = await store.listCasesPage({ view: 'all', cursor: null, limit: 100 })
    expect(all.facets).toEqual({ all: 5, active: 2, attention: 1, finished: 2 })

    const attention = await store.listCasesPage({ view: 'attention', cursor: null, limit: 100 })
    expect(attention.cases.map((item) => item.id)).toEqual(['blocked'])
  })

  test('empty and terminal TaskStatus filters are exact without copying terminal vocabulary', async () => {
    const db = harness.db
    const store = createRuntimePersistence(db)

    await seedCase(db, { id: 'waiting', state: 'waiting', updatedAt: 10 })
    await seedCase(db, { id: 'done', state: 'terminal', terminalKind: 'merged', updatedAt: 20 })
    await seedCase(db, {
      id: 'legacy-canceled',
      state: 'terminal',
      terminalKind: 'closed-unmerged',
      updatedAt: 30,
    })

    expect(
      (await store.listCasesPage({ states: [], view: 'all', cursor: null, limit: 100 })).cases,
    ).toEqual([])
    expect(
      (
        await store.listCasesPage({
          states: ['terminal'],
          terminalCatalogStatuses: ['done'],
          view: 'all',
          cursor: null,
          limit: 100,
        })
      ).cases.map((item) => item.id),
    ).toEqual(['done'])
    expect(
      (
        await store.listCasesPage({
          states: ['waiting', 'terminal'],
          terminalCatalogStatuses: ['canceled'],
          view: 'all',
          cursor: null,
          limit: 100,
        })
      ).cases.map((item) => item.id),
    ).toEqual(['legacy-canceled', 'waiting'])
  })
})

async function seedCase(
  db: ProviderNeutralDatabase,
  input: {
    readonly id: string
    readonly state: 'active' | 'waiting' | 'blocked' | 'terminal'
    readonly terminalKind?: string
    readonly updatedAt: number
  },
): Promise<void> {
  const contextId = `context-${input.id}`
  await db.insert(employeeCases).values({
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
  await db.insert(employeeContextRecords).values({
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
}
