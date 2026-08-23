import { randomUUID } from 'node:crypto'

import { canonicalJson } from '@agent-workflow/shared'
import { z } from 'zod'

import { sha256Hex } from '@/util/hash'
import {
  DEVELOPMENT_APPROVAL_STATUS_CHANGED_EVENT_REF,
  decodeDevelopmentApprovalSubject,
  type DevelopmentApprovalSubject,
} from '@/modules/development-automation/public/types'
import { collectMergeRequestFacts, type MrFactsSnapshot } from '../application/mrFacts'
import type { MrEnsureConnectionDeps } from '../application/mrEnsure'

interface ObserverSource {
  readonly sourceRef: { readonly id: string; readonly revision: number }
}

interface ObserverSubject {
  readonly typeId: string
  readonly subjectRef: string
}

function splitMrSubject(subjectRef: string): { repositoryId: string; mrRef: string } | null {
  const separator = subjectRef.lastIndexOf('!')
  if (separator <= 0 || separator === subjectRef.length - 1) return null
  return { repositoryId: subjectRef.slice(0, separator), mrRef: subjectRef.slice(separator + 1) }
}

export function buildDevelopmentCodeHostFacts(snapshot: MrFactsSnapshot) {
  const review = snapshot.threads.map((thread) => ({
    threadRef: thread.threadRef,
    revision: thread.revision,
    authorClass: thread.authorClass,
    resolved: thread.resolved,
    path: thread.path,
    body: thread.lastBody.slice(0, 1_000),
  }))
  const unresolvedReview = review.filter(
    (thread) => !thread.resolved && thread.authorClass !== 'self',
  )
  const lifecycle = {
    state: snapshot.state,
    headSha: snapshot.headSha,
    targetSha: snapshot.targetSha,
    mergedCommitSha: snapshot.mergedCommitSha,
    draft: snapshot.draft,
    mergeableState: snapshot.mergeableState,
    approvalHold: snapshot.approvalHold,
    unresolvedReviewCount: unresolvedReview.length,
    reviewDigest: sha256Hex(canonicalJson(snapshot.threads)),
  }
  const lifecycleFact = {
    eventTypeId: 'development.lifecycle-updated',
    payload: lifecycle,
    summary:
      snapshot.state === 'merged'
        ? 'MR 已由 committer 合入'
        : snapshot.state === 'closed'
          ? 'MR 已关闭'
          : 'MR 生命周期与可合入事实已刷新',
  } as const
  if (snapshot.state !== 'opened' || snapshot.headSha === null) return [lifecycleFact] as const
  return [
    lifecycleFact,
    ...(unresolvedReview.length === 0
      ? []
      : [
          {
            eventTypeId: 'development.review-updated',
            payload: review,
            summary: [
              `MR 检视意见已刷新：${unresolvedReview.length} 条待处理`,
              ...unresolvedReview
                .slice(0, 5)
                .map(
                  (thread) =>
                    `${thread.threadRef}${thread.path === null ? '' : ` @ ${thread.path}`}: ${thread.body.slice(0, 280)}`,
                ),
            ]
              .join('\n')
              .slice(0, 2_000),
          },
        ]),
    ...(snapshot.mergeableState !== 'conflict' || snapshot.targetSha === null
      ? []
      : [
          {
            eventTypeId: 'development.conflict-updated',
            payload: {
              headSha: snapshot.headSha,
              targetSha: snapshot.targetSha,
              mergeableState: snapshot.mergeableState,
            },
            summary: 'MR 存在代码冲突',
          },
        ]),
    {
      eventTypeId: 'development.pipeline-check-due',
      payload: { headSha: snapshot.headSha },
      summary: 'MR 门禁主动复核周期已到达',
    },
  ] as const
}

type DevelopmentCodeHostFact = ReturnType<typeof buildDevelopmentCodeHostFacts>[number]
type CursorFactCode = 'l' | 'r' | 'c' | 'p'

const cursorFactCodeByEventType = {
  'development.lifecycle-updated': 'l',
  'development.review-updated': 'r',
  'development.conflict-updated': 'c',
  'development.pipeline-check-due': 'p',
} as const satisfies Record<DevelopmentCodeHostFact['eventTypeId'], CursorFactCode>

const codeHostFactRevisionByEventType = {
  'development.lifecycle-updated': 2,
  'development.review-updated': 2,
  'development.conflict-updated': 2,
  'development.pipeline-check-due': 1,
} as const satisfies Record<DevelopmentCodeHostFact['eventTypeId'], number>

function codeHostFactRevision(eventTypeId: string): number {
  const revision = (codeHostFactRevisionByEventType as Readonly<Record<string, number>>)[
    eventTypeId
  ]
  if (revision === undefined) throw new Error(`unknown development code-host fact: ${eventTypeId}`)
  return revision
}

const observerCursorEntrySchema = z
  .object({
    d: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    s: z.number().int().nonnegative(),
  })
  .strict()

