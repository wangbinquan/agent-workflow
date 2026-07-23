// RFC-101 PR-B — memory→skill fusion engine.
//
// A fusion runs as a normal platform TASK: a built-in workflow (aw-skill-fusion)
// drives the built-in writer agent (aw-skill-merger) inside an EPHEMERAL git
// repo seeded from the target skill's files/. The agent must clarify ≥1 round
// (mandatory ask-back is automatic when the self-clarify channel is wired),
// then edits the skill files in place and writes __fusion__/result.json. When
// the engine task settles (lazy-reconciled on fetch + a periodic tick — no
// scheduler surgery), the proposed change is the worktree diff vs its baseline
// commit; the merger approves (atomic skill version bump + memory fuse) or
// rejects-with-feedback (re-run seeded from the prior proposal).
//
// Module-cycle note: this is a top-level orchestrator. Nothing the platform
// runtime imports imports fusion.ts back (only routes + the boot tick do), so
// importing task/skill/skillVersion/memory here is acyclic.

import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { ulid } from 'ulid'
import type { Fusion, FusionSkipped, FusionStatus, LaunchFusion } from '@agent-workflow/shared'
import { FusionResultManifestSchema, TERMINAL_TASK_STATUSES } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { SYSTEM_USER_ID } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { agents, fusions, skills, skillVersions, workflows } from '@/db/schema'
import { createAgent } from '@/services/agent'
import { canManageMemory, fuseMemoriesTx, getMemoryById } from '@/services/memory'
import { canViewResource, isResourceAdminActor, isResourceOwner } from '@/services/resourceAcl'
import { getSkill, getSkillById, getSkillPreconditionTokenById } from '@/services/skill'
import { decodeSkillToken, encodeSkillToken } from '@/services/skillToken'
import { commitSkillVersion, type SkillVersionFsOptions } from '@/services/skillVersion'
import { trySetTaskStatus } from '@/services/lifecycle'
import { cancelTask, getTask, startTask, type StartTaskDeps } from '@/services/task'
import { createWorkflow } from '@/services/workflow'
import { ConflictError, NotFoundError } from '@/util/errors'
import { gitDiffSnapshot, runGit } from '@/util/git'

// Built-in resource names live in the leaf systemResources module (single
// source of truth shared with the list-hiding filter); re-exported here so
// existing `@/services/fusion` importers are unaffected.
export { SKILL_FUSION_WORKFLOW_NAME, SKILL_MERGER_AGENT_NAME } from '@/services/systemResources'
import { SKILL_FUSION_WORKFLOW_NAME, SKILL_MERGER_AGENT_NAME } from '@/services/systemResources'
/** Reserved scaffolding dir inside the fusion worktree; never written to the skill. */
const SCAFFOLD = '__fusion__'
const MANIFEST_REL = `${SCAFFOLD}/result.json`

type FusionRow = typeof fusions.$inferSelect

/** Deps createFusion needs to launch the engine task (mirrors the tasks route). */
export interface FusionDeps {
  db: DbClient
  appHome: string
  opencodeCmd?: string[]
  /** Run the scheduler inline (tests). Production leaves it to the daemon loop. */
  awaitScheduler?: boolean
  /**
   * RFC-108 T4 (AR-01 / Codex impl gate P2): per-node hard-timeout floor from
   * settings, threaded into the fusion engine's internal startTask so a fusion
   * agent that hangs is bounded like any other node. Route resolves it via
   * resolveLaunchRuntimeConfig; omitted → scheduler runs with no floor.
   */
  defaultPerNodeTimeoutMs?: number
  /** RFC-115: global per-node retry budget, threaded into the fusion task. */
  defaultNodeRetries?: number
  /** RFC-115 (Codex F3): global default runtime NAME, threaded into the fusion task. */
  defaultRuntime?: string
  /** Deterministic seed-git failure injection for ownership regression tests. */
  seedGit?: typeof runGit
  /** Deterministic pre-handoff failure injection for ownership regression tests. */
  beforeStartTaskHandoff?: (event: {
    phase: 'create' | 'reject'
    workDir: string
  }) => void | Promise<void>
}

// ---------------------------------------------------------------------------
// Fusion state machine (pure — unit-tested)
// ---------------------------------------------------------------------------

const FUSION_TRANSITIONS: Record<FusionStatus, readonly FusionStatus[]> = {
  running: ['awaiting_approval', 'failed', 'canceled'],
  awaiting_approval: ['applying', 'running', 'canceled', 'failed'],
  applying: ['done', 'failed'],
  done: [],
  rejected: [], // (reserved — rejection re-enters 'running'; terminal 'rejected' is unused in v1)
  canceled: [],
  failed: [],
}

