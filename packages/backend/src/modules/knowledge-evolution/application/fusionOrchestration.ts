// RFC-101 PR-B — memory→skill fusion engine.
//
// A fusion runs as a normal platform TASK: a built-in workflow (aw-skill-fusion)
// drives the built-in writer agent (aw-skill-merger) inside an EPHEMERAL git
// repo seeded from the target skill's files/. The agent must clarify ≥1 round
// (mandatory ask-back is automatic when the self-clarify channel is wired),
// then edits the skill files in place and writes .agent-workflow/fusion/result.json. When
// the engine task settles (lazy-reconciled on fetch + a periodic tick — no
// scheduler surgery), the proposed change is the worktree diff vs its baseline
// commit; the merger approves (atomic skill version bump + memory fuse) or
// rejects-with-feedback (re-run seeded from the prior proposal).
//
// Module-cycle note: this is a top-level orchestrator. Nothing the platform
// runtime imports imports fusion.ts back (only routes + the boot tick do), so
// importing task/skill/skillVersion/memory here is acyclic.

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { ulid } from 'ulid'
import type { Fusion, FusionStatus, LaunchFusion } from '@agent-workflow/shared'
import {
  FusionResultManifestSchema,
  PLATFORM_FUSION_MANIFEST,
  PLATFORM_WORKSPACE_DIR,
  TERMINAL_TASK_STATUSES,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DirectTaskInitiator } from '@/modules/task-execution/domain/taskLaunchOrigin'
import { SYSTEM_USER_ID } from '@/auth/actor'
import {
  bindWorkspaceExcludeParticipant,
  ensureBoundPlatformWorkspaceDirectory,
} from '@/modules/source-control/composition'
import type { MemoryScopeAuthority } from '@/modules/memory/public/catalog'
import type {
  FusionDecisionRecoveryReceipt,
  FusionPersistencePatch,
  FusionPersistenceRecord,
  FusionProvenanceRepairReceipt,
} from '@/modules/knowledge-evolution/public/types'
import type {
  FusionEngineTaskOperations,
  FusionOperations,
  FusionPersistence,
} from '@/modules/knowledge-evolution/public/participants'
import { hasResourceAclBypass } from '@/modules/resource-catalog/public/types'
import { ConflictError, NotFoundError } from '@/util/errors'
import { gitDiffSnapshot, runGit } from '@/util/git'

// Built-in resource names live in the leaf systemResources module (single
// source of truth shared with the list-hiding filter); re-exported here so
// existing `@/services/fusion` importers are unaffected.
export { SKILL_FUSION_WORKFLOW_NAME, SKILL_MERGER_AGENT_NAME } from '@/services/systemResources'
import {
  QUARANTINED_FUSION_SKILL_ID,
  SKILL_FUSION_WORKFLOW_ID,
  SKILL_FUSION_WORKFLOW_NAME,
  SKILL_MERGER_AGENT_ID,
  SKILL_MERGER_AGENT_NAME,
} from '@/services/systemResources'
import { DAEMON_CADENCE } from '@/services/daemonCadence'
// RFC-353 T4（RFC-294 W4-E3）—— 纯判据 / 纯文本已迁进 knowledge-evolution 的 domain 层。
// 这里只剩编排；`isValidFusionTransition` 继续从本模块再导出，既有 import 面不变
// （consumer 在 T8 随路由与恢复入口一起切到 KE public）。
import {
  isValidFusionTransition,
  jsonArray,
  rowToFusion,
  MERGER_BODY,
  MERGER_DESCRIPTION,
  fusionBuiltinWorkflowSeed,
  serializeMemoriesForPrompt,
} from '@/modules/knowledge-evolution/domain'
export { isValidFusionTransition }

/**
 * 内建融合资源的身份。`services/systemResources` 是它们的单一事实源（同一份清单还喂着
 * 「内建资源不在列表里显示」的过滤器），domain 层不去那里取——由这里注入。
 */
