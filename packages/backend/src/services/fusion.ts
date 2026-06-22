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

import { eq } from 'drizzle-orm'
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
import { FusionResultManifestSchema } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { SYSTEM_USER_ID } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { agents, fusions } from '@/db/schema'
import { createAgent } from '@/services/agent'
import { canManageMemory, fuseMemoriesTx, getMemoryById } from '@/services/memory'
import { canViewResource, isAdminActor, isResourceOwner } from '@/services/resourceAcl'
import { getSkill } from '@/services/skill'
import { commitSkillVersion, type SkillVersionFsOptions } from '@/services/skillVersion'
import { trySetTaskStatus } from '@/services/lifecycle'
import { cancelTask, getTask, startTask, type StartTaskDeps } from '@/services/task'
import { listWorkflows, createWorkflow } from '@/services/workflow'
import { ConflictError, NotFoundError } from '@/util/errors'
import { gitDiffSnapshot, runGit } from '@/util/git'

export const SKILL_MERGER_AGENT_NAME = 'aw-skill-merger'
export const SKILL_FUSION_WORKFLOW_NAME = 'aw-skill-fusion'
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
  return isAdminActor(actor) || actor.user.id === row.ownerUserId
}

// ---------------------------------------------------------------------------
// Built-in resource seeding (idempotent)
// ---------------------------------------------------------------------------

const MERGER_BODY = `You are aw-skill-merger, the agent-workflow platform's skill-fusion worker.

Your job: fuse the APPROVED MEMORIES listed in your prompt into the target SKILL whose files are in your current working directory, following skill-authoring conventions, then report what you incorporated.

## Mandatory ask-back (you are in clarify mode)
You MUST ask the merger at least one clarifying question BEFORE editing anything. Confirm the merge goal, surface any conflict (a memory contradicting the skill, or two memories contradicting each other) and ask how to resolve it, and resolve every ambiguity. Do NOT edit files or emit output while clarifying — only emit <workflow-clarify>. Keep asking until the merger stops clarifying.

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
4. Emit a short summary in the output envelope:
   <workflow-output><port name="summary">one-paragraph summary</port></workflow-output>

The \`${SCAFFOLD}/\` directory is framework scaffolding and is never written into the skill — put ONLY the manifest there.`

const MERGER_PROMPT_TEMPLATE = `Fuse the following approved memories into this skill.

## Merge intent
{{intent}}

## Memories to fuse
{{memories}}

The skill's files are in your working directory. Clarify with the merger first (mandatory), then edit the files in place and write the result manifest.`

export async function seedFusionResources(db: DbClient): Promise<void> {
  // Agent
  const existingAgent = db.select({ name: agents.name }).from(agents).all() as Array<{
    name: string
  }>
  if (!existingAgent.some((a) => a.name === SKILL_MERGER_AGENT_NAME)) {
    await createAgent(
      db,
      {
        name: SKILL_MERGER_AGENT_NAME,
        description:
          'Built-in skill-fusion worker: merges approved memories into a managed skill (RFC-101).',
        outputs: ['summary'],
        readonly: false,
        syncOutputsOnIterate: true,
        permission: {},
        skills: [],
        dependsOn: [],
        mcp: [],
        plugins: [],
        frontmatterExtra: {},
        bodyMd: MERGER_BODY,
      },
      { ownerUserId: SYSTEM_USER_ID },
    )
  }
  // Workflow (find by name — names are not unique, so guard on existence)
  const wfs = await listWorkflows(db)
  if (!wfs.some((w) => w.name === SKILL_FUSION_WORKFLOW_NAME)) {
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
      { ownerUserId: SYSTEM_USER_ID },
    )
  }
}

async function fusionWorkflowId(db: DbClient): Promise<string> {
  const wfs = await listWorkflows(db)
  const wf = wfs.find((w) => w.name === SKILL_FUSION_WORKFLOW_NAME)
  if (!wf) throw new Error('aw-skill-fusion workflow missing after seed')
  return wf.id
}

// ---------------------------------------------------------------------------
// Ephemeral worktree helpers
// ---------------------------------------------------------------------------

function fusionWorkDir(appHome: string, fusionId: string, iteration: number): string {
  return join(appHome, 'fusions', fusionId, `iter${iteration}`, 'work')
}