export function isValidFusionTransition(from: FusionStatus, to: FusionStatus): boolean {
  return FUSION_TRANSITIONS[from]?.includes(to) ?? false
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function jsonArray(s: string | null): string[] {
  if (s === null) return []
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function rowToFusion(row: FusionRow): Fusion {
  let skipped: FusionSkipped[] | null = null
  if (row.skippedJson !== null) {
    try {
      const v = JSON.parse(row.skippedJson) as unknown
      if (Array.isArray(v)) skipped = v as FusionSkipped[]
    } catch {
      skipped = null
    }
  }
  return {
    id: row.id,
    skillName: row.skillName,
    baseSkillVersion: row.baseSkillVersion,
    memoryIds: jsonArray(row.memoryIdsJson),
    intent: row.intent,
    status: row.status as FusionStatus,
    iteration: row.iteration,
    currentTaskId: row.currentTaskId,
    proposedDiff: row.proposedDiff,
    incorporatedMemoryIds:
      row.incorporatedMemoryIdsJson === null ? null : jsonArray(row.incorporatedMemoryIdsJson),
    skipped,
    changelog: row.changelog,
    appliedSkillVersion: row.appliedSkillVersion,
    ownerUserId: row.ownerUserId,
    createdAt: row.createdAt,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt,
    decisionReason: row.decisionReason,
    error: row.error,
  }
}

function loadFusionRow(db: DbClient, id: string): FusionRow | null {
  const rows = db.select().from(fusions).where(eq(fusions.id, id)).all() as FusionRow[]
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// ACL
// ---------------------------------------------------------------------------

/** Owner or admin may decide (approve/reject/cancel) a fusion. */
function canDecide(actor: Actor, row: FusionRow): boolean {
  return isResourceAdminActor(actor) || actor.user.id === row.ownerUserId
}

// ---------------------------------------------------------------------------
// Built-in resource seeding (idempotent)
// ---------------------------------------------------------------------------

const MERGER_BODY = `You are aw-skill-merger, the agent-workflow platform's skill-fusion worker.

Your job: fuse the APPROVED MEMORIES listed in your prompt into the target SKILL whose files are in your current working directory, following skill-authoring conventions, then report what you incorporated.

## Mandatory ask-back (you are in clarify mode)
You MUST ask the merger at least one clarifying question BEFORE editing anything. Confirm the merge goal, surface any conflict (a memory contradicting the skill, or two memories contradicting each other) and ask how to resolve it, and resolve every ambiguity. Do NOT edit files or emit output while clarifying — only emit the workflow-clarify envelope using the exact opening tag and required nonce supplied by the user prompt protocol. Keep asking until the merger stops clarifying.

## After the merger stops clarifying — do the merge
1. Read SKILL.md and the existing support files in your working directory.
2. Integrate the memories' knowledge into the skill, honoring the merger's answers:
   - De-duplicate; reconcile conflicts exactly as the merger decided.
   - Preserve the skill's existing useful content; do not drop it.
   - Follow conventions: SKILL.md frontmatter keeps a third-person, trigger-rich \`description\`; the body is imperative, < 500 lines; push detail into \`references/\` with clear pointers (progressive disclosure); keep \`name\` matching the directory.
   - Edit files IN PLACE (SKILL.md and support files). You may add references/ examples/ scripts/.
3. Write a manifest to \`${MANIFEST_REL}\` (create the \`${SCAFFOLD}/\` dir) — JSON:
   {"incorporatedMemoryIds": ["<id>", ...], "skipped": [{"memoryId": "<id>", "reason": "..."}], "changelog": "<what changed, markdown>"}
   List EVERY selected memory in exactly one of incorporated/skipped. Skip a memory only if its knowledge is redundant or the merger declined it — never silently drop.
4. Emit a short summary in the workflow-output envelope, using the exact opening tag and required nonce supplied by the user prompt protocol, with one \`summary\` port containing a one-paragraph summary.

The \`${SCAFFOLD}/\` directory is framework scaffolding and is never written into the skill — put ONLY the manifest there.`

const MERGER_PROMPT_TEMPLATE = `Fuse the following approved memories into this skill.

## Merge intent
{{intent}}

## Memories to fuse
{{memories}}

The skill's files are in your working directory. Clarify with the merger first (mandatory), then edit the files in place and write the result manifest.`

export async function seedFusionResources(db: DbClient): Promise<void> {
  // Agent — agents.name is UNIQUE, so at most one row; repair-or-create.
  const mergerRow = db
    .select()
    .from(agents)
    .where(eq(agents.name, SKILL_MERGER_AGENT_NAME))
    .all()[0]
  if (!mergerRow) {
    await createAgent(
      db,
      {
        name: SKILL_MERGER_AGENT_NAME,
        description:
          'Built-in skill-fusion worker: merges approved memories into a managed skill (RFC-101).',
        outputs: ['summary'],
        inputs: [], // RFC-166
        syncOutputsOnIterate: true,
        permission: {},
        skills: [],
        dependsOn: [],
        mcp: [],
        plugins: [],
        frontmatterExtra: {},
        bodyMd: MERGER_BODY,
      },
      { ownerUserId: SYSTEM_USER_ID, builtin: true },
    )
  } else if (mergerRow.builtin === true || mergerRow.ownerUserId === SYSTEM_USER_ID) {
    // The row IS the framework's (built-in flag set, or __system__-owned). Repair
    // any owner/visibility/builtin drift via raw drizzle (the framework-internal
    // path that bypasses the RFC-104 read-only lock). A reserved-name row that is
    // NEITHER built-in NOR __system__-owned is left UNTOUCHED — never hijack a
    // user agent that squats the name (Codex impl-gate P2). In practice
    // agents.name is unique and the framework seeds at first boot, so this row is
    // the framework's; the user-squatter case is contrived but must not be
    // clobbered. (Full owner-drift off __system__ is likewise left for ops.)
    if (
      mergerRow.builtin !== true ||
      mergerRow.ownerUserId !== SYSTEM_USER_ID ||
      mergerRow.visibility !== 'public'
    ) {
      db.update(agents)
        .set({ builtin: true, ownerUserId: SYSTEM_USER_ID, visibility: 'public' })
        .where(eq(agents.name, SKILL_MERGER_AGENT_NAME))
        .run()
    }
  }
  // Workflow — name is NON-unique. The canonical built-in is the builtin=true
  // row (≤1 by the partial unique index). Repair-or-adopt-or-create:
  const builtinWf = db
    .select()
    .from(workflows)
    .where(and(eq(workflows.builtin, true), eq(workflows.name, SKILL_FUSION_WORKFLOW_NAME)))
    .all()[0]
  const adoptWf = builtinWf
    ? undefined
    : db
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.name, SKILL_FUSION_WORKFLOW_NAME),
            eq(workflows.ownerUserId, SYSTEM_USER_ID),
          ),
        )
        .orderBy(asc(workflows.id))
        .all()[0]
  if (builtinWf) {
    // Repair owner/visibility drift on the canonical row (raw drizzle, as above).
    if (builtinWf.ownerUserId !== SYSTEM_USER_ID || builtinWf.visibility !== 'public') {
      db.update(workflows)
        .set({ ownerUserId: SYSTEM_USER_ID, visibility: 'public' })
        .where(eq(workflows.id, builtinWf.id))
        .run()
    }
  } else if (adoptWf) {
    // Adopt the oldest __system__-owned same-name row (matches the migration's
    // deterministic pick) — heals owner-drift the backfill couldn't mark.
    db.update(workflows)
      .set({ builtin: true, visibility: 'public' })
      .where(eq(workflows.id, adoptWf.id))
      .run()
  } else {
    await createWorkflow(
      db,
      {
        name: SKILL_FUSION_WORKFLOW_NAME,
        description: 'Built-in memory→skill fusion workflow (RFC-101).',
        definition: {
          $schema_version: 4,
          inputs: [
            { kind: 'text', key: 'intent', label: 'Merge intent', required: false },
            { kind: 'text', key: 'memories', label: 'Memories', required: true },
          ],
          nodes: [
            { id: 'in_intent', kind: 'input', inputKey: 'intent' },
            { id: 'in_memories', kind: 'input', inputKey: 'memories' },
            {
              id: 'merger',
              kind: 'agent-single',
              agentName: SKILL_MERGER_AGENT_NAME,
              promptTemplate: MERGER_PROMPT_TEMPLATE,
            },
            { id: 'clarify', kind: 'clarify', title: 'Confirm fusion' },
          ],
          edges: [
            {
              id: 'e_intent',
              source: { nodeId: 'in_intent', portName: 'intent' },
              target: { nodeId: 'merger', portName: 'intent' },
            },
            {
              id: 'e_memories',
              source: { nodeId: 'in_memories', portName: 'memories' },
              target: { nodeId: 'merger', portName: 'memories' },
            },
            {
              id: 'e_ask',
              source: { nodeId: 'merger', portName: '__clarify__' },
              target: { nodeId: 'clarify', portName: 'questions' },
            },
            {
              id: 'e_ans',
              source: { nodeId: 'clarify', portName: 'answers' },
              target: { nodeId: 'merger', portName: '__clarify_response__' },
            },
          ],
          outputs: [],
        },
      },
      { ownerUserId: SYSTEM_USER_ID, builtin: true },
    )
  }
}

async function fusionWorkflowId(db: DbClient): Promise<string> {
  // RFC-104: resolve by the immutable `builtin` flag, not by name — a user may
  // own a same-named workflow (builtin=false); the framework drives only its
  // own canonical row. seedFusionResources runs before every call, so exactly
  // one builtin=true row exists here.
  const row = db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.builtin, true), eq(workflows.name, SKILL_FUSION_WORKFLOW_NAME)))
    .all()[0]
  if (!row) throw new Error('aw-skill-fusion built-in workflow missing after seed')
  return row.id
}

// ---------------------------------------------------------------------------
// Ephemeral worktree helpers
// ---------------------------------------------------------------------------

