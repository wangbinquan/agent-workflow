// RFC-041: Platform long-term memory schemas.
// See design/RFC-041-platform-long-term-memory/design.md §3.1.

import { z } from 'zod'
import { SessionTreeSchema } from './sessionView'

export const MemoryScopeSchema = z.enum(['agent', 'workflow', 'repo', 'global'])
export type MemoryScope = z.infer<typeof MemoryScopeSchema>

export const MemoryStatusSchema = z.enum([
  'candidate',
  'approved',
  'archived',
  'superseded',
  'rejected',
])
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>

export const MemorySourceKindSchema = z.enum(['clarify', 'review', 'feedback', 'manual'])
export type MemorySourceKind = z.infer<typeof MemorySourceKindSchema>

export const DistillActionSchema = z.enum(['new', 'update_of', 'duplicate_of', 'conflict_with'])
export type DistillAction = z.infer<typeof DistillActionSchema>

export const DistillJobStatusSchema = z.enum(['pending', 'running', 'done', 'failed', 'canceled'])
export type DistillJobStatus = z.infer<typeof DistillJobStatusSchema>

const tagsArraySchema = z.array(z.string().min(1).max(40)).max(16)

export const MemorySchema = z
  .object({
    id: z.string().min(1),
    scopeType: MemoryScopeSchema,
    scopeId: z.string().nullable(),
    title: z.string().trim().min(1).max(120),
    bodyMd: z.string().trim().min(1).max(4000),
    tags: tagsArraySchema,
    status: MemoryStatusSchema,
    sourceKind: MemorySourceKindSchema,
    sourceEventId: z.string().nullable(),
    sourceTaskId: z.string().nullable(),
    distillJobId: z.string().nullable(),
    distillAction: DistillActionSchema.nullable(),
    supersedesId: z.string().nullable(),
    supersededById: z.string().nullable(),
    approvedByUserId: z.string().nullable(),
    approvedAt: z.number().int().nullable(),
    createdAt: z.number().int(),
    version: z.number().int().min(1),
  })
  .superRefine((v, ctx) => {
    if (v.scopeType === 'global' && v.scopeId !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'global scope must have scopeId=null',
        path: ['scopeId'],
      })
    }
    if (v.scopeType !== 'global' && (v.scopeId === null || v.scopeId === '')) {
      ctx.addIssue({
        code: 'custom',
        message: 'non-global scope requires scopeId',
        path: ['scopeId'],
      })
    }
  })
export type Memory = z.infer<typeof MemorySchema>

export const MemorySummarySchema = z.object({
  id: z.string(),
  scopeType: MemoryScopeSchema,
  scopeId: z.string().nullable(),
  title: z.string(),
  status: MemoryStatusSchema,
  tags: z.array(z.string()),
  approvedAt: z.number().int().nullable(),
  version: z.number().int(),
  distillAction: DistillActionSchema.nullable(),
})
export type MemorySummary = z.infer<typeof MemorySummarySchema>

// Admin-issued promote action on a candidate row. Discriminated union so
// the supersede target ids only appear in the supersede branch.
export const MemoryCandidatePromoteSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    tagsOverride: z.array(z.string().min(1).max(40)).max(16).optional(),
  }),
  z.object({
    action: z.literal('approve_and_supersede'),
    supersedeIds: z.array(z.string().min(1)).min(1).max(8),
    tagsOverride: z.array(z.string().min(1).max(40)).max(16).optional(),
  }),
  z.object({
    action: z.literal('reject'),
  }),
])
export type MemoryCandidatePromote = z.infer<typeof MemoryCandidatePromoteSchema>

// Admin-issued create memory directly (source_kind='manual'). Used by tests
// and the future "admin writes a memory by hand" UI; the audit trail still
// lands the same row.
export const MemoryCreateRequestSchema = z
  .object({
    scopeType: MemoryScopeSchema,
    scopeId: z.string().nullable(),
    title: z.string().trim().min(1).max(120),
    bodyMd: z.string().trim().min(1).max(4000),
    tags: tagsArraySchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.scopeType === 'global' && v.scopeId !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'global scope must have scopeId=null',
        path: ['scopeId'],
      })
    }
    if (v.scopeType !== 'global' && (v.scopeId === null || v.scopeId === '')) {
      ctx.addIssue({
        code: 'custom',
        message: 'non-global scope requires scopeId',
        path: ['scopeId'],
      })
    }
  })
