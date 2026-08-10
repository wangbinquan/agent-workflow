// RFC-234 §6 (T7) — intent-session HTTP wire schemas.
//
// Sessions are creator-private (+ system-admin read); every mutating request
// is validated here at the route boundary and re-authorized per-row in
// services/intent/*. The commit request carries the exact confirmed draft
// identity (revision + sha-256 hash) plus per-op decisions that may only
// address SERVER-ISSUED slots (design §9.3).

import { z } from 'zod'
import { AclResourceTypeSchema } from './resourceAcl'

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
        z.object({ resourceType: AclResourceTypeSchema, resourceId: z.string().min(1) }).strict(),
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

export const IntentMountRefSchema = z
  .object({
    resourceType: AclResourceTypeSchema,
    resourceId: z.string().min(1).max(128),
  })
  .strict()
export type IntentMountRefWire = z.infer<typeof IntentMountRefSchema>

/** Approving agent mount SUGGESTIONS = explicit mounts of resolved rows the
 *  user picked (design-gate P1-4: nothing auto-mounts; rejected suggestions
 *  are recorded for the next INTENT.md so the agent stops asking). */
export const PostIntentMountApprovalsSchema = z
  .object({
    approve: z.array(IntentMountRefSchema).max(16).default([]),
    rejectNames: z
      .array(z.object({ resourceType: AclResourceTypeSchema, name: z.string().min(1).max(200) }))
      .max(16)
      .default([]),
  })
  .strict()
export type PostIntentMountApprovals = z.infer<typeof PostIntentMountApprovalsSchema>

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

export const IntentSessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['active', 'archived']),
  contextRevision: z.number().int(),
  turnSeq: z.number().int(),
  commitSeq: z.number().int(),
  inFlight: z.boolean(),
  currentDraftRevision: z.number().int().nullable(),
  /** Present only on the admin audit list. */
  ownerUserId: z.string().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type IntentSessionSummary = z.infer<typeof IntentSessionSummarySchema>

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
  z.object({
    kind: z.literal('secret'),
    slotId: z.string(),
    opId: z.string(),
    jsonPointer: z.string(),
  }),
  z.object({
    kind: z.literal('secretWaiver'),
    slotId: z.string(),
    opId: z.string(),
    jsonPointer: z.string(),
  }),
  z.object({
    kind: z.literal('humanBinding'),
    slotId: z.string(),
    opId: z.string(),
    displayName: z.string(),
  }),
  z.object({ kind: z.literal('finalName'), slotId: z.string(), opId: z.string() }),
])
export type IntentSlotDto = z.infer<typeof IntentSlotDtoSchema>

export const IntentDraftDtoSchema = z.object({
  id: z.string(),
  revision: z.number().int(),
  changeset: z.unknown(),
  validation: z.object({
    errors: z.array(z.string()),
    credentialFindings: z.array(
      z.object({
        opId: z.string(),
        jsonPointer: z.string(),
        kind: z.string(),
        excerpt: z.string(),
      }),
    ),
  }),
  slots: z.array(IntentSlotDtoSchema),
  draftHash: z.string(),
  contextRevision: z.number().int(),
  /** True when the session epoch moved past this draft (commit disabled). */
  stale: z.boolean(),
  createdAt: z.number().int(),
})
export type IntentDraftDto = z.infer<typeof IntentDraftDtoSchema>

export const IntentApplyReceiptSchema = z.object({
  journalId: z.string(),
  commitSeq: z.number().int(),
  applied: z.array(
    z.object({
      opId: z.string(),
      resourceType: AclResourceTypeSchema,
      resourceId: z.string(),
      action: z.enum(['create', 'update']),
      fromCopy: z.boolean(),
      name: z.string(),
    }),
  ),
})
export type IntentApplyReceiptWire = z.infer<typeof IntentApplyReceiptSchema>

// AC-11: resource-side provenance annotation. Rows are filtered server-side to
// sessions the actor can read (creator or admin auditor) — a plain viewer of
// the resource gets an empty list, indistinguishable from "not intent-built".
export const IntentProvenanceEntrySchema = z.object({
  commitId: z.string(),
  sessionId: z.string(),
  sessionTitle: z.string(),
  createdAt: z.number().int(),
})
export type IntentProvenanceEntry = z.infer<typeof IntentProvenanceEntrySchema>

export const IntentSessionDetailSchema = z.object({
  session: IntentSessionSummarySchema,
  /** Explicitly mounted roots (session working-set; closure members omitted). */
  mounts: z.array(
    z.object({
      handle: z.string(),
      resourceType: AclResourceTypeSchema,
      resourceId: z.string(),
      detail: z.boolean(),
    }),
  ),
  turns: z.array(IntentTurnDtoSchema),
  currentDraft: IntentDraftDtoSchema.nullable(),
  commits: z.array(
    z.object({
      journalId: z.string(),
      draftId: z.string(),
      state: z.enum(['prepared', 'applying', 'committed', 'failed']),
      receipt: IntentApplyReceiptSchema.nullable(),
      error: z.string().nullable(),
      createdAt: z.number().int(),
    }),
  ),
})
export type IntentSessionDetail = z.infer<typeof IntentSessionDetailSchema>