function fusionWorkDir(appHome: string, fusionId: string, iteration: number): string {
  return join(appHome, 'fusions', fusionId, `iter${iteration}`, 'work')
}

/** git init the work dir, commit a baseline, return the baseline (root) sha. */
async function seedWorktree(workDir: string, git: typeof runGit = runGit): Promise<string> {
  const checkedGit = async (stage: string, args: string[]) => {
    const result = await git(workDir, args)
    if (result.exitCode !== 0) {
      const reason = result.stderr.trim() || result.stdout.trim() || `git exited ${result.exitCode}`
      throw new Error(`failed to ${stage} fusion worktree: ${reason}`)
    }
    return result
  }

  await checkedGit('initialize', ['init', '-b', 'fusion'])
  // Exclude the scaffolding dir from the diff via .git/info/exclude (NOT a
  // tracked .gitignore — keeps the skill's own files untouched).
  writeFileSync(join(workDir, '.git', 'info', 'exclude'), `${SCAFFOLD}/\n`, 'utf-8')
  await checkedGit('stage baseline for', [
    '-c',
    'user.name=agent-workflow',
    '-c',
    'user.email=agent-workflow@local',
    'add',
    '-A',
  ])
  await checkedGit('commit baseline for', [
    '-c',
    'user.name=agent-workflow',
    '-c',
    'user.email=agent-workflow@local',
    'commit',
    '--allow-empty',
    '-m',
    'fusion baseline',
  ])
  const head = await checkedGit('resolve baseline for', ['rev-list', '--max-parents=0', 'HEAD'])
  const baseCommit = head.stdout.trim()
  if (baseCommit === '')
    throw new Error('failed to resolve baseline for fusion worktree: empty SHA')
  return baseCommit
}

/** Copy a worktree's skill content (everything except .git and the scaffold). */
function copyWorktreeContent(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src)) {
    if (entry === '.git' || entry === SCAFFOLD) continue
    cpSync(join(src, entry), join(dst, entry), { recursive: true })
  }
}

function serializeMemoriesForPrompt(
  mems: ReadonlyArray<{ id: string; title: string; bodyMd: string; scopeType: string }>,
): string {
  return mems
    .map((m) => `### Memory ${m.id}\n**${m.title}** _(scope: ${m.scopeType})_\n\n${m.bodyMd}`)
    .join('\n\n')
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

export async function createFusion(
  input: LaunchFusion,
  deps: FusionDeps,
  actor: Actor,
): Promise<Fusion> {
  const { db, appHome } = deps
  await seedFusionResources(db)

  // 1. Target skill must exist, be visible (RFC-099 D1 existence isolation:
  //    invisible ⇒ identical 404 as missing, before any source-kind/owner
  //    error, so a guessed skillName can't probe a private skill's existence),
  //    be managed, and be writable by the actor.
  const skill = await getSkill(db, input.skillName)
  if (skill === null || !(await canViewResource(db, actor, 'skill', skill))) {
    throw new NotFoundError('skill-not-found', `skill '${input.skillName}' not found`)
  }
  if (skill.sourceKind !== 'managed') {
    throw new ConflictError('fusion-skill-not-managed', 'can only fuse into a managed skill')
  }
  if (!isResourceAdminActor(actor) && !isResourceOwner(actor, skill)) {
    throw new ConflictError('fusion-skill-forbidden', 'you cannot write this skill')
  }

  // RFC-170 T6 (Codex F3 + re-review F11): capture the precondition token BEFORE any
  // side effect, bound to the IMMUTABLE id of the skill we just AUTHORIZED (`skill`)
  // — NOT a by-name re-read, which a same-name delete→recreate could repoint to a
  // different (possibly private) skill B. If A was deleted/recreated since the auth
  // check, the by-id read returns null → the fusion is refused (F10-null) before any
  // worktree/task, so B's content never enters a task the original caller owns.
  const preconditionToken = await getSkillPreconditionTokenById(db, skill.id)
  // RFC-170 T6 (Codex re-review F10): a null token means the skill vanished / is
  // not published between the visibility check and here — refuse to create a
  // fusion (and any worktree/task) that could never be decided (legacy-null is
  // fail-closed at decision time anyway; reject it up front, before side effects).
  if (preconditionToken === null) {
    throw new NotFoundError('skill-not-found', `skill '${input.skillName}' not found`)
  }

  // 2. Every selected memory must be approved AND manageable by the actor (D14).
  const loaded: Array<{ id: string; title: string; bodyMd: string; scopeType: string }> = []
  for (const id of input.memoryIds) {
    const got = await getMemoryById(db, id)
    if (got === null) throw new NotFoundError('memory-not-found', `memory '${id}' not found`)
    if (got.memory.status !== 'approved') {
      throw new ConflictError('fusion-memory-not-approved', `memory '${id}' is not approved`)
    }
    const manageable = await canManageMemory(db, actor, {
      scopeType: got.memory.scopeType,
      scopeId: got.memory.scopeId,
    })
    if (!manageable) {
      throw new ConflictError(
        'fusion-memory-forbidden',
        `you cannot manage memory '${id}' (${got.memory.scopeType} scope)`,
      )
    }
    loaded.push({
      id: got.memory.id,
      title: got.memory.title,
      bodyMd: got.memory.bodyMd,
      scopeType: got.memory.scopeType,
    })
  }

  // 3. Seed the ephemeral repo from the skill's current files/.
  const fusionId = ulid()
  const workDir = fusionWorkDir(appHome, fusionId, 1)
  let ownershipTransferredToStartTask = false
  try {
    // Root creation through the startTask call is one ownership interval. Any
    // seed/git/pre-call failure is ours to reclaim; once startTask has accepted
    // the explicit cleanup lease, its outer launch guard owns success/failure.
    mkdirSync(workDir, { recursive: true })
    // RFC-170 T6 (Codex F10/F11): seed from the token's immutable snapshot with a
    // generation (skillId) check; discard the worktree if it can't be seeded safely.
    await seedFusionFromSnapshot(db, appHome, preconditionToken, workDir)
    const baseCommit = await seedWorktree(workDir, deps.seedGit)

    // 4. Launch the engine task (preCreatedWorktree bypasses worktree creation;
    //    repoPath = the ephemeral repo so the StartTask schema is satisfied).
    const taskId = ulid()
    const startDeps: StartTaskDeps = {
      db,
      appHome,
      actorUserId: actor.user.id,
      preCreatedWorktree: {
        taskId,
        worktreePath: workDir,
        branch: 'fusion',
        baseCommit,
        cleanup: { kind: 'owned-root', path: workDir },
      },
      // RFC-165 (F4): fusion is the framework-internal launch face — the local
      // ephemeral repo travels via internalSource (space_kind='internal', GC
      // excluded so the approval flow keeps its dirs), not via the retired
      // public repoPath wire field.
      internalSource: { kind: 'local-path', repoPath: workDir, baseBranch: 'fusion' },
      ...(deps.opencodeCmd ? { opencodeCmd: deps.opencodeCmd } : {}),
      ...(deps.awaitScheduler !== undefined ? { awaitScheduler: deps.awaitScheduler } : {}),
      // RFC-108 T4 + RFC-115: thread per-node timeout / retry budget / default runtime.
      ...(deps.defaultPerNodeTimeoutMs !== undefined
        ? { defaultPerNodeTimeoutMs: deps.defaultPerNodeTimeoutMs }
        : {}),
      ...(deps.defaultNodeRetries !== undefined
        ? { defaultNodeRetries: deps.defaultNodeRetries }
        : {}),
      ...(deps.defaultRuntime !== undefined ? { defaultRuntime: deps.defaultRuntime } : {}),
    }
    await deps.beforeStartTaskHandoff?.({ phase: 'create', workDir })
    const workflowId = await fusionWorkflowId(db)
    const taskLaunch = startTask(
      {
        workflowId,
        name: `fuse → ${input.skillName}`,
        inputs: { intent: input.intent, memories: serializeMemoriesForPrompt(loaded) },
        ...(input.collaboratorUserIds ? { collaboratorUserIds: input.collaboratorUserIds } : {}),
      },
      startDeps,
    )
    // Calling startTask transfers the explicit owned-root lease. It cleans on
    // rejection and marks it committed on success, so our finally must not race
    // or double-delete either outcome.
    ownershipTransferredToStartTask = true
    await taskLaunch

    // 5. Persist the fusion record with the token captured BEFORE seeding (above).
    //    approve / re-run CAS it against the live token so a delete→recreate rebuild
    //    (same name, new skillId — baseSkillVersion alone can't see it) or a
    //    concurrent skill edit is 409-rejected, not silently applied onto the wrong
    //    content.
    const now = Date.now()
    db.insert(fusions)
      .values({
        id: fusionId,
        skillName: input.skillName,
        baseSkillVersion: skill.contentVersion,
        preconditionToken,
        memoryIdsJson: JSON.stringify(input.memoryIds),
        intent: input.intent,
        status: 'running',
        iteration: 1,
        currentTaskId: taskId,
        ownerUserId: actor.user.id,
        createdAt: now,
      })
      .run()

    const fresh = loadFusionRow(db, fusionId)
    if (!fresh) throw new Error('fusion row disappeared right after insert')
    return rowToFusion(fresh)
  } finally {
    if (!ownershipTransferredToStartTask) {
      rmSync(workDir, { recursive: true, force: true })
    }
  }
}

// ---------------------------------------------------------------------------
// Done-detection (lazy reconcile + tick)
// ---------------------------------------------------------------------------

// flag-audit W0：任务终态集合改引 shared 单源（原手抄副本）。
const TERMINAL_TASK: ReadonlySet<string> = new Set(TERMINAL_TASK_STATUSES)

/** FUSION 自身状态机的终态（与任务终态是不同枚举——fusion 无 interrupted）。 */
const FUSION_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'canceled'])

