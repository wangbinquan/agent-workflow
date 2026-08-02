// RFC-239 §3.2 — the AI change narrative ("变更导读"): manually triggered,
// generated once by a read-only system agent from the change-group statistics,
// persisted next to the structural-diff artifact, then served from disk to
// every viewer. The STATIC grouping must render fine without it — this layer
// only adds the plain-language story.
//
// Production wiring follows the intent-builder precedent verbatim (design gate
// P0-5): ResolvedRuntime (binary/model/config-dir), containmentCoordinator and
// the branded opencode head are all forwarded — a verified opencode runtime
// with no containment would fail identity admission, and a custom claude fork
// without the config-dir profile would escape its private per-run dir. Tests
// stub `runFn` only; `testOnlyUnverifiedRuntime` stays out of this path.

import { join } from 'node:path'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import {
  buildChangeGroups,
  changeNarrativeSchema,
  classifyFileKind,
  severityCounts,
  type ChangeGroup,
  type ChangeGroupEntry,
  type ChangeNarrative,
  type ChangeNarrativeStatus,
  type StructuralDiff,
  type Task,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { tasks } from '@/db/schema'
import { DomainError } from '@/util/errors'
import { appHome } from '@/util/paths'
import { gitChangedEntries, gitDiffNumstat } from '@/util/git'
import { markProductionOpencodeCommand } from '@/util/opencode'
import type { Logger } from '@/util/log'
import type { Actor } from '@/auth/actor'
import { canonicalRepoKeys } from '@/services/repoLabels'
import { requireTaskMember } from '@/services/taskCollab'
import { resolveInternalAgentRuntime } from '@/services/runtimeRegistry'
import type { ContainmentCoordinator } from '@/services/sandbox'
import { runSystemAgent, type SystemAgentRunResult } from '@/services/systemAgentRun'
import { getTaskStructuralDiff } from '@/services/structuralDiff/service'
import { ecosystemForManifest } from '@/services/structuralDiff/deps/manifests'

const NARRATIVE_TIMEOUT_MS = 120_000
/** A failed generation stays reportable this long, then decays to the 404
 *  button state (the browser that triggered it has long shown the error). */
const FAILURE_TTL_MS = 60_000
const PROMPT_MAX_CHARS = 30_000
const TOP_SYMBOLS_PER_GROUP = 12

export const NARRATIVE_AGENT_NAME = 'change-narrative'

// ---------------------------------------------------------------------------
// disk cache (same directory family as the structural-diff artifact, so the
// task-deletion chain that removes structural-diffs/{taskId} covers both)
// ---------------------------------------------------------------------------

function narrativePath(taskId: string): string {
  return join(appHome(), 'structural-diffs', taskId, 'narrative-task.json')
}

async function readNarrative(taskId: string): Promise<ChangeNarrative | null> {
  try {
    const raw = await readFile(narrativePath(taskId), 'utf8')
    const parsed = changeNarrativeSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// in-memory generation state (single-flight per task; daemon-local by design —
// a restart drops it and GET falls back to the button state)
// ---------------------------------------------------------------------------

interface GeneratingState {
  startedAt: number
  promise: Promise<void>
}
const generating = new Map<string, GeneratingState>()
const failures = new Map<string, { message: string; at: number }>()
/** Trigger-phase single-flight: concurrent POSTs during the (async) input
 *  validation window await the SAME promise and get the same startedAt. */
const inflightTrigger = new Map<string, Promise<{ status: 'generating'; startedAt: number }>>()

/** Test hook: forget all in-memory generation state. */
export function resetChangeNarrativeStateForTests(): void {
  generating.clear()
  failures.clear()
  inflightTrigger.clear()
}

// ---------------------------------------------------------------------------
// input assembly (shared change-group model — the groups the model narrates
// are EXACTLY the groups the sidebar renders)
// ---------------------------------------------------------------------------

export interface NarrativeInput {
  groups: ChangeGroup[]
  digest: string
  diff: StructuralDiff
}

export async function buildNarrativeInput(db: DbClient, task: Task): Promise<NarrativeInput> {
  const diff = await getTaskStructuralDiff(db, task.id, 'task')
  const multiRepo = task.repoCount > 1

  // The FILE universe is the git enumeration, NOT diff.files — the structural
  // artifact only carries code + manifest files, but the groups must cover
  // docs/config/assets exactly like the frontend join does (same-groups
  // contract). Structural data joins in per path for symbol counts/severity.
  const structuralByPath = new Map(diff.files.map((f) => [f.filePath, f]))
  const manifestPaths = new Set(
    diff.dependencyChanges.flatMap((d) => (d.manifestPath === undefined ? [] : [d.manifestPath])),
  )

  const repos = multiRepo
    ? task.repos.map((r) => ({ worktreePath: r.worktreePath, base: r.baseCommit }))
    : [{ worktreePath: task.worktreePath, base: task.baseCommit }]
  // Same canonical labels the structural service prefixed files with — ONE
  // function on both sides, so `label/rel` keys line up by construction.
  const labels = multiRepo ? canonicalRepoKeys(task.repos) : [undefined]

  const entries: ChangeGroupEntry[] = []
  for (const [i, repo] of repos.entries()) {
    if (repo.base === null || repo.base === '') continue
    const label = labels[i]
    const key = (rel: string): string => (label === undefined ? rel : `${label}/${rel}`)
    let changed
    let lineStats = new Map<string, { added: number; removed: number }>()
    try {
      changed = await gitChangedEntries(repo.worktreePath, repo.base)
      lineStats = await gitDiffNumstat(repo.worktreePath, repo.base)
    } catch {
      continue // a broken repo shard degrades that repo, not the whole input
    }
    for (const entry of changed) {
      const f = structuralByPath.get(key(entry.path))
      const sev = f === undefined ? { breaking: 0, risky: 0, safe: 0 } : severityCounts([f])
      const counts = { added: 0, modified: 0, removed: 0, renamed: 0 }
      for (const c of f?.changes ?? []) {
        if (c.changeType === 'renamed' || c.changeType === 'moved') counts.renamed += 1
        else counts[c.changeType] += 1
      }
      const lines = lineStats.get(entry.path)
      const noLineChange = lines !== undefined && lines.added + lines.removed === 0
      entries.push({
        filePath: entry.path,
        ...(label === undefined ? {} : { repoLabel: label }),
        kind: classifyFileKind(entry.path, {
          isCode: f !== undefined && f.lang !== 'unknown',
          isManifest:
            manifestPaths.has(key(entry.path)) || ecosystemForManifest(entry.path) !== null,
          isBinary: f?.status === 'skipped-binary' || (entry.status !== 'D' && lines === undefined),
        }),
        ...(entry.oldPath === undefined ? {} : { renamedFrom: entry.oldPath }),
        // pure move: git says R and neither the symbol diff nor the line stats
        // saw content change (non-code files judge by lines alone).
        pureMove: entry.status === 'R' && (f !== undefined ? f.changes.length === 0 : noLineChange),
        ...(lines === undefined ? {} : { textStats: lines }),
        symbolCounts: counts,
        severity: { breaking: sev.breaking, risky: sev.risky },
      })
    }
  }
  const digest = diff.contentDigest ?? ''
  return { groups: buildChangeGroups(entries), digest, diff }
}

// ---------------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------------

interface WorkflowNodeIntent {
  nodeId: string
  agentName?: string
  promptHead?: string
}

function nodeIntents(task: Task): WorkflowNodeIntent[] {
  try {
    // `workflowSnapshot` is already-parsed unknown JSON on the Task shape.
    const snap = (
      typeof task.workflowSnapshot === 'string'
        ? JSON.parse(task.workflowSnapshot)
        : task.workflowSnapshot
    ) as {
      nodes?: Array<{ id?: string; agentName?: string; prompt?: string; title?: string }>
    }
    return (snap?.nodes ?? []).flatMap((n) => {
      if (typeof n.id !== 'string') return []
      const head = typeof n.prompt === 'string' ? (n.prompt.split('\n')[0] ?? '') : undefined
      return [
        {
          nodeId: n.id,
          ...(typeof n.agentName === 'string' ? { agentName: n.agentName } : {}),
          ...(head !== undefined && head !== '' ? { promptHead: head.slice(0, 200) } : {}),
        },
      ]
    })
  } catch {
    return []
  }
}

/** Pure prompt builder (unit-tested): task title + node intents + the group
 *  stats and top symbol names. NO code bodies, NO user identities — the
 *  disclosure surface equals the structural diff's (rfc099 prompt isolation). */
export function buildNarrativePrompt(task: Task, input: NarrativeInput): string {
  const lines: string[] = []
  // Display name only — never fall back to the id (RFC-223 identity guard:
  // ids are not prose, and the prompt gains nothing from a ULID).
  lines.push(`# Task`, `name: ${task.name ?? '(unnamed)'}`, '')
  const intents = nodeIntents(task)
  if (intents.length > 0) {
    lines.push(`# Workflow nodes (agent intents)`)
    for (const it of intents) {
      lines.push(
        `- ${it.nodeId}${it.agentName === undefined ? '' : ` (agent: ${it.agentName})`}${it.promptHead === undefined ? '' : `: ${it.promptHead}`}`,
      )
    }
    lines.push('')
  }
  lines.push(`# Change groups`)
  for (const g of input.groups) {
    const s = g.stats
    lines.push(
      `## ${g.key}`,
      `files: ${s.files}; lines: +${s.lines.added} −${s.lines.removed}; symbols: +${s.symbolCounts.added} ~${s.symbolCounts.modified} −${s.symbolCounts.removed} →${s.symbolCounts.renamed}; breaking: ${s.severity.breaking}; risky: ${s.severity.risky}`,
    )
    const names = g.files.slice(0, TOP_SYMBOLS_PER_GROUP).map((f) => f.filePath)
    lines.push(`files sample: ${names.join(', ')}`, '')
  }
  lines.push(
    `# Output`,
    `Respond with ONE JSON object and nothing else (no markdown fences):`,
    `{"overview": "1-3 sentences describing what this change accomplishes as a whole",`,
    ` "groups": [{"key": "<one of the group keys above>", "summary": "one plain-language sentence for that group"}],`,
    ` "readingOrder": [{"ref": "<group key or file path>", "why": "why to read it at this position"}]}`,
    `Write the prose in the same language as the task name / node intents (Chinese task → Chinese prose).`,
  )
  const text = lines.join('\n')
  return text.length > PROMPT_MAX_CHARS ? text.slice(0, PROMPT_MAX_CHARS) : text
}

const NARRATIVE_SYSTEM_PROMPT = `You are a senior code-review guide. You receive statistics about a code change (grouped files, symbol counts, risk counts, agent intents) and produce a short narrative that helps a human reviewer understand the change quickly. You never see or need the code itself. Output STRICT JSON only — one object, no surrounding text.`

// ---------------------------------------------------------------------------
// output parsing
// ---------------------------------------------------------------------------

/** Extract the last complete top-level JSON object from model text (tolerates
 *  \`\`\`json fences and chatter around it). Exported for unit tests. */
export function extractJsonObject(text: string): unknown | null {
  const stripped = text.replace(/```(?:json)?/g, '')
  // Consume balanced top-level objects left to right, remembering the LAST one
  // that parses. A successful parse advances past the whole object so inner
  // braces are never re-tried as candidates (that returned the innermost
  // nested object instead of the document).
  let result: unknown | null = null
  let cursor = 0
  while (cursor < stripped.length) {
    const start = stripped.indexOf('{', cursor)
    if (start < 0) break
    let depth = 0
    let inStr = false
    let esc = false
    let end = -1
    for (let i = start; i < stripped.length; i++) {
      const ch = stripped[i]
      if (esc) {
        esc = false
        continue
      }
      if (ch === '\\') {
        esc = true
        continue
      }
      if (ch === '"') inStr = !inStr
      if (inStr) continue
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end < 0) break // unbalanced tail — nothing more to consume
    try {
      result = JSON.parse(stripped.slice(start, end + 1))
      cursor = end + 1
    } catch {
      cursor = start + 1
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export interface ChangeNarrativeDeps {
  db: DbClient
  /** RFC-239 — per-feature runtime selection (config.changeNarrativeRuntime);
   *  unset falls through defaultRuntime → opencode (RFC-117 chain). */
  runtimeName?: string | null
  defaultRuntime?: string | null
  containmentCoordinator?: ContainmentCoordinator
  /** Test seam — production omits it and gets the real runSystemAgent. */
  runFn?: (opts: Parameters<typeof runSystemAgent>[0]) => Promise<SystemAgentRunResult>
  now?: () => number
  log?: Logger
}

export async function getChangeNarrativeStatus(
  taskId: string,
): Promise<ChangeNarrativeStatus | null> {
  const gen = generating.get(taskId)
  if (gen !== undefined) return { status: 'generating', startedAt: gen.startedAt }
  const stored = await readNarrative(taskId)
  if (stored !== null) return { status: 'ready', narrative: stored }
  const failed = failures.get(taskId)
  if (failed !== undefined && Date.now() - failed.at < FAILURE_TTL_MS) {
    return { status: 'failed', message: failed.message }
  }
  return null
}

/**
 * Member-gated trigger (owner / collaborator / admin — requireTaskMember's
 * exact semantics). Validation is synchronous (409 when there is nothing to
 * narrate), generation is async and single-flighted per task; a re-trigger
 * while running returns the SAME generating state.
 */
export async function triggerChangeNarrative(
  deps: ChangeNarrativeDeps,
  task: Task,
  actor: Actor,
): Promise<{ status: 'generating'; startedAt: number }> {
  // The Task shape does not expose ownerUserId — read the visibility row
  // directly (same Pick the member gate is typed against).
  const ownerRows = await deps.db
    .select({ id: tasks.id, ownerUserId: tasks.ownerUserId })
    .from(tasks)
    .where(eq(tasks.id, task.id))
    .limit(1)
  const ownerRow = ownerRows[0]
  if (ownerRow === undefined) {
    throw new DomainError('task-not-found', `task '${task.id}' not found`, 404)
  }
  await requireTaskMember(deps.db, actor, ownerRow)

  const existing = generating.get(task.id)
  if (existing !== undefined) return { status: 'generating', startedAt: existing.startedAt }
  const inflight = inflightTrigger.get(task.id)
  if (inflight !== undefined) return inflight

  const trigger = (async () => {
    // Synchronous-to-the-caller validation: base-commit / emptiness produce a
    // 4xx on the POST itself, not a background failure the user has to poll
    // for. Reuses the structural-diff computation (409/410 pass through).
    const input = await buildNarrativeInput(deps.db, task)
    if (input.groups.length === 0) {
      throw new DomainError('narrative-nothing-to-narrate', 'this task changed no files', 409)
    }
    const startedAt = (deps.now ?? Date.now)()
    const promise = runGeneration(deps, task, input)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        failures.set(task.id, { message, at: Date.now() })
        deps.log?.warn('change-narrative generation failed', { taskId: task.id, message })
      })
      .finally(() => {
        generating.delete(task.id)
      })
    generating.set(task.id, { startedAt, promise })
    failures.delete(task.id)
    return { status: 'generating' as const, startedAt }
  })()
  inflightTrigger.set(task.id, trigger)
  trigger.finally(() => inflightTrigger.delete(task.id)).catch(() => {})
  return trigger
}

async function taskExists(db: DbClient, taskId: string): Promise<boolean> {
  const rows = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).limit(1)
  return rows.length > 0
}

async function runGeneration(
  deps: ChangeNarrativeDeps,
  task: Task,
  input: NarrativeInput,
): Promise<void> {
  const runtime = await resolveInternalAgentRuntime(deps.db, {
    runtimeName: deps.runtimeName ?? null,
    defaultRuntime: deps.defaultRuntime ?? null,
  })
  const runFn = deps.runFn ?? runSystemAgent
  const result = await runFn({
    feature: 'change-narrative',
    agentName: NARRATIVE_AGENT_NAME,
    systemPrompt: NARRATIVE_SYSTEM_PROMPT,
    prompt: buildNarrativePrompt(task, input),
    protocol: runtime.protocol,
    runtimeBinary: runtime.binaryPath,
    configDirEnv: runtime.configDir.env,
    configDirName: runtime.configDir.name,
    model: runtime.model,
    // Read-only narrowed profile (same one the intent builder runs under; a
    // dedicated zero-tool 'narrative-v1' waits for RFC-237's capability
    // declarations to land — see design §3.2). cwd is a scratch dir with no
    // task worktree mounted, so read-only here means "read its own prompt".
    systemPermissionProfile: 'intent-read-v1',
    ...(deps.containmentCoordinator === undefined
      ? {}
      : { containmentCoordinator: deps.containmentCoordinator }),
    ...(runtime.binaryPath !== null && runtime.binaryPath !== ''
      ? { opencodeCmd: markProductionOpencodeCommand([runtime.binaryPath]) }
      : {}),
    scratchParent: join(appHome(), 'scratch'),
    timeoutMs: NARRATIVE_TIMEOUT_MS,
    log: deps.log,
  })
  if (result.status !== 'ok') {
    throw new Error(
      `narrative agent run failed: ${result.status}${result.resultError === undefined ? '' : ` (${result.resultError})`}`,
    )
  }
  const raw = extractJsonObject(result.eventText)
  if (raw === null || typeof raw !== 'object') {
    throw new Error('narrative agent produced no parsable JSON object')
  }
  const candidate = raw as Record<string, unknown>
  const narrative = changeNarrativeSchema.parse({
    version: 1,
    overview: candidate.overview,
    groups: candidate.groups ?? [],
    readingOrder: candidate.readingOrder ?? [],
    generatedAt: (deps.now ?? Date.now)(),
    inputDigest: input.digest === '' ? 'unknown' : input.digest,
  })
  // Drop group sentences whose key no longer exists (schema is lenient; key
  // drift between generation and render is expected across regenerations).
  const validKeys = new Set(input.groups.map((g) => g.key))
  const pruned: ChangeNarrative = {
    ...narrative,
    groups: narrative.groups.filter((g) => validKeys.has(g.key)),
  }

  // Deletion race (design §3.2-5): the task may be deleted while the agent
  // runs. Check before writing (skip entirely) and after (remove what we just
  // wrote so the deletion chain's directory removal stays final).
  if (!(await taskExists(deps.db, task.id))) return
  const path = narrativePath(task.id)
  try {
    await mkdir(join(appHome(), 'structural-diffs', task.id), { recursive: true })
    await writeFile(path, JSON.stringify(pruned), 'utf8')
  } catch {
    return // best-effort persistence; the trigger's browser still got 'generating'
  }
  if (!(await taskExists(deps.db, task.id))) {
    await rm(join(appHome(), 'structural-diffs', task.id), { recursive: true, force: true }).catch(
      () => {},
    )
  }
}
