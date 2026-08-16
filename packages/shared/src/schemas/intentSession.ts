// RFC-234 §6 (T7) — intent-session HTTP wire schemas.
//
// Sessions are creator-private (+ `intent:audit` read); every mutating request
// is validated here at the route boundary and re-authorized per-row in
// services/intent/*. The commit request carries the exact confirmed draft
// identity (revision + sha-256 hash) plus per-op decisions that may only
// address SERVER-ISSUED slots (design §9.3).

import { z } from 'zod'
import { AclResourceTypeSchema, INTENT_RESOURCE_TYPES } from './resourceAcl'

export const INTENT_MESSAGE_MAX = 16 * 1024

export const CreateIntentSessionSchema = z
  .object({
    message: z.string().min(1).max(INTENT_MESSAGE_MAX),
    /** Optional free-text nudge about the desired artifact kind(s). */
    hint: z.string().max(200).optional(),
    /**
     * Mounts applied BEFORE the first generation turn fires (RFC-234 T13:
     * the modify entry must not race the auto-started turn — a post-create
     * mount POST would 409 against `intent-turn-in-flight` and the first
     * generation would run blind to its target).
     */
    mounts: z
      .array(
        z
          .object({ resourceType: z.enum(INTENT_RESOURCE_TYPES), resourceId: z.string().min(1) })
          .strict(),
      )
      .max(16)
      .optional(),
  })
  .strict()
export type CreateIntentSession = z.infer<typeof CreateIntentSessionSchema>

export const PostIntentMessageSchema = z
  .object({ message: z.string().min(1).max(INTENT_MESSAGE_MAX) })
  .strict()
export type PostIntentMessage = z.infer<typeof PostIntentMessageSchema>

export const IntentAnswerSchema = z
  .object({
    id: z.string().min(1).max(64),
    picked: z.array(z.string().min(1).max(512)).min(1).max(8),
    other: z.string().max(2048).optional(),
  })
  .strict()
export const PostIntentAnswersSchema = z
  .object({ answers: z.array(IntentAnswerSchema).min(1).max(5) })
  .strict()
export type PostIntentAnswers = z.infer<typeof PostIntentAnswersSchema>

/**
 * A reference to a resource an Intent session can mount or has produced.
 *
 * `INTENT_RESOURCE_TYPES`, not the full ACL set. RFC-304 added two ACL resource
 * types the intent flow cannot handle at all — no list endpoint, no dump
 * format, and `intent_provenance` has no room for the value — so accepting
 * them here would only move the failure somewhere with a worse message.
 */
export const IntentMountRefSchema = z
  .object({
    resourceType: z.enum(INTENT_RESOURCE_TYPES),
    resourceId: z.string().min(1).max(128),
  })
  .strict()
export type IntentMountRefWire = z.infer<typeof IntentMountRefSchema>

/** The same shape; provenance lookups ask about the same set. */
export const IntentProvenanceRefSchema = IntentMountRefSchema

/** RFC-235 v22 — every suggestion decision is bound to the exact agent turn
 *  and context the user reviewed. The concrete resource id is server-checked
 *  against that request's type/name inside the final transaction. */
export const IntentMountSuggestionDecisionSchema = z.discriminatedUnion('action', [
  z
    .object({
      resourceType: AclResourceTypeSchema,
      name: z.string().min(1).max(200),
      action: z.literal('approve'),
      resourceId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      resourceType: AclResourceTypeSchema,
      name: z.string().min(1).max(200),
      action: z.literal('reject'),
    })
    .strict(),
])
export type IntentMountSuggestionDecision = z.infer<typeof IntentMountSuggestionDecisionSchema>

export const PostIntentMountApprovalsSchema = z
  .object({
    sourceTurnId: z.string().min(1).max(128),
    expectedTurnSeq: z.number().int().min(1),
    expectedContextRevision: z.number().int().min(0),
    decisions: z.array(IntentMountSuggestionDecisionSchema).min(1).max(16),
  })
  .strict()
export type PostIntentMountApprovals = z.infer<typeof PostIntentMountApprovalsSchema>