/** Settle a running fusion against its engine task's terminal state. */
export async function reconcileFusion(deps: FusionDeps, id: string): Promise<void> {
  const { db } = deps
  const row = loadFusionRow(db, id)
  if (!row || row.status !== 'running' || row.currentTaskId === null) return
  // RFC-170 T6 (Codex F7): reconcile reads the task, then does async git/manifest
  // work, then writes back. A decision (approve/reject/cancel) can race in that
  // window and change status / currentTaskId. So EVERY reconcile write is a CAS on
  // (status='running', currentTaskId=taskId) — if it lost the race it no-ops.
  const taskId = row.currentTaskId
  const reconcileFail = (error: string): void => {
    casFusionStatus(db, id, ['running'], 'failed', {
      expectCurrentTaskId: taskId,
      extra: { error, decidedAt: Date.now() },
    })
  }
  const task = await getTask(db, taskId)
  if (task === null) {
    reconcileFail('engine task vanished')
    return
  }
  if (!TERMINAL_TASK.has(task.status)) return // still running / awaiting clarify

  if (task.status !== 'done') {
    casFusionStatus(db, id, ['running'], task.status === 'canceled' ? 'canceled' : 'failed', {
      expectCurrentTaskId: taskId,
      extra: { error: task.errorSummary ?? `engine task ${task.status}` },
    })
    return
  }

  // Done — compute the proposed diff vs baseline + read the agent's manifest.
  const workDir = task.worktreePath
  try {
    const rootSha = (await runGit(workDir, ['rev-list', '--max-parents=0', 'HEAD'])).stdout.trim()
    const diff = await gitDiffSnapshot(workDir, rootSha)
    const manifestPath = join(workDir, MANIFEST_REL)
    if (!existsSync(manifestPath)) {
      reconcileFail('agent did not write the fusion result manifest')
      return
    }
    const parsed = FusionResultManifestSchema.safeParse(
      JSON.parse(readFileSync(manifestPath, 'utf-8')),
    )
    if (!parsed.success) {
      reconcileFail('fusion result manifest is invalid')
      return
    }
    const selected = new Set(jsonArray(row.memoryIdsJson))
    // incorporated ⊆ selected (drop strays); skipped ∩ incorporated = ∅.
    const incorporated = parsed.data.incorporatedMemoryIds.filter((m) => selected.has(m))
    const incSet = new Set(incorporated)
    const skipped = parsed.data.skipped.filter(
      (s) => selected.has(s.memoryId) && !incSet.has(s.memoryId),
    )
    // Launch contract (D12): every selected memory must be accounted for exactly
    // once. If the agent's manifest leaves any selected id in neither bucket,
    // fail loudly rather than silently leave it approved-but-unexplained.
    const accounted = new Set([...incSet, ...skipped.map((s) => s.memoryId)])
    const unaccounted = [...selected].filter((m) => !accounted.has(m))
    if (unaccounted.length > 0) {
      reconcileFail(
        `agent manifest omitted ${unaccounted.length} selected memory id(s): ${unaccounted.join(', ')}`,
      )
      return
    }
    casFusionStatus(db, id, ['running'], 'awaiting_approval', {
      expectCurrentTaskId: taskId,
      extra: {
        proposedWorktreePath: workDir,
        proposedDiff: diff,
        incorporatedMemoryIdsJson: JSON.stringify(incorporated),
        skippedJson: JSON.stringify(skipped),
        changelog: parsed.data.changelog,
      },
    })
  } catch (err) {
    reconcileFail(err instanceof Error ? err.message : String(err))
  }
}

/**
 * Reconcile running fusions, then return just (id, ownerUserId) of every
 * awaiting_approval fusion — a NARROW projection (no proposedDiff) so the
 * always-on inbox badge poll never reads/parses large diffs just to count.
 */
export async function awaitingApprovalFusionOwners(
  deps: FusionDeps,
): Promise<Array<{ id: string; ownerUserId: string }>> {
  await reconcileRunningFusions(deps)
  return deps.db
    .select({ id: fusions.id, ownerUserId: fusions.ownerUserId })
    .from(fusions)
    .where(eq(fusions.status, 'awaiting_approval'))
    .all() as Array<{ id: string; ownerUserId: string }>
}

export async function reconcileRunningFusions(deps: FusionDeps): Promise<void> {
  const rows = deps.db
    .select({ id: fusions.id })
    .from(fusions)
    .where(eq(fusions.status, 'running'))
    .all() as Array<{ id: string }>
  for (const r of rows) {
    try {
      await reconcileFusion(deps, r.id)
    } catch {
      // best-effort per fusion
    }
  }
}

