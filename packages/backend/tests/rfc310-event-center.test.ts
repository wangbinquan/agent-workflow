import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { eventTypeCatalog } from '@/db/schema'
import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'
import { encodeDevelopmentApprovalSubject } from '@/modules/development-automation/public/types'
import { digitalEmployeeLifecycleEventCatalogJson } from '@/modules/digital-employee/public/events'
import { composeEventCenter } from '@/modules/event-center/composition'
import {
  advanceDevelopmentCodeHostObserverCursor,
  buildDevelopmentCodeHostFacts,
  composeDevelopmentApprovalEventObserver,
} from '@/modules/integration/composition/digitalEmployeeEventObserver'
import type { MrFactsSnapshot } from '@/modules/integration/application/mrFacts'
import {
  codeHostBusinessEventObservation,
  codeHostEventCatalogJson,
  codeHostEventObservation,
} from '@/modules/integration/public/events'
import { taskLifecycleEventCatalogJson } from '@/modules/task-execution/public/events'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const OWNER_PRINCIPAL = {
  userId: 'owner-1',
  canOverrideOwner: false,
  hasPermission: () => true,
} as const

describe('RFC-310 shared Event Center', () => {
  test('publishes one business catalog, hides Webhook compatibility facts, and lets every contracted event start work', async () => {
    let ordinal = 0
    const launches: Array<{
      eventDeliveryId: string
      targetRefId: string
      triggerContext: unknown
    }> = []
    const eventCenter = await composeEventCenter({
      db: createInMemoryDb(MIGRATIONS),
      typePackageDescriptorJsons: [
        codeHostEventCatalogJson,
        developmentEmployeeTypePackage.descriptorJson,
        digitalEmployeeLifecycleEventCatalogJson,
        taskLifecycleEventCatalogJson,
      ],
      routingSubscriptions: {
        list: async () =>
          ['webhook-rule-a', 'webhook-rule-b'].map((id, index) => ({
            id,
            definitionRevision: '1',
            sourceRef: { id: 'code-host.activity', revision: 1 },
            eventTypeRefs: [{ id: 'code-host.event.pipeline_failed', revision: 1 }],
            subjectTypeId: 'code-host.repository',
            subscriber: { kind: 'automation' as const, subscriberRef: id },
            displayName: { 'zh-CN': id, 'en-US': id },
            selector: { kind: 'fixture', config: { index } },
            state: 'active' as const,
            createdAt: index + 1,
            updatedAt: index + 1,
          })),
        match: async () => [],
      },
      now: () => 31_000,
      id: () => `response-resource-${++ordinal}`,
      automationWorkStart: {
        async launch(input) {
          launches.push({
            eventDeliveryId: input.eventDeliveryId,
            targetRefId: input.target.refId,
            triggerContext: input.triggerContext,
          })
          return { kind: 'orchestration' as const, taskId: `task-${launches.length}` }
        },
      },
    })

    const catalog = JSON.parse(await eventCenter.queries.catalog.catalogJson()) as {
      sources: Array<{
        sourceRef: { id: string; revision: number }
        subscriptionCount: number
      }>
      eventTypes: Array<{
        eventTypeRef: { id: string; revision: number }
        triggerParameters: unknown
      }>
    }
    expect(
      catalog.sources.filter((source) => source.sourceRef.id === 'code-host.activity'),
    ).toEqual([expect.objectContaining({ subscriptionCount: 2 })])
    expect(catalog.sources.map((source) => source.sourceRef.id)).not.toContain('employee.channel')
    expect(catalog.eventTypes.map((event) => event.eventTypeRef.id)).toContain(
      'code-host.pipeline.failed',
    )
    expect(
      catalog.eventTypes
        .map((event) => event.eventTypeRef.id)
        .filter((eventTypeId) => eventTypeId.startsWith('code-host.')),
    ).toHaveLength(11)
    expect(catalog.eventTypes.map((event) => event.eventTypeRef.id)).toContain(
      'code-host.issue.labeled',
    )
    expect(
      catalog.eventTypes.some((event) =>
        [
          'development.review-updated',
          'development.conflict-updated',
          'development.lifecycle-updated',
          'development.pipeline-check-due',
        ].includes(event.eventTypeRef.id),
      ),
    ).toBe(false)
    expect(catalog.eventTypes.map((event) => event.eventTypeRef.id)).toContain(
      'platform.task.status-changed',
    )
    expect(catalog.eventTypes.map((event) => event.eventTypeRef.id)).toEqual(
      expect.arrayContaining([
        'approval.status.changed',
        'platform.employee-invocation.result-returned',
      ]),
    )
    expect(
      catalog.eventTypes.some((event) =>
        ['development.approval-updated', 'development.employee-result'].includes(
          event.eventTypeRef.id,
        ),
      ),
    ).toBe(false)
    expect(
      catalog.eventTypes.some((event) => event.eventTypeRef.id.startsWith('code-host.event.')),
    ).toBe(false)

    for (const [name, targetRefId] of [
      ['流水线修复一', 'workflow-repair-a'],
      ['流水线修复二', 'workflow-repair-b'],
    ] as const) {
      await eventCenter.responseRules.commands.create(
        {
          name,
          enabled: true,
          eventTypeRef: { id: 'code-host.pipeline.failed', revision: 1 },
          subjectMatch: 'all',
          subjectPattern: null,
          target: {
            kind: 'workflow',
            refId: targetRefId,
            nameTemplate: '修复 {{trigger.code_host.repo_path}}!{{trigger.code_host.mr_iid}}',
            inputs: { mr: '{{trigger.code_host.mr_iid}}' },
          },
        },
        OWNER_PRINCIPAL,
      )
    }

    await eventCenter.participant.subscribe({
      eventTypeRef: { id: 'code-host.pipeline.failed', revision: 1 },
      subject: {
        typeId: 'code-host.pipeline',
        subjectRef: 'gitlab:platform/service:pipeline:unrelated',
      },
      subscriber: { kind: 'system', subscriberRef: 'exact-audit-subscriber' },
    })
    const subscriptionPages: Array<{ id: string; mode: string }> = []
    for (const page of [1, 2, 3]) {
      const document = JSON.parse(
        await eventCenter.queries.catalog.subscriptionPageJson({
          page,
          limit: 2,
          subscriberRef: null,
        }),
      ) as { items: Array<{ id: string; mode: string }>; total: number }
      expect(document.total).toBe(5)
      subscriptionPages.push(...document.items)
    }
    expect(subscriptionPages).toHaveLength(5)
    expect(new Set(subscriptionPages.map((subscription) => subscription.id)).size).toBe(5)
    expect(subscriptionPages.map((subscription) => subscription.mode).sort()).toEqual([
      'exact',
      'filtered',
      'filtered',
      'filtered',
      'filtered',
    ])

    const receipt = await eventCenter.participant.observe(
      codeHostBusinessEventObservation({
        endpointId: 'endpoint-public',
        deliveryId: 'delivery-public',
        occurredAt: 30_000,
        event: {
          provider: 'gitlab',
          eventUuid: 'provider-public',
          eventType: 'pipeline_failed',
          repoPath: 'platform/service',
          repoHttpUrl: 'https://gitlab.example.com/platform/service.git',
          repoSshUrl: 'git@gitlab.example.com:platform/service.git',
          branch: 'feature/fix',
          mrIid: '42',
          pipelineId: 'pipeline-123',
          pipelineStatus: 'failed',
          author: { username: 'automation' },
          raw: { object_kind: 'pipeline' },
        },
      }),
    )
    expect(receipt.deliveryCount).toBe(2)
    expect(await eventCenter.worker.runOneNotification()).toBe('completed')
    expect(await eventCenter.worker.runOneNotification()).toBe('completed')
    expect(launches.map((launch) => launch.targetRefId).sort()).toEqual([
      'workflow-repair-a',
      'workflow-repair-b',
    ])
    expect(launches[0]?.triggerContext).toMatchObject({
      trigger: {
        code_host: { mr_iid: '42', repo_path: 'platform/service' },
      },
    })

    await eventCenter.participant.observe(
      codeHostEventObservation({
        endpointId: 'endpoint-1',
        deliveryId: 'delivery-compatibility-1',
        occurredAt: 30_001,
        event: {
          provider: 'gitlab',
          eventUuid: 'provider-delivery-1',
          eventType: 'pipeline_failed',
          repoPath: 'platform/service',
          repoHttpUrl: 'https://gitlab.example.com/platform/service.git',
          repoSshUrl: 'git@gitlab.example.com:platform/service.git',
          branch: 'feature/fix',
          mrIid: '42',
          author: { username: 'automation' },
          pipelineStatus: 'failed',
          raw: { object_kind: 'pipeline' },
        },
      }),
    )
    expect(
      await eventCenter.queries.operations.eventRecordPage({ page: 1, limit: 20, sourceId: null }),
    ).toMatchObject({
      total: 1,
      items: [{ eventTypeRef: { id: 'code-host.pipeline.failed', revision: 1 } }],
    })

    await expect(
      eventCenter.responseRules.commands.create(
        {
          name: '不能选择兼容入站事件',
          enabled: true,
          eventTypeRef: { id: 'code-host.event.pipeline_failed', revision: 1 },
          subjectMatch: 'all',
          subjectPattern: null,
          target: {
            kind: 'workflow',
            refId: 'workflow-repair-a',
            nameTemplate: 'repair',
            inputs: {},
          },
        },
        OWNER_PRINCIPAL,
      ),
    ).rejects.toThrow('non-public event facts cannot be selected')
  })

  test('a queued response delivery never executes a target edited after the event matched', async () => {
    const now = 41_000
    let ordinal = 0
    const launches: string[] = []
    const eventCenter = await composeEventCenter({
      db: createInMemoryDb(MIGRATIONS),
      typePackageDescriptorJsons: [
        codeHostEventCatalogJson,
        developmentEmployeeTypePackage.descriptorJson,
      ],
      now: () => now,
      id: () => `stale-rule-resource-${++ordinal}`,
      automationWorkStart: {
        async launch(input) {
          launches.push(input.target.refId)
          return { kind: 'orchestration' as const, taskId: 'unexpected-task' }
        },
      },
    })
    const original = await eventCenter.responseRules.commands.create(
      {
        name: '流水线修复',
        enabled: true,
        eventTypeRef: { id: 'code-host.pipeline.failed', revision: 1 },
        subjectMatch: 'all',
        subjectPattern: null,
        target: {
          kind: 'workflow',
          refId: 'workflow-before-edit',
          nameTemplate: 'repair',
          inputs: {},
        },
      },
      OWNER_PRINCIPAL,
    )
    const receipt = await eventCenter.participant.observe(
      codeHostBusinessEventObservation({
        endpointId: 'endpoint-stale',
        deliveryId: 'delivery-stale',
        occurredAt: now,
        event: {
          provider: 'gitlab',
          eventUuid: 'provider-stale',
          eventType: 'pipeline_failed',
          repoPath: 'platform/service',
          repoHttpUrl: 'https://gitlab.example.com/platform/service.git',
          repoSshUrl: 'git@gitlab.example.com:platform/service.git',
          branch: 'feature/fix',
          mrIid: '43',
          pipelineId: 'pipeline-stale',
          pipelineStatus: 'failed',
          author: { username: 'automation' },
          raw: { object_kind: 'pipeline' },
        },
      }),
    )
    await eventCenter.responseRules.commands.update(
      original.id,
      {
        name: '流水线修复（新定义）',
        enabled: true,
        eventTypeRef: { id: 'code-host.pipeline.failed', revision: 1 },
        subjectMatch: 'all',
        subjectPattern: null,
        target: {
          kind: 'workflow',
          refId: 'workflow-after-edit',
          nameTemplate: 'repair edited',
          inputs: {},
        },
      },
      OWNER_PRINCIPAL,
    )

    expect(await eventCenter.worker.runOneNotification()).toBe('completed')
    expect(launches).toEqual([])
    expect(await eventCenter.queries.operations.deliveryStatuses()).toMatchObject([
      { deliveryId: receipt.deliveryIds[0], state: 'accepted' },
    ])
  })

  test('an upgrade preserves immutable employee-private revisions while publishing new business facts', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const employeePackage = JSON.parse(developmentEmployeeTypePackage.descriptorJson) as {
      typeRef: { typeId: string }
      eventTypes: Array<{
        eventTypeId: string
        version: number
        subjectTypeId: string
        payloadSchemaId: string
        displayName: unknown
        description: unknown
        deliveryClass: string
        priority?: number
        sourceRef: { id: string; revision: number }
      }>
    }
    for (const eventTypeId of ['development.employee-result', 'development.approval-updated']) {
      const eventType = employeePackage.eventTypes.find(
        (candidate) => candidate.eventTypeId === eventTypeId,
      )!
      const legacyDescriptor = {
        schemaVersion: 1,
        eventTypeRef: { id: eventType.eventTypeId, revision: eventType.version },
        sourceRef: eventType.sourceRef,
        ownerTypeId: employeePackage.typeRef.typeId,
        subjectTypeId: eventType.subjectTypeId,
        payloadSchemaId: eventType.payloadSchemaId,
        displayName: eventType.displayName,
        description: eventType.description,
        deliveryClass: eventType.deliveryClass,
        priority: eventType.priority,
      }
      db.insert(eventTypeCatalog)
        .values({
          eventTypeId: eventType.eventTypeId,
          revision: eventType.version,
          sourceId: eventType.sourceRef.id,
          sourceRevision: eventType.sourceRef.revision,
          descriptorJson: JSON.stringify(legacyDescriptor),
          descriptorDigest: 'persisted-before-trigger-contracts',
          catalogVisibility: 'internal',
          state: 'published',
          registeredAt: 1,
        })
        .run()
    }

    const eventCenter = await composeEventCenter({
      db,
      typePackageDescriptorJsons: [
        developmentEmployeeTypePackage.descriptorJson,
        digitalEmployeeLifecycleEventCatalogJson,
      ],
      now: () => 2,
      id: () => 'upgrade-resource',
    })
    const catalog = JSON.parse(await eventCenter.queries.catalog.catalogJson()) as {
      eventTypes: Array<{ eventTypeRef: { id: string } }>
    }
    expect(catalog.eventTypes.map((event) => event.eventTypeRef.id)).toEqual(
      expect.arrayContaining([
        'approval.status.changed',
        'platform.employee-invocation.result-returned',
      ]),
    )
    expect(
      catalog.eventTypes.some((event) =>
        ['development.employee-result', 'development.approval-updated'].includes(
          event.eventTypeRef.id,
        ),
      ),
    ).toBe(false)
  })

  test('approval observer emits revision changes only and uses the typed approval subject', async () => {
    let observations = 0
    const observer = composeDevelopmentApprovalEventObserver({
      gateway: {
        async observe(input) {
          observations += 1
          const approved = observations >= 3
          return {
            ok: true as const,
            receipt: {
              correlationRef: input.correlationRef,
              observedRevision: approved ? 'revision-2' : 'revision-1',
              status: approved ? ('approved' as const) : ('pending' as const),
              evidenceRef: approved ? 'approval-evidence' : null,
              observedAt: approved ? '2026-08-21T00:00:02.000Z' : '2026-08-21T00:00:01.000Z',
            },
          }
        },
      },
      now: () => 42,
    })
    const subject = {
      typeId: 'external-approval',
      subjectRef: encodeDevelopmentApprovalSubject({
        adapterRef: { id: 'approval-adapter', revision: 1 },
        correlationRef: 'approval-correlation',
      }),
    }
    const source = {
      sourceRef: { id: 'development.approval-state', revision: 1 },
    }
    const first = await observer.run({ source, subjects: [subject], cursorJson: null })
    expect(first.observations).toMatchObject([
      {
        eventTypeRef: { id: 'development.approval-updated', revision: 1 },
        subject,
      },
      {
        eventTypeRef: { id: 'approval.status.changed', revision: 1 },
        subject,
        triggerParameters: { subject_ref: subject.subjectRef },
      },
    ])
    const unchanged = await observer.run({
      source,
      subjects: [subject],
      cursorJson: first.cursorJson,
    })
    expect(unchanged.observations).toHaveLength(0)
    const approved = await observer.run({
      source,
      subjects: [subject],
      cursorJson: unchanged.cursorJson,
    })
    expect(approved.observations).toMatchObject([
      { summary: '外部审批状态更新为 approved' },
      { summary: '外部审批状态更新为 approved' },
    ])
  })

  test('polling emits review tombstones and lifecycle facts clear old readiness blockers', () => {
    const clean = {
      mrRef: '42',
      headSha: 'a'.repeat(40),
      targetSha: 'b'.repeat(40),
      targetBranch: 'main',
      state: 'opened',
      draft: false,
      mergeableState: 'mergeable',
      approvalHold: true,
      mergedCommitSha: null,
      mergedAt: null,
      threads: [],
    } satisfies MrFactsSnapshot
    const cleanFacts = buildDevelopmentCodeHostFacts(clean)
    expect(cleanFacts.map((fact) => fact.eventTypeId)).toEqual([
      'development.lifecycle-updated',
      'development.review-updated',
      'development.pipeline-check-due',
    ])
    expect(cleanFacts[1]!.payload).toEqual([])

    const blocked = {
      ...clean,
      mergeableState: 'conflict' as const,
      threads: [
        {
          threadRef: 'thread-1',
          revision: '1:1',
          authorClass: 'human' as const,
          resolved: false,
          lastBody: 'please fix this',
          path: 'src/main.ts',
          messages: [],
        },
        {
          threadRef: 'thread-self',
          revision: '1:2',
          authorClass: 'self' as const,
          resolved: false,
          lastBody: 'platform reply',
          path: null,
          messages: [],
        },
      ],
    } satisfies MrFactsSnapshot
    const blockedFacts = buildDevelopmentCodeHostFacts(blocked)
    expect(blockedFacts.map((fact) => fact.eventTypeId)).toEqual([
      'development.lifecycle-updated',
      'development.review-updated',
      'development.conflict-updated',
      'development.pipeline-check-due',
    ])
    expect(blockedFacts[0]!.payload).toMatchObject({
      mergeableState: 'conflict',
    })
    expect(blockedFacts[0]!.payload).not.toHaveProperty('unresolvedReviewCount')
    expect(blockedFacts[0]!.payload).not.toHaveProperty('reviewDigest')
    expect(cleanFacts[0]!.payload).toMatchObject({ mergeableState: 'mergeable' })
    expect(
      buildDevelopmentCodeHostFacts({
        ...blocked,
        state: 'merged',
        mergedCommitSha: 'c'.repeat(40),
      }).map((fact) => fact.eventTypeId),
    ).toEqual(['development.lifecycle-updated'])
    expect(
      buildDevelopmentCodeHostFacts({ ...blocked, headSha: null }).map((fact) => fact.eventTypeId),
    ).toEqual(['development.lifecycle-updated'])
    expect(
      buildDevelopmentCodeHostFacts({ ...blocked, targetSha: null }).map(
        (fact) => fact.eventTypeId,
      ),
    ).toEqual([
      'development.lifecycle-updated',
      'development.review-updated',
      'development.pipeline-check-due',
    ])
  })

  test('observer cursor emits A-B-A transitions and a new activation baseline exactly once', () => {
    const clean = {
      mrRef: '42',
      headSha: 'a'.repeat(40),
      targetSha: 'b'.repeat(40),
      targetBranch: 'main',
      state: 'opened',
      draft: false,
      mergeableState: 'mergeable',
      approvalHold: false,
      mergedCommitSha: null,
      mergedAt: null,
      threads: [],
    } satisfies MrFactsSnapshot
    const blocked = {
      ...clean,
      mergeableState: 'conflict' as const,
      threads: [
        {
          threadRef: 'thread-1',
          revision: '1:1',
          authorClass: 'human' as const,
          resolved: false,
          lastBody: 'please fix this',
          path: 'src/main.ts',
          messages: [],
        },
      ],
    } satisfies MrFactsSnapshot
    const advance = (cursorJson: string | null, snapshot: MrFactsSnapshot, activation: string) =>
      advanceDevelopmentCodeHostObserverCursor({
        cursorJson,
        activationRef: () => activation,
        factsBySubject: [
          { subjectRef: 'repo-1!42', facts: buildDevelopmentCodeHostFacts(snapshot) },
        ],
      })

    const first = advance(null, clean, 'activation-1')
    expect(first.changes.map((change) => change.fact.eventTypeId)).toEqual([
      'development.lifecycle-updated',
      'development.review-updated',
      'development.pipeline-check-due',
    ])
    expect(
      advance(first.cursorJson, clean, 'unused').changes.map((change) => change.fact.eventTypeId),
    ).toEqual(['development.pipeline-check-due'])

    // Review facts have their own event lane. A new human thread, and especially
    // a later platform acknowledgement in that same thread, must not mutate the
    // lifecycle digest: lifecycle preempts a pending publication continuation.
    // Treating review content as lifecycle state can therefore strand a repaired
    // workspace before prepare-change / publish-mr runs.
    const reviewOnly = {
      ...clean,
      threads: [
        {
          threadRef: 'thread-review-only',
          revision: '1:10',
          authorClass: 'human' as const,
          resolved: false,
          lastBody: 'please add a regression test',
          path: 'src/main.ts',
          messages: [
            {
              messageRef: '10',
              parentMessageRef: null,
              authorClass: 'human' as const,
              body: 'please add a regression test',
              path: 'src/main.ts',
              createdAt: '2026-08-24T00:00:00.000Z',
            },
          ],
        },
      ],
    } satisfies MrFactsSnapshot
    const reviewFirst = advance(first.cursorJson, reviewOnly, 'unused')
    expect(reviewFirst.changes.map((change) => change.fact.eventTypeId)).toEqual([
      'development.review-updated',
      'development.pipeline-check-due',
    ])
    const acknowledged = {
      ...reviewOnly,
      threads: reviewOnly.threads.map((thread) => ({
        ...thread,
        messages: [
          ...thread.messages,
          {
            messageRef: '11',
            parentMessageRef: '10',
            authorClass: 'self' as const,
            body: 'received',
            path: 'src/main.ts',
            createdAt: '2026-08-24T00:00:01.000Z',
          },
        ],
      })),
    } satisfies MrFactsSnapshot
    expect(
      advance(reviewFirst.cursorJson, acknowledged, 'unused').changes.map(
        (change) => change.fact.eventTypeId,
      ),
    ).toEqual(['development.pipeline-check-due'])

    const blockedFirst = advance(first.cursorJson, blocked, 'unused')
    expect(blockedFirst.changes.map((change) => change.fact.eventTypeId)).toEqual([
      'development.lifecycle-updated',
      'development.review-updated',
      'development.conflict-updated',
      'development.pipeline-check-due',
    ])
    const blockedKeys = blockedFirst.changes.map((change) => change.dedupeKey)
    const cleanAgain = advance(blockedFirst.cursorJson, clean, 'unused')
    expect(cleanAgain.changes.map((change) => change.fact.eventTypeId)).toEqual([
      'development.lifecycle-updated',
      'development.review-updated',
      'development.pipeline-check-due',
    ])
    expect(
      cleanAgain.changes.find((change) => change.fact.eventTypeId === 'development.review-updated')
        ?.fact.payload,
    ).toEqual([])
    const blockedAgain = advance(cleanAgain.cursorJson, blocked, 'unused')
    expect(blockedAgain.changes.map((change) => change.fact.eventTypeId)).toEqual([
      'development.lifecycle-updated',
      'development.review-updated',
      'development.conflict-updated',
      'development.pipeline-check-due',
    ])
    expect(blockedAgain.changes.map((change) => change.dedupeKey)).not.toEqual(blockedKeys)

    const restarted = advance(null, blocked, 'activation-2')
    expect(restarted.changes).toHaveLength(4)
    expect(restarted.changes.map((change) => change.dedupeKey)).not.toEqual(blockedKeys)
  })

  test('observer cursor preserves subjects outside the rotating batch so A-B-A is not swallowed', () => {
    const clean = {
      mrRef: '42',
      headSha: 'a'.repeat(40),
      targetSha: 'b'.repeat(40),
      targetBranch: 'main',
      state: 'opened',
      draft: false,
      mergeableState: 'mergeable',
      approvalHold: false,
      mergedCommitSha: null,
      mergedAt: null,
      threads: [],
    } satisfies MrFactsSnapshot
    const blocked = { ...clean, mergeableState: 'conflict' as const }
    const first = advanceDevelopmentCodeHostObserverCursor({
      cursorJson: null,
      activationRef: () => 'activation-rotation',
      factsBySubject: [
        { subjectRef: 'repo!subject-a', facts: buildDevelopmentCodeHostFacts(clean) },
      ],
    })
    const second = advanceDevelopmentCodeHostObserverCursor({
      cursorJson: first.cursorJson,
      activationRef: () => 'unused',
      factsBySubject: [
        { subjectRef: 'repo!subject-b', facts: buildDevelopmentCodeHostFacts(clean) },
      ],
    })
    expect(
      Object.keys(
        (JSON.parse(second.cursorJson) as { subjects: Record<string, unknown> }).subjects,
      ),
    ).toHaveLength(2)

    const changed = advanceDevelopmentCodeHostObserverCursor({
      cursorJson: second.cursorJson,
      activationRef: () => 'unused',
      factsBySubject: [
        { subjectRef: 'repo!subject-a', facts: buildDevelopmentCodeHostFacts(blocked) },
      ],
    })
    expect(changed.changes.map((change) => change.fact.eventTypeId)).toEqual([
      'development.lifecycle-updated',
      'development.conflict-updated',
      'development.pipeline-check-due',
    ])
    expect(changed.changes[0]!.dedupeKey).not.toBe(first.changes[0]!.dedupeKey)
  })

  test('subscriptions activate a short observer, baseline scan dedupes with webhook, and zero subscribers stop it', async () => {
    const now = 10_000
    let ordinal = 0
    const calls: Array<{ cursorJson: string | null; subjects: readonly string[] }> = []
    const eventCenter = await composeEventCenter({
      db: createInMemoryDb(MIGRATIONS),
      typePackageDescriptorJsons: [developmentEmployeeTypePackage.descriptorJson],
      now: () => now,
      id: () => `event-resource-${++ordinal}`,
      workerId: 'observer-test-worker',
      observer: {
        async run(input) {
          calls.push({
            cursorJson: input.cursorJson,
            subjects: input.subjects.map((subject) => subject.subjectRef),
          })
          return {
            schemaVersion: 1,
            cursorJson: '{"sequence":1}',
            observations: [
              {
                sourceRef: input.source.sourceRef,
                eventTypeRef: { id: 'development.pipeline-check-due', revision: 1 },
                subject: input.subjects[0]!,
                occurredAt: now - 1_000,
                dedupeKey: 'pipeline:mr-1:head-a:42',
                summary: '流水线 #42 失败',
                payloadArtifactRef: '.agent-workflow/pipeline/bundle-42/manifest.json',
              },
            ],
          }
        },
      },
    })

    const subscriber = { kind: 'employee-case' as const, subscriberRef: 'case-1' }
    const subject = { typeId: 'merge-request', subjectRef: 'mr-1' }
    const pipelineSubscription = await eventCenter.participant.subscribe({
      eventTypeRef: { id: 'development.pipeline-check-due', revision: 1 },
      subject,
      subscriber,
    })
    expect(pipelineSubscription.created).toBe(true)
    expect(pipelineSubscription.observerTransition).toBe('started')
    expect(
      await eventCenter.participant.subscribe({
        eventTypeRef: { id: 'development.pipeline-check-due', revision: 1 },
        subject,
        subscriber,
      }),
    ).toEqual({ ...pipelineSubscription, created: false, observerTransition: 'none' })
    expect(await eventCenter.queries.operations.observerHealth()).toMatchObject([
      { subscriberCount: 1, state: 'active', nextScanAt: now },
    ])

    expect(await eventCenter.worker.runOneDueObserver()).toBe('completed')
    expect(calls).toEqual([{ cursorJson: null, subjects: ['mr-1'] }])
    const delivery = await eventCenter.participant.pendingDeliveries(subscriber, 10)
    expect(delivery).toHaveLength(1)
    expect(delivery[0]).toMatchObject({
      deliveryClass: 'pipeline',
      payloadArtifactRef: '.agent-workflow/pipeline/bundle-42/manifest.json',
    })

    const duplicate = await eventCenter.participant.observe({
      sourceRef: { id: 'code-host.activity', revision: 1 },
      eventTypeRef: { id: 'development.pipeline-check-due', revision: 1 },
      subject,
      occurredAt: now,
      dedupeKey: 'pipeline:mr-1:head-a:42',
      summary: '同一流水线 webhook',
      payloadArtifactRef: null,
    })
    expect(duplicate.duplicate).toBe(true)
    expect(await eventCenter.participant.pendingDeliveries(subscriber, 10)).toHaveLength(1)
    await eventCenter.participant.acceptDelivery(delivery[0]!.deliveryId)
    expect(await eventCenter.participant.pendingDeliveries(subscriber, 10)).toEqual([])

    expect(
      await eventCenter.participant.unsubscribe(pipelineSubscription.subscriptionId),
    ).toMatchObject({ observerTransition: 'stopped' })
    expect(await eventCenter.worker.runOneDueObserver()).toBe('idle')
    expect(await eventCenter.queries.operations.observerHealth()).toMatchObject([
      { subscriberCount: 0, state: 'idle', nextScanAt: null },
    ])
  })

  test('a webhook nudge wakes only a subscribed observer and is not lost during an active scan', async () => {
    let now = 40_000
    let ordinal = 0
    let runs = 0
    let releaseFirst!: () => void
    let markStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const eventCenter = await composeEventCenter({
      db: createInMemoryDb(MIGRATIONS),
      typePackageDescriptorJsons: [developmentEmployeeTypePackage.descriptorJson],
      now: () => now,
      id: () => `nudge-resource-${++ordinal}`,
      workerId: 'nudge-worker',
      observer: {
        async run() {
          runs += 1
          if (runs === 1) {
            markStarted()
            await firstRelease
          }
          return { schemaVersion: 1 as const, cursorJson: null, observations: [] }
        },
      },
    })
    const subscription = await eventCenter.participant.subscribe({
      eventTypeRef: { id: 'development.pipeline-check-due', revision: 1 },
      subject: { typeId: 'merge-request', subjectRef: 'repo-1!42' },
      subscriber: { kind: 'employee-case', subscriberRef: 'case-1' },
    })

    const firstRun = eventCenter.worker.runOneDueObserver()
    await firstStarted
    now += 25
    expect(
      await eventCenter.observerControl.nudgeSource({
        id: 'code-host.activity',
        revision: 1,
      }),
    ).toBe(true)
    releaseFirst()
    expect(await firstRun).toBe('completed')
    expect((await eventCenter.queries.operations.observerHealth())[0]?.nextScanAt).toBe(now)
    expect(await eventCenter.worker.runOneDueObserver()).toBe('completed')
    expect(runs).toBe(2)

    await eventCenter.participant.unsubscribe(subscription.subscriptionId)
    expect(
      await eventCenter.observerControl.nudgeSource({
        id: 'code-host.activity',
        revision: 1,
      }),
    ).toBe(false)
  })

  test('observer batches rotate so subjects beyond one batch are not starved', async () => {
    let now = 20_000
    let ordinal = 0
    const batches: string[][] = []
    const eventCenter = await composeEventCenter({
      db: createInMemoryDb(MIGRATIONS),
      typePackageDescriptorJsons: [developmentEmployeeTypePackage.descriptorJson],
      now: () => now,
      id: () => `rotation-resource-${++ordinal}`,
      workerId: 'rotation-worker',
      observer: {
        async run(input) {
          batches.push(input.subjects.map((subject) => subject.subjectRef))
          return {
            schemaVersion: 1 as const,
            cursorJson: JSON.stringify({ scan: batches.length }),
            observations: [],
          }
        },
      },
    })
    for (let index = 0; index < 101; index += 1) {
      await eventCenter.participant.subscribe({
        eventTypeRef: { id: 'development.pipeline-check-due', revision: 1 },
        subject: { typeId: 'merge-request', subjectRef: `repo!${index}` },
        subscriber: { kind: 'employee-case', subscriberRef: `case-${index}` },
      })
    }

    expect(await eventCenter.worker.runOneDueObserver()).toBe('completed')
    now += 30_000
    expect(await eventCenter.worker.runOneDueObserver()).toBe('completed')
    expect(batches.map((batch) => batch.length)).toEqual([100, 100])
    expect(new Set(batches.flat()).size).toBe(101)
  })

  test('a late subscriber receives the latest durable event by default and may start fresh', async () => {
    let ordinal = 0
    const eventCenter = await composeEventCenter({
      db: createInMemoryDb(MIGRATIONS),
      typePackageDescriptorJsons: [developmentEmployeeTypePackage.descriptorJson],
      now: () => 30_000,
      id: () => `replay-resource-${++ordinal}`,
    })
    const subject = { typeId: 'employee-invocation', subjectRef: 'invocation-1' }
    await eventCenter.participant.observe({
      sourceRef: { id: 'employee.channel', revision: 1 },
      eventTypeRef: { id: 'development.employee-result', revision: 1 },
      subject,
      occurredAt: 29_000,
      dedupeKey: 'employee-result:invocation-1:completed',
      summary: '子数字员工已完成',
      payloadArtifactRef: null,
    })
    const subscriber = { kind: 'employee-case' as const, subscriberRef: 'parent-case' }
    await eventCenter.participant.subscribe({
      eventTypeRef: { id: 'development.employee-result', revision: 1 },
      subject,
      subscriber,
    })
    expect(await eventCenter.participant.pendingDeliveries(subscriber, 10)).toMatchObject([
      {
        eventTypeRef: { id: 'development.employee-result', revision: 1 },
        subject,
        summary: '子数字员工已完成',
      },
    ])
    const freshSubscriber = {
      kind: 'employee-case' as const,
      subscriberRef: 'reactivated-parent-case',
    }
    await eventCenter.participant.subscribe({
      eventTypeRef: { id: 'development.employee-result', revision: 1 },
      subject,
      subscriber: freshSubscriber,
      replayLatest: false,
    })
    expect(await eventCenter.participant.pendingDeliveries(freshSubscriber, 10)).toEqual([])
  })

  test('Event Center preserves neutral event order and leaves business priority to subscribers', async () => {
    let ordinal = 0
    const eventCenter = await composeEventCenter({
      db: createInMemoryDb(MIGRATIONS),
      typePackageDescriptorJsons: [developmentEmployeeTypePackage.descriptorJson],
      now: () => 20_000,
      id: () => `event-resource-${++ordinal}`,
    })
    const subscriber = { kind: 'employee-case' as const, subscriberRef: 'case-2' }
    const subject = { typeId: 'merge-request', subjectRef: 'mr-2' }
    for (const eventTypeId of ['development.pipeline-check-due', 'development.lifecycle-updated']) {
      await eventCenter.participant.subscribe({
        eventTypeRef: {
          id: eventTypeId,
          revision: eventTypeId === 'development.pipeline-check-due' ? 1 : 2,
        },
        subject,
        subscriber,
      })
    }
    await eventCenter.participant.observe({
      sourceRef: { id: 'code-host.activity', revision: 1 },
      eventTypeRef: { id: 'development.pipeline-check-due', revision: 1 },
      subject,
      occurredAt: 19_000,
      dedupeKey: 'pipeline:mr-2:1',
      summary: '流水线失败',
      payloadArtifactRef: null,
    })
    await eventCenter.participant.observe({
      sourceRef: { id: 'code-host.activity', revision: 1 },
      eventTypeRef: { id: 'development.lifecycle-updated', revision: 2 },
      subject,
      occurredAt: 19_500,
      dedupeKey: 'lifecycle:mr-2:merged',
      summary: 'MR 已合入',
      payloadArtifactRef: null,
    })

    expect(
      (await eventCenter.participant.pendingDeliveries(subscriber, 10)).map(
        (delivery) => delivery.eventTypeRef.id,
      ),
    ).toEqual(['development.pipeline-check-due', 'development.lifecycle-updated'])
  })

  test('one immutable event fans out to independent deliveries for every subscriber', async () => {
    let ordinal = 0
    const eventCenter = await composeEventCenter({
      db: createInMemoryDb(MIGRATIONS),
      typePackageDescriptorJsons: [developmentEmployeeTypePackage.descriptorJson],
      now: () => 25_000,
      id: () => `fanout-resource-${++ordinal}`,
    })
    const subject = { typeId: 'merge-request', subjectRef: 'repo!77' }
    const first = { kind: 'employee-case' as const, subscriberRef: 'case-first' }
    const second = { kind: 'employee-case' as const, subscriberRef: 'case-second' }
    for (const subscriber of [first, second]) {
      await eventCenter.participant.subscribe({
        eventTypeRef: { id: 'development.pipeline-check-due', revision: 1 },
        subject,
        subscriber,
      })
    }

    const receipt = await eventCenter.participant.observe({
      sourceRef: { id: 'code-host.activity', revision: 1 },
      eventTypeRef: { id: 'development.pipeline-check-due', revision: 1 },
      subject,
      occurredAt: 24_000,
      dedupeKey: 'pipeline:repo!77:head-a:19',
      summary: '流水线失败',
      payloadArtifactRef: '.agent-workflow/pipeline/bundle-19/manifest.json',
    })

    expect(receipt.deliveryCount).toBe(2)
    expect(new Set(receipt.deliveryIds).size).toBe(2)
    const firstDelivery = await eventCenter.participant.pendingDeliveries(first, 10)
    const secondDelivery = await eventCenter.participant.pendingDeliveries(second, 10)
    expect(firstDelivery).toHaveLength(1)
    expect(secondDelivery).toHaveLength(1)
    expect(firstDelivery[0]!.eventId).toBe(secondDelivery[0]!.eventId)
    expect(firstDelivery[0]!.deliveryId).not.toBe(secondDelivery[0]!.deliveryId)

    await eventCenter.participant.acceptDelivery(firstDelivery[0]!.deliveryId)
    expect(await eventCenter.participant.pendingDeliveries(first, 10)).toEqual([])
    expect(await eventCenter.participant.pendingDeliveries(second, 10)).toHaveLength(1)

    const duplicate = await eventCenter.participant.observe({
      sourceRef: { id: 'code-host.activity', revision: 1 },
      eventTypeRef: { id: 'development.pipeline-check-due', revision: 1 },
      subject,
      occurredAt: 24_000,
      dedupeKey: 'pipeline:repo!77:head-a:19',
      summary: '同一流水线的重复观察',
      payloadArtifactRef: null,
    })
    expect(duplicate).toMatchObject({
      duplicate: true,
      eventId: firstDelivery[0]!.eventId,
      deliveryCount: 2,
    })
    expect(await eventCenter.participant.pendingDeliveries(second, 10)).toHaveLength(1)
  })

  test('one automation failure cannot consume or dead-letter another subscription delivery', async () => {
    let ordinal = 0
    const consumed: string[] = []
    const definition = (id: string) => ({
      id,
      definitionRevision: '1',
      sourceRef: { id: 'code-host.activity', revision: 1 },
      eventTypeRefs: [{ id: 'development.pipeline-check-due', revision: 1 }],
      subjectTypeId: 'merge-request',
      subscriber: { kind: 'automation' as const, subscriberRef: id },
      displayName: { 'zh-CN': id, 'en-US': id },
      selector: { kind: 'fixture', config: { id } },
      state: 'active' as const,
      createdAt: 1,
      updatedAt: 1,
    })
    const definitions = [definition('automation-fails'), definition('automation-succeeds')]
    const eventCenter = await composeEventCenter({
      db: createInMemoryDb(MIGRATIONS),
      typePackageDescriptorJsons: [developmentEmployeeTypePackage.descriptorJson],
      now: () => 27_000,
      id: () => `automation-fanout-${++ordinal}`,
      routingSubscriptions: {
        list: async () => definitions,
        match: async (observation) =>
          definitions.map((item) => ({
            definition: item,
            eventTypeRef: observation.eventTypeRef,
            materializedSubscriptionId: `materialized:${item.id}:${observation.subject.subjectRef}`,
          })),
      },
      deliveryConsumers: [
        {
          subscriberKind: 'automation',
          canConsume: async () => true,
          async consume(delivery) {
            consumed.push(delivery.subscriber.subscriberRef)
            if (delivery.subscriber.subscriberRef === 'automation-fails') {
              throw new Error('fixture consumer failed')
            }
          },
        },
      ],
      deliveryRetryLimits: {
        current: () => ({ defaultNodeRetries: 0, sessionRestartBudget: 0 }),
      },
    })

    const receipt = await eventCenter.participant.observe({
      sourceRef: { id: 'code-host.activity', revision: 1 },
      eventTypeRef: { id: 'development.pipeline-check-due', revision: 1 },
      subject: { typeId: 'merge-request', subjectRef: 'repo!88' },
      occurredAt: 26_000,
      dedupeKey: 'pipeline:repo!88:head-a:20',
      summary: '流水线失败',
      payloadArtifactRef: null,
    })
    expect(receipt.deliveryCount).toBe(2)
    expect(await eventCenter.worker.runOneNotification()).toBe('dead-letter')
    expect(await eventCenter.worker.runOneNotification()).toBe('completed')
    expect(consumed).toEqual(['automation-fails', 'automation-succeeds'])
    expect(await eventCenter.queries.operations.deliveryStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: receipt.eventId,
          subscriber: { kind: 'automation', subscriberRef: 'automation-fails' },
          state: 'dead-letter',
        }),
        expect.objectContaining({
          eventId: receipt.eventId,
          subscriber: { kind: 'automation', subscriberRef: 'automation-succeeds' },
          state: 'accepted',
        }),
      ]),
    )
  })

  test('a global custom source validates its real script, publishes exact events, polls on subscription, and dedupes storage', async () => {
    let now = Date.parse('2026-08-21T08:00:00.000Z')
    let ordinal = 0
    const eventCenter = await composeEventCenter({
      db: createInMemoryDb(MIGRATIONS),
      // The source is global: no digital-employee type package is required.
      typePackageDescriptorJsons: [],
      now: () => now,
      id: () => `global-event-${++ordinal}`,
      workerId: 'global-custom-source-worker',
    })
    const draft = {
      schemaVersion: 1 as const,
      displayName: { 'zh-CN': '自建问题状态', 'en-US': 'Internal issue status' },
      description: {
        'zh-CN': '轮询自建问题系统中的状态版本。',
        'en-US': 'Poll stable issue revisions from an internal system.',
      },
      pollIntervalMs: 1_000,
      batchSize: 20,
      ingestionMode: 'state-change' as const,
      program: {
        language: 'node' as const,
        templateManaged: true,
        timeoutMs: 10_000,
        source: `import { readFileSync } from 'node:fs'
const input = JSON.parse(readFileSync(process.env.AW_EVENT_INPUT_FILE, 'utf8'))
console.log(JSON.stringify({
  protocol: 'aw-event-observer@1',
  cursor: { scanned: true },
  observations: input.subjects.map((subject) => ({
    eventKey: 'issue.changed',
    subjectRef: subject.subjectRef,
    occurredAt: '2026-08-21T08:00:00.000Z',
    sourceEventKey: subject.subjectRef,
    sourceEventRevision: 'revision-7',
    summary: '问题状态已更新',
  })),
}))`,
      },
      eventTypes: [
        {
          eventKey: 'issue.changed',
          subjectTypeId: 'issue',
          payloadSchemaId: 'event.summary',
          displayName: { 'zh-CN': '问题状态更新', 'en-US': 'Issue status changed' },
          description: {
            'zh-CN': '自建问题系统出现了新的稳定版本。',
            'en-US': 'The internal issue system reported a new stable revision.',
          },
          deliveryClass: 'issue.change',
        },
      ],
      fixture: {
        subjects: [{ typeId: 'issue', subjectRef: 'ISSUE-7' }],
        cursorJson: null,
      },
    }
    const created = (await eventCenter.customSources.commands.create(
      { ...draft, fixture: { ...draft.fixture, subjects: [] } },
      'author-1',
    )) as {
      id: string
    }
    expect(created.id).toBe('global-event-1')
    expect(
      (await eventCenter.customSources.queries.get(created.id)).draft.program.templateManaged,
    ).toBe(true)
    await expect(eventCenter.customSources.commands.validate(created.id)).rejects.toThrow(
      'validation needs at least one real test object',
    )
    await eventCenter.customSources.commands.update(created.id, draft)
    await expect(eventCenter.customSources.commands.validate(created.id)).resolves.toMatchObject({
      observationCount: 1,
    })
    const published = (await eventCenter.customSources.commands.publish(
      created.id,
      'author-1',
    )) as { sourceRef: { id: string; revision: number } }
    expect(published.sourceRef).toEqual({ id: created.id, revision: 1 })
    expect(await eventCenter.customSources.queries.list()).toMatchObject([
      { id: created.id, state: 'published', publishedRevision: 1 },
    ])
    const eventTypeRef = {
      id: `custom.${created.id}.issue.changed`,
      revision: 1,
    }
    expect(JSON.parse(await eventCenter.queries.catalog.catalogJson())).toMatchObject({
      sources: [{ sourceRef: published.sourceRef, ownerTypeId: 'event-center.custom' }],
      eventTypes: [{ eventTypeRef, sourceRef: published.sourceRef }],
    })

    const subscriber = { kind: 'system' as const, subscriberRef: 'workflow-runtime-1' }
    const subscription = await eventCenter.participant.subscribe({
      eventTypeRef,
      subject: { typeId: 'issue', subjectRef: 'ISSUE-7' },
      subscriber,
    })
    expect(subscription.observerTransition).toBe('started')
    expect(await eventCenter.worker.runOneDueObserver()).toBe('completed')
    expect(await eventCenter.participant.pendingDeliveries(subscriber, 10)).toMatchObject([
      {
        eventTypeRef,
        deliveryClass: 'issue.change',
        summary: '问题状态已更新',
      },
    ])

    // The script replays the same source key/revision. The Event Center, not
    // the script, owns the final dedupe identity, so no second delivery exists.
    now += 1_000
    expect(await eventCenter.worker.runOneDueObserver()).toBe('completed')
    expect(await eventCenter.participant.pendingDeliveries(subscriber, 10)).toHaveLength(1)

    await eventCenter.customSources.commands.retire(created.id)
    expect(await eventCenter.customSources.queries.list()).toMatchObject([
      { id: created.id, state: 'retired' },
    ])
    await expect(
      eventCenter.participant.subscribe({
        eventTypeRef,
        subject: { typeId: 'issue', subjectRef: 'ISSUE-8' },
        subscriber: { kind: 'system', subscriberRef: 'workflow-runtime-2' },
      }),
    ).rejects.toThrow('event source is retired')
  })
})