// RFC-293 — one staged working-context update. This is deliberately a plain
// product delta: runtime capabilities and provider configuration do not belong
// to this contract.
export const IntentWorkingSetDeltaSchema = z
  .object({
    additions: z.array(IntentMountRefSchema).default([]),
    removals: z.array(z.string().min(1).max(128)).default([]),
  })
  .strict()
  .superRefine((delta, ctx) => {
    const additions = new Set<string>()
    for (const [index, addition] of delta.additions.entries()) {
      const key = `${addition.resourceType}\u0000${addition.resourceId}`
      if (additions.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['additions', index],
          message: 'duplicate working-context addition',
        })
      }
      additions.add(key)
    }
    const removals = new Set<string>()
    for (const [index, handle] of delta.removals.entries()) {
      if (removals.has(handle)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['removals', index],
          message: 'duplicate working-context removal',
        })
      }
      removals.add(handle)
    }
  })
export type IntentWorkingSetDelta = z.infer<typeof IntentWorkingSetDeltaSchema>

export const IntentWorkingSetChangeModeSchema = z.enum(['after-current', 'interrupt'])
export const IntentWorkingSetChangeStateSchema = z.enum([
  'queued',
  'applying',
  'applied',
  'failed',
  'canceled',
])

export const PostIntentWorkingSetChangeSchema = z
  .object({
    clientMutationId: z.string().min(10).max(64),
    expectedTurnSeq: z.number().int().min(0),
    expectedContextRevision: z.number().int().min(0),
    mode: IntentWorkingSetChangeModeSchema,
    replacesChangeId: z.string().min(1).max(128).optional(),
    delta: IntentWorkingSetDeltaSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.delta.additions.length === 0 && value.delta.removals.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['delta'],
        message: 'working-context delta must not be empty',
      })
    }
  })
export type PostIntentWorkingSetChange = z.infer<typeof PostIntentWorkingSetChangeSchema>

