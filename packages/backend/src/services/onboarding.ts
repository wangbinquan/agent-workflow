// RFC-211 — guided onboarding sandbox: runs, "build it for me", and adoption.
//
// Two ways a step completes, both ending in the same place:
//   - provisionStep  ("帮我建")  — the guide builds a working example and hands
//     back where to edit it.
//   - adoptResource  ("我自己来") — the user built it through the normal form and
//     the guide adopts it: flip the row to private + example, register it.
//
// Adoption is server-side on purpose. Deriving "did the user finish?" from list
// length cannot work: agents/skills/workgroups have no WS channel, GET /api/agents
// returns everyone's visible rows, and for an admin `filterVisibleRows` short-
// circuits entirely — so another person's resource (or the user's other run)
// would tick the checkbox for them.
//
// Everything created here is owned by the acting user and PRIVATE, so several
// people can walk the same track at once without seeing each other's practice
// resources. The per-run name suffix is a hard requirement rather than polish:
// three of the four resource tables have a globally unique name.

import { and, eq } from 'drizzle-orm'
import {
  CreateAgentSchema,
  CreateWorkgroupSchema,
  ONBOARDING_TRACK_STEPS,
  type AdoptOnboardingResource,
  type OnboardingArtifact,
  type OnboardingArtifactType,
  type OnboardingRun,
  type OnboardingStep,
  type OnboardingTrack,
  type ProvisionOnboardingResult,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import {
  agents,
  onboardingArtifacts,
  onboardingRuns,
  skills,
  workflows,
  workgroups,
} from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { createAgent, getAgent, updateAgent } from '@/services/agent'
import { createManagedSkill, type SkillFsOptions } from '@/services/skill'
import { createWorkflow } from '@/services/workflow'
import { createWorkgroup } from '@/services/workgroups'

export interface OnboardingDeps {
  skillFs: SkillFsOptions
}

type RunRow = typeof onboardingRuns.$inferSelect
type ArtifactRow = typeof onboardingArtifacts.$inferSelect

/**
 * Lowercase, so it survives the four name regexes (`/^[a-z0-9][a-z0-9_-]*$/`).
 * ULID's Crockford base32 is uppercase and would 422 verbatim.
 */
export function suffixFromRunId(runId: string): string {
  return runId.slice(-8).toLowerCase()
}

const STEP_TRACK: Readonly<Record<OnboardingStep, OnboardingTrack>> = {
  'agent.create': 'agent',
  'agent.ports': 'agent',
  'agent.run': 'agent',
  'skill.create': 'skill',
  'skill.attach': 'skill',
  'workflow.create': 'workflow',
  'workflow.edit': 'workflow',
  'workflow.run': 'workflow',
  'workgroup.create': 'workgroup',
  'workgroup.members': 'workgroup',
  'workgroup.run': 'workgroup',
}

// --- run lifecycle -----------------------------------------------------------

function parseSteps(json: string): OnboardingStep[] {
  try {
    const raw: unknown = JSON.parse(json)
    if (!Array.isArray(raw)) return []
    return raw.filter((s): s is OnboardingStep => typeof s === 'string' && s in STEP_TRACK)
  } catch {
    return []
  }
}

async function hydrateArtifacts(db: DbClient, runId: string): Promise<OnboardingArtifact[]> {
  const rows = await db
    .select()
    .from(onboardingArtifacts)
    .where(eq(onboardingArtifacts.runId, runId))
  const out: OnboardingArtifact[] = []
  for (const row of rows) {
    // Re-read the live name every time: the user is free to rename their
    // practice resources, and every checkbox in the guide is keyed off whether
    // the resource is still there RIGHT NOW, never off a cached snapshot.
    const live = await liveResourceName(db, row.resourceType, row.resourceId)
    out.push({
      id: row.id,
      runId: row.runId,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      resourceName: live ?? row.resourceName,
      alive: live !== null,
      createdAt: row.createdAt,
    })
  }
  return out
}

async function liveResourceName(
  db: DbClient,
  type: OnboardingArtifactType,
  id: string,
): Promise<string | null> {
  switch (type) {
    case 'agent': {
      const r = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get()
      return r?.name ?? null
    }
    case 'skill': {
      const r = await db.select({ name: skills.name }).from(skills).where(eq(skills.id, id)).get()
      return r?.name ?? null
    }
    case 'workflow': {
      const r = await db
        .select({ name: workflows.name })
        .from(workflows)
        .where(eq(workflows.id, id))
        .get()
      return r?.name ?? null
    }
    case 'workgroup': {
      const r = await db
        .select({ name: workgroups.name })
        .from(workgroups)
        .where(eq(workgroups.id, id))
        .get()
      return r?.name ?? null
    }
    case 'task':
      // Tasks are addressed by id in the UI and cleaned up by the same sweep;
      // the creation-time name snapshot is good enough for the artifact list.
      return null
  }
}

async function toRun(db: DbClient, row: RunRow): Promise<OnboardingRun> {
  return {
    id: row.id,
    track: row.track,
    status: row.status,
    currentStep: (row.currentStep as OnboardingStep | null) ?? null,
    completedSteps: parseSteps(row.completedSteps),
    suffix: row.suffix,
    artifacts: await hydrateArtifacts(db, row.id),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * Start (or resume) a run. An existing `active` run on the same track is reused
 * rather than duplicated — a run holds no lease and no process state, so an
 * abandoned one is simply picked back up instead of leaving a zombie behind and
 * building a second parallel set of practice resources.
 */
export async function startRun(
  db: DbClient,
  actor: Actor,
  track: OnboardingTrack,
): Promise<OnboardingRun> {
  const existing = await db
    .select()
    .from(onboardingRuns)
    .where(
      and(
        eq(onboardingRuns.userId, actor.user.id),
        eq(onboardingRuns.track, track),
        eq(onboardingRuns.status, 'active'),
      ),
    )
    .get()
  if (existing !== undefined) return toRun(db, existing)

  const id = ulid()
  const now = Date.now()
  const inserted = await db
    .insert(onboardingRuns)
    .values({
      id,
      userId: actor.user.id,
      track,
      status: 'active',
      currentStep: ONBOARDING_TRACK_STEPS[track][0] ?? null,
      completedSteps: '[]',
      suffix: suffixFromRunId(id),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  const row = inserted[0]
  if (row === undefined) throw new Error('onboarding run insert returned no row')
  return toRun(db, row)
}

export async function listRuns(db: DbClient, actor: Actor): Promise<OnboardingRun[]> {
  const rows = await db
    .select()
    .from(onboardingRuns)
    .where(eq(onboardingRuns.userId, actor.user.id))
  const out: OnboardingRun[] = []
  for (const row of rows) out.push(await toRun(db, row))
  return out
}

/** Loads a run the actor owns; 404 for anyone else (never 403 — RFC-099 D1). */
async function requireOwnRun(db: DbClient, actor: Actor, runId: string): Promise<RunRow> {
  const row = await db.select().from(onboardingRuns).where(eq(onboardingRuns.id, runId)).get()
  if (row === undefined || row.userId !== actor.user.id) {
    throw new NotFoundError('onboarding-run-not-found', `onboarding run '${runId}' not found`)
  }
  return row
}

export async function patchRun(
  db: DbClient,
  actor: Actor,
  runId: string,
  patch: {
    currentStep?: OnboardingStep | null
    completedSteps?: OnboardingStep[]
    status?: RunRow['status']
  },
): Promise<OnboardingRun> {
  const row = await requireOwnRun(db, actor, runId)
  const next: Partial<RunRow> = { updatedAt: Date.now() }
  if (patch.currentStep !== undefined) next.currentStep = patch.currentStep
  if (patch.completedSteps !== undefined)
    next.completedSteps = JSON.stringify(Array.from(new Set(patch.completedSteps)))
  if (patch.status !== undefined) next.status = patch.status
  await db.update(onboardingRuns).set(next).where(eq(onboardingRuns.id, row.id))
  const updated = await db.select().from(onboardingRuns).where(eq(onboardingRuns.id, row.id)).get()
  if (updated === undefined) throw new Error('onboarding run vanished during patch')
  return toRun(db, updated)
}

// --- artifact bookkeeping ----------------------------------------------------

function recordArtifact(
  db: DbClient,
  runId: string,
  type: OnboardingArtifactType,
  resourceId: string,
  resourceName: string,
): void {
  // uq(resource_type, resource_id) makes this naturally idempotent: a retried
  // provision after a half-finished one re-registers the same resource instead
  // of forking a second bookkeeping row.
  dbTxSync(db, (tx) => {
    const existing = tx
      .select({ id: onboardingArtifacts.id })
      .from(onboardingArtifacts)
      .where(
        and(
          eq(onboardingArtifacts.resourceType, type),
          eq(onboardingArtifacts.resourceId, resourceId),
        ),
      )
      .get()
    if (existing !== undefined) return
    tx.insert(onboardingArtifacts)
      .values({
        id: ulid(),
        runId,
        resourceType: type,
        resourceId,
        resourceName,
        createdAt: Date.now(),
      })
      .run()
  })
}

async function findArtifact(
  db: DbClient,
  runId: string,
  type: OnboardingArtifactType,
): Promise<ArtifactRow | undefined> {
  const rows = await db
    .select()
    .from(onboardingArtifacts)
    .where(and(eq(onboardingArtifacts.runId, runId), eq(onboardingArtifacts.resourceType, type)))
  // A workflow track provisions two agents; the first one registered is the
  // primary (the one the guide sends the user to edit).
  return rows[0]
}

// --- example content ---------------------------------------------------------
//
// Content is English on purpose: it is model-facing (bodyMd becomes the inline
// opencode agent prompt) and matches the repo's existing built-in resources.
// Everything the USER reads about these resources is i18n'd guide chrome.

const CODER_BODY = `You are a focused implementation agent working inside a git worktree.

Keep changes small and reviewable. Explain what you changed and why, then stop.
Do not attempt work that was not asked for.`

const AUDITOR_BODY = `You are a code auditor. You are given a piece of work produced by another agent.

Report concrete, actionable problems only: correctness bugs, missing edge cases,
and unsafe assumptions. If you find nothing, say so plainly instead of inventing
findings.`

const LEAD_BODY = `You coordinate a small team of agents.

Break the goal into concrete assignments, hand them out one at a time, and decide
when the work is done. Prefer finishing a small thing over planning a large one.`

const SKILL_BODY = `# Release notes

Use this procedure whenever you are asked to summarize a set of changes.

1. Group the changes by user-visible impact, not by file.
2. Lead with what changed for the user; mention internals only when they matter.
3. Keep each bullet to one sentence.
4. Call out anything that requires action from the reader (migrations, config).`

/**
 * `outputs` must be non-empty. The framework appends an output-protocol block to
 * every prompt unconditionally, so an agent with zero declared ports gets told
 * "you MUST end your reply with a block listing these ports:" followed by an
 * empty list — a self-contradicting instruction that reliably ends in
 * `envelope-missing`. One markdown port is also the safest shape: a missing
 * declared port is only a warning, but an unclosed one is a hard failure.
 */
function coderInput(suffix: string) {
  return {
    name: `guide-coder-${suffix}`,
    description: 'Guided-tour example: implements a small change and reports what it did.',
    outputs: ['result'],
    outputKinds: { result: 'markdown' as const },
    bodyMd: CODER_BODY,
  }
}

function auditorInput(suffix: string) {
  return {
    name: `guide-auditor-${suffix}`,
    description: 'Guided-tour example: reviews another agent’s work and reports findings.',
    outputs: ['finding'],
    outputKinds: { finding: 'markdown' as const },
    bodyMd: AUDITOR_BODY,
  }
}

function leadInput(suffix: string) {
  return {
    name: `guide-lead-${suffix}`,
    description: 'Guided-tour example: coordinates the other members of a workgroup.',
    outputs: ['plan'],
    outputKinds: { plan: 'markdown' as const },
    bodyMd: LEAD_BODY,
  }
}

/**
 * Four nodes, three edges. Two validator rules drive the shape:
 *   - every `{{token}}` in a prompt needs an inbound edge whose target port has
 *     that exact name;
 *   - an input node's `inputKey` must be declared in `definition.inputs`.
 * The output node needs no inbound edge — the scheduler treats `ports[].bind`
 * as an implicit upstream dependency.
 */
export function buildGuideWorkflowDefinition(
  coderName: string,
  auditorName: string,
): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [
      {
        kind: 'text',
        key: 'task',
        label: 'What should the team do?',
        required: true,
        description: 'One paragraph describing the change you want.',
      },
    ],
    nodes: [
      { id: 'in_task', kind: 'input', inputKey: 'task', position: { x: 80, y: 120 } },
      {
        id: 'coder',
        kind: 'agent-single',
        agentName: coderName,
        promptTemplate:
          'Task: {{task}}\n\nImplement it in the working repo. Keep the change small.',
        position: { x: 340, y: 120 },
      },
      {
        id: 'auditor',
        kind: 'agent-single',
        agentName: auditorName,
        promptTemplate: 'Review the following work and report concrete problems.\n\n{{artifact}}',
        position: { x: 620, y: 120 },
      },
      {
        id: 'out',
        kind: 'output',
        ports: [{ name: 'review', bind: { nodeId: 'auditor', portName: 'finding' } }],
        position: { x: 900, y: 120 },
      },
    ],
    edges: [
      {
        id: 'e_in_coder',
        source: { nodeId: 'in_task', portName: 'task' },
        target: { nodeId: 'coder', portName: 'task' },
      },
      {
        id: 'e_coder_auditor',
        source: { nodeId: 'coder', portName: 'result' },
        target: { nodeId: 'auditor', portName: 'artifact' },
      },
    ],
  } as WorkflowDefinition
}

// --- provisioning ------------------------------------------------------------

interface Provisioned {
  type: OnboardingArtifactType
  id: string
  name: string
  reused: boolean
}

/** Creates the run's primary agent, or returns the one it already made. */
async function ensureCoderAgent(
  db: DbClient,
  actor: Actor,
  run: RunRow,
): Promise<{ id: string; name: string; reused: boolean }> {
  const existing = await findArtifact(db, run.id, 'agent')
  if (existing !== undefined) {
    const live = await liveResourceName(db, 'agent', existing.resourceId)
    if (live !== null) return { id: existing.resourceId, name: live, reused: true }
  }
  const created = await createAgent(db, CreateAgentSchema.parse(coderInput(run.suffix)), {
    ownerUserId: actor.user.id,
    visibility: 'private',
    example: true,
  })
  recordArtifact(db, run.id, 'agent', created.id, created.name)
  return { id: created.id, name: created.name, reused: false }
}

async function ensureSecondaryAgent(
  db: DbClient,
  actor: Actor,
  run: RunRow,
  input: {
    name: string
    description: string
    outputs: string[]
    outputKinds: Record<string, 'markdown'>
    bodyMd: string
  },
): Promise<{ id: string; name: string }> {
  const existing = await getAgent(db, input.name)
  if (existing !== null) {
    recordArtifact(db, run.id, 'agent', existing.id, existing.name)
    return { id: existing.id, name: existing.name }
  }
  const created = await createAgent(db, CreateAgentSchema.parse(input), {
    ownerUserId: actor.user.id,
    visibility: 'private',
    example: true,
  })
  recordArtifact(db, run.id, 'agent', created.id, created.name)
  return { id: created.id, name: created.name }
}

/**
 * "帮我建" for one step. Idempotent: a step that already produced its resource
 * returns that resource with `reused: true` instead of building a second one.
 *
 * Steps that only explain something (agent.ports, workflow.edit, …) resolve to
 * the resource the user should be looking at, provisioning its prerequisite if
 * the user jumped straight to a later step.
 */
export async function provisionStep(
  db: DbClient,
  actor: Actor,
  runId: string,
  step: OnboardingStep,
  deps: OnboardingDeps,
): Promise<ProvisionOnboardingResult> {
  const run = await requireOwnRun(db, actor, runId)
  if (STEP_TRACK[step] !== run.track) {
    throw new ValidationError(
      'onboarding-step-track-mismatch',
      `step '${step}' does not belong to track '${run.track}'`,
    )
  }

  const result = await provisionForStep(db, actor, run, step, deps)
  const completed = new Set(parseSteps(run.completedSteps))
  completed.add(step)
  const updatedRun = await patchRun(db, actor, run.id, {
    completedSteps: [...completed],
    currentStep: nextStep(run.track, step) ?? step,
  })

  return {
    step,
    resourceType: result.type,
    resourceId: result.id,
    resourceName: result.name,
    reused: result.reused,
    run: updatedRun,
  }
}

function nextStep(track: OnboardingTrack, step: OnboardingStep): OnboardingStep | null {
  const steps = ONBOARDING_TRACK_STEPS[track]
  const idx = steps.indexOf(step)
  if (idx < 0 || idx + 1 >= steps.length) return null
  return steps[idx + 1] ?? null
}

async function provisionForStep(
  db: DbClient,
  actor: Actor,
  run: RunRow,
  step: OnboardingStep,
  deps: OnboardingDeps,
): Promise<Provisioned> {
  switch (step) {
    case 'agent.create':
    case 'agent.ports':
    case 'agent.run': {
      const agent = await ensureCoderAgent(db, actor, run)
      return { type: 'agent', id: agent.id, name: agent.name, reused: agent.reused }
    }

    case 'skill.create': {
      const existing = await findArtifact(db, run.id, 'skill')
      if (existing !== undefined) {
        const live = await liveResourceName(db, 'skill', existing.resourceId)
        if (live !== null)
          return { type: 'skill', id: existing.resourceId, name: live, reused: true }
      }
      const created = await createManagedSkill(
        db,
        deps.skillFs,
        {
          name: `guide-release-notes-${run.suffix}`,
          // A description is mandatory in practice, not just polite: opencode
          // filters skills without one out of `available_skills` entirely, so a
          // description-less skill is installed, attached, and permanently
          // invisible to the model — the worst kind of silent success.
          description:
            'Turn a set of changes into user-facing release notes. Use when asked to summarize work.',
          bodyMd: SKILL_BODY,
          frontmatterExtra: {},
        },
        { ownerUserId: actor.user.id, visibility: 'private', example: true },
      )
      recordArtifact(db, run.id, 'skill', created.id, created.name)
      return { type: 'skill', id: created.id, name: created.name, reused: false }
    }

    case 'skill.attach': {
      const skill = await provisionForStep(db, actor, run, 'skill.create', deps)
      const agent = await ensureCoderAgent(db, actor, run)
      const current = await getAgent(db, agent.name)
      const attached = new Set(current?.skills ?? [])
      const already = attached.has(skill.name)
      if (!already) {
        attached.add(skill.name)
        await updateAgent(db, agent.name, { skills: [...attached] })
      }
      return { type: 'agent', id: agent.id, name: agent.name, reused: already }
    }

    case 'workflow.create':
    case 'workflow.edit':
    case 'workflow.run': {
      const existing = await findArtifact(db, run.id, 'workflow')
      if (existing !== undefined) {
        const live = await liveResourceName(db, 'workflow', existing.resourceId)
        if (live !== null)
          return { type: 'workflow', id: existing.resourceId, name: live, reused: true }
      }
      const coder = await ensureCoderAgent(db, actor, run)
      const auditor = await ensureSecondaryAgent(db, actor, run, auditorInput(run.suffix))
      const created = await createWorkflow(
        db,
        {
          name: `guide-review-pipeline-${run.suffix}`,
          description: 'Guided-tour example: one agent does the work, a second one reviews it.',
          definition: buildGuideWorkflowDefinition(coder.name, auditor.name),
        },
        { ownerUserId: actor.user.id, visibility: 'private', example: true },
      )
      recordArtifact(db, run.id, 'workflow', created.id, created.name)
      return { type: 'workflow', id: created.id, name: created.name, reused: false }
    }

    case 'workgroup.create':
    case 'workgroup.members':
    case 'workgroup.run': {
      const existing = await findArtifact(db, run.id, 'workgroup')
      if (existing !== undefined) {
        const live = await liveResourceName(db, 'workgroup', existing.resourceId)
        if (live !== null)
          return { type: 'workgroup', id: existing.resourceId, name: live, reused: true }
      }
      const coder = await ensureCoderAgent(db, actor, run)
      const lead = await ensureSecondaryAgent(db, actor, run, leadInput(run.suffix))
      // Two agent members, not one: a leader_worker group whose only member is
      // the leader still passes the readiness check (with an advisory warning),
      // then runs with nobody to delegate to — a green run that did nothing.
      const created = await createWorkgroup(
        db,
        CreateWorkgroupSchema.parse({
          name: `guide-squad-${run.suffix}`,
          description: 'Guided-tour example: a lead agent delegating to one worker.',
          instructions: 'Deliver the goal with the smallest reasonable change.',
          mode: 'leader_worker',
          leaderDisplayName: 'lead',
          switches: { shareOutputs: true, directMessages: false, blackboard: false },
          maxRounds: 20,
          completionGate: true,
          members: [
            {
              memberType: 'agent',
              agentName: lead.name,
              displayName: 'lead',
              roleDesc: 'Coordinates the work.',
            },
            {
              memberType: 'agent',
              agentName: coder.name,
              displayName: 'worker',
              roleDesc: 'Does the implementation.',
            },
          ],
        }),
        { ownerUserId: actor.user.id, visibility: 'private', example: true },
      )
      recordArtifact(db, run.id, 'workgroup', created.id, created.name)
      return { type: 'workgroup', id: created.id, name: created.name, reused: false }
    }
  }
}

// --- adoption ("我自己来") ----------------------------------------------------

/**
 * Adopt a resource the user built themselves into the run.
 *
 * Ownership is checked against `owner_user_id` directly rather than through
 * `requireResourceOwner`, because that helper returns true for ANY admin — an
 * admin could otherwise adopt (and thereby flip to private, and later delete)
 * somebody else's resource.
 */
export async function adoptResource(
  db: DbClient,
  actor: Actor,
  runId: string,
  input: AdoptOnboardingResource,
): Promise<OnboardingRun> {
  const run = await requireOwnRun(db, actor, runId)
  const { resourceType, resourceKey } = input

  if (resourceType === 'task') {
    // Tasks carry no visibility column and their `example` flag is derived at
    // launch; adoption is pure bookkeeping.
    const { tasks } = await import('@/db/schema')
    const row = await db
      .select({ id: tasks.id, name: tasks.name, ownerUserId: tasks.ownerUserId })
      .from(tasks)
      .where(eq(tasks.id, resourceKey))
      .get()
    if (row === undefined || row.ownerUserId !== actor.user.id) {
      throw new NotFoundError('task-not-found', 'task not found')
    }
    recordArtifact(db, run.id, 'task', row.id, row.name)
    return markStepDone(db, actor, run, input.step)
  }

  const table =
    resourceType === 'agent'
      ? agents
      : resourceType === 'skill'
        ? skills
        : resourceType === 'workflow'
          ? workflows
          : workgroups
  const keyColumn = resourceType === 'workflow' ? workflows.id : table.name
  const row = await db
    .select({ id: table.id, name: table.name, ownerUserId: table.ownerUserId })
    .from(table)
    .where(eq(keyColumn as never, resourceKey))
    .get()

  // Not-found and not-yours are byte-identical: RFC-099 D1 forbids letting an
  // error shape tell you that somebody else's resource exists.
  if (row === undefined) {
    throw new NotFoundError(`${resourceType}-not-found`, `${resourceType} not found`)
  }
  if (row.ownerUserId !== actor.user.id) {
    if (actor.user.role === 'admin') {
      // An admin CAN see it, so tell them the truth: adopting someone else's
      // resource would silently make it private and later delete it, and it
      // would break their next save (assertNewRefsUsable) anyway.
      throw new ForbiddenError(
        'forbidden',
        'only the resource owner can adopt it into their guided tour',
      )
    }
    throw new NotFoundError(`${resourceType}-not-found`, `${resourceType} not found`)
  }

  const currentAcl = await db
    .select({ aclRevision: table.aclRevision })
    .from(table)
    .where(eq(table.id, row.id))
    .get()
  await db
    .update(table)
    .set({
      example: true,
      visibility: 'private',
      // A visibility change MUST bump the ACL revision: the ACL panel commits
      // with an expectedAclRevision, so flipping silently would let a
      // concurrent edit land on top of a snapshot that is no longer true.
      aclRevision: (currentAcl?.aclRevision ?? 0) + 1,
      updatedAt: Date.now(),
    } as never)
    .where(eq(table.id, row.id))
  recordArtifact(db, run.id, resourceType, row.id, row.name)
  return markStepDone(db, actor, run, input.step)
}

async function markStepDone(
  db: DbClient,
  actor: Actor,
  run: RunRow,
  step: OnboardingStep,
): Promise<OnboardingRun> {
  const completed = new Set(parseSteps(run.completedSteps))
  completed.add(step)
  return patchRun(db, actor, run.id, {
    completedSteps: [...completed],
    currentStep: nextStep(run.track, step) ?? step,
  })
}

// --- consistency oracle ------------------------------------------------------

/**
 * Pure diff between the two marker sources. Extracted so the invariant is
 * testable without a database: the artifacts table owns the batch view, the
 * per-row `example` column owns the row view, and nothing but a bug can make
 * them disagree.
 */
export function diffExampleMarkers(
  artifacts: readonly { resourceType: string; resourceId: string }[],
  rows: readonly { resourceType: string; id: string; example: boolean }[],
): { markedWithoutArtifact: string[]; artifactWithoutMark: string[] } {
  const key = (t: string, id: string): string => `${t}:${id}`
  const artifactKeys = new Set(artifacts.map((a) => key(a.resourceType, a.resourceId)))
  const markedKeys = new Set(rows.filter((r) => r.example).map((r) => key(r.resourceType, r.id)))
  return {
    markedWithoutArtifact: [...markedKeys].filter((k) => !artifactKeys.has(k)).sort(),
    artifactWithoutMark: [...artifactKeys].filter((k) => !markedKeys.has(k)).sort(),
  }
}