/**
 * RFC-170 T6 (Codex re-review F9) — recover fusion DECISION half-states left by a
 * daemon crash mid-approve / mid-reject (a decision spans several txs). Run ONCE
 * at boot, before HTTP. DB-only + all writes are CAS (casFusionStatus), so a
 * concurrent live decision always wins.
 *   - `applying` (approve claimed, but the version-bump / done write didn't land):
 *       roll FORWARD to `done` iff a skill_versions row already carries this
 *       fusionId — the version bump + memory fuse commit in ONE tx, so its
 *       presence proves the apply succeeded durably; otherwise roll BACK to
 *       `failed` (nothing applied — re-runnable).
 *   - `running` with `currentTaskId=null` (reject claimed the intermediate but the
 *       new task was never attached): `failed` (re-initiate). Any speculative task
 *       is unreachable from the fusion — a separate GC concern, never left linked.
 */
export function recoverFusionDecisions(db: DbClient): {
  rolledForward: number
  rolledBack: number
  rejectFailed: number
} {
  const now = Date.now()
  let rolledForward = 0
  let rolledBack = 0
  let rejectFailed = 0

  const applying = db
    .select({ id: fusions.id })
    .from(fusions)
    .where(eq(fusions.status, 'applying'))
    .all() as Array<{ id: string }>
  for (const f of applying) {
    const v = db
      .select({ versionIndex: skillVersions.versionIndex })
      .from(skillVersions)
      .where(eq(skillVersions.fusionId, f.id))
      .orderBy(desc(skillVersions.versionIndex))
      .limit(1)
      .all() as Array<{ versionIndex: number }>
    if (v.length > 0) {
      if (
        casFusionStatus(db, f.id, ['applying'], 'done', {
          extra: { appliedSkillVersion: v[0]!.versionIndex, decidedAt: now },
        })
      )
        rolledForward++
    } else if (
      casFusionStatus(db, f.id, ['applying'], 'failed', {
        extra: {
          error: 'daemon restarted mid-apply; re-run on the latest version',
          decidedAt: now,
        },
      })
    ) {
      rolledBack++
    }
  }

  const rejectStuck = db
    .select({ id: fusions.id })
    .from(fusions)
    .where(and(eq(fusions.status, 'running'), isNull(fusions.currentTaskId)))
    .all() as Array<{ id: string }>
  for (const f of rejectStuck) {
    if (
      casFusionStatus(db, f.id, ['running'], 'failed', {
        expectCurrentTaskId: null,
        extra: { error: 'daemon restarted mid-rerun; re-initiate the fusion', decidedAt: now },
      })
    )
      rejectFailed++
  }
  return { rolledForward, rolledBack, rejectFailed }
}

/**
 * Daemon background loop: periodically settle running fusions against their
 * engine task's terminal state, so a fusion whose task finished reaches
 * awaiting_approval (or failed) even when no client is polling /api/fusions.
 * Reconcile only needs db + appHome (no opencode), so the lighter FusionDeps
 * suffices. Non-overlapping; best-effort.
 */
export function startFusionReconcileLoop(
  deps: FusionDeps,
  opts: { intervalMs?: number } = {},
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? 60_000
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    void reconcileRunningFusions(deps)
      .catch(() => undefined)
      .finally(() => {
        busy = false
      })
  }, intervalMs)
  return { stop: () => clearInterval(timer) }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getFusion(deps: FusionDeps, id: string): Promise<Fusion | null> {
  await reconcileFusion(deps, id)
  const row = loadFusionRow(deps.db, id)
  return row ? rowToFusion(row) : null
}

/**
 * List fusions for the overview / inbox. METADATA ONLY — the (potentially
 * large) proposedDiff is never read from the DB (projected away) so an open
 * inbox polling every 15s doesn't materialize every historical diff. The full
 * diff is served by getFusion (GET /api/fusions/:id). The status + skillName
 * filters are pushed into SQL.
 */
export async function listFusionSummaries(
  deps: FusionDeps,
  filter: { skillName?: string; status?: FusionStatus } = {},
): Promise<Fusion[]> {
  await reconcileRunningFusions(deps)
  const conds = []
  if (filter.skillName !== undefined) conds.push(eq(fusions.skillName, filter.skillName))
  if (filter.status !== undefined) conds.push(eq(fusions.status, filter.status))
  const base = deps.db
    .select({
      id: fusions.id,
      skillName: fusions.skillName,
      baseSkillVersion: fusions.baseSkillVersion,
      memoryIdsJson: fusions.memoryIdsJson,
      intent: fusions.intent,
      status: fusions.status,
      iteration: fusions.iteration,
      currentTaskId: fusions.currentTaskId,
      incorporatedMemoryIdsJson: fusions.incorporatedMemoryIdsJson,
      skippedJson: fusions.skippedJson,
      changelog: fusions.changelog,
      appliedSkillVersion: fusions.appliedSkillVersion,
      ownerUserId: fusions.ownerUserId,
      createdAt: fusions.createdAt,
      decidedByUserId: fusions.decidedByUserId,
      decidedAt: fusions.decidedAt,
      decisionReason: fusions.decisionReason,
      error: fusions.error,
    })
    .from(fusions)
  const rows = (conds.length > 0 ? base.where(and(...conds)) : base).all()
  return rows
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((row) => rowToFusion({ ...row, proposedDiff: null } as FusionRow))
}

// ---------------------------------------------------------------------------
// Status writes
// ---------------------------------------------------------------------------

// RFC-170 T6 (Codex F7): the old unconditional setFusionStatus/failFusion were
// removed — every fusion status write now goes through the generation-CAS
// `casFusionStatus` (or the atomic `claimFusionDecision`) so no writer can clobber
// a concurrent decision. See reconcileFusion / approveFusion / rejectFusion / cancelFusion.

// ---------------------------------------------------------------------------
// Approve (atomic apply)
// ---------------------------------------------------------------------------

/**
 * RFC-170 T6 (Codex F4/F5) — atomically claim a fusion for a decision. In ONE tx:
 *   (1) the fusion must still be `from` — serialises concurrent approve/reject, so
 *       the loser's claim returns false and it does NO side effects (no duplicate
 *       tasks, no failFusion overwriting a winner's terminal state);
 *   (2) the target skill's LIVE composite token must still equal what the fusion
 *       captured — a delete→recreate (new skillId), version bump, or metadata edit
 *       (metaRevision) throws Conflict, atomically with the claim;
 * then it transitions to `to` (+ optional extra fields). Encoded tokens are
 * canonical, so string equality IS token equality.
 */
/**
 * RFC-170 T6 (Codex F4/F5) — the actor must STILL own (or be admin on) the target
 * skill at DECISION time. A managed ACL transfer does not drift the composite
 * token, so ownership is rechecked independently before applying / re-running —
 * otherwise the fusion owner could write into a skill they transferred away.
 */
async function requireCurrentSkillWritable(
  db: DbClient,
  actor: Actor,
  token: string | null,
): Promise<void> {
  if (token === null) {
    throw new ConflictError(
      'fusion-precondition-legacy',
      'this fusion predates snapshot protection; re-initiate it against the current skill',
    )
  }
  const target = decodeSkillToken(token)
  if (target === null) {
    throw new ConflictError(
      'fusion-precondition-stale',
      'the target skill identity is invalid; re-initiate the fusion',
    )
  }
  const skill = await getSkillById(db, target.skillId)
  if (skill === null) {
    throw new ConflictError(
      'fusion-precondition-stale',
      'the target skill no longer exists; re-initiate the fusion',
    )
  }
  if (!isResourceAdminActor(actor) && !isResourceOwner(actor, skill)) {
    throw new ConflictError(
      'fusion-skill-forbidden',
      'you no longer have write access to the target skill',
    )
  }
}