export const IntentWorkingSetChangeDtoSchema = z
  .object({
    id: z.string(),
    mode: IntentWorkingSetChangeModeSchema,
    state: IntentWorkingSetChangeStateSchema,
    delta: IntentWorkingSetDeltaSchema,
    expectedTurnSeq: z.number().int().min(0),
    expectedContextRevision: z.number().int().min(0),
    resultingContextRevision: z.number().int().min(0).nullable(),
    resultingTurnId: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .strict()
export type IntentWorkingSetChangeDto = z.infer<typeof IntentWorkingSetChangeDtoSchema>

const IntentIterationFenceSchema = z
  .object({
    clientMutationId: z.string().min(10).max(64),
    expectedTurnSeq: z.number().int().min(0),
    expectedContextRevision: z.number().int().min(0),
  })
  .strict()

export const PostIntentIterationSchema = z.discriminatedUnion('mode', [
  IntentIterationFenceSchema.extend({
    mode: z.literal('refine-current'),
    sourceDraftId: z.string().min(1).max(128),
    sourceDraftHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    feedback: z.string().trim().min(1).max(INTENT_MESSAGE_MAX),
  }).strict(),
  IntentIterationFenceSchema.extend({
    mode: z.literal('continue-checkpoint'),
    sourceCommitSeq: z.number().int().min(1),
    feedback: z.string().trim().min(1).max(INTENT_MESSAGE_MAX),
  }).strict(),
  IntentIterationFenceSchema.extend({
    mode: z.literal('regenerate'),
    sourceDraftId: z.string().min(1).max(128),
    sourceDraftHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }).strict(),
])
export type PostIntentIteration = z.infer<typeof PostIntentIterationSchema>

export const IntentGenerationReceiptSchema = z
  .object({
    userTurnId: z.string(),
    agentTurnId: z.string(),
    replayed: z.boolean(),
  })
  .strict()
export type IntentGenerationReceipt = z.infer<typeof IntentGenerationReceiptSchema>

export const PostIntentCurrentActionSchema = z
  .object({
    clientMutationId: z.string().min(10).max(64),
    sourceTurnId: z.string().min(1).max(128),
    expectedTurnSeq: z.number().int().min(1),
    expectedContextRevision: z.number().int().min(0),
    answers: z.array(IntentAnswerSchema).default([]),
    decisions: z.array(IntentMountSuggestionDecisionSchema).default([]),
  })
  .strict()
export type PostIntentCurrentAction = z.infer<typeof PostIntentCurrentActionSchema>

export const PostIntentRetrySchema = z
  .object({
    clientMutationId: z.string().min(10).max(64),
    sourceTurnId: z.string().min(1).max(128),
    expectedTurnSeq: z.number().int().min(1),
    expectedContextRevision: z.number().int().min(0),
  })
  .strict()
export type PostIntentRetry = z.infer<typeof PostIntentRetrySchema>

export const IntentDecisionSlotSchema = z
  .object({ slotId: z.string().min(1).max(256), value: z.string().max(8192) })
  .strict()
export const IntentCommitDecisionSchema = z
  .object({
    opId: z.string().min(1).max(16),
    applyMode: z.enum(['modify', 'copy']).optional(),
    slots: z.array(IntentDecisionSlotSchema).max(64).optional(),
  })
  .strict()
export const CommitIntentSchema = z
  .object({
    clientMutationId: z.string().min(10).max(64),
    draftRevision: z.number().int().min(1),
    draftHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    decisions: z.array(IntentCommitDecisionSchema).max(64).default([]),
  })
  .strict()
export type CommitIntent = z.infer<typeof CommitIntentSchema>

// ── response DTOs ──

export const IntentJourneyKindSchema = z.enum([
  'goal',
  'generating',
  'clarifying',
  'review-ready',
  'review-blocked',
  'applying',
  'applied',
  'error',
  'archived',
])
export type IntentJourneyKind = z.infer<typeof IntentJourneyKindSchema>

export const IntentJourneyReasonSchema = z.enum([
  'describe-goal',
  'generation-running',
  'working-set-queued',
  'working-set-applying',
  'working-set-failed',
  'draft-refining',
  'draft-regenerating',
  'generation-retrying',
  'answer-questions',
  'review-draft',
  'draft-stale',
  'draft-invalid',
  'apply-running',
  'generation-failed',
  'apply-failed',
  'applied',
  'checkpoint-ready',
  'archived',
])
export type IntentJourneyReason = z.infer<typeof IntentJourneyReasonSchema>

const ACTIVE_INTENT_JOURNEY_TUPLES = new Set([
  'goal:1:0:describe-goal',
  'generating:2:1:generation-running',
  'generating:2:1:working-set-queued',
  'generating:2:1:working-set-applying',
  'generating:2:1:draft-refining',
  'generating:2:1:draft-regenerating',
  'generating:2:1:generation-retrying',
  'clarifying:2:1:answer-questions',
  'review-ready:3:2:review-draft',
  'review-blocked:3:2:draft-stale',
  'review-blocked:3:2:draft-invalid',
  'applying:4:3:apply-running',
  'applied:4:4:applied',
  'error:2:1:generation-failed',
  'error:2:1:working-set-failed',
  'error:4:3:apply-failed',
  'applied:4:4:checkpoint-ready',
])
const ARCHIVED_INTENT_JOURNEY_POSITIONS = new Set(['1:0', '2:1', '3:2', '4:3', '4:4'])

export const IntentJourneySnapshotSchema = z
  .object({
    kind: IntentJourneyKindSchema,
    step: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    completedThrough: z.union([
      z.literal(0),
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
    ]),
    reason: IntentJourneyReasonSchema,
  })
  .strict()
  .superRefine((journey, ctx) => {
    const valid =
      journey.kind === 'archived'
        ? journey.reason === 'archived' &&
          ARCHIVED_INTENT_JOURNEY_POSITIONS.has(`${journey.step}:${journey.completedThrough}`)
        : ACTIVE_INTENT_JOURNEY_TUPLES.has(
            `${journey.kind}:${journey.step}:${journey.completedThrough}:${journey.reason}`,
          )
    if (!valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'intent journey fields do not describe one canonical state',
      })
    }
  })
