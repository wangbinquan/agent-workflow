// Explicit graph requests enter the existing durable Case inbox; no second scheduler.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { createGraphCaseIntake } from '@/modules/development-automation/application/graph-development/caseIntake'
import { GRAPH_EVENT_SOURCE } from '@/modules/development-automation/application/graph-development/employeeType'
import { describeEachProvider } from './helpers/eachProvider'
import { employeeAutomationFixture } from './helpers/daemonEmployeeAutomationBundle'
import { memoryGraphArtifacts } from './helpers/graphDesign'

describeEachProvider('RFC-396 durable Case work requests', (harness) => {
  const homes: string[] = []
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })
  test('a blocked continuation resumes only after its explicit request is admitted and then selects that request', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rfc396-case-'))
    homes.push(home)
    const f = employeeAutomationFixture(harness, home),
      module = f.employee.module
    await f.employee.platformTools.load()
    await module.maintenance.ready()
    await f.employee.initializeGraph()
    await f.employeeInput.integration.eventCenter.initialize()
    const typeRef = { typeId: 'graph-development', revision: 1 }
    const job = (await module.queries.listJobTemplates(typeRef))[0]!
    const employee = await module.commands.createEmployee({
      typeRef,
      actorUserId: null,
      body: {
        name: 'graph fixture',
        jobTemplateRef: { id: job.id, revision: job.publishedRevision },
        workScope: { kind: 'task' },
        toolOverrides: [],
      },
    })
    const runtime = module.runtime!
    const launched = await runtime.commands.launchWork({
      employeeId: employee.id,
      actorUserId: null,
      intake: {
        name: '预约需求',
        kind: 'body',
        body: '预约',
        uploads: [],
        target: { repositoryId: 'repo-fixture' },
        advanced: { typeOptions: {} },
        executionOptions: {},
        externalId: null,
        idempotencyKey: 'launch',
      },
    })
    const caseId = launched.caseRef.id
    // This fixture represents an already-settled blocked Case. Its attention is registered with the real Event Center.
    await f.employeeInput.integration.eventCenter.participant.subscribe({
      eventTypeRef: { id: 'graph-development.clarification-requested', revision: 1 },
      subject: { typeId: 'graph-development.case', subjectRef: caseId },
      subscriber: { kind: 'employee-case', subscriberRef: caseId },
    })
    const { employeeCases, employeeReactionRounds, employeeCaseInbox } = tablesOf(harness.db)
    await harness.db
      .update(employeeCases)
      .set({
        state: 'blocked',
        currentWorkItemRef: 'verify-change',
        blockReason: 'verification failed',
      })
      .where(eq(employeeCases.id, caseId))
    expect(await runtime.worker.planOneReaction()).toBeNull()
    const input = {
      sourceRef: GRAPH_EVENT_SOURCE,
      eventTypeRef: { id: 'graph-development.clarification-requested', revision: 1 },
      subject: { typeId: 'graph-development.case', subjectRef: caseId },
      occurredAt: Date.now(),
      dedupeKey: 'explicit',
      summary: '补充需求',
      payloadArtifactRef: 'request-material',
    }
    const receipt = await f.employeeInput.integration.eventCenter.participant.observe(input)
    expect((await f.employeeInput.integration.eventCenter.participant.observe(input)).eventId).toBe(
      receipt.eventId,
    )
    // Passive event observation alone does not race the existing continuation.
    expect(await runtime.worker.planOneReaction()).toBeNull()
    expect(await runtime.worker.pumpOneDelivery()).toBe(true)
    const roundId = await runtime.worker.planOneReaction()
    expect(roundId).not.toBeNull()
    const round = (
      await harness.db
        .select()
        .from(employeeReactionRounds)
        .where(eq(employeeReactionRounds.id, roundId!))
    )[0]!
    expect(round.workItemRef).toBe('design-and-clarify')
    const inbox = await harness.db
      .select()
      .from(employeeCaseInbox)
      .where(eq(employeeCaseInbox.caseId, caseId))
    expect(inbox.filter((row) => row.eventId === receipt.eventId)).toHaveLength(1)
    expect(await runtime.worker.planOneReaction()).toBeNull()
  }, 30_000)
})

test('review withdrawal cancels the original task, while follow-on intake uses the strict advanced-options shape and original material', async () => {
  const artifacts = memoryGraphArtifacts(),
    canceled: string[] = [],
    launches: unknown[] = []
  const context = {
    caseId: 'case',
    designId: 'design',
    repositoryId: 'repo',
    request: { body: 'old', kind: 'body', targetBranch: 'main', uploads: [] },
    consumedRevision: 1,
    basisId: null,
    basisDigest: null,
    reviewReceiptId: null,
    reviewDecision: null,
    candidateRef: null,
    candidateTreeOid: null,
    evidenceIds: [],
    result: 'awaiting-request',
  }
  const payload = await artifacts.put([
    {
      path: 'request.json',
      content: JSON.stringify({ document: { title: '原始设计' }, instruction: '新条件' }),
    },
  ])
  const events = {
    async observe() {
      return { eventId: 'event' }
    },
    async subscribe() {},
    async unsubscribe() {},
    async pendingDeliveries() {
      return []
    },
    async acceptDelivery() {},
  }
  const intake = createGraphCaseIntake({
    readCase: async () => ({
      projectionJson: JSON.stringify({
        case: {
          id: 'case',
          employeeRef: { id: 'employee' },
          state: 'waiting',
          currentWorkItemRef: 'review-design',
        },
        contexts: [
          { typeId: 'graph-development.design-context', stateJson: JSON.stringify(context) },
        ],
        activeRound: { workItemRef: 'review-design', executionRef: 'review-task' },
      }),
    }),
    owner: async () => ({ ownerUserId: 'owner' }),
    cancelTask: async (id) => {
      canceled.push(id)
    },
    launchWork: async (request) => {
      launches.push(request)
      return { caseRef: { id: 'follow-on' } }
    },
    events: events as unknown as Parameters<typeof createGraphCaseIntake>[0]['events'],
    humanInputs: { clarificationRounds: async () => [], reviewDecision: async () => null },
    artifacts,
  })
  expect(
    (
      await intake.requestWork({
        caseId: 'case',
        requestId: 'clarify',
        kind: 'clarification',
        withdrawReview: true,
        payloadRef: payload,
      })
    ).queued,
  ).toBe(true)
  expect(canceled).toEqual(['review-task'])
  expect(
    await intake.followOn({
      caseId: 'case',
      requestId: 'next',
      body: '新条件',
      artifactRef: payload,
    }),
  ).toEqual({ caseId: 'follow-on' })
  expect(launches[0]).toMatchObject({
    actorUserId: 'owner',
    intake: {
      advanced: { typeOptions: { 'working-branch': 'main' } },
      idempotencyKey: 'graph-follow-on:case:next',
      body: expect.stringContaining('原始设计'),
    },
  })
})
