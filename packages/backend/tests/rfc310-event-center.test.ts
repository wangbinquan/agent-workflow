import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'
import { encodeDevelopmentApprovalSubject } from '@/modules/development-automation/public/types'
import { composeEventCenter } from '@/modules/event-center/composition'
import {
  advanceDevelopmentCodeHostObserverCursor,
  buildDevelopmentCodeHostFacts,
  composeDevelopmentApprovalEventObserver,
} from '@/modules/integration/composition/digitalEmployeeEventObserver'
import type { MrFactsSnapshot } from '@/modules/integration/application/mrFacts'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-310 shared Event Center', () => {
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
    expect(first.observations).toHaveLength(1)
    expect(first.observations[0]).toMatchObject({
      eventTypeRef: { id: 'development.approval-updated', revision: 1 },
      subject,
    })
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
    expect(approved.observations).toMatchObject([{ summary: '外部审批状态更新为 approved' }])
  })

  test('polling emits only actionable review/conflict events and lifecycle facts clear old readiness blockers', () => {
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
      'development.pipeline-updated',
    ])

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
        },
        {
          threadRef: 'thread-self',
          revision: '1:2',
          authorClass: 'self' as const,
          resolved: false,
          lastBody: 'platform reply',
          path: null,
        },
      ],
    } satisfies MrFactsSnapshot
    const blockedFacts = buildDevelopmentCodeHostFacts(blocked)
    expect(blockedFacts.map((fact) => fact.eventTypeId)).toEqual([
      'development.lifecycle-updated',
      'development.review-updated',
      'development.conflict-updated',
      'development.pipeline-updated',
    ])
    expect(blockedFacts[0]!.payload).toMatchObject({
      mergeableState: 'conflict',
      unresolvedReviewCount: 1,
      reviewDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(cleanFacts[0]!.payload).toMatchObject({
      mergeableState: 'mergeable',
      unresolvedReviewCount: 0,
    })
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
      'development.pipeline-updated',
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
      'development.pipeline-updated',
    ])
    expect(
      advance(first.cursorJson, clean, 'unused').changes.map((change) => change.fact.eventTypeId),
    ).toEqual(['development.pipeline-updated'])

    const blockedFirst = advance(first.cursorJson, blocked, 'unused')
    expect(blockedFirst.changes.map((change) => change.fact.eventTypeId)).toEqual([
      'development.lifecycle-updated',
      'development.review-updated',
      'development.conflict-updated',
      'development.pipeline-updated',
    ])
    const blockedKeys = blockedFirst.changes.map((change) => change.dedupeKey)
    const cleanAgain = advance(blockedFirst.cursorJson, clean, 'unused')
    const blockedAgain = advance(cleanAgain.cursorJson, blocked, 'unused')
    expect(blockedAgain.changes.map((change) => change.fact.eventTypeId)).toEqual([
      'development.lifecycle-updated',
      'development.review-updated',
      'development.conflict-updated',
      'development.pipeline-updated',
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
      'development.pipeline-updated',
    ])
    expect(changed.changes[0]!.dedupeKey).not.toBe(first.changes[0]!.dedupeKey)
  })

  test('subscriptions activate a short observer, baseline scan dedupes with webhook, and zero subscribers stop it', async () => {
    const now = 10_000
    let ordinal = 0
    const calls: Array<{ cursorJson: string | null; subjects: readonly string[] }> = []
    const eventCenter = composeEventCenter({
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
                eventTypeRef: { id: 'development.pipeline-updated', revision: 1 },
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
    const pipelineSubscription = eventCenter.participant.subscribe({
      eventTypeRef: { id: 'development.pipeline-updated', revision: 1 },
      subject,
      subscriber,
    })
    expect(pipelineSubscription.created).toBe(true)
    expect(pipelineSubscription.observerTransition).toBe('started')
    expect(
      eventCenter.participant.subscribe({
        eventTypeRef: { id: 'development.pipeline-updated', revision: 1 },
        subject,
        subscriber,
      }),
    ).toEqual({ ...pipelineSubscription, created: false, observerTransition: 'none' })
    expect(eventCenter.queries.observerHealth()).toMatchObject([
      { subscriberCount: 1, state: 'active', nextScanAt: now },
    ])

    expect(await eventCenter.worker.runOneDueObserver()).toBe('completed')
    expect(calls).toEqual([{ cursorJson: null, subjects: ['mr-1'] }])
    const delivery = eventCenter.participant.pendingDeliveries(subscriber, 10)
    expect(delivery).toHaveLength(1)
    expect(delivery[0]).toMatchObject({
      deliveryClass: 'pipeline',
      priority: 700,
      payloadArtifactRef: '.agent-workflow/pipeline/bundle-42/manifest.json',
    })

    const duplicate = eventCenter.participant.observe({
      sourceRef: { id: 'development.code-host-state', revision: 1 },
      eventTypeRef: { id: 'development.pipeline-updated', revision: 1 },
      subject,
      occurredAt: now,
      dedupeKey: 'pipeline:mr-1:head-a:42',
      summary: '同一流水线 webhook',
      payloadArtifactRef: null,
    })
    expect(duplicate.duplicate).toBe(true)
    expect(eventCenter.participant.pendingDeliveries(subscriber, 10)).toHaveLength(1)
    eventCenter.participant.acceptDelivery(delivery[0]!.deliveryId)
    expect(eventCenter.participant.pendingDeliveries(subscriber, 10)).toEqual([])

    expect(eventCenter.participant.unsubscribe(pipelineSubscription.subscriptionId)).toMatchObject({
      observerTransition: 'stopped',
    })
    expect(await eventCenter.worker.runOneDueObserver()).toBe('idle')
    expect(eventCenter.queries.observerHealth()).toMatchObject([
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
    const eventCenter = composeEventCenter({
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
    const subscription = eventCenter.participant.subscribe({
      eventTypeRef: { id: 'development.pipeline-updated', revision: 1 },
      subject: { typeId: 'merge-request', subjectRef: 'repo-1!42' },
      subscriber: { kind: 'employee-case', subscriberRef: 'case-1' },
    })

    const firstRun = eventCenter.worker.runOneDueObserver()
    await firstStarted
    now += 25
    expect(
      eventCenter.observerControl.nudgeSource({
        id: 'development.code-host-state',
        revision: 1,
      }),
    ).toBe(true)
    releaseFirst()
    expect(await firstRun).toBe('completed')
    expect(eventCenter.queries.observerHealth()[0]?.nextScanAt).toBe(now)
    expect(await eventCenter.worker.runOneDueObserver()).toBe('completed')
    expect(runs).toBe(2)

    eventCenter.participant.unsubscribe(subscription.subscriptionId)
    expect(
      eventCenter.observerControl.nudgeSource({
        id: 'development.code-host-state',
        revision: 1,
      }),
    ).toBe(false)
  })

  test('observer batches rotate so subjects beyond one batch are not starved', async () => {
    let now = 20_000
    let ordinal = 0
    const batches: string[][] = []
    const eventCenter = composeEventCenter({
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
      eventCenter.participant.subscribe({
        eventTypeRef: { id: 'development.pipeline-updated', revision: 1 },
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

  test('a late subscriber receives the latest durable event for its exact subject', () => {
    let ordinal = 0
    const eventCenter = composeEventCenter({
      db: createInMemoryDb(MIGRATIONS),
      typePackageDescriptorJsons: [developmentEmployeeTypePackage.descriptorJson],
      now: () => 30_000,
      id: () => `replay-resource-${++ordinal}`,
    })
    const subject = { typeId: 'employee-invocation', subjectRef: 'invocation-1' }
    eventCenter.participant.observe({
      sourceRef: { id: 'employee.channel', revision: 1 },
      eventTypeRef: { id: 'development.employee-result', revision: 1 },
      subject,
      occurredAt: 29_000,
      dedupeKey: 'employee-result:invocation-1:completed',
      summary: '子数字员工已完成',
      payloadArtifactRef: null,
    })
    const subscriber = { kind: 'employee-case' as const, subscriberRef: 'parent-case' }
    eventCenter.participant.subscribe({
      eventTypeRef: { id: 'development.employee-result', revision: 1 },
      subject,
      subscriber,
    })
    expect(eventCenter.participant.pendingDeliveries(subscriber, 10)).toMatchObject([
      {
        eventTypeRef: { id: 'development.employee-result', revision: 1 },
        subject,
        summary: '子数字员工已完成',
      },
    ])
  })

  test('one case queue receives higher-priority lifecycle events before pipeline events', () => {
    let ordinal = 0
    const eventCenter = composeEventCenter({
      db: createInMemoryDb(MIGRATIONS),
      typePackageDescriptorJsons: [developmentEmployeeTypePackage.descriptorJson],
      now: () => 20_000,
      id: () => `event-resource-${++ordinal}`,
    })
    const subscriber = { kind: 'employee-case' as const, subscriberRef: 'case-2' }
    const subject = { typeId: 'merge-request', subjectRef: 'mr-2' }
    for (const eventTypeId of ['development.pipeline-updated', 'development.lifecycle-updated']) {
      eventCenter.participant.subscribe({
        eventTypeRef: { id: eventTypeId, revision: 1 },
        subject,
        subscriber,
      })
    }
    eventCenter.participant.observe({
      sourceRef: { id: 'development.code-host-state', revision: 1 },
      eventTypeRef: { id: 'development.pipeline-updated', revision: 1 },
      subject,
      occurredAt: 19_000,
      dedupeKey: 'pipeline:mr-2:1',
      summary: '流水线失败',
      payloadArtifactRef: null,
    })
    eventCenter.participant.observe({
      sourceRef: { id: 'development.code-host-state', revision: 1 },
      eventTypeRef: { id: 'development.lifecycle-updated', revision: 1 },
      subject,
      occurredAt: 19_500,
      dedupeKey: 'lifecycle:mr-2:merged',
      summary: 'MR 已合入',
      payloadArtifactRef: null,
    })

    expect(
      eventCenter.participant
        .pendingDeliveries(subscriber, 10)
        .map((delivery) => delivery.eventTypeRef.id),
    ).toEqual(['development.lifecycle-updated', 'development.pipeline-updated'])
  })
})
