// RFC-041 — memory distiller (PR2 scope).
//
// The distiller is a *system* opencode agent — not stored in the `agents`
// table, not user-editable. We hand opencode an inline agent JSON via
// OPENCODE_CONFIG_CONTENT (the merge order documented in
// packages/opencode/src/config/config.ts:641 puts inline JSON ahead of any
// directory-scanned agent of the same name), spawn the subprocess in a
// throwaway temp dir (so the distill never produces a git diff side-effect
// on a real worktree), and parse the `candidates` port out of the last
// <workflow-output> envelope on stdout.
//
// Failures (timeout / non-zero exit / unparseable envelope / zod-invalid
// candidate) are swallowed at the candidate level when the rest of the
// batch is salvageable; only "no envelope at all" / spawn errors bubble up
// to the scheduler, which records them in `memory_distill_jobs.last_error`
// and applies exponential backoff.
//
// Tests inject `spawnFn` to skip the real Bun.spawn — production passes
// `defaultDistillerSpawn` which actually runs opencode.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import type {
  Memory,
  MemoryDistillJob,
  ResolvedDistillScope,
  SourceContextBudget,
} from '@agent-workflow/shared'
import { DEFAULT_SOURCE_CONTEXT_BUDGET, MemorySchema, redactGitUrl } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { logicalRuns, memories, memoryDistillJobs, suspensions, taskFeedback } from '@/db/schema'

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
import { extractLastEnvelope } from '@/services/envelope'
import { captureDistillJobSession } from '@/services/distillSessionCapture'
import { clipHeadTail } from '@/services/distillerSourceContext'
import { appHome } from '@/util/paths'
import { MEMORY_CHANNEL, memoryBroadcaster } from '@/ws/broadcaster'
import { createLogger } from '@/util/log'

const log = createLogger('memory-distiller')

export const DISTILLER_AGENT_NAME = 'aw-memory-distiller'

/**
 * The frozen prompt the distiller agent runs with. Lives in source so the
 * upgrade path is a code PR — not a settings edit — and so the wording is
 * grep-able from production logs (`grep -F 'aw-memory-distiller' …`).
 *
 * Keep this English regardless of UI locale: agents read it in-process and
 * the resulting memory bodies are inject-time-pasted into other agents'
 * system prompts, so a stable, non-translated lingua franca avoids the
 * "Chinese memory injected into an English agent prompt" mismatch.
 *
 * Business-focus addendum: this platform is deployed against real domain
 * code, so the prompt aggressively biases the distiller toward extracting
 * durable BUSINESS and ARCHITECTURE knowledge (domain glossary,
 * invariants, process rules, architecture rationale, integration
 * contracts, compliance, data semantics, anti-patterns, conventions,
 * quality bar) over fleeting workflow ergonomics. Each candidate's title
 * carries a "[category:xxx]" prefix so admins can sort by category in the
 * Approval Queue without schema churn. The prefix categories below are
 * grep-locked by memory-distiller.test.ts to prevent silent drift.
 */
export const DISTILLER_SYSTEM_PROMPT = `You are aw-memory-distiller, an internal subsystem of the agent-workflow platform.

Your single task: read a batch of recent events (clarify Q&A, human review decisions, or task-feedback notes) and emit zero or more *candidate long-term memories* that future agents should learn from.

This platform is deployed to drive real business workflows. The memories you produce are silently injected into the system prompts of downstream agents that operate on real domain code. Aggressively favor durable BUSINESS and ARCHITECTURE knowledge over fleeting workflow ergonomics: when an event reveals a domain rule, a system invariant, or a design decision, prefer extracting that over the surface-level "what the user said today".

PRIORITIZE these categories. Write the matching category as a "[category:xxx]" prefix on the candidate title (e.g. "[category:invariant] discounts >30% require manager approval"):

1. [category:domain-glossary] — concept definitions specific to this product or domain
   (e.g. "in this system 'order' means a post-checkout immutable snapshot, distinct from OMS's order").
2. [category:invariant] — hard business rules / constraints that must always hold
   (e.g. "refund window is 14 days after shipment"; "discount > 30% requires manager approval").
3. [category:process] — business workflows, state machines, ordering / dependency constraints
   (e.g. "customer must finish KYC before opening an account"; "PR must pass review before merge").
4. [category:architecture] — technical / design decisions WITH rationale ("why" is the load-bearing part)
   (e.g. "we use event sourcing because compliance requires a 7-year audit trail").
5. [category:integration] — external system contracts, SLAs, idempotency / retry / pagination conventions
   (e.g. "Stripe webhook handlers must be idempotent via idempotency-key").
6. [category:compliance] — regulatory / legal constraints (GDPR, SOC2, PCI, industry-specific) that shape implementation choices.
7. [category:data-semantics] — non-obvious meaning of fields, enums, status values
   (e.g. "status='inactive' = archived but recoverable; status='deleted' = GC candidate").
8. [category:anti-pattern] — known failure modes / what NOT to do, ideally with the reason
   (e.g. "do not hard-delete users — breaks reconciliation chain").
9. [category:convention] — stable team / reviewer / stakeholder preferences a future agent should respect
   (e.g. "finance team prefers monthly batch reports, not realtime dashboards").
10. [category:quality-bar] — what counts as "done" in this project
    (e.g. "every feature must ship with integration tests against a real DB, not mocks").

Cross-cutting properties of a good candidate (apply to ALL categories):
- atomic and generalizable — a single rule of thumb that survives outside the event that produced it.
- names a clear binding scope (one of: agent, workflow, repo, global). Architecture / compliance / domain-glossary usually bind at repo or global; conventions usually bind at agent or workflow.
- written in plain English (regardless of source language), post-incident framing (NOT "today the user said X" — instead "X is the rule in this system").
- actionable for a future agent in similar situations.
- includes the *why* whenever rationale appears in the event — rationale is what makes a memory injectable rather than dogmatic.
- at most ~400 characters in bodyMd; title <= 120 chars total INCLUDING the "[category:xxx]" prefix.

REJECT (emit nothing for it) if the candidate is:
- a fleeting status update, mood, or one-off acknowledgement.
- a single-decision narrative without an extractable rule (e.g. "user merged PR #482").
- a hallucination, restatement of input verbatim, or pure paraphrase.
- already derivable from README / package.json / TypeScript types / existing approved memories.
- a personal momentary preference ("don't ping me on Fridays").
- contains secrets, tokens, credentials, or personally-identifying information.
- has no clear scope it applies to.
- contradicts an existing approved memory without explicit reasoning.

You will be given:
- The events to process (each tagged with its source kind and ids).
- The list of currently-approved memories in each candidate scope (for dedup).
- The list of currently-used tags in each scope (for tag reuse).

For each candidate you emit, label its relation to existing memories using "action":
- "new"             — no existing memory addresses this.
- "update_of"       — refines / improves an existing memory; set referenceMemoryId.
- "duplicate_of"    — already covered; set referenceMemoryId.
- "conflict_with"   — contradicts an existing memory; set referenceMemoryId.

Tag rules:
- ALWAYS include the chosen category as a tag (matching the title prefix). If the category already appears in the scope's existing tag pool list, put it in "knownTags"; otherwise put it in "newTags".
- Prefer existing tags exactly (case-sensitive lowercase-kebab).
- Beyond the category tag, only introduce new tags when they meaningfully sharpen retrieval. List those in "newTags" not "knownTags". The admin decides whether to keep them.

Output exactly one <workflow-output> envelope with a single port "candidates" whose value is JSON matching this shape:

{
  "candidates": [
    {
      "scopeType": "agent" | "workflow" | "repo" | "global",
      "scopeId": "<id or null for global>",
      "title": "[category:xxx] <= 120 chars total including prefix",
      "bodyMd": "<= 400 chars, plain English, includes rationale when rationale appeared in events",
      "knownTags": ["existing-tag", ...],
      "newTags": ["proposed-new-tag", ...],
      "action": "new" | "update_of" | "duplicate_of" | "conflict_with",
      "referenceMemoryId": "<id of related approved memory, or null>",
      "sourceRefs": [{"kind": "clarify" | "review" | "feedback", "id": "<event id>"}]
    }
  ]
}

If no good candidate exists, emit:
<workflow-output>
<port name="candidates">{"candidates": []}</port>
</workflow-output>

Do NOT include any other narration outside the envelope. Do NOT call any tools.`

