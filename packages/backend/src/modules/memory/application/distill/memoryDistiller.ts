// RFC-041 — memory distiller (PR2 scope)。RFC-352（RFC-294 W4-E2）把它从
// `services/memoryDistiller.ts` 整体迁进 memory 模块（模块不再向 legacy 借自己的实现），
// 随后逐块下沉：提示词常量已进 `domain/distillPrompt.ts`。
// **迁位与下沉分两步做**：1274 行一次性按行区间猜切会切错边界（`runDistill` 自己就建
// 一次性 worktree，不只在 spawn 里），所以改成「先整体迁位、再逐块抽、每抽一块 typecheck」。
// RFC-041 — memory distiller (PR2 scope).
//
// The distiller is a *system* runtime agent — not stored in the `agents` table
// and not user-editable. It runs naturally in a throwaway scratch worktree (so
// distillation never creates a git diff in a real worktree).
//
// RFC-367 rewired two things here:
//   · the run goes through the shared `runSystemAgent` primitive (intent /
//     change-narrative precedent), so the candidate parse reads the SAME
//     normalized event stream the session tab is built from. The old split —
//     candidates from a 256KB stdout tail, conversation from a post-run SQLite
//     walk — drifted twice and silently dropped every candidate for a month
//     (see RFC-367 proposal §1).
//   · an output-protocol failure is no longer a `log.warn` + empty result. It
//     re-asks IN THE SAME SESSION (the worker-node follow-up machinery), and
//     after the retry budget the job FAILS with a reason — the scheduler then
//     records `memory_distill_jobs.last_error` and backs off.
//
// Still swallowed on purpose: a single zod-invalid candidate when the rest of
// the batch is salvageable. If NONE survive, that is a failure (AC-14).
//
// Tests inject `runFn` to skip the real subprocess.

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { ulid } from 'ulid'
import type {
  DistillSourceKind,
  Memory,
  MemoryDistillJob,
  ParseSessionInputEvent,
  ResolvedDistillScope,
  SourceContextBudget,
} from '@agent-workflow/shared'
import {
  awInputProtocolNote,
  buildProtocolBlock,
  DEFAULT_PROTOCOL_RETRY_BUDGET,
  DEFAULT_SOURCE_CONTEXT_BUDGET,
  type EnvelopeFollowupReason,
  fenceUntrusted,
  renderEnvelopeFollowupPrompt,
  MemorySchema,
  parseSessionTree,
  redactGitUrl,
} from '@agent-workflow/shared'
import { readNodeRunPrompt } from '@/services/nodeRunPrompt'
import { Paths } from '@/util/paths'
import type { RuntimeKind, SystemAgentOutputEvidence } from '@/services/runtime/types'
import {
  classifyMissingEnvelope,
  releaseSystemAgentScratch,
  runSystemAgent,
  type SystemAgentRunOptions,
  type SystemAgentRunResult,
} from '@/services/systemAgentRun'
import {
  DistillerProtocolError,
  parseDistillerCandidates,
  type DistillProtocolFailureCode,
  type RawCandidate,
} from './distillerOutput'
import { generateEnvelopeNonce } from '@/services/nodeRunMint'
import { clipHeadTail, renderSessionTreeToDistillerMd } from '@/modules/memory/domain/sourceContext'
import { MEMORY_CHANNEL, memoryBroadcaster } from '@/ws/broadcaster'
import { createLogger } from '@/util/log'
import type {
  MemoryDistillClarifyWorkRecord,
  MemoryDistillReviewedArtifactReader,
  MemoryDistillWorkStore,
} from '@/modules/memory/application/ports/distillWorkStore'

import {
  DISTILLER_AGENT_NAME,
  DISTILLER_OUTPUT_LANG_DIRECTIVE,
  DISTILLER_SYSTEM_PROMPT,
  type DistillerOutputLang,
} from '@/modules/memory/domain/distillPrompt'

// 迁位期兼容：既有 consumer（调度器与多条测试）仍从这里取提示词常量。
export {
  DISTILLER_AGENT_NAME,
  DISTILLER_OUTPUT_LANG_DIRECTIVE,
  DISTILLER_SYSTEM_PROMPT,
  type DistillerOutputLang,
}

const log = createLogger('memory-distiller')

// 一次蒸馏 = 一个 runtime 子进程跑完整个 LLM 轮次，输入是一批合并的
// clarify / review / feedback 事件。原先是 120_000（2 分钟），对这个体量明显偏短：
// 超时按失败计，整批退避重试，已经烧掉的 token 白花。默认改为 1 小时（用户
// 2026-09-21 指定），并可由 `config.memoryDistillTimeoutMs` 覆盖（设置页
// 「系统代理 · 记忆蒸馏」，边界见 SETTINGS_NUMERIC_BOUNDS.memoryDistillTimeoutMs）。
const DEFAULT_TIMEOUT_MS = 3_600_000

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface DistillResult {
  candidatesCreated: number
  /** ids of memory rows that were inserted (status='candidate'). */
  createdMemoryIds: string[]
}

