// RFC-616 §6.3 / §14「数字员工事实」(design/RFC-616-process-metrics/design.md) — the facts the digital-employee
// module offers to process metrics through the platform contract, on both providers.
//
// What this file locks, in the order of its tests:
//   · case visibility is `canViewCase` as a row filter (owner, member, read-all, stranger), together with the
//     window, the employee filter, newest-first order and the limit;
//   · rounds are read from the round table itself: a collaboration round and a round that failed before it
//     started have no metering receipt, so receipts cannot stand in for them;
//   · case state changes are read back from the lifecycle events the runtime really publishes;
//   · approvals: only submitted ones, their text instants as epoch milliseconds, closed once the status is final;
//   · the responsibility map of a type revision and the rework work items its type declares;
//   · human feedback goes through the type's own projection; a type without one, or an answer that cannot be
//     validated, is "not provided" (null) — never zero;
//   · every id-list method takes at most 500 ids.
//
// The fixture types are derived from a registered descriptor only because a descriptor has to be a valid one;
// nothing here depends on what that type does.

import type { Permission } from '@agent-workflow/shared'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'
import { createEmployeePlatformWorkItemPersistence } from '@/modules/development-automation/infrastructure/employeePlatformWorkItemPersistence'
import { canViewCase } from '@/modules/digital-employee/application/caseAccess'
import { createProcessEmployeeFacts } from '@/modules/digital-employee/composition/processFacts'
import {
  employeeTypePackageDescriptorSchema,
  packageDigest,
  type EmployeeTypePackageDescriptor,
} from '@/modules/digital-employee/domain/model'
import type {
  EmployeeCaseRecord,
  ReactionRoundRecord,
} from '@/modules/digital-employee/domain/runtimeModel'
import { createDigitalEmployeeAuthoringPersistence } from '@/modules/digital-employee/infrastructure/authoringStore'
import { createRuntimePersistence } from '@/modules/digital-employee/infrastructure/runtimeStore'
import { digitalEmployeeLifecycleEventCatalogJson } from '@/modules/digital-employee/public/events'
import { createProcessSubjectEvents } from '@/modules/event-center/composition/processFacts'
import type { EventObservationInput } from '@/modules/event-center/public/types'
import {
  PROCESS_EMPLOYEE_CASE_SUBJECT,
  PROCESS_FACT_ID_BATCH,
  type ProcessSubjectEventRow,
  type ProcessViewer,
} from '@/platform/contracts/processFacts'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { describeEachProvider } from './helpers/eachProvider'
import { composeEventCenter, standaloneEventCenterSelections } from './helpers/eventCenter'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 10, 1)
const WINDOW = { from: T0, to: T0 + DAY, limit: 100 }

const sample = employeeTypePackageDescriptorSchema.parse(
  JSON.parse(developmentEmployeeTypePackage.descriptorJson) as unknown,
)

function workItemOfKind(nodeKind: 'business-tool' | 'system' | 'collaboration'): string {
  const item = sample.authoringManifest.workItems.find(
    (candidate) => candidate.nodeKind === nodeKind,
  )
  if (item === undefined) throw new Error(`the sample manifest has no ${nodeKind} work item`)
  return item.workItemRef
}
const TOOL_ITEM = workItemOfKind('business-tool')
const SYSTEM_ITEM = workItemOfKind('system')
const COLLABORATION_ITEM = workItemOfKind('collaboration')

function descriptorOf(
  typeId: string,
  revision: number,
  edit: (descriptor: EmployeeTypePackageDescriptor) => void = () => {},
): EmployeeTypePackageDescriptor {
  const descriptor = structuredClone(sample)
  descriptor.typeRef = { typeId, revision }
  edit(descriptor)
  return descriptor
}

/** The context type of the fixture type that records what people wrote: `{ "notes": [{ text, at, item? }] }`. */
const NOTES = 'fixture.notes'
const GARBLED = 'fixture.garbled'
const UNREADABLE = 'fixture.unreadable'

interface Note {
  readonly text: string
  readonly at: number
  readonly item?: string
}
const notesState = (notes: readonly Note[]) => JSON.stringify({ notes })

const TYPES: Parameters<typeof createProcessEmployeeFacts>[1] = {
  typePackages: [
    {
      descriptorJson: JSON.stringify(descriptorOf('declaring', 3)),
      // Declared once too often, once for a work item no revision has, and in an order of its own.
      describeProcessMetricsJson: () =>
        JSON.stringify({
          reworkWorkItemRefs: [
            COLLABORATION_ITEM,
            'not-a-work-item',
            TOOL_ITEM,
            COLLABORATION_ITEM,
          ],
        }),
    },
    { descriptorJson: JSON.stringify(descriptorOf('plain', 1)) },
    {
      descriptorJson: JSON.stringify(descriptorOf('careless', 1)),
      describeProcessMetricsJson: () => JSON.stringify({ reworkWorkItemRefs: 'all of them' }),
    },
    {
      descriptorJson: JSON.stringify(descriptorOf('throwing', 1)),
      describeProcessMetricsJson: () => {
        throw new Error('this type cannot say')
      },
    },
  ],
  contextCodecs: [
    {
      typeId: 'declaring',
      projectHumanFeedbackJson(contextTypeId, stateJson) {
        if (contextTypeId === GARBLED) return JSON.stringify({ items: [{ text: '', at: 'then' }] })
        if (contextTypeId === UNREADABLE) throw new Error('this type cannot read the context')
        if (contextTypeId !== NOTES) return JSON.stringify({ items: [] })
        const state = JSON.parse(stateJson) as { notes: Note[] }
        return JSON.stringify({
          items: state.notes.map((note) => ({
            text: note.text,
            at: note.at,
            ...(note.item === undefined ? {} : { workItemRef: note.item }),
          })),
        })
      },
    },
    // A codec of a type that does not project feedback.
    { typeId: 'plain' },
  ],
}

function caseRecord(id: string, overrides: Partial<EmployeeCaseRecord> = {}): EmployeeCaseRecord {
  return {
    id,
    name: `Case ${id}`,
    employeeRef: { id: 'employee-a', revision: 1 },
    typeRef: { typeId: 'declaring', revision: 3 },
    primaryContextId: `${id}-context`,
    executionPolicyRevision: 1,
    maxDurationMs: null,
    consumedDurationMs: 0,
    maxTotalTokens: null,
    consumedTotalTokens: 0,
    ownerUserId: 'owner-1',
    launchOrigin: 'manual',
    state: 'active',
    terminalKind: null,
    blockReason: null,
    currentWorkItemRef: null,
    activeRoundId: null,
    revision: 1,
    writerGeneration: 1,
    createdAt: T0,
    updatedAt: T0,
    terminalAt: null,
    ...overrides,
  }
}