function claimFusionDecision(
  db: DbClient,
  id: string,
  actor: Actor,
  from: FusionStatus,
  to: FusionStatus,
  extra: Partial<FusionRow> = {},
): boolean {
  return dbTxSync(db, (tx) => {
    const cur = tx
      .select({
        status: fusions.status,
        preconditionToken: fusions.preconditionToken,
      })
      .from(fusions)
      .where(eq(fusions.id, id))
      .get()
    if (!cur || cur.status !== from) return false // lost the decision race
    if (cur.preconditionToken === null) {
      throw new ConflictError(
        'fusion-precondition-legacy',
        'this fusion predates snapshot protection; re-initiate it against the current skill',
      )
    }
    const target = decodeSkillToken(cur.preconditionToken)
    if (target === null) {
      throw new ConflictError(
        'fusion-precondition-stale',
        'the target skill identity is invalid; re-initiate the fusion',
      )
    }
    const live = tx
      .select({
        id: skills.id,
        contentVersion: skills.contentVersion,
        metaRevision: skills.metaRevision,
        ownerUserId: skills.ownerUserId,
      })
      .from(skills)
      .where(and(eq(skills.id, target.skillId), eq(skills.reservationState, 'ready')))
      .get()
    const liveToken =
      live === undefined
        ? null
        : encodeSkillToken({
            skillId: live.id,
            contentVersion: live.contentVersion,
            metaRevision: live.metaRevision,
          })
    if (liveToken === null || liveToken !== cur.preconditionToken) {
      throw new ConflictError(
        'fusion-precondition-stale',
        'the target skill changed since this fusion started; re-initiate the fusion',
      )
    }
    // RFC-170 T6 (Codex re-review F8): re-check the CURRENT owner IN this tx (a
    // managed ACL transfer doesn't drift the token, so an owner check outside the
    // claim is TOCTOU). The pre-claim `requireCurrentSkillWritable` is a fast-fail;
    // this is the authoritative gate atomic with the status transition.
    if (!isResourceAdminActor(actor) && live!.ownerUserId !== actor.user.id) {
      throw new ConflictError(
        'fusion-skill-forbidden',
        'you no longer have write access to the target skill',
      )
    }
    tx.update(fusions)
      .set({ status: to, ...extra })
      .where(eq(fusions.id, id))
      .run()
    return true
  })
}

/**
 * RFC-170 T6 (Codex re-review F7) — a conditional status write: apply only if the
 * fusion is STILL in one of `fromStatuses` and (when given) still points at
 * `currentTaskId`. This makes every non-claim writer (reconcile write-back / fail,
 * cancel, reject's task attach) a generation-CAS keyed on (status, currentTaskId),
 * so a writer that raced a concurrent decision does NOT clobber it. Returns whether
 * it applied. dbTxSync + bun:sqlite single-writer make the read+update atomic.
 */
function casFusionStatus(
  db: DbClient,
  id: string,
  fromStatuses: readonly FusionStatus[],
  to: FusionStatus,
  opts: { expectCurrentTaskId?: string | null; extra?: Partial<FusionRow> } = {},
): boolean {
  return dbTxSync(db, (tx) => {
    const cur = tx
      .select({ status: fusions.status, currentTaskId: fusions.currentTaskId })
      .from(fusions)
      .where(eq(fusions.id, id))
      .get()
    if (!cur || !fromStatuses.includes(cur.status as FusionStatus)) return false
    if (opts.expectCurrentTaskId !== undefined && cur.currentTaskId !== opts.expectCurrentTaskId) {
      return false
    }
    tx.update(fusions)
      .set({ status: to, ...(opts.extra ?? {}) })
      .where(eq(fusions.id, id))
      .run()
    return true
  })
}

/** Decode a fusion's captured token into the OCC components for commitSkillVersion. */
function fusionTokenExpectations(token: string | null): {
  expectedSkillId?: string
  expectedVersion?: number
  expectedMetaRevision?: number
} {
  const t = token === null ? null : decodeSkillToken(token)
  if (t === null) return {}
  return {
    expectedSkillId: t.skillId,
    expectedVersion: t.contentVersion,
    expectedMetaRevision: t.metaRevision,
  }
}

function requireFusionSkillId(token: string | null): string {
  const decoded = token === null ? null : decodeSkillToken(token)
  if (decoded === null) {
    throw new ConflictError(
      'fusion-precondition-stale',
      'the target skill identity is invalid; re-initiate the fusion',
    )
  }
  return decoded.skillId
}

/**
 * RFC-170 T6 (Codex re-review F10/F11) — seed `workDir` from the token's IMMUTABLE
 * version snapshot (`versions/v<contentVersion>/files`), then verify the skill at
 * this name is STILL the token's exact generation. The snapshot PATH is keyed by
 * (name, version), so a same-name delete→recreate makes it resolve to a DIFFERENT
 * skill's content; the skillId in the token is the discriminator. Verifying the
 * live identity BOTH before and after the copy (the task hasn't started yet) means
 * no wrong-generation bytes ever reach a running fusion task. FAIL-CLOSED: a
 * missing snapshot or a generation mismatch throws (no live fallback, no empty
 * seed). The caller discards `workDir` on throw.
 */
async function seedFusionFromSnapshot(
  db: DbClient,
  appHome: string,
  token: string | null,
  workDir: string,
): Promise<void> {
  const t = token === null ? null : decodeSkillToken(token)
  if (t === null) {
    throw new ConflictError('fusion-precondition-stale', 'invalid precondition token; re-initiate')
  }
  const matches = (s: Awaited<ReturnType<typeof getSkillById>>): boolean =>
    s !== null && s.id === t.skillId && s.contentVersion === t.contentVersion
  const seedDir = join(appHome, 'skills', t.skillId, 'versions', `v${t.contentVersion}`, 'files')
  if (!existsSync(seedDir)) {
    throw new ConflictError(
      'fusion-skill-unversioned',
      `the target skill has no v${t.contentVersion} snapshot to fuse from; re-save it first`,
    )
  }
  // Pre-copy: catch a delete→recreate that already repointed this name+version.
  if (!matches(await getSkillById(db, t.skillId))) {
    throw new ConflictError('fusion-precondition-stale', 'the target skill changed; re-initiate')
  }
  copyWorktreeContent(seedDir, workDir)
  // Post-copy: catch a recreate that raced the copy (no task has started).
  if (!matches(await getSkillById(db, t.skillId))) {
    throw new ConflictError(
      'fusion-precondition-stale',
      'the target skill changed during setup; re-initiate',
    )
  }
}