/** git init the work dir, commit a baseline, return the baseline (root) sha. */
async function seedWorktree(workDir: string): Promise<string> {
  await runGit(workDir, ['init', '-b', 'fusion'])
  // Exclude the scaffolding dir from the diff via .git/info/exclude (NOT a
  // tracked .gitignore — keeps the skill's own files untouched).
  writeFileSync(join(workDir, '.git', 'info', 'exclude'), `${SCAFFOLD}/\n`, 'utf-8')
  await runGit(workDir, [
    '-c',
    'user.name=agent-workflow',
    '-c',
    'user.email=agent-workflow@local',
    'add',
    '-A',
  ])
  await runGit(workDir, [
    '-c',
    'user.name=agent-workflow',
    '-c',
    'user.email=agent-workflow@local',
    'commit',
    '--allow-empty',
    '-m',
    'fusion baseline',
  ])
  const head = await runGit(workDir, ['rev-list', '--max-parents=0', 'HEAD'])
  return head.stdout.trim()
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
  if (!isAdminActor(actor) && !isResourceOwner(actor, skill)) {
    throw new ConflictError('fusion-skill-forbidden', 'you cannot write this skill')
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
  mkdirSync(workDir, { recursive: true })
  const skillFilesDir = join(appHome, 'skills', input.skillName, 'files')
  if (existsSync(skillFilesDir)) copyWorktreeContent(skillFilesDir, workDir)
  const baseCommit = await seedWorktree(workDir)

  // 4. Launch the engine task (preCreatedWorktree bypasses worktree creation;
  //    repoPath = the ephemeral repo so the StartTask schema is satisfied).
  const taskId = ulid()
  const startDeps: StartTaskDeps = {
    db,
    appHome,
    actorUserId: actor.user.id,
    preCreatedWorktree: { taskId, worktreePath: workDir, branch: 'fusion', baseCommit },
    ...(deps.opencodeCmd ? { opencodeCmd: deps.opencodeCmd } : {}),
    ...(deps.awaitScheduler !== undefined ? { awaitScheduler: deps.awaitScheduler } : {}),
  }
  await startTask(
    {
      workflowId: await fusionWorkflowId(db),
      name: `fuse → ${input.skillName}`,
      repoPath: workDir,
      baseBranch: 'fusion',
      inputs: { intent: input.intent, memories: serializeMemoriesForPrompt(loaded) },
      ...(input.collaboratorUserIds ? { collaboratorUserIds: input.collaboratorUserIds } : {}),
    },
    startDeps,
  )

  // 5. Persist the fusion record.
  const now = Date.now()
  db.insert(fusions)
    .values({
      id: fusionId,
      skillName: input.skillName,
      baseSkillVersion: skill.contentVersion,
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
}

// ---------------------------------------------------------------------------
// Done-detection (lazy reconcile + tick)
// ---------------------------------------------------------------------------

const TERMINAL_TASK = new Set(['done', 'failed', 'canceled', 'interrupted'])

/** Settle a running fusion against its engine task's terminal state. */
export async function reconcileFusion(deps: FusionDeps, id: string): Promise<void> {
  const { db } = deps
  const row = loadFusionRow(db, id)
  if (!row || row.status !== 'running' || row.currentTaskId === null) return
  const task = await getTask(db, row.currentTaskId)
  if (task === null) {
    failFusion(db, id, 'engine task vanished')
    return
  }
  if (!TERMINAL_TASK.has(task.status)) return // still running / awaiting clarify

  if (task.status !== 'done') {
    setFusionStatus(db, id, task.status === 'canceled' ? 'canceled' : 'failed', {
      error: task.errorSummary ?? `engine task ${task.status}`,
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
      failFusion(db, id, 'agent did not write the fusion result manifest')
      return
    }
    const parsed = FusionResultManifestSchema.safeParse(
      JSON.parse(readFileSync(manifestPath, 'utf-8')),
    )
    if (!parsed.success) {
      failFusion(db, id, 'fusion result manifest is invalid')
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
      failFusion(
        db,
        id,
        `agent manifest omitted ${unaccounted.length} selected memory id(s): ${unaccounted.join(', ')}`,
      )
      return
    }
    db.update(fusions)
      .set({
        status: 'awaiting_approval',
        proposedWorktreePath: workDir,
        proposedDiff: diff,
        incorporatedMemoryIdsJson: JSON.stringify(incorporated),
        skippedJson: JSON.stringify(skipped),
        changelog: parsed.data.changelog,
      })
      .where(eq(fusions.id, id))
      .run()
  } catch (err) {
    failFusion(db, id, err instanceof Error ? err.message : String(err))
  }
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

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getFusion(deps: FusionDeps, id: string): Promise<Fusion | null> {
  await reconcileFusion(deps, id)
  const row = loadFusionRow(deps.db, id)
  return row ? rowToFusion(row) : null
}

export async function listFusions(
  deps: FusionDeps,
  filter: { skillName?: string } = {},
): Promise<Fusion[]> {
  await reconcileRunningFusions(deps)
  const rows = (
    filter.skillName !== undefined
      ? deps.db.select().from(fusions).where(eq(fusions.skillName, filter.skillName))
      : deps.db.select().from(fusions)
  ).all() as FusionRow[]
  return rows.sort((a, b) => b.createdAt - a.createdAt).map(rowToFusion)
}

// ---------------------------------------------------------------------------
// Status writes
// ---------------------------------------------------------------------------

function setFusionStatus(
  db: DbClient,
  id: string,
  to: FusionStatus,
  extra: Partial<FusionRow> = {},
): void {
  db.update(fusions)
    .set({ status: to, ...extra })
    .where(eq(fusions.id, id))
    .run()
}

function failFusion(db: DbClient, id: string, error: string): void {
  setFusionStatus(db, id, 'failed', { error, decidedAt: Date.now() })
}

// ---------------------------------------------------------------------------
// Approve (atomic apply)
// ---------------------------------------------------------------------------

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

  setFusionStatus(db, id, 'applying')
  const incorporated = jsonArray(row.incorporatedMemoryIdsJson)
  const proposedDir = row.proposedWorktreePath
  const now = Date.now()
  const fsOpts: SkillVersionFsOptions = { appHome }
  try {
    const version = commitSkillVersion(
      db,
      fsOpts,
      row.skillName,
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
        expectedVersion: row.baseSkillVersion, // OCC: fail if the skill drifted
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
    setFusionStatus(db, id, 'done', {
      appliedSkillVersion: version.versionIndex,
      decidedByUserId: actor.user.id,
      decidedAt: now,
    })
  } catch (err) {
    const code = (err as { code?: string }).code
    const msg =
      code === 'skill-version-conflict'
        ? 'the skill changed since this fusion started; re-run on the latest version'
        : err instanceof Error
          ? err.message
          : String(err)
    failFusion(db, id, msg)
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
  mkdirSync(workDir, { recursive: true })
  // Baseline commit = the CURRENT skill files, so the approval diff is always
  // current-skill → proposed. apply() copies the whole worktree over the skill
  // under OCC, so the displayed diff must be measured from the skill — NOT the
  // per-iteration prior proposal (Codex P2: otherwise a re-run hides the
  // earlier iteration's changes from the diff the merger approves).
  const skillFilesDir = join(appHome, 'skills', row.skillName, 'files')
  if (existsSync(skillFilesDir)) copyWorktreeContent(skillFilesDir, workDir)
  const baseCommit = await seedWorktree(workDir)
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
    preCreatedWorktree: { taskId, worktreePath: workDir, branch: 'fusion', baseCommit },
    ...(deps.opencodeCmd ? { opencodeCmd: deps.opencodeCmd } : {}),
    ...(deps.awaitScheduler !== undefined ? { awaitScheduler: deps.awaitScheduler } : {}),
  }
  const intentWithFeedback = `${row.intent}\n\n## Merger feedback on the previous attempt (revise accordingly)\n${feedback}`
  await startTask(
    {
      workflowId: await fusionWorkflowId(db),
      name: `fuse → ${row.skillName} (iter ${nextIter})`,
      repoPath: workDir,
      baseBranch: 'fusion',
      inputs: { intent: intentWithFeedback, memories: serializeMemoriesForPrompt(loaded) },
    },
    startDeps,
  )

  db.update(fusions)
    .set({
      status: 'running',
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
    })
    .where(eq(fusions.id, id))
    .run()

  return rowToFusion(loadFusionRow(db, id)!)
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export async function cancelFusion(deps: FusionDeps, id: string, actor: Actor): Promise<Fusion> {
  const { db } = deps
  const row = loadFusionRow(db, id)
  if (!row) throw new NotFoundError('fusion-not-found', `fusion '${id}' not found`)
  if (!canDecide(actor, row)) {
    throw new ConflictError('fusion-forbidden', 'only the fusion owner or an admin may cancel')
  }
  if (['done', 'failed', 'canceled'].includes(row.status)) {
    throw new ConflictError('fusion-terminal', `fusion is already '${row.status}'`)
  }
  if (row.currentTaskId !== null) {
    const task = await getTask(db, row.currentTaskId)
    if (task !== null && (task.status === 'pending' || task.status === 'running')) {
      await cancelTask(db, row.currentTaskId).catch(() => undefined)
    } else if (
      task !== null &&
      (task.status === 'awaiting_human' || task.status === 'awaiting_review')
    ) {
      // A fusion task spends its mandatory-clarify round in awaiting_human;
      // cancelTask refuses those, so terminalize directly (CAS) — this lets the
      // RFC-053 reconciler abandon the now-orphaned clarify session instead of
      // leaving it open in the clarify inbox forever.
      await trySetTaskStatus({
        db,
        taskId: row.currentTaskId,
        to: 'canceled',
        allowedFrom: ['awaiting_human', 'awaiting_review'],
        extra: { finishedAt: Date.now(), errorSummary: 'fusion canceled' },
        reason: 'cancelFusion: terminalize parked engine task',
      }).catch(() => false)
    }
  }
  setFusionStatus(db, id, 'canceled', { decidedByUserId: actor.user.id, decidedAt: Date.now() })
  return rowToFusion(loadFusionRow(db, id)!)
}