/**
 * RFC-050: a short trailer appended at the END of the user prompt — never
 * the system prompt. By living in the user prompt we leave
 * `DISTILLER_SYSTEM_PROMPT` byte-for-byte identical to RFC-041 (locked by
 * the grep-guard test + a SHA-256 hash baseline). The two strings are
 * intentionally short and surgical: instructions, categories, envelope
 * shape, and rejection rules stay in English; only the visible candidate
 * text language flips. The `[category:xxx]` title prefix MUST remain
 * lowercase ASCII (locked by the existing memory-distiller test).
 */
export type DistillerOutputLang = 'zh-CN' | 'en-US'
export const DISTILLER_OUTPUT_LANG_DIRECTIVE: Readonly<Record<DistillerOutputLang, string>> = {
  'en-US':
    "Emit each candidate's `title` (after the [category:xxx] prefix) and `bodyMd` in English. The category prefix itself remains lowercase ASCII (e.g. [category:invariant]).",
  'zh-CN':
    '候选记忆的 `title`（[category:xxx] 前缀之后部分）与 `bodyMd` 用简体中文输出。`[category:xxx]` 前缀本身保持小写 ASCII（如 [category:invariant]），不要翻译。',
} as const

const DEFAULT_TIMEOUT_MS = 120_000

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface DistillResult {
  candidatesCreated: number
  /** ids of memory rows that were inserted (status='candidate'). */
  createdMemoryIds: string[]
}

export interface RunDistillOptions {
  db: DbClient
  job: MemoryDistillJob
  /**
   * Sibling jobs sharing the same debounce_key that the scheduler decided
   * to merge into this batch. Always includes `job` itself. The distiller
   * lists all source events from these in one user prompt.
   */
  siblings: MemoryDistillJob[]
  /** Inject a fake spawn for tests. Default = real Bun.spawn pipeline. */
  spawnFn?: DistillerSpawnFn
  /** Default 120_000ms; tests override to keep cases fast. */
  timeoutMs?: number
  /**
   * Default model for the distiller agent. Falls back to inline-null
   * (opencode picks its installed default). Settings field
   * `memoryDistillModel` is plumbed through by the scheduler.
   */
  model?: string | null
  /**
   * RFC-044: per-source byte budget for the new transcript / body context
   * blocks. Plumbed by the scheduler from `config.memoryDistillSourceContext`.
   * Defaults to DEFAULT_SOURCE_CONTEXT_BUDGET — passing 0 fields disables the
   * corresponding block.
   */
  sourceContextBudget?: SourceContextBudget
}

export interface DistillerSpawnInput {
  /** Hardcoded English user prompt assembled in buildDistillerUserPrompt. */
  userPrompt: string
  /** Inline agent JSON to pass via OPENCODE_CONFIG_CONTENT. */
  inlineConfigJson: string
  /** Tmp cwd allocated for this distill — no git side-effects. */
  cwd: string
  timeoutMs: number
}

export interface DistillerSpawnResult {
  exitCode: number | null
  /** Full stdout — caller calls extractLastEnvelope on it. */
  stdout: string
  /** Full stderr — caller may persist on failure for debugging. */
  stderr: string
}