export interface RunDistillOptions {
  store: MemoryDistillWorkStore
  reviewedArtifacts: MemoryDistillReviewedArtifactReader
  job: MemoryDistillJob
  /**
   * Sibling jobs sharing the same debounce_key that the scheduler decided
   * to merge into this batch. Always includes `job` itself. The distiller
   * lists all source events from these in one user prompt.
   */
  siblings: MemoryDistillJob[]
  /**
   * RFC-367 test seam — defaults to `runSystemAgent`. Same shape intent /
   * change-narrative use, so a fake here is a fake everywhere.
   */
  runFn?: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
  /**
   * `config.memoryDistillTimeoutMs`, default `DEFAULT_TIMEOUT_MS` (1 hour).
   * RFC-367 §3.2: this is the budget for the WHOLE distill — the first round
   * plus every protocol follow-up share it, so a doomed batch cannot occupy
   * the single-flight distill queue for 4× the configured time.
   */
  timeoutMs?: number
  /**
   * RFC-117 — resolved runtime for the distiller. `protocol` (which driver),
   * `runtimeBinary` (custom fork) and `model` all come from the runtime profile
   * selected via `config.memoryDistillRuntime` (or the global default); the
   * scheduler resolves the profile and plumbs these through. Omitted → opencode
   * with the binary's own default model (legacy behavior).
   */
  protocol?: RuntimeKind
  runtimeBinary?: string | null
  /** Model from the resolved runtime profile; null → the runtime's own default. */
  model?: string | null
  /** RFC-276: opt-in Claude CLI compatibility marker. */
  isSandbox?: boolean
  /**
   * RFC-044: per-source byte budget for the new transcript / body context
   * blocks. Plumbed by the scheduler from `config.memoryDistillSourceContext`.
   * Defaults to DEFAULT_SOURCE_CONTEXT_BUDGET — passing 0 fields disables the
   * corresponding block.
   */
  sourceContextBudget?: SourceContextBudget
  /** RFC-200 deterministic test seam; production generates a fresh value per attempt. */
  envelopeNonce?: string
}

export class IndeterminateRuntimeProcessError extends Error {
  constructor(message = 'runtime spawn state is indeterminate') {
    super(message)
    this.name = 'IndeterminateRuntimeProcessError'
  }
}

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
  /** RFC-366: one settled agent node_run per entry. */
  agentRun: Array<{
    id: string
    taskId: string
    nodeId: string
    agentName: string | null
    status: string
    durationMs: number | null
    failureCode: string | null
    errorMessage: string | null
    promptMd: string | null
    /** Approved memories this run already had injected (RFC-046 snapshot). */
    injectedMemories: Array<{ scopeType: string; title: string; bodyMdHead: string }>
    injectedMemoriesReason: string | null
    transcriptMd: string | null
    transcriptReason: string | null
    outputs: Array<{ portName: string; kind: string | null; content: string }>
  }>
  /** RFC-366: one settled task per entry. */
  taskRun: Array<{
    id: string
    name: string
    status: string
    durationMs: number
    errorSummary: string | null
    errorMessage: string | null
    failedNodeId: string | null
    inputsMd: string
    nodeOutcomes: Array<{ nodeId: string; status: string; retryIndex: number }>
    finalOutputs: Array<{ nodeId: string; portName: string; content: string }>
  }>
}

/**
 * Read every source event named in `jobs`. Best-effort — missing rows
 * (event was deleted between enqueue and run) are silently skipped so a
 * single bad row never poisons the rest of the batch.
 *
 * RFC-044: when the optional `budget` argument is passed, the loader also
 * fetches the source-agent transcript for clarify rows (via
 * `clarify_sessions.source_agent_node_run_id` → `node_run_events`) and the
 * reviewed document body for review rows (`docVersions.bodyPath` file).
 * Each extra read is best-effort: on failure the corresponding `*Md` field
 * is null and the `*Reason` field carries a short string the builder prints
 * as a placeholder line — the distiller still runs, degraded to RFC-041
 * fidelity for that one source.
 */