export async function approveFusion(deps: FusionDeps, id: string, actor: Actor): Promise<Fusion> {
  const { db, appHome } = deps
  await reconcileFusion(deps, id)
  const row = loadFusionRow(db, id)
  if (!row) throw new NotFoundError('fusion-not-found', `fusion '${id}' not found`)
  if (!canDecide(actor, row)) {
    throw new ConflictError('fusion-forbidden', 'only the fusion owner or an admin may approve')
  }
  if (row.status !== 'awaiting_approval') {
    throw new ConflictError(
      'fusion-not-awaiting',
      `fusion is '${row.status}', not awaiting_approval`,
    )
  }
  if (row.proposedWorktreePath === null || !existsSync(row.proposedWorktreePath)) {
    throw new ConflictError('fusion-proposal-missing', 'the proposed change is no longer on disk')
  }
  // RFC-170 T6 (Codex F4): re-check write access to the CURRENT skill. A managed
  // ACL transfer does not change the token, so without this the fusion owner could
  // approve a write into a skill they no longer own after transferring it away.
  await requireCurrentSkillWritable(db, actor, row.preconditionToken)
  // RFC-170 T6 (Codex F4): atomically CLAIM awaiting_approval → applying with the
  // skill-token check in the SAME tx. Only the winner proceeds; a lost race or a
  // drifted skill aborts here with zero side effects (replaces the old
  // unconditional setFusionStatus('applying') that let a loser fail over a
  // winner's committed 'done').
  if (!claimFusionDecision(db, id, actor, 'awaiting_approval', 'applying')) {
    throw new ConflictError('fusion-not-awaiting', 'fusion is no longer awaiting approval')
  }
  const incorporated = jsonArray(row.incorporatedMemoryIdsJson)
  const proposedDir = row.proposedWorktreePath
  const now = Date.now()
  const fsOpts: SkillVersionFsOptions = { appHome }
  try {
    const version = commitSkillVersion(
      db,
      fsOpts,
      requireFusionSkillId(row.preconditionToken),
      (staging) => {
        for (const e of readdirSync(staging))
          rmSync(join(staging, e), { recursive: true, force: true })
        copyWorktreeContent(proposedDir, staging)
      },
      {
        source: 'fusion',
        authorUserId: actor.user.id,
        summary: row.changelog ?? `Fused ${incorporated.length} memories`,
        fusionId: row.id,
        // RFC-170 (Codex F4): fence the FULL composite token IN the version-bump
        // tx — skillId (delete→recreate ABA), contentVersion, and metaRevision —
        // not just the version. Catches a drift between the claim and this write.
        ...fusionTokenExpectations(row.preconditionToken),
        txExtra: (tx, newVersion) => {
          fuseMemoriesTx(tx, {
            memoryIds: incorporated,
            skillName: row.skillName,
            skillVersion: newVersion,
            fusionId: row.id,
            userId: actor.user.id,
            now,
          })
        },
      },
    )
    // RFC-170 T6 (Codex F7): CAS from the 'applying' state we exclusively hold.
    casFusionStatus(db, id, ['applying'], 'done', {
      extra: {
        appliedSkillVersion: version.versionIndex,
        decidedByUserId: actor.user.id,
        decidedAt: now,
      },
    })
  } catch (err) {
    const code = (err as { code?: string }).code
    const msg =
      code === 'skill-version-conflict'
        ? 'the skill changed since this fusion started; re-run on the latest version'
        : err instanceof Error
          ? err.message
          : String(err)
    // The version write already committed durably iff it threw AFTER the DB tx;
    // fail only from 'applying' (we own it) so we never overwrite a done/canceled.
    casFusionStatus(db, id, ['applying'], 'failed', {
      extra: { error: msg, decidedAt: Date.now() },
    })
    throw err instanceof Error ? err : new Error(msg)
  }
  const fresh = loadFusionRow(db, id)
  return rowToFusion(fresh!)
}

// ---------------------------------------------------------------------------
// Reject (re-run seeded from the prior proposal + feedback)
// ---------------------------------------------------------------------------