// 不标注 `FusionBuiltinResourceIdentity`：结构类型在调用处已经把形状校严了，
// 而多一条 type import 就多一条 legacy→模块的过渡边要入账（T5 一并消失，不值当）。
const FUSION_BUILTIN_IDENTITY = Object.freeze({
  workflowId: SKILL_FUSION_WORKFLOW_ID,
  workflowName: SKILL_FUSION_WORKFLOW_NAME,
  mergerAgentId: SKILL_MERGER_AGENT_ID,
  mergerAgentName: SKILL_MERGER_AGENT_NAME,
})
const MANIFEST_REL = PLATFORM_FUSION_MANIFEST

type FusionRow = FusionPersistenceRecord

/** Deps createFusion needs to launch the engine task (mirrors the tasks route). */
export interface FusionDeps {
  operations: FusionOperations
  appHome: string
  /** TEST-ONLY runtime-neutral command-head override; production passes configPath. */
  binaryOverride?: readonly string[]
  /** Daemon config path — threaded to the scheduler's single resolution point. */
  configPath?: string
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
  sessionRestartBudget?: number // RFC-313
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

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ACL
// ---------------------------------------------------------------------------

/** Owner or admin may decide (approve/reject/cancel) a fusion. */
function canDecide(actor: Actor, row: FusionRow): boolean {
  return hasResourceAclBypass(actor) || actor.user.id === row.ownerUserId
}

// ---------------------------------------------------------------------------
// Built-in resource seeding (idempotent)
// ---------------------------------------------------------------------------

export async function seedFusionResources(persistence: FusionPersistence): Promise<void> {
  await persistence.seedResources({
    ownerUserId: SYSTEM_USER_ID,
    agent: {
      id: SKILL_MERGER_AGENT_ID,
      name: SKILL_MERGER_AGENT_NAME,
      description: MERGER_DESCRIPTION,
      outputs: ['summary'],
      syncOutputsOnIterate: true,
      bodyMd: MERGER_BODY,
    },
    workflow: fusionBuiltinWorkflowSeed(FUSION_BUILTIN_IDENTITY),
  })
}

async function fusionWorkflowId(persistence: FusionPersistence): Promise<string> {
  return await persistence.loadBuiltinWorkflowId(
    fusionBuiltinWorkflowSeed(FUSION_BUILTIN_IDENTITY),
    SYSTEM_USER_ID,
  )
}

// ---------------------------------------------------------------------------
// Ephemeral worktree helpers
// ---------------------------------------------------------------------------

function fusionWorkDir(appHome: string, fusionId: string, iteration: number): string {
  return join(appHome, 'fusions', fusionId, `iter${iteration}`, 'work')
}

/** git init the work dir, commit a baseline, return the baseline (root) sha. */
async function seedWorktree(
  workDir: string,
  appHome: string,
  git: typeof runGit = runGit,
): Promise<string> {
  const checkedGit = async (stage: string, args: string[]) => {
    const result = await git(workDir, args)
    if (result.exitCode !== 0) {
      const reason = result.stderr.trim() || result.stdout.trim() || `git exited ${result.exitCode}`
      throw new Error(`failed to ${stage} fusion worktree: ${reason}`)
    }
    return result
  }

  await checkedGit('initialize', ['init', '-b', 'fusion'])
  await bindWorkspaceExcludeParticipant({ worktreePath: workDir, appHome }).ensure()
  ensureBoundPlatformWorkspaceDirectory({ worktreePath: workDir, kind: 'fusion' })
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
    if (entry === '.git' || entry === PLATFORM_WORKSPACE_DIR) continue
    cpSync(join(src, entry), join(dst, entry), { recursive: true })
  }
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

export async function createFusion(
  input: LaunchFusion,
  deps: FusionDeps,
  scopeAuthority: MemoryScopeAuthority,
  launchInitiator: DirectTaskInitiator,
): Promise<Fusion> {
  const { operations, appHome } = deps
  const actor = scopeAuthority.actor
  await seedFusionResources(operations.persistence)

  // 1. Target skill must exist, be visible (RFC-099 D1 existence isolation:
  //    invisible ⇒ identical 404 as missing, before any source-kind/owner
  //    error, so a guessed skillId can't probe a private skill's existence),
  //    be managed, and be writable by the actor.
  const skillAccess = await operations.persistence.loadSkillAccess(actor, input.skillId)
  if (skillAccess === null || skillAccess.access === 'none') {
    throw new NotFoundError('skill-not-found', `skill '${input.skillId}' not found`)
  }
  const skill = skillAccess.skill
  // RFC-324: fusion writes the target skill's content, so an edit grant reaches
  // it — same door as POST /api/skills/:id/save.
  if (skillAccess.access !== 'write' && skillAccess.access !== 'own') {
    throw new ConflictError('fusion-skill-forbidden', 'you cannot write this skill')
  }

  // RFC-170 T6 (Codex F3 + re-review F11): capture the precondition token BEFORE any
  // side effect, bound to the IMMUTABLE id of the skill we just AUTHORIZED (`skill`)
  // — NOT a by-name re-read, which a same-name delete→recreate could repoint to a
  // different (possibly private) skill B. If A was deleted/recreated since the auth
  // check, the by-id read returns null → the fusion is refused (F10-null) before any
  // worktree/task, so B's content never enters a task the original caller owns.
  const preconditionToken = skillAccess.preconditionToken
  // RFC-170 T6 (Codex re-review F10): a null token means the skill vanished / is
  // not published between the visibility check and here — refuse to create a
  // fusion (and any worktree/task) that could never be decided (legacy-null is
  // fail-closed at decision time anyway; reject it up front, before side effects).
  if (preconditionToken === null) {
    throw new NotFoundError('skill-not-found', `skill '${input.skillId}' not found`)
  }

  // 2. Every selected memory must be approved AND manageable by the actor (D14).
  const loaded: Array<{ id: string; title: string; bodyMd: string; scopeType: string }> = []
  for (const id of input.memoryIds) {
    const got = await operations.memories.queries.getById(id)
    if (got === null) throw new NotFoundError('memory-not-found', `memory '${id}' not found`)
    if (got.memory.status !== 'approved') {
      throw new ConflictError('fusion-memory-not-approved', `memory '${id}' is not approved`)
    }
    const manageable = await operations.memories.queries.canManage(scopeAuthority, {
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
    await seedFusionFromSnapshot(
      operations.persistence,
      appHome,
      skill.id,
      skill.contentVersion,
      preconditionToken,
      workDir,
    )
    const baseCommit = await seedWorktree(workDir, appHome, deps.seedGit)

    // 4. Launch the engine task (preCreatedWorktree bypasses worktree creation;
    //    repoPath = the ephemeral repo so the StartTask schema is satisfied).
    const taskId = ulid()
    await deps.beforeStartTaskHandoff?.({ phase: 'create', workDir })
    const workflowId = await fusionWorkflowId(operations.persistence)
    const taskLaunch = operations.tasks.launch({
      taskId,
      workflowId,
      name: `fuse → ${skill.name}`,
      inputs: { intent: input.intent, memories: serializeMemoriesForPrompt(loaded) },
      ...(input.collaboratorUserIds ? { collaboratorUserIds: input.collaboratorUserIds } : {}),
      ownerUserId: actor.user.id,
      initiator: launchInitiator,
      worktreePath: workDir,
      baseCommit,
      platformInputPaths: [MANIFEST_REL],
      ...(deps.binaryOverride ? { binaryOverride: deps.binaryOverride } : {}),
      ...(deps.configPath !== undefined ? { configPath: deps.configPath } : {}),
      ...(deps.awaitScheduler !== undefined ? { awaitScheduler: deps.awaitScheduler } : {}),
      ...(deps.defaultPerNodeTimeoutMs !== undefined
        ? { defaultPerNodeTimeoutMs: deps.defaultPerNodeTimeoutMs }
        : {}),
      ...(deps.sessionRestartBudget !== undefined
        ? { sessionRestartBudget: deps.sessionRestartBudget }
        : {}),
      ...(deps.defaultNodeRetries !== undefined
        ? { defaultNodeRetries: deps.defaultNodeRetries }
        : {}),
      ...(deps.defaultRuntime !== undefined ? { defaultRuntime: deps.defaultRuntime } : {}),
    })
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
    await operations.persistence.create({
      id: fusionId,
      skillId: skill.id,
      skillName: skill.name,
      baseSkillVersion: skill.contentVersion,
      preconditionToken,
      memoryIdsJson: JSON.stringify(input.memoryIds),
      intent: input.intent,
      status: 'running',
      iteration: 1,
      currentTaskId: taskId,
      proposedWorktreePath: null,
      proposedDiff: null,
      incorporatedMemoryIdsJson: null,
      skippedJson: null,
      changelog: null,
      appliedSkillVersion: null,
      ownerUserId: actor.user.id,
      createdAt: now,
      decidedByUserId: null,
      decidedAt: null,
      decisionReason: null,
      error: null,
    })

    const fresh = await operations.persistence.load(fusionId)
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
  const { operations } = deps
  const row = await operations.persistence.load(id)
  if (!row || row.status !== 'running' || row.currentTaskId === null) return
  // RFC-170 T6 (Codex F7): reconcile reads the task, then does async git/manifest
  // work, then writes back. A decision (approve/reject/cancel) can race in that
  // window and change status / currentTaskId. So EVERY reconcile write is a CAS on
  // (status='running', currentTaskId=taskId) — if it lost the race it no-ops.
  const taskId = row.currentTaskId
  const reconcileFail = async (error: string): Promise<void> => {
    await casFusionStatus(operations.persistence, id, ['running'], 'failed', {
      expectCurrentTaskId: taskId,
      extra: { error, decidedAt: Date.now() },
    })
  }
  const task = await operations.tasks.load(taskId)
  if (task === null) {
    await reconcileFail('engine task vanished')
    return
  }
  if (!TERMINAL_TASK.has(task.status)) return // still running / awaiting clarify

  if (task.status !== 'done') {
    await casFusionStatus(
      operations.persistence,
      id,
      ['running'],
      task.status === 'canceled' ? 'canceled' : 'failed',
      {
        expectCurrentTaskId: taskId,
        extra: { error: task.errorSummary ?? `engine task ${task.status}` },
      },
    )
    return
  }

  // Done — compute the proposed diff vs baseline + read the agent's manifest.
  const workDir = task.worktreePath
  try {
    const rootSha = (await runGit(workDir, ['rev-list', '--max-parents=0', 'HEAD'])).stdout.trim()
    const diff = await gitDiffSnapshot(workDir, rootSha)
    ensureBoundPlatformWorkspaceDirectory({ worktreePath: workDir, kind: 'fusion' })
    const manifestPath = join(workDir, MANIFEST_REL)
    if (!existsSync(manifestPath)) {
      await reconcileFail('agent did not write the fusion result manifest')
      return
    }
    const manifestStat = lstatSync(manifestPath)
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      await reconcileFail('fusion result manifest is not a plain file')
      return
    }
    const parsed = FusionResultManifestSchema.safeParse(
      JSON.parse(readFileSync(manifestPath, 'utf-8')),
    )
    if (!parsed.success) {
      await reconcileFail('fusion result manifest is invalid')
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
      await reconcileFail(
        `agent manifest omitted ${unaccounted.length} selected memory id(s): ${unaccounted.join(', ')}`,
      )
      return
    }
    await casFusionStatus(operations.persistence, id, ['running'], 'awaiting_approval', {
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
    await reconcileFail(err instanceof Error ? err.message : String(err))
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
  return [...(await deps.operations.persistence.listAwaitingApprovalOwners())]
}

export async function reconcileRunningFusions(deps: FusionDeps): Promise<void> {
  const ids = await deps.operations.persistence.listIdsByStatus('running')
  for (const id of ids) {
    try {
      await reconcileFusion(deps, id)
    } catch {
      // best-effort per fusion
    }
  }
}

/**
 * RFC-223 PR-4 upgrade repair. The SQL migration can prove completed applies
 * from skill_versions, but SQLite has no base64url decoder for the precondition
 * token carried by an in-flight historical fusion. At boot, decode that
 * launch-time token and reconcile it with any committed version oracle:
 *
 * - valid token + no version: token skillId is trustworthy;
 * - one version identity + no valid token: the atomic apply record is
 *   independently trustworthy (including when the token is malformed);
 * - token/version disagreement, semantically-invalid token, or multi-row
 *   history: quarantine; non-terminal work is terminalized failed so no worker
 *   resumes.
 *
 * Names are never consulted. Memory provenance additionally requires the exact
 * (fusion_id, fused_into_skill_version, source='fusion') version row.
 */
export async function repairFusionProvenance(
  persistence: FusionPersistence,
): Promise<FusionProvenanceRepairReceipt> {
  return await persistence.repairProvenance()
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
export async function recoverFusionDecisions(
  persistence: FusionPersistence,
): Promise<FusionDecisionRecoveryReceipt> {
  return await persistence.recoverDecisions()
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
  const intervalMs = opts.intervalMs ?? DAEMON_CADENCE.fusionReconcile
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
  const row = await deps.operations.persistence.load(id)
  return row ? rowToFusion(row) : null
}

/**
 * List fusions for the overview / inbox. METADATA ONLY — the (potentially
 * large) proposedDiff is never read from the DB (projected away) so an open
 * inbox polling every 15s doesn't materialize every historical diff. The full
 * diff is served by getFusion (GET /api/fusions/:id). The status + skillId
 * filters are pushed into SQL.
 */
export async function listFusionSummaries(
  deps: FusionDeps,
  filter: { skillId?: string; status?: FusionStatus } = {},
): Promise<Fusion[]> {
  await reconcileRunningFusions(deps)
  const rows = await deps.operations.persistence.listSummaries(filter)
  return rows.map(rowToFusion)
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
  persistence: FusionPersistence,
  actor: Actor,
  skillId: string,
  token: string | null,
): Promise<void> {
  if (skillId === QUARANTINED_FUSION_SKILL_ID) {
    throw new ConflictError(
      'fusion-provenance-quarantined',
      'the target skill identity could not be proven during upgrade; re-initiate the fusion',
    )
  }
  if (token === null) {
    throw new ConflictError(
      'fusion-precondition-legacy',
      'this fusion predates snapshot protection; re-initiate it against the current skill',
    )
  }
  const access = await persistence.loadSkillAccess(actor, skillId)
  if (access === null || access.skill.id !== skillId || access.preconditionToken !== token) {
    throw new ConflictError(
      'fusion-precondition-stale',
      'the target skill changed or no longer exists; re-initiate the fusion',
    )
  }
  if (access.access !== 'write' && access.access !== 'own') {
    throw new ConflictError(
      'fusion-skill-forbidden',
      'you no longer have write access to the target skill',
    )
  }
}

async function claimFusionDecision(
  persistence: FusionPersistence,
  id: string,
  actor: Actor,
  from: FusionStatus,
  to: FusionStatus,
  patch: FusionPersistencePatch = {},
): Promise<boolean> {
  return await persistence.claimDecision({ id, actor, from, to, patch })
}

/**
 * RFC-170 T6 (Codex re-review F7) — a conditional status write: apply only if the
 * fusion is STILL in one of `fromStatuses` and (when given) still points at
 * `currentTaskId`. This makes every non-claim writer (reconcile write-back / fail,
 * cancel, reject's task attach) a generation-CAS keyed on (status, currentTaskId),
 * so a writer that raced a concurrent decision does NOT clobber it. Returns whether
 * it applied. dbTxSync + bun:sqlite single-writer make the read+update atomic.
 */
async function casFusionStatus(
  persistence: FusionPersistence,
  id: string,
  fromStatuses: readonly FusionStatus[],
  to: FusionStatus,
  opts: { expectCurrentTaskId?: string | null; extra?: FusionPersistencePatch } = {},
): Promise<boolean> {
  return await persistence.casStatus({
    id,
    from: fromStatuses,
    to,
    ...(opts.expectCurrentTaskId !== undefined
      ? { expectedCurrentTaskId: opts.expectCurrentTaskId }
      : {}),
    ...(opts.extra !== undefined ? { patch: opts.extra } : {}),
  })
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
  persistence: FusionPersistence,
  appHome: string,
  skillId: string,
  contentVersion: number,
  token: string | null,
  workDir: string,
): Promise<void> {
  if (token === null || skillId === QUARANTINED_FUSION_SKILL_ID) {
    throw new ConflictError('fusion-precondition-stale', 'invalid precondition token; re-initiate')
  }
  const matches = (
    identity: Awaited<ReturnType<FusionPersistence['loadSkillIdentity']>>,
  ): boolean =>
    identity !== null && identity.id === skillId && identity.contentVersion === contentVersion
  const seedDir = join(appHome, 'skills', skillId, 'versions', `v${contentVersion}`, 'files')
  if (!existsSync(seedDir)) {
    throw new ConflictError(
      'fusion-skill-unversioned',
      `the target skill has no v${contentVersion} snapshot to fuse from; re-save it first`,
    )
  }
  // Pre-copy: catch a delete→recreate that already repointed this name+version.
  if (!matches(await persistence.loadSkillIdentity(skillId))) {
    throw new ConflictError('fusion-precondition-stale', 'the target skill changed; re-initiate')
  }
  copyWorktreeContent(seedDir, workDir)
  // Post-copy: catch a recreate that raced the copy (no task has started).
  if (!matches(await persistence.loadSkillIdentity(skillId))) {
    throw new ConflictError(
      'fusion-precondition-stale',
      'the target skill changed during setup; re-initiate',
    )
  }
}

export async function approveFusion(deps: FusionDeps, id: string, actor: Actor): Promise<Fusion> {
  const { operations, appHome } = deps
  const persistence = operations.persistence
  await reconcileFusion(deps, id)
  const row = await persistence.load(id)
  if (!row) throw new NotFoundError('fusion-not-found', `fusion '${id}' not found`)
  if (!canDecide(actor, row)) {
    throw new ConflictError(
      'fusion-forbidden',
      'only the fusion owner or an actor with resource-acl:bypass may approve',
    )
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
  await requireCurrentSkillWritable(persistence, actor, row.skillId, row.preconditionToken)
  // RFC-170 T6 (Codex F4): atomically CLAIM awaiting_approval → applying with the
  // skill-token check in the SAME tx. Only the winner proceeds; a lost race or a
  // drifted skill aborts here with zero side effects (replaces the old
  // unconditional setFusionStatus('applying') that let a loser fail over a
  // winner's committed 'done').
  if (!(await claimFusionDecision(persistence, id, actor, 'awaiting_approval', 'applying'))) {
    throw new ConflictError('fusion-not-awaiting', 'fusion is no longer awaiting approval')
  }
  const incorporated = jsonArray(row.incorporatedMemoryIdsJson)
  const proposedDir = row.proposedWorktreePath
  const now = Date.now()
  try {
    const version = await persistence.apply({
      fusionId: row.id,
      actor,
      appHome,
      proposedWorktreePath: proposedDir,
      incorporatedMemoryIds: incorporated,
      summary: row.changelog ?? `Fused ${incorporated.length} memories`,
      now,
    })
    // RFC-170 T6 (Codex F7): CAS from the 'applying' state we exclusively hold.
    await casFusionStatus(persistence, id, ['applying'], 'done', {
      extra: {
        appliedSkillVersion: version.versionIndex,
        decidedByUserId: actor.user.id,
        decidedAt: now,
      },
    })
  } catch (err) {
    const code = (err as { code?: string }).code
    // RFC-285 B5：skill 围栏码已归一 resource-operation-stale。
    const msg =
      code === 'resource-operation-stale'
        ? 'the skill changed since this fusion started; re-run on the latest version'
        : err instanceof Error
          ? err.message
          : String(err)
    // The version write already committed durably iff it threw AFTER the DB tx;
    // fail only from 'applying' (we own it) so we never overwrite a done/canceled.
    await casFusionStatus(persistence, id, ['applying'], 'failed', {
      extra: { error: msg, decidedAt: Date.now() },
    })
    throw err instanceof Error ? err : new Error(msg)
  }
  const fresh = await persistence.load(id)
  if (!fresh) throw new Error(`fusion '${id}' disappeared after apply`)
  return rowToFusion(fresh)
}

// ---------------------------------------------------------------------------
// Reject (re-run seeded from the prior proposal + feedback)
// ---------------------------------------------------------------------------

export async function rejectFusion(
  deps: FusionDeps,
  id: string,
  feedback: string,
  actor: Actor,
  launchInitiator: DirectTaskInitiator,
): Promise<Fusion> {
  const { operations, appHome } = deps
  const persistence = operations.persistence
  await reconcileFusion(deps, id)
  const row = await persistence.load(id)
  if (!row) throw new NotFoundError('fusion-not-found', `fusion '${id}' not found`)
  if (!canDecide(actor, row)) {
    throw new ConflictError(
      'fusion-forbidden',
      'only the fusion owner or an actor with resource-acl:bypass may reject',
    )
  }
  if (row.status !== 'awaiting_approval') {
    throw new ConflictError(
      'fusion-not-awaiting',
      `fusion is '${row.status}', not awaiting_approval`,
    )
  }
  // RFC-170 T6 (Codex F5): re-check write access to the CURRENT skill before a
  // re-run (a managed ACL transfer doesn't drift the token).
  await requireCurrentSkillWritable(persistence, actor, row.skillId, row.preconditionToken)
  // RFC-170 T6 (Codex F5): atomically CLAIM awaiting_approval → running (with the
  // skill-token check in the SAME tx) BEFORE any side effect. `currentTaskId` is
  // nulled so a concurrent reconcile skips this fusion until the new task is set.
  // A lost decision race or a drifted/legacy skill aborts here with zero worktree
  // or task creation — the "zero side effect on stale" guarantee now actually
  // holds (the old pre-check was TOCTOU vs the worktree/task creation below).
  if (
    !(await claimFusionDecision(persistence, id, actor, 'awaiting_approval', 'running', {
      currentTaskId: null,
    }))
  ) {
    throw new ConflictError('fusion-not-awaiting', 'fusion is no longer awaiting approval')
  }

  try {
    const memIds = jsonArray(row.memoryIdsJson)
    const loaded: Array<{ id: string; title: string; bodyMd: string; scopeType: string }> = []
    for (const mid of memIds) {
      const got = await operations.memories.queries.getById(mid)
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
      await seedFusionFromSnapshot(
        persistence,
        appHome,
        row.skillId,
        row.baseSkillVersion,
        row.preconditionToken,
        workDir,
      )
      const baseCommit = await seedWorktree(workDir, appHome, deps.seedGit)
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
      const intentWithFeedback = `${row.intent}\n\n## Merger feedback on the previous attempt (revise accordingly)\n${feedback}`
      await deps.beforeStartTaskHandoff?.({ phase: 'reject', workDir })
      const workflowId = await fusionWorkflowId(persistence)
      const taskLaunch = operations.tasks.launch({
        taskId,
        workflowId,
        name: `fuse → ${row.skillName} (iter ${nextIter})`,
        inputs: { intent: intentWithFeedback, memories: serializeMemoriesForPrompt(loaded) },
        ownerUserId: actor.user.id,
        initiator: launchInitiator,
        worktreePath: workDir,
        baseCommit,
        platformInputPaths: [MANIFEST_REL],
        ...(deps.binaryOverride ? { binaryOverride: deps.binaryOverride } : {}),
        ...(deps.configPath !== undefined ? { configPath: deps.configPath } : {}),
        ...(deps.awaitScheduler !== undefined ? { awaitScheduler: deps.awaitScheduler } : {}),
        ...(deps.defaultPerNodeTimeoutMs !== undefined
          ? { defaultPerNodeTimeoutMs: deps.defaultPerNodeTimeoutMs }
          : {}),
        ...(deps.sessionRestartBudget !== undefined
          ? { sessionRestartBudget: deps.sessionRestartBudget }
          : {}),
        ...(deps.defaultNodeRetries !== undefined
          ? { defaultNodeRetries: deps.defaultNodeRetries }
          : {}),
        ...(deps.defaultRuntime !== undefined ? { defaultRuntime: deps.defaultRuntime } : {}),
      })
      ownershipTransferredToStartTask = true
      await taskLaunch

      // RFC-170 T6 (Codex F7): attach the new task via CAS on (status='running',
      // currentTaskId=null) — the intermediate state this reject claimed. A cancel
      // that raced during seeding/startTask flips status to 'canceled', so this CAS
      // fails; we then cancel the speculative task we just started rather than
      // orphaning it on a canceled fusion.
      const attached = await casFusionStatus(persistence, id, ['running'], 'running', {
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
        await cancelFusionEngineTask(operations.tasks, taskId)
        throw new ConflictError(
          'fusion-not-awaiting',
          'the fusion was canceled during the re-run; the speculative task was rolled back',
        )
      }

      const fresh = await persistence.load(id)
      if (!fresh) throw new Error(`fusion '${id}' disappeared after re-run`)
      return rowToFusion(fresh)
    } finally {
      if (!ownershipTransferredToStartTask) {
        rmSync(workDir, { recursive: true, force: true })
      }
    }
  } catch (err) {
    // We own the 'running' claim; a post-claim failure must not leave the fusion
    // stuck running with no task — fail it (CAS from 'running', so we don't
    // clobber a concurrent cancel that already terminalized it).
    await casFusionStatus(persistence, id, ['running'], 'failed', {
      extra: { error: err instanceof Error ? err.message : String(err), decidedAt: Date.now() },
    })
    throw err instanceof Error ? err : new Error(String(err))
  }
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/**
 * RFC-170 T6 (Codex re-review F12) — cancel a fusion's engine task in every
 * cancelable state. RFC-202 made cancelTask authoritative for pending, running,
 * awaiting_human, and awaiting_review; keeping the old direct parked-task CAS
 * here would bypass cancelTask's terminal sweep and its task-scoped review
 * mutation coordinator.
 */
async function cancelFusionEngineTask(
  tasks: FusionEngineTaskOperations,
  taskId: string,
): Promise<void> {
  // RFC-170 T6 (Codex re-review F12): a task can FLIP between the read and the
  // cancel. Reading once + swallowing the miss leaves the engine task alive
  // under a canceled fusion. Instead RE-READ and retry cancelTask until the task
  // is terminal (bounded — the fusion is already canceled, so it must settle;
  // the bound guards a pathological oscillation).
  for (let attempt = 0; attempt < 8; attempt++) {
    const task = await tasks.load(taskId)
    if (task === null || TERMINAL_TASK.has(task.status)) return // gone or terminal → done
    if (
      task.status === 'pending' ||
      task.status === 'running' ||
      task.status === 'awaiting_human' ||
      task.status === 'awaiting_review'
    ) {
      await tasks.cancel(taskId).catch(() => undefined)
    }
    // Loop: re-read next iteration; if the cancel landed we return at the top.
  }
}

export async function cancelFusion(deps: FusionDeps, id: string, actor: Actor): Promise<Fusion> {
  const { operations } = deps
  const row = await operations.persistence.load(id)
  if (!row) throw new NotFoundError('fusion-not-found', `fusion '${id}' not found`)
  if (!canDecide(actor, row)) {
    throw new ConflictError(
      'fusion-forbidden',
      'only the fusion owner or an actor with resource-acl:bypass may cancel',
    )
  }
  if (FUSION_TERMINAL_STATUSES.has(row.status)) {
    throw new ConflictError('fusion-terminal', `fusion is already '${row.status}'`)
  }
  // RFC-170 T6 (Codex re-review F12): atomically CLAIM the cancellation and capture
  // the task that is current AT COMMIT TIME — not a stale pre-loaded one. Otherwise
  // a concurrent reject that attached a new task B between our load and this CAS
  // would leave B running while we canceled A. Only from a cancelable state (NOT
  // 'applying' — a mid-approve commit must not be canceled from under the winner).
  const claim = await operations.persistence.claimCancellation({ id, actor, now: Date.now() })
  if (!claim.ok) {
    throw new ConflictError(
      'fusion-terminal',
      `fusion '${id}' is no longer cancelable (a decision is in progress or it already settled)`,
    )
  }
  // Cancel the EXACT task current at cancel-commit time (covers parked states).
  if (claim.taskId !== null) await cancelFusionEngineTask(operations.tasks, claim.taskId)
  const fresh = await operations.persistence.load(id)
  if (!fresh) throw new Error(`fusion '${id}' disappeared after cancel`)
  return rowToFusion(fresh)
}