export type DistillerSpawnFn = (input: DistillerSpawnInput) => Promise<DistillerSpawnResult>

// -----------------------------------------------------------------------------
// Source event loading
// -----------------------------------------------------------------------------

export interface LoadedSourceEvents {
  clarify: Array<{
    id: string
    taskId: string
    nodeId: string
    questions: string
    answers: string
    /**
     * RFC-044: markdown-rendered source-agent transcript (events for the
     * node_run that emitted this clarify), already byte-clipped to the
     * configured budget. NULL means the loader could not produce a
     * transcript — `sourceTranscriptReason` carries the human-readable
     * cause and the builder prints a placeholder line instead.
     */
    sourceTranscriptMd: string | null
    sourceTranscriptReason: string | null
  }>
  review: Array<{
    id: string
    taskId: string
    nodeId: string
    decision: string
    bodyPath: string
    comments: Array<{ body: string; anchorParagraphIdx: number; selectedText: string }>
    /**
     * RFC-044: full markdown body of the reviewed doc version, already
     * byte-clipped. NULL when the file is unreadable (worktree GC / path
     * drift) — `reviewedBodyReason` carries the cause.
     */
    reviewedBodyMd: string | null
    reviewedBodyReason: string | null
  }>
  feedback: Array<{ id: string; taskId: string; bodyMd: string; createdAt: number }>
}

/**
 * Read every source event named in `jobs`. Best-effort — missing rows
 * (event was deleted between enqueue and run) are silently skipped so a
 * single bad row never poisons the rest of the batch.
 *
 * RFC-044: when the optional `budget` argument is passed, the loader also
 * fetches the source-agent transcript for clarify rows (via
 * `clarify_sessions.source_agent_node_run_id` → `node_run_events`) and the
 * reviewed document body for review rows (the doc-version body_path file).
 * Each extra read is best-effort: on failure the corresponding `*Md` field
 * is null and the `*Reason` field carries a short string the builder prints
 * as a placeholder line — the distiller still runs, degraded to RFC-041
 * fidelity for that one source.
 */
export async function loadSourceEvents(
  db: DbClient,
  jobs: MemoryDistillJob[],
  budget: SourceContextBudget = DEFAULT_SOURCE_CONTEXT_BUDGET,
): Promise<LoadedSourceEvents> {
  const clarifyIds = jobs.filter((j) => j.sourceKind === 'clarify').map((j) => j.sourceEventId)
  const reviewIds = jobs.filter((j) => j.sourceKind === 'review').map((j) => j.sourceEventId)
  const feedbackIds = jobs.filter((j) => j.sourceKind === 'feedback').map((j) => j.sourceEventId)

  // RFC-061 follow-up P2-1 — load clarify + review history from the
  // suspensions projection. distill jobs created post-RFC-061 carry
  // suspension.id as sourceEventId (see suspensions.ts:resolveSuspension
  // enqueue hook). The shape projects to clarify-like / review-like for
  // downstream renderers; eventually the renderers can switch to a
  // unified suspension shape (separate cleanup PR).
  type ClarifyShape = {
    id: string
    taskId: string
    clarifyNodeId: string
    sourceAgentNodeRunId: string
    questionsJson: string
    answersJson: string | null
  }
  type ReviewShape = {
    id: string
    taskId: string
    reviewNodeId: string
    decision: string
    bodyPath: string
    versionIndex: number
  }

  const clarifyRows: ClarifyShape[] = []
  if (clarifyIds.length > 0) {
    const rows = await db
      .select({
        id: suspensions.id,
        signalKind: suspensions.signalKind,
        payload: suspensions.payload,
        logicalRunId: suspensions.logicalRunId,
        lrTaskId: logicalRuns.taskId,
        lrNodeId: logicalRuns.nodeId,
      })
      .from(suspensions)
      .innerJoin(logicalRuns, eq(suspensions.logicalRunId, logicalRuns.id))
      .where(inArray(suspensions.id, clarifyIds))
    for (const r of rows) {
      if (r.signalKind !== 'self-clarify' && r.signalKind !== 'cross-clarify') continue
      const body = safeParse(r.payload) as {
        questions?: ReadonlyArray<{ id: string; text: string }>
      } | null
      clarifyRows.push({
        id: r.id,
        taskId: r.lrTaskId,
        clarifyNodeId: r.lrNodeId,
        sourceAgentNodeRunId: r.logicalRunId,
        questionsJson: JSON.stringify(body?.questions ?? []),
        answersJson: null,
      })
    }
  }

  const reviewRows: ReviewShape[] = []
  if (reviewIds.length > 0) {
    const rows = await db
      .select({
        id: suspensions.id,
        signalKind: suspensions.signalKind,
        payload: suspensions.payload,
        logicalRunId: suspensions.logicalRunId,
        lrTaskId: logicalRuns.taskId,
        lrNodeId: logicalRuns.nodeId,
        lrIter: logicalRuns.iter,
      })
      .from(suspensions)
      .innerJoin(logicalRuns, eq(suspensions.logicalRunId, logicalRuns.id))
      .where(inArray(suspensions.id, reviewIds))
    for (const r of rows) {
      if (r.signalKind !== 'review') continue
      const body = safeParse(r.payload) as {
        docNodeId?: string
        docPortName?: string
      } | null
      reviewRows.push({
        id: r.id,
        taskId: r.lrTaskId,
        reviewNodeId: r.lrNodeId,
        decision: 'pending',
        bodyPath: `${body?.docNodeId ?? '?'}.${body?.docPortName ?? '?'}`,
        versionIndex: r.lrIter + 1,
      })
    }
  }

  const feedbackRows =
    feedbackIds.length > 0
      ? await db.select().from(taskFeedback).where(inArray(taskFeedback.id, feedbackIds))
      : []

  // RFC-061 follow-up: review_comments table is dropped with doc_versions.
  // The distill pipeline no longer attaches per-anchor reviewer notes; the
  // suspensions-projection successor will store them as part of the review
  // resolution payload.
  const commentsByDv = new Map<
    string,
    Array<{ body: string; anchorParagraphIdx: number; selectedText: string }>
  >()

  const transcriptsByClarifyId = await loadClarifyTranscripts(db, clarifyRows, budget)
  const reviewBodiesByDvId = await loadReviewBodies(reviewRows, budget)

  return {
    clarify: clarifyRows.map((r) => {
      const t = transcriptsByClarifyId.get(r.id) ?? {
        md: null,
        reason: 'disabled by config',
      }
      return {
        id: r.id,
        taskId: r.taskId,
        nodeId: r.clarifyNodeId,
        questions: r.questionsJson,
        answers: r.answersJson ?? '[]',
        sourceTranscriptMd: t.md,
        sourceTranscriptReason: t.reason,
      }
    }),
    review: reviewRows.map((r) => {
      const b = reviewBodiesByDvId.get(r.id) ?? { md: null, reason: 'disabled by config' }
      return {
        id: r.id,
        taskId: r.taskId,
        nodeId: r.reviewNodeId,
        decision: r.decision,
        bodyPath: r.bodyPath,
        comments: commentsByDv.get(r.id) ?? [],
        reviewedBodyMd: b.md,
        reviewedBodyReason: b.reason,
      }
    }),
    feedback: feedbackRows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      bodyMd: r.bodyMd,
      createdAt: r.createdAt,
    })),
  }
}