export async function loadSourceEvents(
  store: MemoryDistillWorkStore,
  reviewedArtifacts: MemoryDistillReviewedArtifactReader,
  jobs: MemoryDistillJob[],
  budget: SourceContextBudget = DEFAULT_SOURCE_CONTEXT_BUDGET,
): Promise<LoadedSourceEvents> {
  const clarifyIds = jobs.filter((j) => j.sourceKind === 'clarify').map((j) => j.sourceEventId)
  const reviewIds = jobs.filter((j) => j.sourceKind === 'review').map((j) => j.sourceEventId)
  const feedbackIds = jobs.filter((j) => j.sourceKind === 'feedback').map((j) => j.sourceEventId)
  // RFC-366: agent-run's sourceEventId is a node_run id, task-run's is a task id.
  const agentRunIds = jobs.filter((j) => j.sourceKind === 'agent-run').map((j) => j.sourceEventId)
  const taskRunIds = jobs.filter((j) => j.sourceKind === 'task-run').map((j) => j.sourceEventId)

  const [clarifyRows, reviewRows, feedbackRows] = await Promise.all([
    store.listClarifySources(clarifyIds),
    store.listReviewSources(reviewIds),
    store.listFeedbackSources(feedbackIds),
  ])

  // Comments are 1:N on doc_versions; one pass to fetch them all.
  const commentRows = await store.listReviewComments(reviewIds)
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
      body: c.body,
      anchorParagraphIdx: c.anchorParagraphIdx,
      selectedText: c.selectedText,
    })
  }

  const transcriptsByClarifyId = await loadClarifyTranscripts(store, clarifyRows, budget)
  const reviewBodiesByDvId = await loadReviewBodies(reviewedArtifacts, reviewRows, budget)
  const agentRun = await loadAgentRunSources(store, agentRunIds, budget)
  const taskRun = await loadTaskRunSources(store, taskRunIds, budget)

  return {
    agentRun,
    taskRun,
    clarify: clarifyRows.map((r) => {
      const t = transcriptsByClarifyId.get(r.id) ?? {
        md: null,
        reason: 'disabled by config',
      }
      return {
        id: r.id,
        taskId: r.taskId,
        nodeId: r.intermediaryNodeId,
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
  store: MemoryDistillWorkStore,
  clarifyRows: readonly MemoryDistillClarifyWorkRecord[],
  budget: SourceContextBudget,
): Promise<Map<string, SourceContextResult>> {
  const out = new Map<string, SourceContextResult>()
  if (budget.clarifyTranscriptMaxBytes === 0 || clarifyRows.length === 0) return out

  const sourceRunIds = [
    ...new Set(clarifyRows.flatMap((r) => (r.askingNodeRunId !== null ? [r.askingNodeRunId] : []))),
  ]
  const byRun = await renderNodeRunTranscripts(
    store,
    sourceRunIds,
    budget.clarifyTranscriptMaxBytes,
  )
  for (const c of clarifyRows) {
    out.set(
      c.id,
      c.askingNodeRunId === null
        ? { md: null, reason: 'source node_run not found' }
        : (byRun.get(c.askingNodeRunId) ?? { md: null, reason: 'source node_run not found' }),
    )
  }
  return out
}

/**
 * RFC-366 — load one `agent-run` source per settled node_run.
 *
 * Three blocks, each independently budgeted and each degrading on its own:
 * the run's transcript, the ports it emitted, and the approved memories that
 * were injected INTO it. The last one is what lets the distiller answer "is this
 * already known?" instead of re-proposing a memory the agent was handed.
 *
 * The agent's display name comes from the task's workflow snapshot (node_runs
 * has no agent column). A name-only or quarantined node yields null, and the
 * prompt just prints the node id — the transcript carries the real context.
 */
async function loadAgentRunSources(
  store: MemoryDistillWorkStore,
  ids: readonly string[],
  budget: SourceContextBudget,
): Promise<LoadedSourceEvents['agentRun']> {
  if (ids.length === 0) return []
  const rows = await store.listAgentRunSources(ids)
  if (rows.length === 0) return []
  const transcripts = await renderNodeRunTranscripts(
    store,
    rows.map((r) => r.id),
    budget.agentTranscriptMaxBytes,
  )
  const outputRows =
    budget.agentOutputsMaxBytes === 0 ? [] : await store.listNodeRunOutputs(rows.map((r) => r.id))
  const outputsByRun = new Map<string, LoadedSourceEvents['agentRun'][number]['outputs']>()
  for (const row of outputRows) {
    const bucket = outputsByRun.get(row.nodeRunId) ?? []
    bucket.push({
      portName: row.portName,
      kind: row.kind,
      content: clipHeadTail(row.content, budget.agentOutputsMaxBytes),
    })
    outputsByRun.set(row.nodeRunId, bucket)
  }
  // Agent display names come from each task's frozen snapshot, read once per task.
  const taskIds = [...new Set(rows.map((r) => r.taskId))]
  const snapshots = new Map<string, string>()
  for (const taskId of taskIds) {
    const scope = await store.findTaskScope(taskId)
    if (scope !== null) snapshots.set(taskId, scope.workflowSnapshot)
  }
  return rows.map((row) => {
    const transcript = transcripts.get(row.id) ?? { md: null, reason: 'disabled by config' }
    const injected = readInjectedMemories(row.injectedMemoriesJson, budget)
    return {
      id: row.id,
      taskId: row.taskId,
      nodeId: row.nodeId,
      agentName: agentNameOfSnapshotNode(snapshots.get(row.taskId) ?? null, row.nodeId),
      status: row.status,
      durationMs:
        row.startedAt !== null && row.finishedAt !== null ? row.finishedAt - row.startedAt : null,
      failureCode: row.failureCode,
      errorMessage: row.errorMessage,
      promptMd: readNodeRunPrompt(row),
      injectedMemories: injected.entries,
      injectedMemoriesReason: injected.reason,
      transcriptMd: transcript.md,
      transcriptReason: transcript.reason,
      outputs: outputsByRun.get(row.id) ?? [],
    }
  })
}

/**
 * RFC-366 — the `agent-run` block's "already known" list.
 *
 * `node_runs.injected_memories_json` is written by the RFC-046 injection step.
 * Shape drift or a truncated write must not cost us the whole source, so a parse
 * failure degrades to a reason string exactly like the transcript does.
 */
function readInjectedMemories(
  json: string | null,
  budget: SourceContextBudget,
): {
  entries: LoadedSourceEvents['agentRun'][number]['injectedMemories']
  reason: string | null
} {
  if (budget.agentInjectedMemoriesMaxBytes === 0)
    return { entries: [], reason: 'disabled by config' }
  if (json === null) return { entries: [], reason: null }
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (err) {
    return { entries: [], reason: `unreadable: ${err instanceof Error ? err.message : 'parse'}` }
  }
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown[] }).items
      : null
  if (list === null) return { entries: [], reason: 'unreadable: unexpected snapshot shape' }
  const entries: LoadedSourceEvents['agentRun'][number]['injectedMemories'] = []
  let used = 0
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const title = typeof record.title === 'string' ? record.title : null
    if (title === null) continue
    const scopeType = typeof record.scopeType === 'string' ? record.scopeType : 'unknown'
    const body = typeof record.bodyMd === 'string' ? record.bodyMd : ''
    const entry = { scopeType, title, bodyMdHead: body.slice(0, 200) }
    used += title.length + entry.bodyMdHead.length
    if (used > budget.agentInjectedMemoriesMaxBytes) break
    entries.push(entry)
  }
  return { entries, reason: null }
}