const observerCursorSubjectSchema = z
  .object({
    l: observerCursorEntrySchema.optional(),
    r: observerCursorEntrySchema.optional(),
    c: observerCursorEntrySchema.optional(),
    p: observerCursorEntrySchema.optional(),
  })
  .strict()

const observerCursorSchema = z
  .object({
    schemaVersion: z.literal(1),
    activationRef: z.string().min(1).max(200),
    subjects: z.record(observerCursorSubjectSchema),
  })
  .strict()

export function advanceDevelopmentCodeHostObserverCursor(input: {
  readonly cursorJson: string | null
  readonly activationRef: () => string
  readonly factsBySubject: readonly {
    readonly subjectRef: string
    readonly facts: readonly DevelopmentCodeHostFact[]
  }[]
}) {
  const previous =
    input.cursorJson === null
      ? { schemaVersion: 1 as const, activationRef: input.activationRef(), subjects: {} }
      : observerCursorSchema.parse(JSON.parse(input.cursorJson) as unknown)
  const subjects: Record<
    string,
    Partial<Record<CursorFactCode, { d: string | null; s: number }>>
  > = { ...previous.subjects }
  const changes: Array<{
    subjectRef: string
    fact: DevelopmentCodeHostFact
    dedupeKey: string
  }> = []

  for (const group of input.factsBySubject) {
    const subjectKey = sha256Hex(group.subjectRef)
    const priorSubject = previous.subjects[subjectKey]
    const nextSubject: Partial<Record<CursorFactCode, { d: string | null; s: number }>> = {}
    for (const [eventTypeId, code] of Object.entries(cursorFactCodeByEventType) as Array<
      [DevelopmentCodeHostFact['eventTypeId'], CursorFactCode]
    >) {
      const fact = group.facts.find((candidate) => candidate.eventTypeId === eventTypeId)
      const prior = priorSubject?.[code]
      if (fact === undefined) {
        if (prior !== undefined) nextSubject[code] = { d: null, s: prior.s }
        continue
      }
      const digest = sha256Hex(canonicalJson(fact.payload))
      const periodicRefresh = eventTypeId === 'development.pipeline-check-due'
      if (!periodicRefresh && prior?.d === digest) {
        nextSubject[code] = prior
        continue
      }
      const sequence = (prior?.s ?? 0) + 1
      nextSubject[code] = { d: digest, s: sequence }
      changes.push({
        subjectRef: group.subjectRef,
        fact,
        dedupeKey: `development-observer:${sha256Hex(
          canonicalJson({
            activationRef: previous.activationRef,
            subjectRef: group.subjectRef,
            eventTypeId,
            sequence,
            digest,
          }),
        )}`,
      })
    }
    subjects[subjectKey] = nextSubject
  }

  const cursor = observerCursorSchema.parse({ ...previous, subjects })
  return { cursorJson: JSON.stringify(cursor), changes }
}

export function composeDevelopmentCodeHostEventObserver(input: {
  readonly binding: (repositoryId: string) => MrEnsureConnectionDeps | null
  readonly now?: () => number
  readonly activationRef?: () => string
}) {
  const now = input.now ?? Date.now
  const activationRef = input.activationRef ?? randomUUID
  return {
    async run(request: {
      readonly source: ObserverSource
      readonly subjects: readonly ObserverSubject[]
      readonly cursorJson: string | null
    }) {
      if (request.source.sourceRef.id !== 'code-host.activity') {
        return { schemaVersion: 1 as const, cursorJson: request.cursorJson, observations: [] }
      }
      const observations: Array<{
        sourceRef: { id: string; revision: number }
        eventTypeRef: { id: string; revision: number }
        subject: ObserverSubject
        occurredAt: number
        dedupeKey: string
        summary: string
        payloadArtifactRef: null
      }> = []
      const factsBySubject: Array<{
        subject: ObserverSubject
        facts: ReturnType<typeof buildDevelopmentCodeHostFacts>
      }> = []
      for (const subject of request.subjects) {
        if (subject.typeId !== 'merge-request') continue
        const parsed = splitMrSubject(subject.subjectRef)
        if (parsed === null) throw new Error(`invalid merge-request subject: ${subject.subjectRef}`)
        const binding = input.binding(parsed.repositoryId)
        if (binding === null) {
          throw new Error(`no code-host connection for repository ${parsed.repositoryId}`)
        }
        const collected = await collectMergeRequestFacts(binding, parsed.mrRef, {
          selfMarker: subject.subjectRef,
          trustPlatformSelfMarkers: true,
        })
        if (!collected.ok) {
          throw new Error(`${collected.code}: ${collected.detail}`)
        }
        const snapshot = collected.snapshot
        const facts = buildDevelopmentCodeHostFacts(snapshot)
        factsBySubject.push({ subject, facts })
      }
      const advanced = advanceDevelopmentCodeHostObserverCursor({
        cursorJson: request.cursorJson,
        activationRef,
        factsBySubject: factsBySubject.map(({ subject, facts }) => ({
          subjectRef: subject.subjectRef,
          facts,
        })),
      })
      const subjectsByRef = new Map(
        factsBySubject.map(({ subject }) => [subject.subjectRef, subject] as const),
      )
      const occurredAt = now()
      for (const change of advanced.changes) {
        const subject = subjectsByRef.get(change.subjectRef)
        if (subject === undefined)
          throw new Error(`observer subject disappeared: ${change.subjectRef}`)
        observations.push({
          sourceRef: request.source.sourceRef,
          eventTypeRef: {
            id: change.fact.eventTypeId,
            revision: codeHostFactRevision(change.fact.eventTypeId),
          },
          subject,
          occurredAt,
          dedupeKey: change.dedupeKey,
          summary: change.fact.summary,
          payloadArtifactRef: null,
        })
      }
      return {
        schemaVersion: 1 as const,
        cursorJson: advanced.cursorJson,
        observations,
      }
    },
  }
}