interface SourceContextResult {
  md: string | null
  reason: string | null
}

/**
 * RFC-044: per-clarify-session source-agent transcript.
 *
 *  - Skipped entirely when `budget.clarifyTranscriptMaxBytes === 0`; the
 *    map omits these keys so the caller's `.get() ?? {...'disabled by config'}`
 *    fallback fills them in uniformly.
 *  - Pulls the source agent node_run row (prompt + startedAt + agentId),
 *    its events, and the agent name in three batch SELECTs.
 *  - Renders each session via `parseSessionTree` →
 *    `renderSessionTreeToDistillerMd`, then byte-clips to the configured
 *    budget.
 */
async function loadClarifyTranscripts(
  _db: DbClient,
  _clarifyRows: Array<{ id: string; sourceAgentNodeRunId: string }>,
  _budget: SourceContextBudget,
): Promise<Map<string, SourceContextResult>> {
  // RFC-061 follow-up: source node_runs + node_run_events tables are on
  // the drop list. Clarify transcript rendering for distill is degraded
  // until the loader is rewired to read from attempts + projection
  // events. Returning an empty map preserves the call shape; callers
  // already fall back to `{ md: null, reason: '...' }` per id.
  return new Map<string, SourceContextResult>()
}

/**
 * RFC-044: read each the doc-version body_path markdown file (relative to
 * appHome) and clip to the budget. Skipped when the budget is 0; per-row
 * read failures degrade to a null + reason pair so the builder can render a
 * placeholder line.
 */
async function loadReviewBodies(
  reviewRows: Array<{ id: string; bodyPath: string }>,
  budget: SourceContextBudget,
): Promise<Map<string, SourceContextResult>> {
  const out = new Map<string, SourceContextResult>()
  if (budget.reviewBodyMaxBytes === 0 || reviewRows.length === 0) return out
  const home = appHome()
  for (const r of reviewRows) {
    try {
      const abs = join(home, r.bodyPath)
      const file = Bun.file(abs)
      if (!(await file.exists())) {
        out.set(r.id, { md: null, reason: 'reviewed body unreadable: file missing' })
        continue
      }
      const text = await file.text()
      out.set(r.id, { md: clipHeadTail(text, budget.reviewBodyMaxBytes), reason: null })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      out.set(r.id, { md: null, reason: `reviewed body unreadable: ${msg}` })
    }
  }
  return out
}

// -----------------------------------------------------------------------------
// Scope dedup context loading
// -----------------------------------------------------------------------------

export interface ScopeContext {
  scopeType: 'agent' | 'workflow' | 'repo' | 'global'
  scopeId: string | null
  approved: Array<{ id: string; title: string; bodyMdHead: string; tags: string[] }>
  tagPool: string[]
}

/**
 * Build the per-scope dedup context the distiller prompt embeds. Body is
 * truncated to 200 chars so the context block stays bounded even for scopes
 * with many memories.
 */
export async function loadScopeContexts(
  db: DbClient,
  scope: ResolvedDistillScope,
): Promise<ScopeContext[]> {
  const out: ScopeContext[] = []
  for (const agentId of scope.agentIds) {
    out.push(await loadOne(db, 'agent', agentId))
  }
  if (scope.workflowId !== null) {
    out.push(await loadOne(db, 'workflow', scope.workflowId))
  }
  if (scope.repoId !== null) {
    out.push(await loadOne(db, 'repo', scope.repoId))
  }
  if (scope.includeGlobal) {
    out.push(await loadOne(db, 'global', null))
  }
  return out
}