export type IntentJourneySnapshot = z.infer<typeof IntentJourneySnapshotSchema>

export const IntentSessionSummarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.enum(['active', 'archived']),
    contextRevision: z.number().int(),
    turnSeq: z.number().int(),
    commitSeq: z.number().int(),
    inFlight: z.boolean(),
    currentDraftRevision: z.number().int().nullable(),
    journey: IntentJourneySnapshotSchema,
    /** Present only on the cross-owner audit list. */
    ownerUserId: z.string().optional(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .strict()
export type IntentSessionSummary = z.infer<typeof IntentSessionSummarySchema>

export const IntentSessionListPageSchema = z
  .object({
    items: z.array(IntentSessionSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
export type IntentSessionListPage = z.infer<typeof IntentSessionListPageSchema>

export const IntentTurnExecutionDtoSchema = z
  .object({
    captureState: z.enum(['live', 'complete', 'truncated', 'incomplete']),
    lastEventSeq: z.number().int().min(0),
    eventBytes: z.number().int().min(0),
    rootSessionId: z.string().nullable(),
    incompleteReason: z
      .enum([
        'stream-persist-failed',
        'stream-frame-limit-exceeded',
        'child-capture-failed',
        'post-exit-flush-timeout',
      ])
      .nullable(),
  })
  .strict()
export type IntentTurnExecutionDto = z.infer<typeof IntentTurnExecutionDtoSchema>

export const IntentTurnDtoSchema = z
  .object({
    id: z.string(),
    seq: z.number().int(),
    role: z.enum(['user', 'agent']),
    kind: z.enum([
      'message',
      'answers',
      'mount-approval',
      'running',
      'questions',
      'changeset',
      'error',
    ]),
    content: z.record(z.string(), z.unknown()),
    contextRevision: z.number().int(),
    runMeta: z.record(z.string(), z.unknown()).nullable(),
    /** Whether this failed turn's private scratch is still retained for bounded diagnosis. */
    scratchRetained: z.boolean(),
    /** Null for user/legacy turns; populated from reservation for new agent turns. */
    execution: IntentTurnExecutionDtoSchema.nullable(),
    createdAt: z.number().int(),
  })
  .strict()
export type IntentTurnDto = z.infer<typeof IntentTurnDtoSchema>

export const IntentSlotDtoSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('secret'),
      slotId: z.string(),
      opId: z.string(),
      jsonPointer: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('secretWaiver'),
      slotId: z.string(),
      opId: z.string(),
      jsonPointer: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('humanBinding'),
      slotId: z.string(),
      opId: z.string(),
      displayName: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal('finalName'), slotId: z.string(), opId: z.string() }).strict(),
])
export type IntentSlotDto = z.infer<typeof IntentSlotDtoSchema>

export const IntentDraftLifecycleSchema = z.enum([
  'current',
  'committed',
  'superseded',
  'discarded',
])
export const IntentDraftActivitySchema = z.enum(['idle', 'generating'])