export type MemoryCreateRequest = z.infer<typeof MemoryCreateRequestSchema>

// RFC-045: Admin-issued in-place edit. Distinct from MemoryCreateRequestSchema
// because every field is optional (partial PATCH) — but at least one must be
// present, and when scopeType + scopeId are *both* in the patch they must
// satisfy the global ↔ scopeId-null invariant on their own. The
// "scopeType-only" case (caller changes scope_type but keeps the row's
// existing scope_id) is allowed by the schema and re-validated against the
// row at the service layer (§design.md §4.2 step 3).
export const MemoryPatchRequestSchema = z
  .object({
    scopeType: MemoryScopeSchema.optional(),
    scopeId: z.string().nullable().optional(),
    title: z.string().trim().min(1).max(120).optional(),
    bodyMd: z.string().trim().min(1).max(4000).optional(),
    tags: tagsArraySchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (
      v.scopeType === undefined &&
      v.scopeId === undefined &&
      v.title === undefined &&
      v.bodyMd === undefined &&
      v.tags === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'patch must include at least one of scopeType/scopeId/title/bodyMd/tags',
        path: [],
      })
    }
    if (v.scopeType !== undefined && v.scopeId !== undefined) {
      if (v.scopeType === 'global' && v.scopeId !== null) {
        ctx.addIssue({
          code: 'custom',
          message: 'global scope must have scopeId=null',
          path: ['scopeId'],
        })
      }
      if (v.scopeType !== 'global' && (v.scopeId === null || v.scopeId === '')) {
        ctx.addIssue({
          code: 'custom',
          message: 'non-global scope requires scopeId',
          path: ['scopeId'],
        })
      }
    }
  })
export type MemoryPatchRequest = z.infer<typeof MemoryPatchRequestSchema>

/** Field names that PATCH /api/memories/:id may change (and that the WS
 *  `memory.updated` event reports in changedFields). Kept as a const tuple so
 *  the WS schema can derive the same enum without redeclaring it.
 *  Order is fixed so test fixtures are stable. */
export const MEMORY_PATCH_FIELDS = ['scopeType', 'scopeId', 'title', 'bodyMd', 'tags'] as const
export type MemoryPatchField = (typeof MEMORY_PATCH_FIELDS)[number]

// Resolved scope set computed at enqueue time and frozen on the job row.
export const ResolvedDistillScopeSchema = z.object({
  agentIds: z.array(z.string()),
  workflowId: z.string().nullable(),
  repoId: z.string().nullable(),
  includeGlobal: z.boolean(),
})
export type ResolvedDistillScope = z.infer<typeof ResolvedDistillScopeSchema>

export const MemoryDistillJobSchema = z.object({
  id: z.string(),
  debounceKey: z.string(),
  sourceKind: z.enum(['clarify', 'review', 'feedback']),
  sourceEventId: z.string(),
  taskId: z.string().nullable(),
  scopeResolved: ResolvedDistillScopeSchema,
  status: DistillJobStatusSchema,
  attempts: z.number().int(),
  nextRunAt: z.number().int(),
  lastError: z.string().nullable(),
  createdAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
  // RFC-043: distill job detail artefacts. All nullable — old job rows
  // (created before migration 0024) and rows that errored before
  // spawn / before opencode emitted a sessionId leave these as null.
  opencodeSessionId: z.string().nullable().optional(),
  userPromptMd: z.string().nullable().optional(),
  exitCode: z.number().int().nullable().optional(),
  stderrExcerpt: z.string().nullable().optional(),
})
export type MemoryDistillJob = z.infer<typeof MemoryDistillJobSchema>

// RFC-043: a single captured event row from memory_distill_events, sent
// over the wire as the building block of MemoryDistillSessionViewSchema.
// kind mirrors node_run_events.kind plus the RFC-043 capture-failure
// marker; payload is the raw JSON line transcoded from opencode's
// SQLite (handed straight to parseSessionTree on the backend).
export const MemoryDistillEventSchema = z.object({
  id: z.number().int(),
  attemptIndex: z.number().int().min(0),
  sessionId: z.string(),
  parentSessionId: z.string().nullable(),
  ts: z.number().int(),
  kind: z.string(),
  payload: z.string(),
})
export type MemoryDistillEvent = z.infer<typeof MemoryDistillEventSchema>