async function loadOne(
  db: DbClient,
  scopeType: 'agent' | 'workflow' | 'repo' | 'global',
  scopeId: string | null,
): Promise<ScopeContext> {
  const where =
    scopeId === null
      ? and(eq(memories.scopeType, scopeType), eq(memories.status, 'approved'))
      : and(
          eq(memories.scopeType, scopeType),
          eq(memories.scopeId, scopeId),
          eq(memories.status, 'approved'),
        )
  const rows = await db.select().from(memories).where(where!).orderBy(desc(memories.createdAt))
  const tagBag = new Set<string>()
  const approved = rows.map((r) => {
    let tags: string[] = []
    try {
      const parsed = JSON.parse(r.tags) as unknown
      if (Array.isArray(parsed)) tags = parsed.filter((x): x is string => typeof x === 'string')
    } catch {
      tags = []
    }
    for (const t of tags) tagBag.add(t)
    return {
      id: r.id,
      title: r.title,
      bodyMdHead: r.bodyMd.slice(0, 200),
      tags,
    }
  })
  return { scopeType, scopeId, approved, tagPool: [...tagBag].sort() }
}

// -----------------------------------------------------------------------------
// Prompt assembly
// -----------------------------------------------------------------------------

export interface BuildDistillerPromptInput {
  events: LoadedSourceEvents
  scopeContexts: ScopeContext[]
  taskId: string | null
  /**
   * RFC-044: governs whether the `Source agent transcript:` /
   * `Reviewed document body:` blocks are emitted per source event. When a
   * field is 0 the corresponding block is skipped entirely — keeping the
   * prompt byte-for-byte equivalent to the RFC-041 baseline. Optional so
   * existing callers (tests + legacy code) keep compiling; defaults to the
   * shared DEFAULT_SOURCE_CONTEXT_BUDGET.
   */
  sourceContextBudget?: SourceContextBudget
  /**
   * RFC-050: language for the visible candidate text (`title` after the
   * lowercase ASCII `[category:xxx]` prefix, plus `bodyMd`). Appended as a
   * short trailing directive at the END of the user prompt; the system
   * prompt itself stays English (locked by grep guard + hash baseline).
   * Defaults to `'en-US'`, which restores byte-level RFC-041 baseline.
   */
  outputLang?: DistillerOutputLang
}

export function buildDistillerUserPrompt(input: BuildDistillerPromptInput): string {
  const budget = input.sourceContextBudget ?? DEFAULT_SOURCE_CONTEXT_BUDGET
  const emitClarifyTranscript = budget.clarifyTranscriptMaxBytes > 0
  const emitReviewBody = budget.reviewBodyMaxBytes > 0
  const lines: string[] = []
  lines.push('# Source events to distill')
  if (input.taskId !== null) {
    lines.push(`Task: ${input.taskId}`)
  }
  lines.push('')

  if (input.events.clarify.length > 0) {
    lines.push('## Clarify sessions')
    for (const ev of input.events.clarify) {
      lines.push(`### clarify:${ev.id} (node ${ev.nodeId})`)
      lines.push('Questions:')
      lines.push(stringifyForPrompt(ev.questions))
      lines.push('Answers:')
      lines.push(stringifyForPrompt(ev.answers))
      if (emitClarifyTranscript) {
        lines.push('Source agent transcript:')
        if (ev.sourceTranscriptMd !== null) {
          lines.push(ev.sourceTranscriptMd)
        } else {
          lines.push(
            `(source-agent transcript unavailable: ${ev.sourceTranscriptReason ?? 'unknown'})`,
          )
        }
      }
      lines.push('')
    }
  }

  if (input.events.review.length > 0) {
    lines.push('## Review decisions')
    for (const ev of input.events.review) {
      lines.push(`### review:${ev.id} (node ${ev.nodeId}, decision=${ev.decision})`)
      lines.push(`Source path: ${ev.bodyPath}`)
      if (emitReviewBody) {
        lines.push('Reviewed document body:')
        if (ev.reviewedBodyMd !== null) {
          lines.push('```markdown')
          lines.push(ev.reviewedBodyMd)
          lines.push('```')
        } else {
          lines.push(`(reviewed body unavailable: ${ev.reviewedBodyReason ?? 'unknown'})`)
        }
      }
      if (ev.comments.length > 0) {
        lines.push('Comments:')
        for (const c of ev.comments) {
          lines.push(`- (¶${c.anchorParagraphIdx}) on "${c.selectedText.slice(0, 80)}": ${c.body}`)
        }
      }
      lines.push('')
    }
  }

  if (input.events.feedback.length > 0) {
    lines.push('## Task feedback notes')
    for (const ev of input.events.feedback) {
      lines.push(`### feedback:${ev.id}`)
      lines.push(ev.bodyMd)
      lines.push('')
    }
  }

  lines.push('# Currently-approved memories (do not duplicate)')
  for (const sc of input.scopeContexts) {
    const id = sc.scopeId ?? 'null'
    lines.push(`## scope=${sc.scopeType}/${id} (tags: ${sc.tagPool.join(', ') || 'none'})`)
    if (sc.approved.length === 0) {
      lines.push('(none)')
    } else {
      for (const m of sc.approved) {
        lines.push(`- [${m.id}] ${m.title} — ${m.bodyMdHead}`)
      }
    }
    lines.push('')
  }

  lines.push(
    '# Instructions',
    'Emit exactly one <workflow-output> envelope. The "candidates" port carries the JSON shape documented in your system prompt. If nothing is worth distilling, emit `{"candidates": []}`.',
  )
  // RFC-050: append the output-language directive last so the model sees it
  // closest to its own generation point. The 'en-US' branch is byte-stable
  // — its inclusion is the only diff vs. the RFC-041 baseline prompt and
  // is harmless reinforcement of the system prompt's existing
  // English-by-default stance.
  const outputLang: DistillerOutputLang = input.outputLang ?? 'en-US'
  lines.push('', DISTILLER_OUTPUT_LANG_DIRECTIVE[outputLang])
  return lines.join('\n')
}

function stringifyForPrompt(s: string): string {
  // The clarify/review rows carry JSON-encoded blobs; pretty-print so the
  // model has a readable shape, but cap at 4kB per blob to keep budget
  // bounded.
  try {
    const obj = JSON.parse(s) as unknown
    return '```json\n' + JSON.stringify(obj, null, 2).slice(0, 4000) + '\n```'
  } catch {
    return '```\n' + s.slice(0, 4000) + '\n```'
  }
}