export const IntentDraftDtoSchema = z
  .object({
    id: z.string(),
    revision: z.number().int(),
    changeset: z.unknown(),
    validation: z
      .object({
        errors: z.array(z.string()),
        credentialFindings: z.array(
          z
            .object({
              opId: z.string(),
              jsonPointer: z.string(),
              kind: z.string(),
              excerpt: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
    slots: z.array(IntentSlotDtoSchema),
    draftHash: z.string(),
    contextRevision: z.number().int(),
    /** True when the session epoch moved past this draft (commit disabled). */
    stale: z.boolean(),
    lifecycle: IntentDraftLifecycleSchema,
    activity: IntentDraftActivitySchema,
    commitSeq: z.number().int().min(1).nullable(),
    createdAt: z.number().int(),
  })
  .strict()
export type IntentDraftDto = z.infer<typeof IntentDraftDtoSchema>

export const IntentComposerSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('conversation') }).strict(),
  z
    .object({
      kind: z.literal('current-draft'),
      draftId: z.string(),
      revision: z.number().int().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('latest-checkpoint'),
      commitSeq: z.number().int().min(1),
    })
    .strict(),
])
export type IntentComposerSource = z.infer<typeof IntentComposerSourceSchema>

export const IntentRetrySourceSchema = z
  .object({
    turnId: z.string(),
    turnSeq: z.number().int().min(1),
  })
  .strict()
export type IntentRetrySource = z.infer<typeof IntentRetrySourceSchema>

export const IntentApplyReceiptSchema = z
  .object({
    journalId: z.string(),
    commitSeq: z.number().int(),
    applied: z.array(
      z
        .object({
          opId: z.string(),
          resourceType: AclResourceTypeSchema,
          resourceId: z.string(),
          action: z.enum(['create', 'update']),
          fromCopy: z.boolean(),
          name: z.string(),
        })
        .strict(),
    ),
  })
  .strict()
export type IntentApplyReceiptWire = z.infer<typeof IntentApplyReceiptSchema>

// AC-11: resource-side provenance annotation. Rows are filtered server-side to
// sessions the actor can read (creator or `intent:audit`) — a plain viewer of
// the resource gets an empty list, indistinguishable from "not intent-built".
export const IntentProvenanceEntrySchema = z.object({
  commitId: z.string(),
  sessionId: z.string(),
  sessionTitle: z.string(),
  createdAt: z.number().int(),
})
export type IntentProvenanceEntry = z.infer<typeof IntentProvenanceEntrySchema>

export const IntentMountApprovalReceiptSchema = z
  .object({
    sourceTurnId: z.string(),
    sourceTurnSeq: z.number().int().min(1),
    approvalTurnId: z.string(),
    approvalTurnSeq: z.number().int().min(1),
    resultingContextRevision: z.number().int().min(0),
    approved: z.array(
      z
        .object({
          resourceType: AclResourceTypeSchema,
          name: z.string(),
          resourceId: z.string(),
          handle: z.string(),
        })
        .strict(),
    ),
    rejected: z.array(z.object({ resourceType: AclResourceTypeSchema, name: z.string() }).strict()),
  })
  .strict()
export type IntentMountApprovalReceipt = z.infer<typeof IntentMountApprovalReceiptSchema>

export const IntentMountSuggestionBatchSchema = z
  .object({
    sourceTurnId: z.string(),
    sourceTurnSeq: z.number().int().min(1),
    contextRevision: z.number().int().min(0),
    items: z.array(
      z
        .object({
          resourceType: AclResourceTypeSchema,
          name: z.string(),
          reason: z.string().nullable(),
          candidates: z.array(
            z
              .object({
                resourceId: z.string(),
                name: z.string(),
                description: z.string().nullable(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict()
export type IntentMountSuggestionBatch = z.infer<typeof IntentMountSuggestionBatchSchema>

export const IntentSessionDetailSchema = z
  .object({
    session: IntentSessionSummarySchema,
    /** Explicitly mounted roots (session working-set; closure members omitted). */
    mounts: z.array(
      z
        .object({
          handle: z.string(),
          resourceType: AclResourceTypeSchema,
          resourceId: z.string(),
          displayName: z.string().nullable(),
          detail: z.boolean(),
        })
        .strict(),
    ),
    workingSetChange: IntentWorkingSetChangeDtoSchema.nullable(),
    mountSuggestions: IntentMountSuggestionBatchSchema.nullable(),
    turns: z.array(IntentTurnDtoSchema),
    currentDraft: IntentDraftDtoSchema.nullable(),
    drafts: z.array(IntentDraftDtoSchema),
    composerSource: IntentComposerSourceSchema,
    retrySource: IntentRetrySourceSchema.nullable(),
    commits: z.array(
      z
        .object({
          journalId: z.string(),
          draftId: z.string(),
          state: z.enum(['prepared', 'applying', 'committed', 'failed']),
          receipt: IntentApplyReceiptSchema.nullable(),
          error: z.string().nullable(),
          createdAt: z.number().int(),
        })
        .strict(),
    ),
  })
  .strict()
export type IntentSessionDetail = z.infer<typeof IntentSessionDetailSchema>