export async function rejectFusion(
  deps: FusionDeps,
  id: string,
  feedback: string,
  actor: Actor,
): Promise<Fusion> {
  const { db, appHome } = deps
  await reconcileFusion(deps, id)
  const row = loadFusionRow(db, id)
  if (!row) throw new NotFoundError('fusion-not-found', `fusion '${id}' not found`)
  if (!canDecide(actor, row)) {
    throw new ConflictError('fusion-forbidden', 'only the fusion owner or an admin may reject')
  }
  if (row.status !== 'awaiting_approval') {
    throw new ConflictError(
      'fusion-not-awaiting',
      `fusion is '${row.status}', not awaiting_approval`,
    )
  }
  // RFC-170 T6 (Codex F5): re-check write access to the CURRENT skill before a
  // re-run (a managed ACL transfer doesn't drift the token).
  await requireCurrentSkillWritable(db, actor, row.preconditionToken)
  // RFC-170 T6 (Codex F5): atomically CLAIM awaiting_approval → running (with the
  // skill-token check in the SAME tx) BEFORE any side effect. `currentTaskId` is
  // nulled so a concurrent reconcile skips this fusion until the new task is set.
  // A lost decision race or a drifted/legacy skill aborts here with zero worktree
  // or task creation — the "zero side effect on stale" guarantee now actually
  // holds (the old pre-check was TOCTOU vs the worktree/task creation below).
  if (
    !claimFusionDecision(db, id, actor, 'awaiting_approval', 'running', { currentTaskId: null })
  ) {
    throw new ConflictError('fusion-not-awaiting', 'fusion is no longer awaiting approval')
  }

  try {
    const memIds = jsonArray(row.memoryIdsJson)
    const loaded: Array<{ id: string; title: string; bodyMd: string; scopeType: string }> = []
    for (const mid of memIds) {
      const got = await getMemoryById(db, mid)
      if (got !== null && got.memory.status === 'approved') {
        loaded.push({
          id: got.memory.id,
          title: got.memory.title,
          bodyMd: got.memory.bodyMd,
          scopeType: got.memory.scopeType,
        })
      }
    }

    const nextIter = row.iteration + 1
    const workDir = fusionWorkDir(appHome, row.id, nextIter)
    let ownershipTransferredToStartTask = false
    try {
      mkdirSync(workDir, { recursive: true })
      // Baseline commit = the CURRENT skill files, so the approval diff is always
      // current-skill → proposed. apply() copies the whole worktree over the skill
      // under OCC, so the displayed diff must be measured from the skill — NOT the
      // per-iteration prior proposal (Codex P2: otherwise a re-run hides the
      // earlier iteration's changes from the diff the merger approves).
      // RFC-170 T6 (Codex F10/F11): re-run baseline = the token's immutable snapshot,
      // with a generation (skillId) check (the claim above verified the token, but
      // re-verify around the copy for a same-name recreate). A throw is caught below.
      await seedFusionFromSnapshot(db, appHome, row.preconditionToken, workDir)
      const baseCommit = await seedWorktree(workDir, deps.seedGit)
      // Then overlay the PRIOR proposal as uncommitted working changes, so the
      // agent refines its last attempt while the diff vs baseline stays full.
      if (row.proposedWorktreePath !== null && existsSync(row.proposedWorktreePath)) {
        for (const e of readdirSync(workDir)) {
          if (e === '.git') continue
          rmSync(join(workDir, e), { recursive: true, force: true })
        }
        copyWorktreeContent(row.proposedWorktreePath, workDir)
      }

      const taskId = ulid()
      const startDeps: StartTaskDeps = {
        db,
        appHome,
        actorUserId: actor.user.id,
        preCreatedWorktree: {
          taskId,
          worktreePath: workDir,
          branch: 'fusion',
          baseCommit,
          cleanup: { kind: 'owned-root', path: workDir },
        },
        // RFC-165 (F4): fusion is the framework-internal launch face — the local
        // ephemeral repo travels via internalSource (space_kind='internal', GC
        // excluded so the approval flow keeps its dirs), not via the retired
        // public repoPath wire field.
        internalSource: { kind: 'local-path', repoPath: workDir, baseBranch: 'fusion' },
        ...(deps.opencodeCmd ? { opencodeCmd: deps.opencodeCmd } : {}),
        ...(deps.awaitScheduler !== undefined ? { awaitScheduler: deps.awaitScheduler } : {}),
        // RFC-108 T4 + RFC-115: thread per-node timeout / retry budget / default runtime.
        ...(deps.defaultPerNodeTimeoutMs !== undefined
          ? { defaultPerNodeTimeoutMs: deps.defaultPerNodeTimeoutMs }
          : {}),
        ...(deps.defaultNodeRetries !== undefined
          ? { defaultNodeRetries: deps.defaultNodeRetries }
          : {}),
        ...(deps.defaultRuntime !== undefined ? { defaultRuntime: deps.defaultRuntime } : {}),
      }
      const intentWithFeedback = `${row.intent}\n\n## Merger feedback on the previous attempt (revise accordingly)\n${feedback}`
      await deps.beforeStartTaskHandoff?.({ phase: 'reject', workDir })
      const workflowId = await fusionWorkflowId(db)
      const taskLaunch = startTask(
        {
          workflowId,
          name: `fuse → ${row.skillName} (iter ${nextIter})`,
          inputs: { intent: intentWithFeedback, memories: serializeMemoriesForPrompt(loaded) },
        },
        startDeps,
      )
      ownershipTransferredToStartTask = true
      await taskLaunch

      // RFC-170 T6 (Codex F7): attach the new task via CAS on (status='running',
      // currentTaskId=null) — the intermediate state this reject claimed. A cancel
      // that raced during seeding/startTask flips status to 'canceled', so this CAS
      // fails; we then cancel the speculative task we just started rather than
      // orphaning it on a canceled fusion.
      const attached = casFusionStatus(db, id, ['running'], 'running', {
        expectCurrentTaskId: null,
        extra: {
          iteration: nextIter,
          currentTaskId: taskId,
          proposedWorktreePath: null,
          proposedDiff: null,
          incorporatedMemoryIdsJson: null,
          skippedJson: null,
          changelog: null,
          decisionReason: feedback,
          decidedByUserId: actor.user.id,
          decidedAt: Date.now(),
        },
      })
      if (!attached) {
        // RFC-170 T6 (Codex re-review F12): the speculative task may already be
        // parked in its mandatory clarify round — cancelFusionEngineTask covers
        // that (plain cancelTask would refuse it and orphan the worker/workspace).
        await cancelFusionEngineTask(db, taskId)
        throw new ConflictError(
          'fusion-not-awaiting',
          'the fusion was canceled during the re-run; the speculative task was rolled back',
        )
      }

      return rowToFusion(loadFusionRow(db, id)!)
    } finally {
      if (!ownershipTransferredToStartTask) {
        rmSync(workDir, { recursive: true, force: true })
      }
    }
  } catch (err) {
    // We own the 'running' claim; a post-claim failure must not leave the fusion
    // stuck running with no task — fail it (CAS from 'running', so we don't
    // clobber a concurrent cancel that already terminalized it).
    casFusionStatus(db, id, ['running'], 'failed', {
      extra: { error: err instanceof Error ? err.message : String(err), decidedAt: Date.now() },
    })
    throw err instanceof Error ? err : new Error(String(err))
  }
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/**
 * RFC-170 T6 (Codex re-review F12) — cancel a fusion's engine task, covering EVERY
 * state it can be in: pending/running via cancelTask, and PARKED
 * awaiting_human/awaiting_review (its mandatory clarify round — cancelTask refuses
 * those) via a direct CAS terminalize so the RFC-053 reconciler abandons the
 * orphaned clarify session instead of leaking a worker/workspace forever.
 */
async function cancelFusionEngineTask(db: DbClient, taskId: string): Promise<void> {
  // RFC-170 T6 (Codex re-review F12): a task can FLIP between the read and the
  // cancel (running→awaiting_human makes cancelTask refuse; parked→pending makes
  // the narrow trySetTaskStatus miss). Reading once + swallowing the miss leaves
  // the engine task alive under a canceled fusion. Instead RE-READ and retry the
  // state-appropriate cancel until the task is terminal (bounded — the fusion is
  // already canceled, so it must settle; the bound guards a pathological oscillation).
  for (let attempt = 0; attempt < 8; attempt++) {
    const task = await getTask(db, taskId)
    if (task === null || TERMINAL_TASK.has(task.status)) return // gone or terminal → done
    if (task.status === 'pending' || task.status === 'running') {
      await cancelTask(db, taskId).catch(() => undefined)
    } else if (task.status === 'awaiting_human' || task.status === 'awaiting_review') {
      // Parked in its mandatory clarify round; cancelTask refuses those, so
      // terminalize directly. The RFC-053 reconciler then abandons the orphaned
      // clarify session. (A full clarify node_run/round/session teardown is a
      // task-layer concern tracked as a follow-up — see §6g.)
      await trySetTaskStatus({
        db,
        taskId,
        to: 'canceled',
        allowedFrom: ['awaiting_human', 'awaiting_review'],
        extra: { finishedAt: Date.now(), errorSummary: 'fusion canceled' },
        reason: 'fusion: terminalize parked engine task',
      }).catch(() => false)
    }
    // Loop: re-read next iteration; if the cancel landed we return at the top.
  }
}

export async function cancelFusion(deps: FusionDeps, id: string, actor: Actor): Promise<Fusion> {
  const { db } = deps
  const row = loadFusionRow(db, id)
  if (!row) throw new NotFoundError('fusion-not-found', `fusion '${id}' not found`)
  if (!canDecide(actor, row)) {
    throw new ConflictError('fusion-forbidden', 'only the fusion owner or an admin may cancel')
  }
  if (FUSION_TERMINAL_STATUSES.has(row.status)) {
    throw new ConflictError('fusion-terminal', `fusion is already '${row.status}'`)
  }
  // RFC-170 T6 (Codex re-review F12): atomically CLAIM the cancellation and capture
  // the task that is current AT COMMIT TIME — not a stale pre-loaded one. Otherwise
  // a concurrent reject that attached a new task B between our load and this CAS
  // would leave B running while we canceled A. Only from a cancelable state (NOT
  // 'applying' — a mid-approve commit must not be canceled from under the winner).
  const claim = dbTxSync(db, (tx) => {
    const cur = tx
      .select({ status: fusions.status, currentTaskId: fusions.currentTaskId })
      .from(fusions)
      .where(eq(fusions.id, id))
      .get()
    if (!cur || (cur.status !== 'running' && cur.status !== 'awaiting_approval')) {
      return { ok: false as const }
    }
    tx.update(fusions)
      .set({ status: 'canceled', decidedByUserId: actor.user.id, decidedAt: Date.now() })
      .where(eq(fusions.id, id))
      .run()
    return { ok: true as const, taskId: cur.currentTaskId }
  })
  if (!claim.ok) {
    throw new ConflictError(
      'fusion-terminal',
      `fusion '${id}' is no longer cancelable (a decision is in progress or it already settled)`,
    )
  }
  // Cancel the EXACT task current at cancel-commit time (covers parked states).
  if (claim.taskId !== null) await cancelFusionEngineTask(db, claim.taskId)
  return rowToFusion(loadFusionRow(db, id)!)
}