// -----------------------------------------------------------------------------
// Envelope parsing (candidates port)
// -----------------------------------------------------------------------------

export interface RawCandidate {
  scopeType: 'agent' | 'workflow' | 'repo' | 'global'
  scopeId: string | null
  title: string
  bodyMd: string
  knownTags?: string[]
  newTags?: string[]
  action: 'new' | 'update_of' | 'duplicate_of' | 'conflict_with'
  referenceMemoryId?: string | null
  sourceRefs?: Array<{ kind: 'clarify' | 'review' | 'feedback'; id: string }>
}

/**
 * Pull the `candidates` port content out of the last <workflow-output>
 * envelope and JSON-parse it. Returns [] for "envelope missing" / "port
 * missing" / "JSON malformed" — those are recorded as warnings, not
 * thrown, so a bad envelope produces an empty distill result rather than
 * a permanent failed job. Genuine spawn failures are still thrown.
 */
export function parseDistillerOutput(stdout: string): RawCandidate[] {
  // opencode --format json emits line-delimited JSON; each line is an event.
  // Concatenate text bodies, then pull the envelope.
  const buffer: string[] = []
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    let evt: Record<string, unknown> | null = null
    try {
      evt = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Not JSON — could be a test-only mock dumping the envelope verbatim
      // to stdout. Take it as-is.
      buffer.push(line)
      continue
    }
    if (evt === null) continue
    const text = extractEventText(evt)
    if (text !== null) buffer.push(text)
  }
  const text = buffer.join('')
  const envelope = extractLastEnvelope(text)
  if (envelope === null) {
    log.warn('no <workflow-output> envelope in distiller stdout')
    return []
  }
  const portMatch = envelope.match(
    /<port\s+name=(?:"candidates"|'candidates')\s*>([\s\S]*?)<\/port>/,
  )
  if (portMatch === null) {
    log.warn('distiller envelope missing "candidates" port')
    return []
  }
  let parsed: { candidates?: RawCandidate[] }
  try {
    parsed = JSON.parse(portMatch[1]!.trim()) as { candidates?: RawCandidate[] }
  } catch (err) {
    log.warn('distiller candidates JSON malformed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
  if (parsed.candidates === undefined) return []
  if (!Array.isArray(parsed.candidates)) return []
  return parsed.candidates
}

function extractEventText(evt: Record<string, unknown>): string | null {
  // opencode --format json (1.15.x) emits per-part events shaped like:
  //   { type: 'text', sessionID, messageID, part: { type: 'text', text: '...' }, timestamp }
  // We check this FIRST because it's what every real distiller run produces;
  // missing it caused the envelope to never reach extractLastEnvelope and
  // every candidate batch silently became `[]` (no memory rows linked back
  // to the job). Mirrors runner.ts::extractTextFromEvent so distiller and
  // worker-node tolerance stay in lockstep.
  const part = evt.part as Record<string, unknown> | undefined
  if (part && typeof part === 'object') {
    const ptype = part.type
    const ptext = part.text
    if (ptype === 'text' && typeof ptext === 'string') return ptext
  }
  // Legacy / synthetic / unit-test shapes we also accept.
  if (evt.type === 'text' && typeof evt.text === 'string') return evt.text
  const direct = evt.text
  if (typeof direct === 'string') return direct
  const message = evt.message
  if (typeof message === 'object' && message !== null) {
    const content = (message as Record<string, unknown>).content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const parts: string[] = []
      for (const item of content) {
        if (typeof item === 'string') parts.push(item)
        else if (typeof item === 'object' && item !== null) {
          const text = (item as Record<string, unknown>).text
          if (typeof text === 'string') parts.push(text)
        }
      }
      if (parts.length > 0) return parts.join('')
    }
  }
  const delta = evt.delta
  if (typeof delta === 'object' && delta !== null) {
    const text = (delta as Record<string, unknown>).text
    if (typeof text === 'string') return text
  }
  return null
}

// -----------------------------------------------------------------------------
// Candidate validation + persistence
// -----------------------------------------------------------------------------

export interface PersistedCandidate {
  memory: Memory
  raw: RawCandidate
}

/**
 * Validate one raw candidate and insert as status='candidate'. Returns
 * `null` on validation failure so the caller can log + skip rather than
 * fail the whole batch.
 */