const approvalObserverCursorSchema = z
  .object({
    schemaVersion: z.literal(1),
    subjects: z.record(
      z
        .object({
          digest: z.string().regex(/^[a-f0-9]{64}$/),
          sequence: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict()

interface DevelopmentApprovalObservationGateway {
  observe(input: DevelopmentApprovalSubject): Promise<
    | {
        readonly ok: true
        readonly receipt: {
          readonly status: 'pending' | 'approved' | 'rejected' | 'expired' | 'unavailable'
        }
      }
    | {
        readonly ok: false
        readonly failure: { readonly code: string; readonly remediation: string }
      }
  >
}

export function composeDevelopmentApprovalEventObserver(input: {
  readonly gateway: DevelopmentApprovalObservationGateway
  readonly now?: () => number
}) {
  const now = input.now ?? Date.now
  return {
    async run(request: {
      readonly source: ObserverSource
      readonly subjects: readonly ObserverSubject[]
      readonly cursorJson: string | null
    }) {
      if (request.source.sourceRef.id !== 'development.approval-state') {
        return { schemaVersion: 1 as const, cursorJson: request.cursorJson, observations: [] }
      }
      const previous =
        request.cursorJson === null
          ? { schemaVersion: 1 as const, subjects: {} }
          : approvalObserverCursorSchema.parse(JSON.parse(request.cursorJson) as unknown)
      const subjects = { ...previous.subjects }
      const observations: Array<{
        sourceRef: { id: string; revision: number }
        eventTypeRef: { id: string; revision: number }
        subject: ObserverSubject
        occurredAt: number
        dedupeKey: string
        summary: string
        payloadArtifactRef: null
        triggerParameters?: { subject_ref: string }
      }> = []
      for (const subject of request.subjects) {
        if (subject.typeId !== 'external-approval') continue
        const parsed = decodeDevelopmentApprovalSubject(subject.subjectRef)
        if (parsed === null)
          throw new Error(`invalid external-approval subject: ${subject.subjectRef}`)
        const observed = await input.gateway.observe(parsed)
        if (!observed.ok) {
          throw new Error(`${observed.failure.code}: ${observed.failure.remediation}`)
        }
        const digest = sha256Hex(canonicalJson(observed.receipt))
        const key = sha256Hex(subject.subjectRef)
        const prior = previous.subjects[key]
        if (prior?.digest === digest) continue
        const sequence = (prior?.sequence ?? 0) + 1
        subjects[key] = { digest, sequence }
        const occurredAt = now()
        const summary =
          observed.receipt.status === 'pending'
            ? '外部审批仍在等待处理'
            : `外部审批状态更新为 ${observed.receipt.status}`
        observations.push({
          sourceRef: request.source.sourceRef,
          eventTypeRef: { id: 'development.approval-updated', revision: 1 },
          subject,
          occurredAt,
          dedupeKey: `development-approval-observer:${key}:${sequence}:${digest}`,
          summary,
          payloadArtifactRef: null,
        })
        observations.push({
          sourceRef: request.source.sourceRef,
          eventTypeRef: DEVELOPMENT_APPROVAL_STATUS_CHANGED_EVENT_REF,
          subject,
          occurredAt,
          dedupeKey: `approval-status-changed:${key}:${sequence}:${digest}`,
          summary,
          payloadArtifactRef: null,
          triggerParameters: { subject_ref: subject.subjectRef },
        })
      }
      return {
        schemaVersion: 1 as const,
        cursorJson: JSON.stringify(approvalObserverCursorSchema.parse({ ...previous, subjects })),
        observations,
      }
    },
  }
}

export function composeDevelopmentEmployeeEventObserver(input: {
  readonly codeHost: ReturnType<typeof composeDevelopmentCodeHostEventObserver>
  readonly approval: ReturnType<typeof composeDevelopmentApprovalEventObserver>
}) {
  return {
    run(request: {
      readonly source: ObserverSource
      readonly subjects: readonly ObserverSubject[]
      readonly cursorJson: string | null
    }) {
      return request.source.sourceRef.id === 'development.approval-state'
        ? input.approval.run(request)
        : input.codeHost.run(request)
    },
  }
}