async function seedCase(
  db: PersistenceDb,
  id: string,
  overrides: Partial<EmployeeCaseRecord> = {},
  primaryContext: { readonly typeId?: string; readonly stateJson?: string } = {},
): Promise<EmployeeCaseRecord> {
  const record = caseRecord(id, overrides)
  await createRuntimePersistence(db).createCase({
    caseRecord: record,
    primaryContext: {
      id: record.primaryContextId,
      caseId: id,
      typeId: primaryContext.typeId ?? 'fixture.root',
      schemaVersion: 1,
      revision: 1,
      lifecycleState: 'active',
      stateJson: primaryContext.stateJson ?? '{}',
      artifactRefs: [],
      createdAt: record.createdAt,
      updatedAt: record.createdAt,
    },
    contextDigest: '0'.repeat(64),
    externalSubject: { typeId: 'fixture.subject', subjectRef: `subject:${id}` },
    eventOrigin: null,
    uploadClaims: [],
    initialMembers: [],
  })
  return record
}

async function seedContext(
  db: PersistenceDb,
  input: {
    readonly id: string
    readonly caseId: string
    readonly typeId: string
    readonly stateJson: string
    readonly createdAt: number
  },
): Promise<void> {
  const { employeeContextRecords } = tablesOf(db)
  await insertOne(db, employeeContextRecords, {
    id: input.id,
    caseId: input.caseId,
    typeId: input.typeId,
    schemaVersion: 1,
    currentRevision: 1,
    lifecycleState: 'active',
    stateJson: input.stateJson,
    artifactRefsJson: '[]',
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  })
}

async function seedUser(db: PersistenceDb, id: string): Promise<void> {
  const { users } = tablesOf(db)
  await insertOne(db, users, {
    id,
    username: id,
    displayName: id,
    role: 'user',
    status: 'active',
    createdAt: T0,
    updatedAt: T0,
  })
}

async function seedEmployee(db: PersistenceDb, id: string, name: string): Promise<void> {
  const { employeeDefinitions } = tablesOf(db)
  await insertOne(db, employeeDefinitions, {
    id,
    name,
    typeId: 'declaring',
    typeRevision: 3,
    configurationJson: '{}',
    createdAt: T0,
    updatedAt: T0,
  })
}

/** Plans a round the way the runtime does: against the case revision it read. */
async function openRound(
  db: PersistenceDb,
  input: {
    readonly caseId: string
    readonly roundId: string
    readonly workItemRef: string
    readonly at: number
  },
): Promise<void> {
  const store = createRuntimePersistence(db)
  const current = await store.getCase(input.caseId)
  if (current === null) throw new Error(`missing case fixture: ${input.caseId}`)
  const round: ReactionRoundRecord = {
    id: input.roundId,
    caseId: input.caseId,
    caseRevision: current.revision,
    inboxId: null,
    employeeRef: current.employeeRef,
    ruleId: 'fixture-rule',
    workItemRef: input.workItemRef,
    workContractRef: { contractId: 'fixture.contract', version: 1 },
    toolRef: null,
    executionPolicyRevision: 1,
    inputContextRefsJson: '[]',
    planJson: '{}',
    state: 'planned',
    executionRef: null,
    outputJson: null,
    attemptOrdinal: 0,
    createdAt: input.at,
    updatedAt: input.at,
    settledAt: null,
  }
  const created = await store.createRound({
    round,
    plan: {} as never,
    inboxId: null,
    expectedCaseRevision: current.revision,
    launchOutbox: null,
    reactionDispatch: null,
  })
  if (!created) throw new Error(`round fixture was not created: ${input.roundId}`)
}

/** What the runtime's outbox worker does with a lifecycle event: hand the stored observation to the event center. */
async function publishLifecycleEvents(
  db: PersistenceDb,
  observe: (observation: EventObservationInput) => Promise<unknown>,
): Promise<number> {
  const store = createRuntimePersistence(db)
  let published = 0
  for (;;) {
    const outbox = await store.claimOutbox({
      workerId: 'rfc616-fixture',
      now: T0 + DAY,
      leaseMs: MINUTE,
    })
    if (outbox === null) return published
    if (outbox.kind !== 'event-publish') throw new Error(`unexpected outbox work: ${outbox.kind}`)
    await observe(JSON.parse(outbox.payloadJson) as EventObservationInput)
    await store.completeOutbox(outbox.id, 'rfc616-fixture', T0 + DAY)
    published += 1
  }
}

const byOrder = (left: { readonly order: number }, right: { readonly order: number }) =>
  left.order - right.order