export async function validateAndPersistCandidate(
  db: DbClient,
  raw: RawCandidate,
  job: MemoryDistillJob,
): Promise<PersistedCandidate | null> {
  // Coalesce tag lists to one array; distiller's newTags surface for admin
  // attention but live alongside knownTags in `tags`.
  const tags = Array.from(
    new Set(
      [...(raw.knownTags ?? []), ...(raw.newTags ?? [])].map((t) => t.trim()).filter(Boolean),
    ),
  ).slice(0, 16)

  const id = ulid()
  let memory: Memory
  try {
    memory = MemorySchema.parse({
      id,
      scopeType: raw.scopeType,
      scopeId: raw.scopeId,
      title: raw.title,
      bodyMd: raw.bodyMd,
      tags,
      status: 'candidate',
      sourceKind: job.sourceKind,
      sourceEventId: job.sourceEventId,
      sourceTaskId: job.taskId,
      distillJobId: job.id,
      distillAction: raw.action,
      supersedesId: null,
      supersededById: null,
      approvedByUserId: null,
      approvedAt: null,
      createdAt: Date.now(),
      version: 1,
    })
  } catch (err) {
    log.warn('candidate failed validation; skipping', {
      jobId: job.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  await db.insert(memories).values({
    id: memory.id,
    scopeType: memory.scopeType,
    scopeId: memory.scopeId,
    title: memory.title,
    bodyMd: memory.bodyMd,
    tags: JSON.stringify(memory.tags),
    status: 'candidate',
    sourceKind: memory.sourceKind,
    sourceEventId: memory.sourceEventId,
    sourceTaskId: memory.sourceTaskId,
    distillJobId: memory.distillJobId,
    distillAction: memory.distillAction,
    supersedesId: null,
    supersededById: null,
    approvedByUserId: null,
    approvedAt: null,
    createdAt: memory.createdAt,
    version: 1,
  })
  memoryBroadcaster.broadcast(MEMORY_CHANNEL, {
    type: 'memory.candidate.created',
    memory: {
      id: memory.id,
      scopeType: memory.scopeType,
      scopeId: memory.scopeId,
      title: memory.title,
      status: 'candidate',
      tags: memory.tags,
      approvedAt: null,
      version: 1,
      distillAction: memory.distillAction,
    },
  })
  return { memory, raw }
}

// -----------------------------------------------------------------------------
// Spawn helpers
// -----------------------------------------------------------------------------

/**
 * Real Bun.spawn-based distiller spawn. Held behind `spawnFn` so tests can
 * substitute a deterministic fake without paying for a subprocess.
 */
export async function defaultDistillerSpawn(
  input: DistillerSpawnInput,
): Promise<DistillerSpawnResult> {
  const opencodeBin = process.env.AGENT_WORKFLOW_OPENCODE_BIN ?? 'opencode'
  const cmd = [
    opencodeBin,
    'run',
    input.userPrompt,
    '--agent',
    DISTILLER_AGENT_NAME,
    '--format',
    'json',
    '--dangerously-skip-permissions',
  ]
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // See runner.ts for the full rationale — opencode 1.14.51+ resolves root
    // from `process.env.PWD` before `process.cwd()`, so PWD must match the
    // spawn cwd or `--format json` events go missing.
    PWD: input.cwd,
    OPENCODE_CONFIG_CONTENT: input.inlineConfigJson,
    OPENCODE_CONFIG_DIR: input.cwd,
  }
  const child = Bun.spawn({
    cmd,
    cwd: input.cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const timeoutHandle = setTimeout(() => {
    timedOut = true
    try {
      child.kill('SIGTERM')
    } catch {
      // already exited
    }
  }, input.timeoutMs)
  let exitCode: number | null
  try {
    exitCode = await child.exited
  } finally {
    clearTimeout(timeoutHandle)
  }
  const stdout = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  if (timedOut) {
    throw new Error(`distiller timeout after ${input.timeoutMs}ms`)
  }
  return { exitCode, stdout, stderr }
}

// -----------------------------------------------------------------------------
// Top-level orchestrator
// -----------------------------------------------------------------------------

export async function runDistill(options: RunDistillOptions): Promise<DistillResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const spawnFn = options.spawnFn ?? defaultDistillerSpawn

  const scope = options.job.scopeResolved
  const sourceContextBudget = options.sourceContextBudget ?? DEFAULT_SOURCE_CONTEXT_BUDGET
  const [events, scopeContexts] = await Promise.all([
    loadSourceEvents(options.db, options.siblings, sourceContextBudget),
    loadScopeContexts(options.db, scope),
  ])
  // RFC-050: read the language from the job row (snapshotted at enqueue
  // by the scheduler). We deliberately do NOT read `config.memoryDistillLang`
  // here — retries and merged-sibling reruns must all use the language the
  // batch started with, even if the admin flipped the setting mid-batch.
  const outputLang: DistillerOutputLang = options.job.outputLang ?? 'en-US'
  const userPrompt = buildDistillerUserPrompt({
    events,
    scopeContexts,
    taskId: options.job.taskId,
    sourceContextBudget,
    outputLang,
  })

  // RFC-043: persist the user prompt + dedup snapshot on the first
  // attempt so the admin detail page can show "what the distiller saw"
  // even if the subprocess errors out before any output. Subsequent
  // retries re-derive prompt-side context from events captured per
  // attempt; we do NOT overwrite the prompt on retry to preserve the
  // first-attempt audit trail.
  if (options.job.attempts === 0) {
    const dedupSnapshotJson = JSON.stringify({
      snapshot: buildDedupSnapshotForPersist(scopeContexts),
    })
    try {
      await options.db
        .update(memoryDistillJobs)
        .set({ userPromptMd: userPrompt, dedupSnapshotIdsJson: dedupSnapshotJson })
        .where(eq(memoryDistillJobs.id, options.job.id))
    } catch (err) {
      log.warn('rfc043/persist-prompt-failed', {
        jobId: options.job.id,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const inlineConfig: { agent: Record<string, Record<string, unknown>> } = {
    agent: {
      [DISTILLER_AGENT_NAME]: {
        prompt: DISTILLER_SYSTEM_PROMPT,
        ...(options.model !== undefined && options.model !== null ? { model: options.model } : {}),
      },
    },
  }
  const cwd = await mkdtemp(join(tmpdir(), 'aw-distiller-'))
  let result: DistillerSpawnResult
  try {
    result = await spawnFn({
      userPrompt,
      inlineConfigJson: JSON.stringify(inlineConfig),
      cwd,
      timeoutMs,
    })
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {
      // best-effort cleanup
    })
  }

  // RFC-043: stamp the post-spawn artefacts onto the job row before any
  // throw / capture. Failures here are non-fatal (logged); the original
  // success/failure semantics of runDistill are preserved.
  const sessionId = extractFirstSessionIdFromStdout(result.stdout)
  const stderrExcerpt = clipAndRedactStderr(result.stderr, 2048)
  try {
    await options.db
      .update(memoryDistillJobs)
      .set({
        opencodeSessionId: sessionId,
        exitCode: result.exitCode,
        stderrExcerpt,
      })
      .where(eq(memoryDistillJobs.id, options.job.id))
  } catch (err) {
    log.warn('rfc043/persist-spawn-result-failed', {
      jobId: options.job.id,
      err: err instanceof Error ? err.message : String(err),
    })
  }

  // RFC-043: capture conversation BEFORE the exit-code throw so failed
  // jobs still get whatever events opencode managed to write before
  // crashing. captureDistillJobSession never throws.
  if (sessionId !== null) {
    try {
      await captureDistillJobSession({
        db: options.db,
        distillJobId: options.job.id,
        attemptIndex: options.job.attempts,
        rootSessionId: sessionId,
      })
    } catch (err) {
      log.warn('rfc043/distill-capture-failed', {
        jobId: options.job.id,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (result.exitCode !== 0 && result.exitCode !== null) {
    throw new Error(
      `distiller subprocess exited with code ${result.exitCode}: ${result.stderr.slice(0, 400)}`,
    )
  }
  const rawCandidates = parseDistillerOutput(result.stdout)
  const persisted: string[] = []
  for (const raw of rawCandidates) {
    const ok = await validateAndPersistCandidate(options.db, raw, options.job)
    if (ok !== null) persisted.push(ok.memory.id)
  }
  return { candidatesCreated: persisted.length, createdMemoryIds: persisted }
}

// -----------------------------------------------------------------------------
// RFC-043 helpers
// -----------------------------------------------------------------------------

/**
 * Pull the first `sessionID` field out of opencode's --format json stdout.
 * Mirrors the inline extraction the worker-node runner does in
 * runner.ts:498-510. Lines that don't parse as JSON or lack the field
 * are skipped silently.
 */
export function extractFirstSessionIdFromStdout(stdout: string): string | null {
  if (typeof stdout !== 'string' || stdout.length === 0) return null
  const lines = stdout.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0) continue
    let evt: unknown
    try {
      evt = JSON.parse(line)
    } catch {
      continue
    }
    if (evt !== null && typeof evt === 'object') {
      const candidate = (evt as { sessionID?: unknown }).sessionID
      if (typeof candidate === 'string' && candidate.length > 0) return candidate
    }
  }
  return null
}

/**
 * Truncate + redact a stderr blob before persisting it on the job row.
 * `redactGitUrl` strips SSH / HTTPS credentials embedded in URLs; the
 * trailing slice keeps the column bounded for the detail page.
 *
 * Null/empty stderr becomes null (so the admin UI can detect "nothing
 * was written" vs. "we kept the first N bytes").
 */
export function clipAndRedactStderr(stderr: string, maxBytes: number): string | null {
  if (typeof stderr !== 'string') return null
  if (stderr.length === 0) return null
  const redacted = redactGitUrl(stderr)
  if (redacted.length <= maxBytes) return redacted
  return `${redacted.slice(0, maxBytes)}\n…(truncated; original ${redacted.length} bytes)`
}

/**
 * Reduce the scope-context bundle the distiller actually saw at run
 * time down to the minimal columns the detail page needs ({memoryId,
 * scopeType, scopeId, title}). Body is intentionally omitted — the
 * memories table remains the source of truth so detail page can re-
 * fetch full body for entries still alive.
 */
export function buildDedupSnapshotForPersist(scopeContexts: ScopeContext[]): Array<{
  memoryId: string
  scopeType: ScopeContext['scopeType']
  scopeId: string | null
  title: string
}> {
  const out: Array<{
    memoryId: string
    scopeType: ScopeContext['scopeType']
    scopeId: string | null
    title: string
  }> = []
  for (const ctx of scopeContexts) {
    for (const m of ctx.approved) {
      out.push({
        memoryId: m.id,
        scopeType: ctx.scopeType,
        scopeId: ctx.scopeId,
        title: m.title,
      })
    }
  }
  return out
}

// -----------------------------------------------------------------------------
// Row → MemoryDistillJob hydration (shared helper for scheduler tests)
// -----------------------------------------------------------------------------

interface DistillJobRow {
  id: string
  debounceKey: string
  sourceKind: 'clarify' | 'review' | 'feedback'
  sourceEventId: string
  taskId: string | null
  scopeResolvedJson: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'canceled'
  attempts: number
  nextRunAt: number
  lastError: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  outputLang?: string | null
}

export function rowToDistillJob(row: DistillJobRow): MemoryDistillJob {
  let scopeResolved: ResolvedDistillScope = {
    agentIds: [],
    workflowId: null,
    repoId: null,
    includeGlobal: true,
  }
  try {
    const parsed = JSON.parse(row.scopeResolvedJson) as Partial<ResolvedDistillScope>
    if (parsed && typeof parsed === 'object') {
      scopeResolved = {
        agentIds: Array.isArray(parsed.agentIds)
          ? parsed.agentIds.filter((x): x is string => typeof x === 'string')
          : [],
        workflowId: typeof parsed.workflowId === 'string' ? parsed.workflowId : null,
        repoId: typeof parsed.repoId === 'string' ? parsed.repoId : null,
        includeGlobal: parsed.includeGlobal !== false,
      }
    }
  } catch {
    // keep defaults
  }
  const outputLang =
    row.outputLang === 'zh-CN' || row.outputLang === 'en-US' ? row.outputLang : null
  return {
    id: row.id,
    debounceKey: row.debounceKey,
    sourceKind: row.sourceKind,
    sourceEventId: row.sourceEventId,
    taskId: row.taskId,
    scopeResolved,
    status: row.status,
    attempts: row.attempts,
    nextRunAt: row.nextRunAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    outputLang,
  }
}

export type DistillerSchema = typeof memoryDistillJobs