/** RFC-366 — display name for a snapshot node; null when it cannot be named. */
function agentNameOfSnapshotNode(workflowSnapshot: string | null, nodeId: string): string | null {
  if (workflowSnapshot === null) return null
  let parsed: { nodes?: Array<Record<string, unknown>> } = {}
  try {
    parsed = JSON.parse(workflowSnapshot) as typeof parsed
  } catch {
    return null
  }
  for (const node of parsed.nodes ?? []) {
    if (typeof node !== 'object' || node === null) continue
    if (node.id !== nodeId) continue
    return typeof node.agentName === 'string' && node.agentName.length > 0 ? node.agentName : null
  }
  return null
}

/**
 * RFC-366 — load one `task-run` source per settled task.
 *
 * Deliberately NOT a transcript dump: every agent in the task already produced
 * its own `agent-run` source with its full session (D1 + D6), so repeating them
 * here would pay twice for the same tokens. What this block adds is the shape of
 * the whole run — what it was asked to do, which nodes ended how, what came out
 * the far end.
 */
async function loadTaskRunSources(
  store: MemoryDistillWorkStore,
  ids: readonly string[],
  budget: SourceContextBudget,
): Promise<LoadedSourceEvents['taskRun']> {
  if (ids.length === 0) return []
  const rows = await store.listTaskRunSources(ids)
  if (rows.length === 0) return []
  const statuses = await store.listTaskNodeStatuses(rows.map((r) => r.id))
  const byTask = new Map<string, LoadedSourceEvents['taskRun'][number]['nodeOutcomes']>()
  for (const row of statuses) {
    const bucket = byTask.get(row.taskId) ?? []
    bucket.push({ nodeId: row.nodeId, status: row.status, retryIndex: row.retryIndex })
    byTask.set(row.taskId, bucket)
  }
  // The final outputs are the OUTPUT nodes' ports — the task's actual product.
  // Reading every node's ports instead would just restate the agent-run blocks.
  const outputNodeIdsByTask = new Map<string, Set<string>>()
  for (const row of rows) outputNodeIdsByTask.set(row.id, outputNodeIds(row.workflowSnapshot))
  const outputRuns = statuses.filter((row) =>
    (outputNodeIdsByTask.get(row.taskId) ?? new Set<string>()).has(row.nodeId),
  )
  const ownerOfRun = new Map(outputRuns.map((row) => [row.nodeRunId, row] as const))
  const portRows =
    outputRuns.length === 0
      ? []
      : await store.listNodeRunOutputs(outputRuns.map((row) => row.nodeRunId))
  const finalOutputsByTask = new Map<
    string,
    LoadedSourceEvents['taskRun'][number]['finalOutputs']
  >()
  for (const port of portRows) {
    const owner = ownerOfRun.get(port.nodeRunId)
    if (owner === undefined) continue
    const bucket = finalOutputsByTask.get(owner.taskId) ?? []
    bucket.push({
      nodeId: owner.nodeId,
      portName: port.portName,
      content: clipHeadTail(port.content, budget.taskSummaryMaxBytes),
    })
    finalOutputsByTask.set(owner.taskId, bucket)
  }
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    durationMs: row.runningMs,
    errorSummary: row.errorSummary,
    errorMessage: row.errorMessage,
    failedNodeId: row.failedNodeId,
    inputsMd: clipHeadTail(row.inputs, budget.taskSummaryMaxBytes),
    nodeOutcomes: byTask.get(row.id) ?? [],
    finalOutputs: finalOutputsByTask.get(row.id) ?? [],
  }))
}

/** RFC-366 — ids of the workflow snapshot's `output` nodes. */
function outputNodeIds(workflowSnapshot: string): Set<string> {
  const ids = new Set<string>()
  let parsed: { nodes?: Array<Record<string, unknown>> } = {}
  try {
    parsed = JSON.parse(workflowSnapshot) as typeof parsed
  } catch {
    return ids
  }
  for (const node of parsed.nodes ?? []) {
    if (typeof node !== 'object' || node === null) continue
    if (node.kind !== 'output') continue
    if (typeof node.id === 'string') ids.add(node.id)
  }
  return ids
}

/**
 * RFC-366 (T13) — render a batch of node_runs' sessions into distiller markdown.
 *
 * Lifted verbatim out of {@link loadClarifyTranscripts} so the `agent-run` source
 * renders through the SAME code path. Two callers reading `node_run_events` with
 * two copies of the parse/clip pipeline is how the clarify block and the agent
 * block would end up formatted differently for no reason anybody could name.
 *
 * Returns one entry per requested id; a run that cannot be rendered gets a null
 * `md` plus the human-readable `reason` the prompt prints as a placeholder.
 */