// RFC-043: GET /api/memory/distill-jobs/:jobId/session response. One
// attempt entry per retry round; the conversation tree is the same
// shape RFC-027 SessionTab consumes so ConversationFlow is reusable.
export const MemoryDistillSessionAttemptSchema = z.object({
  attemptIndex: z.number().int().min(0),
  rootSessionId: z.string().nullable(),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
  /** True when the capture wrote a 'rfc043/distill-capture-failed' marker for this attempt. */
  captureFailed: z.boolean(),
  tree: SessionTreeSchema.nullable(),
})
export type MemoryDistillSessionAttempt = z.infer<typeof MemoryDistillSessionAttemptSchema>

export const MemoryDistillSessionViewSchema = z.object({
  attempts: z.array(MemoryDistillSessionAttemptSchema),
})
export type MemoryDistillSessionView = z.infer<typeof MemoryDistillSessionViewSchema>

// RFC-043: a memory candidate produced by THIS distill job, paired with
// its currently-stored status (which may have moved on from candidate
// to approved / rejected / archived since the job ran).
export const MemoryDistillCandidateSnapshotSchema = z.object({
  memoryId: z.string(),
  title: z.string(),
  bodyMd: z.string(),
  scopeType: MemoryScopeSchema,
  scopeId: z.string().nullable(),
  distillAction: DistillActionSchema,
  currentStatus: MemoryStatusSchema,
  referenceMemoryId: z.string().nullable(),
  createdAt: z.number().int(),
})
export type MemoryDistillCandidateSnapshot = z.infer<typeof MemoryDistillCandidateSnapshotSchema>

// RFC-043: minimal row about each source event the distiller consumed.
// `deletedOrMissing` lets the frontend grey out deep links to e.g. a
// clarify session that was cleaned up after the job ran.
export const MemoryDistillSourceEventEntrySchema = z.object({
  kind: z.enum(['clarify', 'review', 'feedback']),
  id: z.string(),
  summary: z.string(),
  deepLink: z.string(),
  deletedOrMissing: z.boolean(),
  taskId: z.string().nullable(),
})
export type MemoryDistillSourceEventEntry = z.infer<typeof MemoryDistillSourceEventEntrySchema>

// RFC-043: per-memory snapshot row captured at distill time so detail
// page can show "what the distiller actually saw" even after approve /
// archive changes those memories. Only minimal columns are stored —
// memories table remains the source of truth.
export const MemoryDistillDedupSnapshotEntrySchema = z.object({
  memoryId: z.string(),
  scopeType: MemoryScopeSchema,
  scopeId: z.string().nullable(),
  title: z.string(),
})
export type MemoryDistillDedupSnapshotEntry = z.infer<typeof MemoryDistillDedupSnapshotEntrySchema>

export const MemoryDistillJobDetailSchema = z.object({
  job: MemoryDistillJobSchema,
  siblings: z.array(MemoryDistillJobSchema),
  sourceEvents: z.array(MemoryDistillSourceEventEntrySchema),
  dedupSnapshot: z.array(MemoryDistillDedupSnapshotEntrySchema),
  candidates: z.array(MemoryDistillCandidateSnapshotSchema),
})
export type MemoryDistillJobDetail = z.infer<typeof MemoryDistillJobDetailSchema>

// RFC-046: snapshot of one approved memory captured at runner-inject time.
// Persisted in node_runs.injected_memories_json as an array. The runner
// freezes the *post-budget-clip* set so the snapshot byte-for-byte mirrors
// what the model actually saw in its system prompt (see RFC-041 §G7 /
// RFC-046 §design.md §3.1). All fields are captured verbatim from the
// memories row at inject time so later RFC-045 edits / archives / supersedes
// do not rewrite history.
export const InjectedMemorySnapshotSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().nonnegative(),
  scopeType: MemoryScopeSchema,
  scopeId: z.string().nullable(),
  title: z.string().min(1).max(120),
  bodyMd: z.string().min(1).max(4000),
  tags: z.array(z.string()).max(16),
  sourceKind: z.string(),
  approvedAt: z.number().int().nonnegative().nullable(),
})
export type InjectedMemorySnapshot = z.infer<typeof InjectedMemorySnapshotSchema>

export const MemoryListFilterSchema = z.object({
  status: MemoryStatusSchema.optional(),
  scopeType: MemoryScopeSchema.optional(),
  scopeId: z.string().min(1).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  tag: z.string().min(1).max(40).optional(),
})
export type MemoryListFilter = z.infer<typeof MemoryListFilterSchema>