describeEachProvider('RFC-616 digital-employee process facts', (harness) => {
  test('a case is visible to its owner, its members and a read-all viewer — exactly as canViewCase decides', async () => {
    const db = harness.db
    await seedUser(db, 'member-1')
    await seedCase(db, 'case-own', { createdAt: T0 + 1 * HOUR })
    await seedCase(db, 'case-observed', { createdAt: T0 + 2 * HOUR })
    await seedCase(db, 'case-shared', { createdAt: T0 + 3 * HOUR, ownerUserId: 'owner-2' })
    await seedCase(db, 'case-ownerless', { createdAt: T0 + 4 * HOUR, ownerUserId: null })
    await seedCase(db, 'case-foreign', { createdAt: T0 + 5 * HOUR, ownerUserId: 'owner-2' })
    const memberRoles: Record<string, 'observer' | 'collaborator'> = {
      'case-observed': 'observer',
      'case-shared': 'collaborator',
      'case-ownerless': 'collaborator',
    }
    const owners: Record<string, string | null> = {
      'case-own': 'owner-1',
      'case-observed': 'owner-1',
      'case-shared': 'owner-2',
      'case-ownerless': null,
      'case-foreign': 'owner-2',
    }
    const store = createRuntimePersistence(db)
    for (const [caseId, role] of Object.entries(memberRoles)) {
      await store.replaceCaseMembers({
        caseId,
        ownerUserId: owners[caseId] ?? null,
        members: [{ userId: 'member-1', role }],
        addedBy: 'fixture',
        now: T0,
      })
    }
    const facts = createProcessEmployeeFacts(db, TYPES)
    const viewers = {
      owner: { userId: 'owner-1', canReadAll: false },
      member: { userId: 'member-1', canReadAll: false },
      stranger: { userId: 'stranger-1', canReadAll: false },
      auditor: { userId: 'auditor-1', canReadAll: true },
    } satisfies Record<string, ProcessViewer>
    const listed = async (viewer: ProcessViewer) =>
      (await facts.cases(viewer, WINDOW)).map((row) => row.caseId)

    // Newest first.
    expect(await listed(viewers.auditor)).toEqual([
      'case-foreign',
      'case-ownerless',
      'case-shared',
      'case-observed',
      'case-own',
    ])
    expect(await listed(viewers.owner)).toEqual(['case-observed', 'case-own'])
    expect(await listed(viewers.member)).toEqual(['case-ownerless', 'case-shared', 'case-observed'])
    expect(await listed(viewers.stranger)).toEqual([])

    // The list and the single read agree with the module's own rule for every viewer and case.
    for (const [name, viewer] of Object.entries(viewers)) {
      const visible = new Set(await listed(viewer))
      for (const [caseId, ownerUserId] of Object.entries(owners)) {
        const allowed = canViewCase(
          {
            user: { id: viewer.userId },
            permissions: new Set<Permission>(viewer.canReadAll ? ['tasks:read:all'] : []),
          },
          { id: caseId, ownerUserId, employeeId: 'employee-a' },
          viewer.userId === 'member-1' ? (memberRoles[caseId] ?? null) : null,
        )
        expect([name, caseId, visible.has(caseId)]).toEqual([name, caseId, allowed])
        expect([name, caseId, (await facts.case(viewer, caseId)) !== null]).toEqual([
          name,
          caseId,
          allowed,
        ])
      }
    }
    expect(await facts.case(viewers.auditor, 'case-missing')).toBeNull()
  })

  test('cases are taken from the window [from, to), optionally for one employee, newest first up to the limit', async () => {
    const db = harness.db
    await seedCase(db, 'case-before', { createdAt: T0 - 1 })
    await seedCase(db, 'case-at-from', { createdAt: T0 })
    await seedCase(db, 'case-b', {
      createdAt: T0 + HOUR,
      employeeRef: { id: 'employee-b', revision: 4 },
    })
    // Created in the same millisecond: the id decides.
    await seedCase(db, 'case-tie-1', { createdAt: T0 + 2 * HOUR })
    await seedCase(db, 'case-tie-2', { createdAt: T0 + 2 * HOUR })
    await seedCase(db, 'case-at-to', { createdAt: T0 + DAY })
    const facts = createProcessEmployeeFacts(db, TYPES)
    const auditor: ProcessViewer = { userId: 'auditor-1', canReadAll: true }
    const ids = async (query: Parameters<typeof facts.cases>[1]) =>
      (await facts.cases(auditor, query)).map((row) => row.caseId)

    expect(await ids(WINDOW)).toEqual(['case-tie-2', 'case-tie-1', 'case-b', 'case-at-from'])
    expect(await ids({ ...WINDOW, limit: 2 })).toEqual(['case-tie-2', 'case-tie-1'])
    expect(await ids({ ...WINDOW, employeeId: 'employee-b' })).toEqual(['case-b'])
    expect(await ids({ ...WINDOW, employeeId: 'employee-unknown' })).toEqual([])
    expect(await ids({ from: T0 + DAY, to: T0 + 2 * DAY, limit: 100 })).toEqual(['case-at-to'])
    // The employee filter narrows inside the viewer's own cases; it never widens them.
    expect(
      await facts.cases(
        { userId: 'stranger-1', canReadAll: false },
        { ...WINDOW, employeeId: 'employee-b' },
      ),
    ).toEqual([])
  })

  test('a case row carries the frozen refs, the current employee name and the state as it is now', async () => {
    const db = harness.db
    await seedEmployee(db, 'employee-a', 'Alpha')
    await seedCase(db, 'case-active', {
      name: 'Ship the report',
      createdAt: T0 + HOUR,
      launchOrigin: 'webhook',
      employeeRef: { id: 'employee-a', revision: 7 },
    })
    await seedCase(db, 'case-blocked', {
      createdAt: T0 + 2 * HOUR,
      state: 'blocked',
      blockReason: 'waiting for a decision',
    })
    await seedCase(db, 'case-ended', {
      createdAt: T0 + 3 * HOUR,
      employeeRef: { id: 'employee-gone', revision: 2 },
      typeRef: { typeId: 'plain', revision: 1 },
      ownerUserId: null,
      launchOrigin: 'scheduled',
      state: 'terminal',
      terminalKind: 'canceled',
      terminalAt: T0 + 4 * HOUR,
      // A reason left on a row that is no longer blocked is not reported.
      blockReason: 'stale reason',
    })
    const facts = createProcessEmployeeFacts(db, TYPES)
    const auditor: ProcessViewer = { userId: 'auditor-1', canReadAll: true }

    expect(await facts.case(auditor, 'case-active')).toEqual({
      caseId: 'case-active',
      name: 'Ship the report',
      employeeId: 'employee-a',
      employeeName: 'Alpha',
      employeeRevision: 7,
      typeId: 'declaring',
      typeRevision: 3,
      origin: 'webhook',
      ownerUserId: 'owner-1',
      state: 'active',
      terminalKind: null,
      blockReason: null,
      createdAt: T0 + HOUR,
      terminalAt: null,
    })
    expect(await facts.case(auditor, 'case-blocked')).toMatchObject({
      state: 'blocked',
      blockReason: 'waiting for a decision',
      employeeName: 'Alpha',
    })
    expect(await facts.case(auditor, 'case-ended')).toEqual({
      caseId: 'case-ended',
      name: 'Case case-ended',
      employeeId: 'employee-gone',
      // No definition with this id exists any more.
      employeeName: null,
      employeeRevision: 2,
      typeId: 'plain',
      typeRevision: 1,
      origin: 'scheduled',
      ownerUserId: null,
      state: 'terminal',
      terminalKind: 'canceled',
      blockReason: null,
      createdAt: T0 + 3 * HOUR,
      terminalAt: T0 + 4 * HOUR,
    })
    // The list returns the same rows as the single read.
    const single = async (caseId: string) => {
      const row = await facts.case(auditor, caseId)
      if (row === null) throw new Error(`a read-all viewer reads every case: ${caseId}`)
      return row
    }
    expect(await facts.cases(auditor, WINDOW)).toEqual([
      await single('case-ended'),
      await single('case-blocked'),
      await single('case-active'),
    ])

    // The name is the employee's current one, not one frozen on the case.
    const { employeeDefinitions } = tablesOf(db)
    await db
      .update(employeeDefinitions)
      .set({ name: 'Alpha (renamed)' })
      .where(eq(employeeDefinitions.id, 'employee-a'))
    expect((await facts.case(auditor, 'case-active'))?.employeeName).toBe('Alpha (renamed)')
  })

  test('an ended case reports the terminal kind its writer recorded, including the plain completion', async () => {
    const db = harness.db
    const store = createRuntimePersistence(db)
    // A case whose last round simply finishes it: the writer records the plain completion kind.
    await seedCase(db, 'case-finished', { createdAt: T0 + 1 * HOUR })
    await openRound(db, {
      caseId: 'case-finished',
      roundId: 'round-last',
      workItemRef: SYSTEM_ITEM,
      at: T0 + 1 * HOUR,
    })
    await store.settleRound({
      roundId: 'round-last',
      state: 'completed',
      outputJson: '{}',
      nextCaseState: 'terminal',
      now: T0 + 2 * HOUR,
    })
    // A round that ends the case with a kind of the type's own.
    await seedCase(db, 'case-delivered', { createdAt: T0 + 3 * HOUR })
    await openRound(db, {
      caseId: 'case-delivered',
      roundId: 'round-delivery',
      workItemRef: SYSTEM_ITEM,
      at: T0 + 3 * HOUR,
    })
    await store.settleRound({
      roundId: 'round-delivery',
      state: 'completed',
      outputJson: '{}',
      nextCaseState: 'terminal',
      terminalKind: 'fixture-delivered',
      now: T0 + 4 * HOUR,
    })
    // A person ends the case.
    await seedCase(db, 'case-stopped', { createdAt: T0 + 5 * HOUR })
    await store.terminateCase('case-stopped', 'canceled', T0 + 6 * HOUR)
    const facts = createProcessEmployeeFacts(db, TYPES)

    const ended = await facts.cases({ userId: 'auditor-1', canReadAll: true }, WINDOW)
    expect(
      ended.map((row) => [
        row.caseId,
        row.state,
        row.terminalKind,
        row.terminalAt,
        row.blockReason,
      ]),
    ).toEqual([
      ['case-stopped', 'terminal', 'canceled', T0 + 6 * HOUR, null],
      ['case-delivered', 'terminal', 'fixture-delivered', T0 + 4 * HOUR, null],
      ['case-finished', 'terminal', 'completed', T0 + 2 * HOUR, null],
    ])
  })

  test('rounds come from the round table: a collaboration round and a round that failed before starting have no receipt', async () => {
    const db = harness.db
    const store = createRuntimePersistence(db)
    await seedCase(db, 'case-rounds')
    await seedCase(db, 'case-planning')
    await seedCase(db, 'case-idle')

    // A tool round that needed a second attempt: one receipt per settled attempt.
    await openRound(db, {
      caseId: 'case-rounds',
      roundId: 'round-tool',
      workItemRef: TOOL_ITEM,
      at: T0 + 1 * MINUTE,
    })
    await store.markRoundRunning('round-tool', 'execution-1', T0 + 2 * MINUTE)
    await store.recordMetering({
      sourceRef: 'execution-1',
      caseId: 'case-rounds',
      roundId: 'round-tool',
      durationMs: 40_000,
      totalTokens: 1_200,
      now: T0 + 3 * MINUTE,
    })
    await store.retryRound({
      roundId: 'round-tool',
      expectedExecutionRef: 'execution-1',
      attemptOrdinal: 1,
      errorJson: '{"error":"the first attempt failed"}',
      reactionDispatch: { plan: {} as never, retryFeedbackRef: null, lastDispatchError: null },
      nextAttemptAt: T0 + 3 * MINUTE,
      now: T0 + 3 * MINUTE,
    })
    await store.markRoundRunning('round-tool', 'execution-2', T0 + 4 * MINUTE)
    await store.recordMetering({
      sourceRef: 'execution-2',
      caseId: 'case-rounds',
      roundId: 'round-tool',
      durationMs: 55_000,
      totalTokens: 2_300,
      now: T0 + 5 * MINUTE,
    })
    await store.settleRound({
      roundId: 'round-tool',
      state: 'completed',
      outputJson: '{}',
      now: T0 + 5 * MINUTE,
    })
    // A collaboration round waits for another employee and is never metered.
    await openRound(db, {
      caseId: 'case-rounds',
      roundId: 'round-collaboration',
      workItemRef: COLLABORATION_ITEM,
      at: T0 + 6 * MINUTE,
    })
    await store.settleRound({
      roundId: 'round-collaboration',
      state: 'completed',
      outputJson: '{}',
      now: T0 + 9 * MINUTE,
    })
    // A round that fails before anything was started.
    await openRound(db, {
      caseId: 'case-rounds',
      roundId: 'round-never-started',
      workItemRef: SYSTEM_ITEM,
      at: T0 + 10 * MINUTE,
    })
    await store.settleRound({
      roundId: 'round-never-started',
      state: 'failed',
      outputJson: null,
      now: T0 + 11 * MINUTE,
    })
    // A round that is still planned.
    await openRound(db, {
      caseId: 'case-planning',
      roundId: 'round-open',
      workItemRef: TOOL_ITEM,
      at: T0 + 12 * MINUTE,
    })
    const facts = createProcessEmployeeFacts(db, TYPES)
    const asked = ['case-rounds', 'case-planning', 'case-idle', 'case-rounds', 'case-missing']

    const rounds = await facts.rounds(asked)
    expect(rounds.filter((round) => round.caseId === 'case-rounds')).toEqual([
      {
        caseId: 'case-rounds',
        roundId: 'round-tool',
        workItemRef: TOOL_ITEM,
        state: 'completed',
        attemptOrdinal: 1,
        createdAt: T0 + 1 * MINUTE,
        settledAt: T0 + 5 * MINUTE,
      },
      {
        caseId: 'case-rounds',
        roundId: 'round-collaboration',
        workItemRef: COLLABORATION_ITEM,
        state: 'completed',
        attemptOrdinal: 0,
        createdAt: T0 + 6 * MINUTE,
        settledAt: T0 + 9 * MINUTE,
      },
      {
        caseId: 'case-rounds',
        roundId: 'round-never-started',
        workItemRef: SYSTEM_ITEM,
        state: 'failed',
        attemptOrdinal: 0,
        createdAt: T0 + 10 * MINUTE,
        settledAt: T0 + 11 * MINUTE,
      },
    ])
    expect(rounds.filter((round) => round.caseId !== 'case-rounds')).toEqual([
      {
        caseId: 'case-planning',
        roundId: 'round-open',
        workItemRef: TOOL_ITEM,
        state: 'planned',
        attemptOrdinal: 0,
        createdAt: T0 + 12 * MINUTE,
        settledAt: null,
      },
    ])

    const metering = await facts.metering(asked)
    expect(metering).toEqual([
      { caseId: 'case-rounds', roundId: 'round-tool', durationMs: 40_000, totalTokens: 1_200 },
      { caseId: 'case-rounds', roundId: 'round-tool', durationMs: 55_000, totalTokens: 2_300 },
    ])
    // The receipts name one round out of four: they cannot stand in for the rounds.
    expect(new Set(metering.map((receipt) => receipt.roundId))).toEqual(new Set(['round-tool']))
    expect(rounds).toHaveLength(4)
  })

  test('case state changes are read back from the lifecycle events the runtime publishes', async () => {
    const db = harness.db
    const store = createRuntimePersistence(db)
    const eventCenter = await composeEventCenter({
      ...standaloneEventCenterSelections(),
      db,
      typePackageDescriptorJsons: [digitalEmployeeLifecycleEventCatalogJson],
      automation: { kind: 'observation-only' },
    })
    await seedCase(db, 'case-stops', { createdAt: T0 })
    await seedCase(db, 'case-steady', { createdAt: T0 + 5 })
    await store.blockCase('case-stops', 'needs a decision', T0 + 10 * MINUTE)
    await store.resumeCase('case-stops', T0 + 30 * MINUTE)
    await store.blockCase('case-stops', 'stopped again', T0 + 40 * MINUTE)
    const facts = createProcessEmployeeFacts(db, TYPES)
    const auditor: ProcessViewer = { userId: 'auditor-1', canReadAll: true }
    expect((await facts.case(auditor, 'case-stops'))?.blockReason).toBe('stopped again')
    await store.terminateCase('case-stops', 'canceled', T0 + 90 * MINUTE)
    expect(
      await publishLifecycleEvents(db, (observation) =>
        eventCenter.participant.observe(observation),
      ),
    ).toBe(6)

    const events = await createProcessSubjectEvents(db).history(PROCESS_EMPLOYEE_CASE_SUBJECT, [
      'case-stops',
      'case-steady',
    ])
    const transitions = facts.transitions(events)

    expect(transitions.filter((change) => change.caseId === 'case-stops')).toEqual([
      { caseId: 'case-stops', at: T0, from: null, to: 'active' },
      { caseId: 'case-stops', at: T0 + 10 * MINUTE, from: 'active', to: 'blocked' },
      { caseId: 'case-stops', at: T0 + 30 * MINUTE, from: 'blocked', to: 'active' },
      { caseId: 'case-stops', at: T0 + 40 * MINUTE, from: 'active', to: 'blocked' },
      { caseId: 'case-stops', at: T0 + 90 * MINUTE, from: 'blocked', to: 'terminal' },
    ])
    expect(transitions.filter((change) => change.caseId === 'case-steady')).toEqual([
      { caseId: 'case-steady', at: T0 + 5, from: null, to: 'active' },
    ])
    expect(transitions).toHaveLength(6)
    // Terminating cleared the reason, so only a case that is blocked right now has one.
    expect(await facts.case(auditor, 'case-stops')).toMatchObject({
      state: 'terminal',
      terminalKind: 'canceled',
      blockReason: null,
      terminalAt: T0 + 90 * MINUTE,
    })
  })

  test('transitions keep the change order within a millisecond and ignore what is not a readable state change', () => {
    const facts = createProcessEmployeeFacts(harness.db, TYPES)
    const changed = 'platform.employee-case.state-changed'
    const document = (routingFacts: unknown) =>
      JSON.stringify({ summary: 'fixture', routingFacts, triggerContext: null })
    const event = (
      subjectRef: string,
      occurredAt: number,
      summaryJson: string,
      eventTypeId = changed,
    ): ProcessSubjectEventRow => ({ subjectRef, occurredAt, eventTypeId, summaryJson })

    expect(
      facts.transitions([
        // Stored in publish order, which is not the order the case changed in.
        event(
          'case-a',
          T0 + 5,
          document({ state: 'blocked', previousState: 'active', revision: 3 }),
        ),
        event(
          'case-a',
          T0 + 5,
          document({ state: 'active', previousState: 'waiting', revision: 2 }),
        ),
        event('case-b', T0 + 1, document({ state: 'waiting', previousState: null, revision: 1 })),
        event('case-a', T0 + 1, document({ state: 'waiting', previousState: null, revision: 1 })),
        // Not a state change of a case.
        event(
          'case-a',
          T0 + 2,
          document({ state: 'terminal', previousState: 'active' }),
          'platform.employee-invocation.result-returned',
        ),
        // Documents this module did not write or cannot read.
        event('case-a', T0 + 3, 'not a document'),
        event('case-a', T0 + 3, 'null'),
        event('case-a', T0 + 3, document(null)),
        event(
          'case-a',
          T0 + 3,
          document({ state: 'paused', previousState: 'active', revision: 9 }),
        ),
        event('case-a', T0 + 3, document({ previousState: 'active', revision: 9 })),
        event('case-a', T0 + 3, document({ state: 'active', previousState: 'gone', revision: 9 })),
      ]),
    ).toEqual([
      { caseId: 'case-a', at: T0 + 1, from: null, to: 'waiting' },
      { caseId: 'case-a', at: T0 + 5, from: 'waiting', to: 'active' },
      { caseId: 'case-a', at: T0 + 5, from: 'active', to: 'blocked' },
      { caseId: 'case-b', at: T0 + 1, from: null, to: 'waiting' },
    ])
    expect(facts.transitions([])).toEqual([])
  })

  test('approvals: submitted ones only, text instants as epoch milliseconds, closed once the status is final', async () => {
    const db = harness.db
    await seedCase(db, 'case-approvals')
    await seedCase(db, 'case-other')
    await openRound(db, {
      caseId: 'case-approvals',
      roundId: 'round-submit',
      workItemRef: SYSTEM_ITEM,
      at: T0,
    })
    await openRound(db, {
      caseId: 'case-other',
      roundId: 'round-submit-other',
      workItemRef: SYSTEM_ITEM,
      at: T0,
    })
    // The writer of these rows, with the values it writes: adapter receipts carry an ISO-8601 instant with an
    // offset, observations are stamped with `toISOString()`.
    const sagas = createEmployeePlatformWorkItemPersistence(db)
    const prepare = async (key: string, createdAt: number, caseId = 'case-approvals') => {
      await sagas.prepareApprovalSaga({
        id: `approval:${key}`,
        caseId,
        submitRoundId: caseId === 'case-approvals' ? 'round-submit' : 'round-submit-other',
        adapterId: 'approval-adapter',
        adapterRevision: 1,
        validatedDraftRef: `draft:${key}`,
        deadlineAt: new Date(T0 + 7 * DAY).toISOString(),
        idempotencyKey: key,
        intentDigest: `intent:${key}`,
        correlationRef: null,
        externalRequestRef: null,
        submittedRevision: null,
        submittedAt: null,
        latestStatus: 'prepared',
        observedRevision: null,
        evidenceRef: null,
        observedAt: null,
        createdAt,
        updatedAt: createdAt,
      })
    }
    const submit = async (key: string, submittedAt: string, updatedAt: number) => {
      await sagas.recordApprovalSubmission({
        idempotencyKey: key,
        correlationRef: `correlation:${key}`,
        externalRequestRef: `request:${key}`,
        submittedRevision: '1',
        submittedAt,
        updatedAt,
      })
    }
    const observe = async (
      key: string,
      latestStatus: 'pending' | 'approved' | 'rejected' | 'expired' | 'unavailable',
      observedAt: string,
      updatedAt: number,
    ) => {
      await sagas.recordApprovalObservation({
        idempotencyKey: key,
        latestStatus,
        observedRevision: '2',
        evidenceRef: null,
        observedAt,
        updatedAt,
      })
    }
    // Prepared, never accepted by the external system.
    await prepare('a-prepared', T0 + 1 * HOUR)
    // Submitted and observed once, still waiting for a decision.
    await prepare('b-pending', T0 + 2 * HOUR)
    await submit('b-pending', '2026-11-01T10:05:00+08:00', T0 + 2 * HOUR + MINUTE)
    await observe('b-pending', 'pending', new Date(T0 + 3 * HOUR).toISOString(), T0 + 3 * HOUR)
    // Decided.
    await prepare('c-approved', T0 + 4 * HOUR)
    await submit(
      'c-approved',
      new Date(T0 + 4 * HOUR + MINUTE).toISOString(),
      T0 + 4 * HOUR + MINUTE,
    )
    await observe('c-approved', 'approved', new Date(T0 + 6 * HOUR).toISOString(), T0 + 6 * HOUR)
    await prepare('d-rejected', T0 + 7 * HOUR)
    await submit('d-rejected', new Date(T0 + 7 * HOUR).toISOString(), T0 + 7 * HOUR)
    await observe('d-rejected', 'rejected', new Date(T0 + 8 * HOUR).toISOString(), T0 + 8 * HOUR)
    await prepare('e-expired', T0 + 9 * HOUR)
    await submit('e-expired', new Date(T0 + 9 * HOUR).toISOString(), T0 + 9 * HOUR)
    await observe('e-expired', 'expired', new Date(T0 + 10 * HOUR).toISOString(), T0 + 10 * HOUR)
    // Ended without a verdict: the writer stops observing here too.
    await prepare('f-unavailable', T0 + 11 * HOUR)
    await submit('f-unavailable', new Date(T0 + 11 * HOUR).toISOString(), T0 + 11 * HOUR)
    await observe(
      'f-unavailable',
      'unavailable',
      new Date(T0 + 12 * HOUR).toISOString(),
      T0 + 12 * HOUR,
    )
    // Instants that cannot be read fall back to when the row was created and last written.
    await prepare('g-unreadable', T0 + 13 * HOUR)
    await submit('g-unreadable', 'shortly after noon', T0 + 13 * HOUR + MINUTE)
    await observe('g-unreadable', 'approved', 'a while later', T0 + 14 * HOUR)
    await prepare('h-other-case', T0 + 15 * HOUR, 'case-other')
    await submit('h-other-case', new Date(T0 + 15 * HOUR).toISOString(), T0 + 15 * HOUR)
    const facts = createProcessEmployeeFacts(db, TYPES)

    expect(await facts.approvals(['case-approvals', 'case-approvals'])).toEqual([
      {
        caseId: 'case-approvals',
        submittedAt: Date.UTC(2026, 10, 1, 2, 5, 0),
        settledAt: null,
        status: 'pending',
      },
      {
        caseId: 'case-approvals',
        submittedAt: T0 + 4 * HOUR + MINUTE,
        settledAt: T0 + 6 * HOUR,
        status: 'approved',
      },
      {
        caseId: 'case-approvals',
        submittedAt: T0 + 7 * HOUR,
        settledAt: T0 + 8 * HOUR,
        status: 'rejected',
      },
      {
        caseId: 'case-approvals',
        submittedAt: T0 + 9 * HOUR,
        settledAt: T0 + 10 * HOUR,
        status: 'expired',
      },
      {
        caseId: 'case-approvals',
        submittedAt: T0 + 11 * HOUR,
        settledAt: T0 + 12 * HOUR,
        status: 'unavailable',
      },
      {
        caseId: 'case-approvals',
        submittedAt: T0 + 13 * HOUR,
        settledAt: T0 + 14 * HOUR,
        status: 'approved',
      },
    ])
    expect(await facts.approvals(['case-other'])).toEqual([
      { caseId: 'case-other', submittedAt: T0 + 15 * HOUR, settledAt: null, status: 'pending' },
    ])
    expect(await facts.approvals(['case-missing'])).toEqual([])
  })

  test('the responsibility map of a type revision: regions with lanes and work items, in their declared order', async () => {
    const db = harness.db
    const packages = createDigitalEmployeeAuthoringPersistence(db)
    const register = async (descriptor: EmployeeTypePackageDescriptor) => {
      await packages.ensureTypePackage({
        descriptor,
        descriptorDigest: packageDigest(descriptor),
        state: 'published',
        registeredAt: T0,
      })
    }
    // Stored back to front: the map is ordered by what the manifest declares, not by how it was written down.
    await register(
      descriptorOf('declaring', 3, (descriptor) => {
        descriptor.authoringManifest.lifecycleRegions.reverse()
        for (const region of descriptor.authoringManifest.lifecycleRegions)
          region.responsibilityLanes.reverse()
        descriptor.authoringManifest.workItems.reverse()
      }),
    )
    await register(
      descriptorOf('unlaned', 1, (descriptor) => {
        for (const region of descriptor.authoringManifest.lifecycleRegions)
          region.responsibilityLanes = []
        for (const item of descriptor.authoringManifest.workItems) item.responsibilityLaneId = null
      }),
    )
    const { employeeTypePackages } = tablesOf(db)
    await insertOne(db, employeeTypePackages, {
      typeId: 'unreadable',
      revision: 1,
      descriptorJson: JSON.stringify({ schemaVersion: 1, typeRef: { typeId: 'unreadable' } }),
      descriptorDigest: 'f'.repeat(64),
      registeredAt: T0,
    })
    const facts = createProcessEmployeeFacts(db, TYPES)

    const map = await facts.manifest('declaring', 3)
    if (map === null) throw new Error('the registered revision has a responsibility map')
    expect([map.typeId, map.typeRevision]).toEqual(['declaring', 3])
    const regions = [...sample.authoringManifest.lifecycleRegions].sort(byOrder)
    expect(map.regions.map((region) => region.regionId)).toEqual(
      regions.map((region) => region.regionId),
    )
    expect(map.regions.length).toBeGreaterThanOrEqual(2)
    for (const [index, region] of regions.entries()) {
      const lanes = [...region.responsibilityLanes].sort(byOrder)
      expect(map.regions[index]).toEqual({
        regionId: region.regionId,
        label: region.label,
        order: region.order,
        lanes: lanes.map((lane) => ({
          laneId: lane.laneId,
          label: lane.label,
          order: lane.order,
          kind: lane.kind,
        })),
      })
    }
    // The spine of the first region is what a delivery boundary is read from.
    expect(map.regions[0]?.lanes.some((lane) => lane.kind === 'spine')).toBe(true)

    const items = [...sample.authoringManifest.workItems].sort(byOrder)
    // Every work item of the sample sits in a lane, so none of the lane ids below is the empty one.
    expect(items.every((item) => item.responsibilityLaneId !== null)).toBe(true)
    expect(map.workItems).toEqual(
      items.map((item) => ({
        workItemRef: item.workItemRef,
        regionId: item.regionId,
        laneId: item.responsibilityLaneId ?? '',
        order: item.order,
        label: item.label,
        nodeKind: item.nodeKind,
      })),
    )
    expect(map.workItems.length).toBe(sample.authoringManifest.workItems.length)
    expect(new Set(map.workItems.map((item) => item.nodeKind))).toEqual(
      new Set(['business-tool', 'system', 'collaboration']),
    )
    // Every work item sits in a lane of its own region.
    for (const item of map.workItems) {
      const region = map.regions.find((candidate) => candidate.regionId === item.regionId)
      expect([item.workItemRef, region?.lanes.some((lane) => lane.laneId === item.laneId)]).toEqual(
        [item.workItemRef, true],
      )
    }

    // A region may declare no lanes; its work items then carry an empty lane id.
    const unlaned = await facts.manifest('unlaned', 1)
    expect(unlaned?.regions.every((region) => region.lanes.length === 0)).toBe(true)
    expect(new Set(unlaned?.workItems.map((item) => item.laneId))).toEqual(new Set(['']))

    // Nothing registered under that ref, or a descriptor this build cannot read: no map.
    expect(await facts.manifest('declaring', 99)).toBeNull()
    expect(await facts.manifest('never-registered', 1)).toBeNull()
    expect(await facts.manifest('unreadable', 1)).toBeNull()
  })

  test('rework work items are what the type declares, limited to the work items of that revision', async () => {
    const db = harness.db
    const packages = createDigitalEmployeeAuthoringPersistence(db)
    const register = async (descriptor: EmployeeTypePackageDescriptor) => {
      await packages.ensureTypePackage({
        descriptor,
        descriptorDigest: packageDigest(descriptor),
        state: 'published',
        registeredAt: T0,
      })
    }
    const without =
      (...refs: string[]) =>
      (descriptor: EmployeeTypePackageDescriptor) => {
        descriptor.authoringManifest.workItems = descriptor.authoringManifest.workItems.filter(
          (item) => !refs.includes(item.workItemRef),
        )
      }
    await register(descriptorOf('declaring', 3))
    // Older revisions of the same type are frozen history: only revision 3 is compiled into this build.
    await register(descriptorOf('declaring', 2, without(COLLABORATION_ITEM)))
    await register(descriptorOf('declaring', 1, without(COLLABORATION_ITEM, TOOL_ITEM)))
    await register(descriptorOf('plain', 1))
    await register(descriptorOf('careless', 1))
    await register(descriptorOf('throwing', 1))
    await register(descriptorOf('unregistered', 1))
    const facts = createProcessEmployeeFacts(db, TYPES)
    const rework = async (typeId: string, revision: number) => {
      const map = await facts.manifest(typeId, revision)
      if (map === null) throw new Error(`no responsibility map for ${typeId}@${revision}`)
      return map.reworkWorkItemRefs
    }

    // In the order declared, once each, without the ref no work item has.
    expect(await rework('declaring', 3)).toEqual([COLLABORATION_ITEM, TOOL_ITEM])
    // The type's declaration also speaks for its older revisions, as far as they have the work items.
    expect(await rework('declaring', 2)).toEqual([TOOL_ITEM])
    expect(await rework('declaring', 1)).toBeNull()
    // A type that does not declare, declares something else, or fails while declaring.
    expect(await rework('plain', 1)).toBeNull()
    expect(await rework('careless', 1)).toBeNull()
    expect(await rework('throwing', 1)).toBeNull()
    // A stored type this build has no package for.
    expect(await rework('unregistered', 1)).toBeNull()
  })

  test("human feedback is what the type's own projection reports; no projection or an unreadable answer is null, never zero", async () => {
    const db = harness.db
    // Two feedback contexts and one of another kind.
    await seedCase(db, 'case-feedback', {}, { typeId: 'fixture.root' })
    await seedContext(db, {
      id: 'feedback-notes-1',
      caseId: 'case-feedback',
      typeId: NOTES,
      stateJson: notesState([
        { text: 'Use the shared helper here.', at: T0 + 10, item: TOOL_ITEM },
        { text: 'The summary is missing.', at: T0 + 20 },
      ]),
      createdAt: T0 + 1,
    })
    await seedContext(db, {
      id: 'feedback-notes-2',
      caseId: 'case-feedback',
      typeId: NOTES,
      stateJson: notesState([{ text: 'Looks good now.', at: T0 + 30, item: SYSTEM_ITEM }]),
      createdAt: T0 + 2,
    })
    // The type projects feedback and this case simply has none: a measured zero.
    await seedCase(db, 'case-quiet')
    // The type does not project feedback, whatever its contexts hold.
    await seedCase(
      db,
      'case-plain',
      { typeRef: { typeId: 'plain', revision: 1 } },
      { typeId: NOTES, stateJson: notesState([{ text: 'Nobody reads this.', at: T0 }]) },
    )
    // No codec of this build knows the type.
    await seedCase(db, 'case-unknown-type', { typeRef: { typeId: 'retired', revision: 1 } })
    // One context answers with something that is not the declared shape; the readable one does not count alone.
    await seedCase(
      db,
      'case-garbled',
      {},
      { typeId: NOTES, stateJson: notesState([{ text: 'A readable note.', at: T0 }]) },
    )
    await seedContext(db, {
      id: 'garbled-context',
      caseId: 'case-garbled',
      typeId: GARBLED,
      stateJson: '{}',
      createdAt: T0 + 1,
    })
    // The type fails while reading one of its contexts.
    await seedCase(db, 'case-unreadable', {}, { typeId: UNREADABLE })
    await seedContext(db, {
      id: 'unreadable-notes',
      caseId: 'case-unreadable',
      typeId: NOTES,
      stateJson: notesState([{ text: 'A later readable note.', at: T0 }]),
      createdAt: T0 + 1,
    })
    const facts = createProcessEmployeeFacts(db, TYPES)
    const asked = [
      'case-feedback',
      'case-quiet',
      'case-plain',
      'case-unknown-type',
      'case-garbled',
      'case-unreadable',
      'case-missing',
      'case-feedback',
    ]

    expect(await facts.humanFeedbackCounts(asked)).toEqual([
      { caseId: 'case-feedback', items: 3 },
      { caseId: 'case-quiet', items: 0 },
      { caseId: 'case-plain', items: null },
      { caseId: 'case-unknown-type', items: null },
      { caseId: 'case-garbled', items: null },
      { caseId: 'case-unreadable', items: null },
    ])
    // Only cases with a count have texts, in the order their contexts were created.
    expect(await facts.texts(asked)).toEqual([
      {
        source: 'employee-feedback',
        taskId: null,
        caseId: 'case-feedback',
        stageRef: TOOL_ITEM,
        at: T0 + 10,
        text: 'Use the shared helper here.',
      },
      {
        source: 'employee-feedback',
        taskId: null,
        caseId: 'case-feedback',
        stageRef: null,
        at: T0 + 20,
        text: 'The summary is missing.',
      },
      {
        source: 'employee-feedback',
        taskId: null,
        caseId: 'case-feedback',
        stageRef: SYSTEM_ITEM,
        at: T0 + 30,
        text: 'Looks good now.',
      },
    ])
  })

  test('feedback is counted for every case of a full batch, not only for the first slice of contexts read', async () => {
    const db = harness.db
    // More than two of the slices contexts are read in.
    const caseIds = Array.from(
      { length: 230 },
      (_, index) => `case-${String(index).padStart(3, '0')}`,
    )
    const { employeeCases, employeeContextRecords } = tablesOf(db)
    await db.insert(employeeCases).values(
      caseIds.map((id, index) => ({
        id,
        name: id,
        employeeId: 'employee-a',
        employeeRevision: 1,
        typeId: 'declaring',
        typeRevision: 3,
        primaryContextId: `${id}-context`,
        executionPolicyRevision: 1,
        createdAt: T0 + index,
        updatedAt: T0 + index,
      })),
    )
    await db.insert(employeeContextRecords).values(
      caseIds.map((id, index) => ({
        id: `${id}-context`,
        caseId: id,
        typeId: NOTES,
        schemaVersion: 1,
        currentRevision: 1,
        lifecycleState: 'active' as const,
        // Case n holds n % 3 notes, so a slice read twice or skipped changes the totals.
        stateJson: notesState(
          Array.from({ length: index % 3 }, (_, note) => ({
            text: `note ${note} of ${id}`,
            at: T0 + index,
          })),
        ),
        artifactRefsJson: '[]',
        createdAt: T0,
        updatedAt: T0,
      })),
    )
    const facts = createProcessEmployeeFacts(db, TYPES)

    const counts = await facts.humanFeedbackCounts(caseIds)
    expect(counts).toEqual(caseIds.map((caseId, index) => ({ caseId, items: index % 3 })))
    const texts = await facts.texts(caseIds)
    expect(texts).toHaveLength(caseIds.reduce((total, _, index) => total + (index % 3), 0))
    expect(texts.filter((item) => item.caseId === 'case-229').map((item) => item.text)).toEqual([
      'note 0 of case-229',
    ])
  })

  test('an id list holds at most 500 ids, repeats count once, and an empty list answers empty', async () => {
    const db = harness.db
    await seedCase(db, 'case-one')
    await openRound(db, {
      caseId: 'case-one',
      roundId: 'round-one',
      workItemRef: TOOL_ITEM,
      at: T0,
    })
    const facts = createProcessEmployeeFacts(db, TYPES)
    const ids = (count: number) => Array.from({ length: count }, (_, index) => `case-${index}`)
    const reads = {
      rounds: (caseIds: readonly string[]) => facts.rounds(caseIds),
      metering: (caseIds: readonly string[]) => facts.metering(caseIds),
      approvals: (caseIds: readonly string[]) => facts.approvals(caseIds),
      humanFeedbackCounts: (caseIds: readonly string[]) => facts.humanFeedbackCounts(caseIds),
      texts: (caseIds: readonly string[]) => facts.texts(caseIds),
    }

    for (const [name, read] of Object.entries(reads)) {
      await expect(read(ids(PROCESS_FACT_ID_BATCH + 1)), name).rejects.toThrow(RangeError)
      expect([name, await read(ids(PROCESS_FACT_ID_BATCH))]).toEqual([name, []])
      expect([name, await read([])]).toEqual([name, []])
    }
    expect(await facts.rounds(['case-one', 'case-one', 'case-one'])).toHaveLength(1)
    expect(await facts.humanFeedbackCounts(['case-one', 'case-one'])).toEqual([
      { caseId: 'case-one', items: 0 },
    ])
  })
})