async function renderNodeRunTranscripts(
  store: MemoryDistillWorkStore,
  runIds: readonly string[],
  maxBytes: number,
): Promise<Map<string, SourceContextResult>> {
  const out = new Map<string, SourceContextResult>()
  if (runIds.length === 0 || maxBytes === 0) return out
  const runRows = await store.listNodeRuns(runIds)
  const runById = new Map(runRows.map((r) => [r.id, r] as const))
  const eventRows = await store.listNodeRunEvents(runIds)
  const eventsByRun = new Map<string, ParseSessionInputEvent[]>()
  for (const e of eventRows) {
    const list = eventsByRun.get(e.nodeRunId) ?? []
    list.push({
      id: e.id,
      ts: e.ts,
      kind: e.kind,
      payload: e.payload,
      sessionId: e.sessionId,
      parentSessionId: e.parentSessionId,
    })
    eventsByRun.set(e.nodeRunId, list)
  }
  for (const runId of runIds) {
    const run = runById.get(runId)
    if (run === undefined) {
      out.set(runId, { md: null, reason: 'source node_run not found' })
      continue
    }
    const events = eventsByRun.get(run.id) ?? []
    if (events.length === 0) {
      out.set(runId, { md: null, reason: 'no events captured for source node_run' })
      continue
    }
    try {
      // node_runs has no agent_id column; agent identity is by workflow
      // node lookup (out of scope here). Render with a neutral name — the
      // transcript content itself carries the context the distiller needs.
      const tree = parseSessionTree({
        rootSessionId: run.opencodeSessionId,
        promptText: readNodeRunPrompt(run),
        startedAt: run.startedAt,
        primaryAgentName: 'agent',
        events,
      })
      out.set(runId, {
        md: clipHeadTail(renderSessionTreeToDistillerMd(tree), maxBytes),
        reason: null,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      out.set(runId, { md: null, reason: `parse-failed: ${msg}` })
    }
  }
  return out
}

/**
 * RFC-044: read each `docVersions.bodyPath` markdown file (relative to
 * appHome) and clip to the budget. Skipped when the budget is 0; per-row
 * read failures degrade to a null + reason pair so the builder can render a
 * placeholder line.
 */
async function loadReviewBodies(
  reviewedArtifacts: MemoryDistillReviewedArtifactReader,
  reviewRows: readonly { id: string; bodyPath: string }[],
  budget: SourceContextBudget,
): Promise<Map<string, SourceContextResult>> {
  const out = new Map<string, SourceContextResult>()
  if (budget.reviewBodyMaxBytes === 0 || reviewRows.length === 0) return out
  for (const r of reviewRows) {
    try {
      const text = await reviewedArtifacts.read(r.bodyPath)
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
  store: MemoryDistillWorkStore,
  scope: ResolvedDistillScope,
): Promise<ScopeContext[]> {
  const out: ScopeContext[] = []
  for (const agentId of scope.agentIds) {
    out.push(await loadOne(store, 'agent', agentId))
  }
  if (scope.workflowId !== null) {
    out.push(await loadOne(store, 'workflow', scope.workflowId))
  }
  if (scope.repoId !== null) {
    out.push(await loadOne(store, 'repo', scope.repoId))
  }
  if (scope.includeGlobal) {
    out.push(await loadOne(store, 'global', null))
  }
  return out
}

async function loadOne(
  store: MemoryDistillWorkStore,
  scopeType: 'agent' | 'workflow' | 'repo' | 'global',
  scopeId: string | null,
): Promise<ScopeContext> {
  const rows = await store.listApprovedMemories(scopeType, scopeId)
  const tagBag = new Set<string>()
  const approved = rows.map((r) => {
    let tags: string[] = []
    try {
      const parsed = JSON.parse(r.tagsJson) as unknown
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
  /** RFC-200: absent preserves the pre-RFC-200 prompt bytes for direct callers. */
  envelopeNonce?: string
}

export function buildDistillerUserPrompt(input: BuildDistillerPromptInput): string {
  const envelopeNonce = input.envelopeNonce ?? ''
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

  // RFC-366 —— agent 运行结束。
  if (input.events.agentRun.length > 0) {
    lines.push('## Finished agent runs')
    for (const ev of input.events.agentRun) {
      const who = ev.agentName ?? ev.nodeId
      lines.push(`### agent-run:${ev.id} (agent ${who}, node ${ev.nodeId}, status=${ev.status})`)
      if (ev.durationMs !== null) lines.push(`Duration: ${ev.durationMs}ms`)
      if (ev.failureCode !== null) lines.push(`Failure code: ${ev.failureCode}`)
      if (ev.promptMd !== null) {
        lines.push('Node prompt:')
        lines.push(ev.promptMd)
      }
      // 先摆「本次运行已经知道的记忆」，再摆过程：模型读到过程时，已有记忆就在上文，
      // 于是「这条是不是已经有了」是个回看问题，而不是要它凭空回忆。
      if (ev.injectedMemoriesReason !== null) {
        lines.push(`Memories already injected into this run: (${ev.injectedMemoriesReason})`)
      } else if (ev.injectedMemories.length > 0) {
        lines.push('Memories already injected into this run (do NOT re-propose these as new):')
        for (const m of ev.injectedMemories) {
          lines.push(`- [${m.scopeType}] ${m.title} — ${m.bodyMdHead}`)
        }
      }
      lines.push('Agent transcript:')
      if (ev.transcriptMd !== null) {
        lines.push(ev.transcriptMd)
      } else {
        lines.push(`(agent transcript unavailable: ${ev.transcriptReason ?? 'unknown'})`)
      }
      if (ev.outputs.length > 0) {
        lines.push('Outputs:')
        for (const o of ev.outputs) {
          lines.push(`- port "${o.portName}"${o.kind === null ? '' : ` (${o.kind})`}: ${o.content}`)
        }
      }
      if (ev.errorMessage !== null) {
        lines.push('Error:')
        lines.push(ev.errorMessage)
      }
      lines.push('')
    }
  }

  // RFC-366 —— 任务执行结束。没有 transcript：本任务里每个 agent 的会话已经各自
  // 作为 agent-run 源喂过一遍（D6），这里只补「整次执行长什么样」。
  if (input.events.taskRun.length > 0) {
    lines.push('## Finished task executions')
    for (const ev of input.events.taskRun) {
      lines.push(`### task-run:${ev.id} (${ev.name}, status=${ev.status})`)
      lines.push(`Duration: ${ev.durationMs}ms`)
      if (ev.failedNodeId !== null) lines.push(`Failed node: ${ev.failedNodeId}`)
      if (ev.errorSummary !== null) lines.push(`Error summary: ${ev.errorSummary}`)
      if (ev.errorMessage !== null) lines.push(`Error: ${ev.errorMessage}`)
      lines.push('Launch inputs:')
      lines.push(stringifyForPrompt(ev.inputsMd))
      if (ev.nodeOutcomes.length > 0) {
        lines.push('Node outcomes:')
        for (const n of ev.nodeOutcomes) {
          lines.push(`- ${n.nodeId}: ${n.status} (retry ${n.retryIndex})`)
        }
      }
      if (ev.finalOutputs.length > 0) {
        lines.push('Final outputs:')
        for (const o of ev.finalOutputs) {
          lines.push(`- node "${o.nodeId}" port "${o.portName}": ${o.content}`)
        }
      }
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

  if (envelopeNonce.length > 0) {
    const sourceContext = lines.join('\n')
    lines.length = 0
    lines.push(
      `**Untrusted input boundary.** ${awInputProtocolNote(envelopeNonce)}`,
      '',
      fenceUntrusted('memory-distill-source-context', sourceContext, envelopeNonce),
      '',
    )
  }

  // RFC-367: the reply-format instruction is the shared `buildProtocolBlock`
  // that every worker node gets — it renders the literal `Format:` example
  // (`<port name="candidates">...</port>` + the closing tag), which this prompt
  // never showed before. 2026-09-21 production forensics: ten consecutive runs
  // emitted a bare envelope with no port wrapper (two of them mis-spelling the
  // tag as `<wf-output>` / `<wflow-output>`), and every candidate was dropped.
  // Giving only the opening tag was not enough for a mid-tier model to
  // reconstruct the rest.
  lines.push('# Instructions', buildProtocolBlock(['candidates'], undefined, envelopeNonce).trim())
  lines.push(
    'The "candidates" port carries the JSON shape documented in your system prompt. If nothing is worth distilling, emit `{"candidates": []}` INSIDE that port — the envelope and the port tag are required either way.',
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

// RFC-367: `RawCandidate` 与新的判别式解析一起搬到 `distillerOutput.ts`（纯函数单独成文件，
// 便于直接断言）。这里按既有 import 路径原样转出，调用方不动。
export type {
  DistillerOutputParse,
  DistillProtocolFailureCode,
  RawCandidate,
} from './distillerOutput'
export { DistillerProtocolError, parseDistillerCandidates } from './distillerOutput'

// RFC-367: the candidates parser moved to `distillerOutput.ts` and now takes
// ALREADY-normalized assistant text (`runSystemAgent`'s `eventText`). The old
// per-line `driver.parseEvent` walk that lived here is gone — normalization has
// exactly one owner again, the executor's pump.

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
  store: MemoryDistillWorkStore,
  raw: RawCandidate,
  job: MemoryDistillJob,
  /**
   * RFC-367 AC-14: the caller needs the rejection reason to decide whether the
   * whole batch was lost (N emitted, 0 persisted → a failed job, not a green
   * zero-candidate one). Optional so existing callers are unaffected.
   */
  onReject?: (reason: string) => void,
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
      fusedIntoSkillId: null,
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log.warn('candidate failed validation; skipping', { jobId: job.id, error: reason })
    onReject?.(reason)
    return null
  }

  await store.insertCandidate({ memory })
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
      fusedIntoSkillId: null,
    },
  })
  return { memory, raw }
}

// -----------------------------------------------------------------------------
// Spawn helpers
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Top-level orchestrator
// -----------------------------------------------------------------------------

export async function runDistill(options: RunDistillOptions): Promise<DistillResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const runFn = options.runFn ?? runSystemAgent

  const scope = options.job.scopeResolved
  const sourceContextBudget = options.sourceContextBudget ?? DEFAULT_SOURCE_CONTEXT_BUDGET
  const [events, scopeContexts] = await Promise.all([
    loadSourceEvents(
      options.store,
      options.reviewedArtifacts,
      options.siblings,
      sourceContextBudget,
    ),
    loadScopeContexts(options.store, scope),
  ])
  // RFC-050: read the language from the job row (snapshotted at enqueue
  // by the scheduler). We deliberately do NOT read `config.memoryDistillLang`
  // here — retries and merged-sibling reruns must all use the language the
  // batch started with, even if the admin flipped the setting mid-batch.
  const outputLang: DistillerOutputLang = options.job.outputLang ?? 'en-US'
  const envelopeNonce = options.envelopeNonce ?? generateEnvelopeNonce()
  const userPrompt = buildDistillerUserPrompt({
    events,
    scopeContexts,
    taskId: options.job.taskId,
    sourceContextBudget,
    outputLang,
    envelopeNonce,
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
      await options.store.savePrompt(options.job.id, userPrompt, dedupSnapshotJson)
    } catch (err) {
      log.warn('rfc043/persist-prompt-failed', {
        jobId: options.job.id,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const protocol: RuntimeKind = options.protocol ?? 'opencode'
  // RFC-280 T4/T5（落差⑤）：appHome scratch，不再 OS tmpdir —— GC 归属确定
  // （`runScratchOrphanGc` 24h 兜底）。RFC-367：**整条补问链共用这一个** ——
  // claude 的 transcript 按 cwd-slug 归档，换 cwd 就等于换项目目录，`--resume`
  // 会落空（RFC-111 design §225/283/298 实测）。
  const scratchParent = join(Paths.root, 'scratch')
  const scratchName = `distiller-${randomBytes(8).toString('hex')}`
  // RFC-367: one sink for the whole attempt (all follow-up rounds share the
  // session, so they share the record). The store owns the DB, so it owns the
  // writer; `runDistill` only hands it to the runtime.
  const eventSink = options.store.eventSinkFor({
    distillJobId: options.job.id,
    attemptIndex: options.job.attempts,
  })

  // RFC-367 §3.2：`timeoutMs` 是**整次蒸馏（含全部补问轮）**的总额度，不是单轮额度。
  // 否则一个 tick 最多 5 个 head 串行 × 每个 4 轮 × 1h = 20h 把蒸馏队列钉死。
  const deadline = Date.now() + timeoutMs

  let sessionId: string | undefined
  let lastResult: SystemAgentRunResult | undefined
  let lastFailure: { code: DistillProtocolFailureCode; detail?: string } | undefined

  /** 链终止时释放一次。见 RFC-367 design §3.1 的状态表。 */
  const releaseChainScratch = (result: SystemAgentRunResult | undefined): void => {
    if (result === undefined) return
    // `unreaped`：子进程未确认死亡，可能仍持有 scratch 下的文件。
    // `spawn-failed`：runSystemAgent 把「plan cleanup 抛错」也改写成这一档并刻意保留目录，
    // 从结果上与真正的启动失败不可区分 —— 宁可留给 24h orphan GC，也不在活进程脚下 rm -rf。
    if (result.status === 'unreaped' || result.status === 'spawn-failed') return
    releaseSystemAgentScratch({
      scratchDir: result.scratchDir,
      expectedParent: scratchParent,
      expectedName: scratchName,
    })
  }

  try {
    for (let round = 0; round <= DEFAULT_PROTOCOL_RETRY_BUDGET; round += 1) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) throw new Error(`distiller timeout after ${timeoutMs}ms`)

      const prompt =
        round === 0 || lastFailure === undefined
          ? userPrompt
          : buildDistillerFollowupPrompt({
              failure: lastFailure,
              evidence: lastResult?.outputEvidence,
              envelopeNonce,
            })

      const result = await runFn({
        feature: 'memory-distiller',
        agentName: DISTILLER_AGENT_NAME,
        systemPrompt: DISTILLER_SYSTEM_PROMPT,
        prompt,
        protocol,
        runtimeBinary: options.runtimeBinary ?? null,
        model: options.model ?? null,
        isSandbox: options.isSandbox === true,
        scratchParent,
        scratchName,
        timeoutMs: remainingMs,
        // 链未结束前不许删 scratch（claude 的 --resume 依赖同一 cwd-slug）。
        retainScratchOnSuccess: true,
        ...(eventSink === undefined ? {} : { eventSink }),
        ...(round > 0 && sessionId !== undefined ? { resumeSessionId: sessionId } : {}),
      })
      lastResult = result
      sessionId ??= result.capturedSessionId

      // RFC-043: stamp the post-spawn artefacts onto the job row. Failures here
      // are non-fatal (logged); the original success/failure semantics of
      // runDistill are preserved. Every round overwrites — same semantics as a
      // scheduler-level retry overwriting the previous attempt's row.
      try {
        await options.store.saveSpawnResult(options.job.id, {
          sessionId: result.capturedSessionId ?? null,
          exitCode: result.exitCode,
          stderrExcerpt: clipAndRedactStderr(result.stderrTail, 2048),
        })
      } catch (err) {
        log.warn('rfc043/persist-spawn-result-failed', {
          jobId: options.job.id,
          err: err instanceof Error ? err.message : String(err),
        })
      }

      // 进程级失败不补问：模型没得到说话机会，再问一遍也是同样的失败。
      if (result.status !== 'ok') throw mapSystemAgentFailure(result, timeoutMs)

      const parsed = parseDistillerCandidates(result.eventText, envelopeNonce)
      if (parsed.ok) {
        const rejections: string[] = []
        const persisted: string[] = []
        for (const raw of parsed.candidates) {
          const ok = await validateAndPersistCandidate(options.store, raw, options.job, (reason) =>
            rejections.push(reason),
          )
          if (ok !== null) persisted.push(ok.memory.id)
        }
        // RFC-367 AC-14: 解析出 N>0 条却一条都没落库 —— 这和「没什么可蒸馏」在 UI 上完全
        // 同形（绿的 0 候选），正是本 RFC 要消灭的那种静默。判失败，把拒因写进 last_error。
        if (parsed.candidates.length > 0 && persisted.length === 0) {
          throw new Error(
            `distiller emitted ${parsed.candidates.length} candidate(s) but none passed validation: ${
              rejections[0] ?? 'unknown reason'
            }`,
          )
        }
        return { candidatesCreated: persisted.length, createdMemoryIds: persisted }
      }

      lastFailure = {
        code: parsed.code,
        ...(parsed.detail === undefined ? {} : { detail: parsed.detail }),
      }
      // 没有 session id 就无法 resume；重跑整批是调度器退避的事，不在这里烧第二次 token。
      if (sessionId === undefined) {
        throw new DistillerProtocolError(
          parsed.code,
          round + 1,
          describeProtocolFailure(
            lastFailure,
            result.outputEvidence,
            'no runtime session to resume',
          ),
        )
      }
    }

    throw new DistillerProtocolError(
      lastFailure?.code ?? 'envelope-missing',
      DEFAULT_PROTOCOL_RETRY_BUDGET + 1,
      describeProtocolFailure(lastFailure, lastResult?.outputEvidence),
    )
  } finally {
    // RFC-367: nothing to capture after the fact any more — the sink recorded
    // every round live, from the same normalized stream the parser read.
    releaseChainScratch(lastResult)
  }
}

/** `SystemAgentRunStatus` → 蒸馏器历史上的错误契约（调度器只读 message）。 */
function mapSystemAgentFailure(result: SystemAgentRunResult, timeoutMs: number): Error {
  switch (result.status) {
    case 'unreaped':
      return new IndeterminateRuntimeProcessError('distiller runtime process could not be reaped')
    case 'timeout':
      return new Error(`distiller timeout after ${timeoutMs}ms`)
    case 'aborted':
      return new Error('distiller run aborted')
    case 'spawn-failed':
      return new Error(result.stderrTail || 'distiller runtime failed to spawn')
    case 'result-error':
      return new Error(
        `distiller runtime reported a terminal error: ${result.resultError ?? '(no detail)'}`,
      )
    default:
      return new Error(
        `distiller subprocess exited with code ${result.exitCode}: ${result.stderrTail.slice(0, 400)}`,
      )
  }
}

/**
 * 协议失败的人类可读说明，落 `memory_distill_jobs.last_error`。
 *
 * `classifyMissingEnvelope` 的**整个值域都是「为什么没有 envelope」**，所以只在
 * `envelope-missing` 这一档用它；其余档位 envelope 明明在，套用它会得到
 * `assistant-stopped-without-envelope` —— 又一句假话。截断这一条独立判断，因为它是唯一
 * 「不是模型的错」的可能原因。
 */
function describeProtocolFailure(
  failure: { code: DistillProtocolFailureCode; detail?: string } | undefined,
  evidence: SystemAgentOutputEvidence | undefined,
  extra?: string,
): string {
  const parts: string[] = []
  if (failure?.detail !== undefined && failure.detail !== '') parts.push(failure.detail)
  if (evidence?.eventTextCapHit === true) {
    parts.push(
      'the reply exceeded the retained-output cap, so the envelope may have been truncated',
    )
  } else if (failure?.code === 'envelope-missing') {
    parts.push(`evidence: ${classifyMissingEnvelope(evidence)}`)
  }
  if (extra !== undefined) parts.push(extra)
  return parts.join('; ')
}

/**
 * 同会话补问：复用 worker 节点那套渲染件，外加一行本地 detail。
 * `renderEnvelopeFollowupPrompt` 是纯字符串拼接、不懂业务，所以 detail 在这里拼。
 */
function buildDistillerFollowupPrompt(input: {
  failure: { code: DistillProtocolFailureCode; detail?: string }
  evidence: SystemAgentOutputEvidence | undefined
  envelopeNonce: string
}): string {
  const base = renderEnvelopeFollowupPrompt({
    hasClarifyChannel: false,
    reason: followupReasonFor(input.failure.code),
    envelopeNonce: input.envelopeNonce,
  })
  const notes: string[] = []
  if (input.failure.code === 'json-malformed') {
    notes.push(
      `The \`<port name="candidates">\` element was present, but its content was not valid JSON (${
        input.failure.detail ?? 'parse error'
      }). Re-emit the port with a single raw JSON object — no prose, no code fence.`,
    )
  }
  if (input.failure.code === 'candidates-not-array') {
    notes.push(
      `The \`<port name="candidates">\` element was present, but its JSON did not carry a "candidates" array (${
        input.failure.detail ?? 'wrong shape'
      }). The port must hold exactly {"candidates": [ ... ]}.`,
    )
  }
  if (input.evidence?.eventTextCapHit === true) {
    notes.push(
      'Your previous reply was long enough to exceed the retained-output cap. Reply with the envelope ONLY — do not restate the input.',
    )
  }
  return notes.length === 0 ? base : `${base}\n\n${notes.join('\n')}`
}

/** 失败码 → 补问开场白。措辞必须对得上实际缺陷，否则模型改错方向（RFC-367 的来由）。 */
function followupReasonFor(code: DistillProtocolFailureCode): EnvelopeFollowupReason {
  switch (code) {
    case 'envelope-missing':
      return 'envelope-missing'
    case 'port-malformed':
      return 'envelope-port-malformed'
    default:
      // port-missing / json-malformed / candidates-not-array 都是「envelope 在、port 这一层
      // 出了问题」，开场白同款；后两者另由 buildDistillerFollowupPrompt 追加具体 detail。
      return 'port-missing'
  }
}

// -----------------------------------------------------------------------------
// RFC-043 helpers
// -----------------------------------------------------------------------------

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
  sourceKind: DistillSourceKind
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
