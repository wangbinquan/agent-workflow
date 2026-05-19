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
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { Memory, MemoryDistillJob, ResolvedDistillScope } from '@agent-workflow/shared'
import { MemorySchema, redactGitUrl } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import {
  clarifySessions,
  docVersions,
  memories,
  memoryDistillJobs,
  reviewComments,
  taskFeedback,
} from '@/db/schema'
import { extractLastEnvelope } from '@/services/envelope'
import { captureDistillJobSession } from '@/services/distillSessionCapture'
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
 */
export const DISTILLER_SYSTEM_PROMPT = `You are aw-memory-distiller, an internal subsystem of the agent-workflow platform.

Your single task: read a batch of recent events (clarify Q&A, human review decisions, or task-feedback notes) and emit zero or more *candidate long-term memories* that future agents should learn from.

A good candidate memory:
- is a single, atomic, generalizable rule of thumb, decision, or preference — not a story.
- names a clear binding scope (one of: agent, workflow, repo, global).
- is written in plain English (regardless of the source language).
- is actionable for a future agent in similar situations.
- is at most ~400 characters.

A bad candidate (REJECT — emit nothing for it):
- is a fleeting status update, mood, or one-off acknowledgement.
- is a hallucination, restatement of the input verbatim, or pure paraphrase.
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
- Prefer existing tags exactly (case-sensitive lowercase-kebab).
- If you must introduce a new tag, list it in "newTags" not "knownTags". The admin decides whether to keep it.

Output exactly one <workflow-output> envelope with a single port "candidates" whose value is JSON matching this shape:

{
  "candidates": [
    {
      "scopeType": "agent" | "workflow" | "repo" | "global",
      "scopeId": "<id or null for global>",
      "title": "<= 120 chars",
      "bodyMd": "<= 400 chars, plain English",
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
  }>
  review: Array<{
    id: string
    taskId: string
    nodeId: string
    decision: string
    bodyPath: string
    comments: Array<{ body: string; anchorParagraphIdx: number; selectedText: string }>
  }>
  feedback: Array<{ id: string; taskId: string; bodyMd: string; createdAt: number }>
}

/**
 * Read every source event named in `jobs`. Best-effort — missing rows
 * (event was deleted between enqueue and run) are silently skipped so a
 * single bad row never poisons the rest of the batch.
 */
export async function loadSourceEvents(
  db: DbClient,
  jobs: MemoryDistillJob[],
): Promise<LoadedSourceEvents> {
  const clarifyIds = jobs.filter((j) => j.sourceKind === 'clarify').map((j) => j.sourceEventId)
  const reviewIds = jobs.filter((j) => j.sourceKind === 'review').map((j) => j.sourceEventId)
  const feedbackIds = jobs.filter((j) => j.sourceKind === 'feedback').map((j) => j.sourceEventId)

  const clarifyRows =
    clarifyIds.length > 0
      ? await db.select().from(clarifySessions).where(inArray(clarifySessions.id, clarifyIds))
      : []
  const reviewRows =
    reviewIds.length > 0
      ? await db.select().from(docVersions).where(inArray(docVersions.id, reviewIds))
      : []
  const feedbackRows =
    feedbackIds.length > 0
      ? await db.select().from(taskFeedback).where(inArray(taskFeedback.id, feedbackIds))
      : []

  // Comments are 1:N on doc_versions; one pass to fetch them all.
  const commentRows =
    reviewIds.length > 0
      ? await db
          .select()
          .from(reviewComments)
          .where(inArray(reviewComments.docVersionId, reviewIds))
          .orderBy(asc(reviewComments.anchorParagraphIdx), asc(reviewComments.anchorOffsetStart))
      : []
  const commentsByDv = new Map<
    string,
    Array<{ body: string; anchorParagraphIdx: number; selectedText: string }>
  >()
  for (const c of commentRows) {
    let bucket = commentsByDv.get(c.docVersionId)
    if (bucket === undefined) {
      bucket = []
      commentsByDv.set(c.docVersionId, bucket)
    }
    bucket.push({
      body: c.commentText,
      anchorParagraphIdx: c.anchorParagraphIdx,
      selectedText: c.selectedText,
    })
  }

  return {
    clarify: clarifyRows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      nodeId: r.clarifyNodeId,
      questions: r.questionsJson,
      answers: r.answersJson ?? '[]',
    })),
    review: reviewRows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      nodeId: r.reviewNodeId,
      decision: r.decision,
      bodyPath: r.bodyPath,
      comments: commentsByDv.get(r.id) ?? [],
    })),
    feedback: feedbackRows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      bodyMd: r.bodyMd,
      createdAt: r.createdAt,
    })),
  }
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
}

export function buildDistillerUserPrompt(input: BuildDistillerPromptInput): string {
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
      lines.push('')
    }
  }

  if (input.events.review.length > 0) {
    lines.push('## Review decisions')
    for (const ev of input.events.review) {
      lines.push(`### review:${ev.id} (node ${ev.nodeId}, decision=${ev.decision})`)
      lines.push(`(reviewed body lives at ${ev.bodyPath})`)
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
  const [events, scopeContexts] = await Promise.all([
    loadSourceEvents(options.db, options.siblings),
    loadScopeContexts(options.db, scope),
  ])
  const userPrompt = buildDistillerUserPrompt({
    events,
    scopeContexts,
    taskId: options.job.taskId,
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
  }
}

export type DistillerSchema = typeof memoryDistillJobs
