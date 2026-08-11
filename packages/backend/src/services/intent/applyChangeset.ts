// RFC-234 §9 (T6) — the intent bundle apply pipeline.
//
// External invariant (AC-4/AC-13): either every resource of the confirmed
// draft lands terminally VISIBLE, or zero do; one clientMutationId takes
// effect at most once (duplicate requests replay the stored receipt).
//
// Phases (design §9.1-§9.5):
//   claim     one tx: draft-hash + context-epoch + no-in-flight checks, then
//             UNIQUE(session, clientMutationId) journal claim ('prepared').
//             A duplicate returns the stored receipt/error with ZERO side
//             effects (design-gate P0-6).
//   preflight resolveIntentBundle (slots/copy/rewiring) + per-type prepare*
//             kernels with same-bundle pending seams. No side effects.
//   prestage  compensable side effects, each RECORDED IN THE JOURNAL BEFORE it
//             runs (design-gate P0-5): plugin installs, skill stages.
//   big tx    journal CAS prepared→applying, then every commit kernel in topo
//             order (same-connection uncommitted visibility makes
//             assertRefsUsableInTx exact for bundle-internal refs), fences
//             re-verified inside the kernels, provenance rows, session epoch
//             close, journal 'committed' + receipt.
//   forward   idempotent post-commit publishes: skill finishOperation,
//             created/updated broadcasts.
//   converge  boot/hourly: prepared/applying → compensate artifacts → failed;
//             committed → replay roll-forward (convergeIntentApplyJournal).
//
// v1 op-coverage boundary (recorded in plan.md): creates for all six types +
// updates for agent/mcp/workflow/workgroup. skill/plugin UPDATE ops are
// rejected as `intent-op-unsupported` until the follow-stretch lands the
// op-lock + staged-version roll-forward path.

import { and, eq } from 'drizzle-orm'
import {
  CreateAgentSchema,
  CreateMcpSchema,
  CreateWorkgroupSchema,
  UpdateAgentSchema,
  WorkflowDefinitionSchema,
  type CreateMcp,
  type CreateWorkgroup,
  type UpdateWorkgroup,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { stringify as stringifyYaml } from 'yaml'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import {
  intentApplyJournal,
  intentDrafts,
  intentProvenance,
  intentSessions,
  plugins as pluginsTable,
} from '@/db/schema'
import { ACL_TABLES } from '@/services/resourceAcl'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger, type Logger } from '@/util/log'
import { ulid } from 'ulid'
import { ZodError } from 'zod'
import { formatChangesetIssues } from '@agent-workflow/shared'
import {
  commitAgentCreateInTx,
  commitAgentUpdateInTx,
  getAgentById,
  prepareAgentCreate,
  prepareAgentUpdate,
  type PreparedAgentCreate,
  type PreparedAgentUpdate,
} from '@/services/agent'
import {
  commitMcpCreateInTx,
  commitMcpUpdateInTx,
  getMcpById,
  prepareMcpCreate,
  type PreparedMcpCreate,
  type PreparedMcpUpdate,
} from '@/services/mcp'
import {
  commitPluginCreateInTx,
  commitPluginPublishInTx,
  type PreparedPluginCreate,
} from '@/services/plugin'
import { pluginOperationConfigHashOf } from '@/services/pluginOperationRevision'
import {
  cleanupInstallGeneration,
  installPlugin,
  plannedGenerationDir,
  type InstallResult,
} from '@/services/pluginInstaller'
import {
  commitSkillReadyInTx,
  compensateManagedSkillStage,
  stageManagedSkill,
} from '@/services/skill'
import { finishOperation } from '@/services/skillOperations'
import {
  abortStagedSkillVersion,
  commitSkillVersionInTx,
  publishStagedSkillVersion,
  stageSkillVersion,
  type StagedSkillVersion,
} from '@/services/skillVersion'
import { unmarkSkillBootVerified } from '@/services/skillBootVerify'
import {
  broadcastWorkflowCreated,
  commitWorkflowSaveInTx,
  insertWorkflowInTx,
  prepareWorkflowSave,
  rowToWorkflowDetail,
  type PreparedWorkflowSave,
} from '@/services/workflow'
import {
  broadcastWorkgroupCreated,
  commitWorkgroupCreateInTx,
  commitWorkgroupSaveInTx,
  prepareWorkgroupCreate,
  prepareWorkgroupSave,
  type PreparedWorkgroupCreate,
  type PreparedWorkgroupSave,
} from '@/services/workgroups'
import {
  assertRefsUsableInTx,
  extractWorkflowWorkflowRefs,
  extractWorkflowWorkgroupRefs,
} from '@/services/resourceRefs'
import { type IntentContextManifest, type IntentFence, type IntentManifestEntry } from './manifest'
import { resolveIntentBundle, type IntentDecision, type ResolvedIntentOp } from './resolveChangeset'
import { sessionManifest } from './session'

export interface IntentApplyReceipt {
  journalId: string
  commitSeq: number
  applied: Array<{
    opId: string
    resourceType: string
    resourceId: string
    action: 'create' | 'update'
    fromCopy: boolean
    name: string
  }>
}

type JournalArtifact =
  /** RFC-271 T17：`generationDir` 由调用方**预铸**并先落库——只记 pluginId 时，
   *  崩溃后的收敛器不知道该删哪个 generation 目录，而粗粒度 GC 又被任一非终态
   *  node run 完全挡住 ⇒ 目录永久残留。旧形态（无该字段）仍可解析。 */
  | { kind: 'plugin-install'; pluginId: string; generationDir?: string }
  | { kind: 'skill-stage'; skillId: string; opId: string; skillDir: string }
  | { kind: 'skill-version-stage'; skillId: string; opId: string; stagingDir: string }

/**
 * Codex impl-gate P0-1/P2-3 — update targets the actor cannot modify in place:
 *  - foreign or built-in owner (D-round1: 他人/内置仅副本) → copy-only.
 * RFC-271 T14: the skill/plugin "not implemented yet" carve-out is GONE; all six
 * types share the one ownerUserId rule.
 * handle → reason. Shared by the apply preflight (enforced inside
 * resolveIntentBundle) and the session-detail route (drives the commit UI).
 */
export async function copyOnlyTargetsFor(
  db: DbClient,
  actor: Actor,
  manifest: IntentContextManifest,
  changeset: {
    ops: ReadonlyArray<{ action: string; resourceType: string; target?: string }>
  },
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const byHandle = new Map(
    manifest.map((entry): [string, IntentManifestEntry] => [entry.handle, entry]),
  )
  for (const op of changeset.ops) {
    if (op.action !== 'update' || op.target === undefined) continue
    // RFC-271 T14（决策 27）：skill / plugin 的「尚不支持原地更新」特例已解除——
    // 它们和其余四类走**同一条** ownerUserId 判据。⚠️ 那条判据本身一字未动：
    // 他人拥有的 / 内置的资源仍然强制 copy，copy 语义（slot 派生 / 重连 /
    // finalName / receipt 的 fromCopy）逐条保持。
    const entry = byHandle.get(op.target)
    if (entry === undefined) continue // unknown handle → draft validation owns it
    const table = ACL_TABLES[entry.resourceType]
    const row = (
      await db
        .select({ ownerUserId: table.ownerUserId })
        .from(table)
        .where(eq(table.id, entry.resourceId))
        .limit(1)
    )[0]
    if (row === undefined) continue // vanished row → fence/stale owns it
    if (row.ownerUserId !== actor.user.id) {
      out.set(op.target, 'owned by another user or built-in')
    }
  }
  return out
}

type PluginRow = typeof pluginsTable.$inferSelect

/**
 * RFC-271 T17 —— 插件基线复核**只读一次**。
 *
 * ⚠️ 分两次读（一次算 hash、一次做整行捕获）会让「两次读之间被人改掉」的窗口
 * 原样复现，而 `commitPluginPublishInTx` 的整行 CAS 正是为堵这个窗口而存在的。
 * 所以这里返回**同一行**，hash 与捕获都从它算。
 */
async function requirePluginRowForIntent(db: DbClient, id: string): Promise<PluginRow> {
  const rows = await db.select().from(pluginsTable).where(eq(pluginsTable.id, id)).limit(1)
  const row = rows[0]
  if (row === undefined) throw new NotFoundError('plugin-not-found', `plugin '${id}' not found`)
  return row
}

/** `pluginOperationConfigHashOf` 要的最小投影（与 plugin.ts 的 rowToPlugin 同源字段）。 */
function rowToPluginForIntent(row: PluginRow): Parameters<typeof pluginOperationConfigHashOf>[0] {
  return {
    ...row,
    options: JSON.parse(row.optionsJson) as Record<string, unknown>,
  } as never
}

export interface ApplyIntentFaults {
  afterPluginInstall?: () => void
  afterSkillStage?: () => void
  beforeTx?: () => void
  inTxAfterOps?: () => void
  afterTxBeforeRollForward?: () => void
}

export interface ApplyIntentDeps {
  db: DbClient
  appHome: string
  actor: Actor
  /** Plugin installer seam (tests point specs at local fixtures). */
  pluginInstallOpts?: Parameters<typeof installPlugin>[2]
  faults?: ApplyIntentFaults
  log?: Logger
}

export interface ApplyIntentInput {
  sessionId: string
  clientMutationId: string
  draftRevision: number
  draftHash: string
  decisions: IntentDecision[]
}

/** Per-session in-process serialization (single-daemon platform). */
const applyLocks = new Map<string, Promise<unknown>>()

async function withSessionApplyLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prior = applyLocks.get(sessionId) ?? Promise.resolve()
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  applyLocks.set(
    sessionId,
    prior.then(() => gate),
  )
  await prior.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
    if (applyLocks.get(sessionId) === gate) applyLocks.delete(sessionId)
  }
}

async function occupiedNamesFor(
  db: DbClient,
  ownerUserId: string,
): Promise<ReadonlyMap<ResolvedIntentOp['resourceType'], ReadonlySet<string>>> {
  const out = new Map<ResolvedIntentOp['resourceType'], Set<string>>()
  for (const type of Object.keys(ACL_TABLES) as Array<keyof typeof ACL_TABLES>) {
    const table = ACL_TABLES[type]
    const rows = await db
      .select({ name: table.name })
      .from(table)
      .where(eq(table.ownerUserId, ownerUserId))
    out.set(type, new Set(rows.map((r) => r.name.toLowerCase())))
  }
  return out
}

type PreparedOp =
  | { op: ResolvedIntentOp; kind: 'agent-create'; prepared: PreparedAgentCreate }
  | { op: ResolvedIntentOp; kind: 'agent-update'; prepared: PreparedAgentUpdate }
  | { op: ResolvedIntentOp; kind: 'mcp-create'; prepared: PreparedMcpCreate }
  | { op: ResolvedIntentOp; kind: 'mcp-update'; prepared: PreparedMcpUpdate }
  | {
      op: ResolvedIntentOp
      kind: 'plugin-create'
      spec: string
      parsed: PreparedPluginCreate['parsed']
    }
  | { op: ResolvedIntentOp; kind: 'skill-create' }
  | { op: ResolvedIntentOp; kind: 'skill-update'; staged: StagedSkillVersion }
  | {
      op: ResolvedIntentOp
      kind: 'plugin-update'
      spec: string
      specChanged: boolean
      captured: PluginRow
      payload: { options: Record<string, unknown>; description: string; enabled: boolean }
    }
  | { op: ResolvedIntentOp; kind: 'workflow-create'; definition: WorkflowDefinition }
  | { op: ResolvedIntentOp; kind: 'workflow-update'; prepared: PreparedWorkflowSave }
  | { op: ResolvedIntentOp; kind: 'workgroup-create'; prepared: PreparedWorkgroupCreate }
  | { op: ResolvedIntentOp; kind: 'workgroup-update'; prepared: PreparedWorkgroupSave }

function agentFenceOf(fence: IntentFence | undefined): {
  expectedUpdatedAt: number
  expectedAclRevision: number
} {
  if (fence?.kind !== 'agent')
    throw new ConflictError('intent-baseline-stale', 'agent fence missing')
  return { expectedUpdatedAt: fence.updatedAt, expectedAclRevision: fence.aclRevision }
}

export async function applyIntentChangeset(
  deps: ApplyIntentDeps,
  input: ApplyIntentInput,
): Promise<IntentApplyReceipt> {
  return withSessionApplyLock(input.sessionId, () => applyInner(deps, input))
}

async function applyInner(
  deps: ApplyIntentDeps,
  input: ApplyIntentInput,
): Promise<IntentApplyReceipt> {
  const log = deps.log ?? createLogger('intentApply')
  const { db, actor } = deps
  const journalId = ulid()

  // ── claim (design §9.1) ──
  const claim = dbTxSync(db, (tx) => {
    const session = tx
      .select()
      .from(intentSessions)
      .where(eq(intentSessions.id, input.sessionId))
      .get()
    if (session === undefined || session.ownerUserId !== actor.user.id) {
      throw new NotFoundError('intent-session-not-found', 'intent session not found')
    }
    const existing = tx
      .select()
      .from(intentApplyJournal)
      .where(
        and(
          eq(intentApplyJournal.sessionId, input.sessionId),
          eq(intentApplyJournal.clientMutationId, input.clientMutationId),
        ),
      )
      .get()
    if (existing !== undefined) {
      return { kind: 'replay' as const, existing, session }
    }
    if (session.status !== 'active') {
      throw new ConflictError('intent-session-archived', 'session is archived')
    }
    if (session.inFlightTurnId !== null) {
      throw new ConflictError('intent-turn-in-flight', 'a generation turn is running')
    }
    const draft = tx
      .select()
      .from(intentDrafts)
      .where(
        and(
          eq(intentDrafts.sessionId, input.sessionId),
          eq(intentDrafts.revision, input.draftRevision),
        ),
      )
      .get()
    if (draft === undefined) {
      throw new NotFoundError('intent-draft-not-found', 'draft revision not found')
    }
    if (draft.draftHash !== input.draftHash) {
      throw new ConflictError('intent-draft-hash-mismatch', 'confirmed draft hash does not match', {
        expected: draft.draftHash,
      })
    }
    if (draft.contextRevision !== session.contextRevision) {
      throw new ConflictError(
        'intent-baseline-stale',
        'the session context moved since this draft was generated; rebase and regenerate',
      )
    }
    // Codex impl-gate P1-3: the hash proves WHICH revision was confirmed, not
    // that it is still the CURRENT one — a later turn in the same epoch mints
    // a higher revision without bumping contextRevision. Refuse stale tabs.
    if (session.currentDraftId !== draft.id) {
      throw new ConflictError(
        'intent-draft-superseded',
        'a newer draft revision exists in this session; review and commit the latest draft',
        { confirmedRevision: draft.revision },
      )
    }
    const now = Date.now()
    tx.insert(intentApplyJournal)
      .values({
        id: journalId,
        sessionId: input.sessionId,
        clientMutationId: input.clientMutationId,
        draftId: draft.id,
        draftHash: draft.draftHash,
        state: 'prepared',
        preparedArtifactsJson: '[]',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    return { kind: 'claimed' as const, session, draft }
  })

  if (claim.kind === 'replay') {
    const row = claim.existing
    if (row.state === 'committed' && row.receiptJson !== null) {
      return JSON.parse(row.receiptJson) as IntentApplyReceipt
    }
    if (row.state === 'failed') {
      throw new ConflictError(
        'intent-apply-failed-replay',
        row.error ?? 'this apply attempt failed',
        {
          journalId: row.id,
        },
      )
    }
    // prepared/applying without a live lock holder = a crashed attempt that
    // boot convergence has not yet swept. Refuse rather than guess.
    throw new ConflictError(
      'intent-apply-unsettled',
      'a prior apply attempt is unsettled; retry later',
      {
        journalId: row.id,
      },
    )
  }

  // P2-1: the whole claim→settle window is registered so the converger can
  // never mistake this process's own live apply for a crashed one.
  ACTIVE_APPLY_JOURNALS.add(journalId)

  const artifacts: JournalArtifact[] = []
  const recordArtifact = (artifact: JournalArtifact): void => {
    artifacts.push(artifact)
    dbTxSync(db, (tx) => {
      tx.update(intentApplyJournal)
        .set({ preparedArtifactsJson: JSON.stringify(artifacts), updatedAt: Date.now() })
        .where(eq(intentApplyJournal.id, journalId))
        .run()
    })
  }
  const settleFailed = (error: unknown): void => {
    dbTxSync(db, (tx) => {
      tx.update(intentApplyJournal)
        .set({
          state: 'failed',
          error:
            error instanceof Error
              ? `${(error as { code?: string }).code ?? 'error'}: ${error.message}`
              : String(error),
          updatedAt: Date.now(),
        })
        .where(eq(intentApplyJournal.id, journalId))
        .run()
    })
  }

  const pluginInstalls = new Map<string, InstallResult>()
  const skillStages = new Map<string, { skillId: string; opId: string; skillDir: string }>()
  const skillVersionStages = new Map<string, StagedSkillVersion>()
  let committedReceipt: IntentApplyReceipt | null = null
  try {
    // ── preflight (design §9.2/§9.3) ──
    const manifest = sessionManifest(claim.session)
    const changeset = JSON.parse(claim.draft.changesetJson)
    const occupiedNames = await occupiedNamesFor(db, actor.user.id)
    const copyOnlyTargets = await copyOnlyTargetsFor(db, actor, manifest, changeset)
    const bundle = resolveIntentBundle({
      manifest,
      changeset,
      decisions: input.decisions,
      occupiedNames,
      copyOnlyTargets,
    })
    const pendingIds = new Set(
      bundle.ops.filter((o) => o.action === 'create').map((o) => o.resourceId),
    )
    const pendingAgentNames = new Map(
      bundle.ops
        .filter((o) => o.action === 'create' && o.resourceType === 'agent')
        .map((o) => [o.resourceId, (o.payload as { name: string }).name]),
    )

    const preparedOps: PreparedOp[] = []
    for (const op of bundle.ops) {
      try {
        if (op.action === 'create') {
          switch (op.resourceType) {
            case 'agent': {
              const parsed = CreateAgentSchema.parse(op.payload)
              const prepared = await prepareAgentCreate(db, parsed, {
                ownerUserId: actor.user.id,
                actor,
                id: op.resourceId,
                pendingBundleIds: pendingIds,
              })
              preparedOps.push({ op, kind: 'agent-create', prepared })
              break
            }
            case 'mcp': {
              const parsed: CreateMcp = CreateMcpSchema.parse(op.payload)
              const prepared = await prepareMcpCreate(db, parsed, {
                ownerUserId: actor.user.id,
                actor,
              })
              preparedOps.push({
                op,
                kind: 'mcp-create',
                prepared: { ...prepared, id: op.resourceId },
              })
              break
            }
            case 'plugin': {
              const p = op.payload as {
                name: string
                spec: string
                options: Record<string, unknown>
                description: string
                enabled: boolean
              }
              preparedOps.push({
                op,
                kind: 'plugin-create',
                spec: p.spec,
                parsed: {
                  name: p.name,
                  spec: p.spec,
                  options: p.options,
                  description: p.description,
                  enabled: p.enabled,
                },
              })
              break
            }
            case 'skill':
              preparedOps.push({ op, kind: 'skill-create' })
              break
            case 'workflow': {
              const definition = WorkflowDefinitionSchema.parse(op.payload.definition)
              preparedOps.push({ op, kind: 'workflow-create', definition })
              break
            }
            case 'workgroup': {
              const parsed: CreateWorkgroup = CreateWorkgroupSchema.parse(op.payload)
              const prepared = await prepareWorkgroupCreate(db, parsed, {
                ownerUserId: actor.user.id,
                actor,
                pendingAgentNames,
              })
              preparedOps.push({
                op,
                kind: 'workgroup-create',
                prepared: { ...prepared, groupId: op.resourceId },
              })
              break
            }
          }
          continue
        }
        // ── updates ──
        switch (op.resourceType) {
          case 'agent': {
            const existing = await getAgentById(db, op.resourceId)
            if (existing === null) throw new NotFoundError('agent-not-found', 'agent not found')
            if ((op.payload as { name: string }).name !== existing.name) {
              throw new ValidationError(
                'intent-rename-unsupported',
                'renaming via intent update is not supported; use the finalName slot on a copy, or the rename flow',
              )
            }
            const { name: _name, ...patchBody } = op.payload as Record<string, unknown>
            const patch = UpdateAgentSchema.parse(patchBody)
            const prepared = await prepareAgentUpdate(
              db,
              op.resourceId,
              patch,
              actor,
              agentFenceOf(op.manifestEntry?.fence),
              {
                pendingBundleIds: pendingIds,
              },
            )
            preparedOps.push({ op, kind: 'agent-update', prepared })
            break
          }
          case 'mcp': {
            const existing = await getMcpById(db, op.resourceId)
            if (existing === null) throw new NotFoundError('mcp-not-found', 'mcp not found')
            const fence = op.manifestEntry?.fence
            if (fence?.kind !== 'mcp') {
              throw new ConflictError('intent-baseline-stale', 'mcp fence missing')
            }
            const p = op.payload as CreateMcp
            if (p.type !== existing.type) {
              throw new ValidationError('mcp-type-immutable', 'mcp type cannot change')
            }
            // Codex impl-gate P1-2: the intent MCP schema carries no oauth
            // block, and update replaces config WHOLE — carry the existing
            // oauth forward or a remote MCP silently loses its auth.
            const existingOauth = (existing.config as { oauth?: unknown }).oauth
            const nextConfig =
              existingOauth === undefined
                ? p.config
                : { ...(p.config as Record<string, unknown>), oauth: existingOauth }
            const set: PreparedMcpUpdate['set'] = {
              updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
              description: p.description,
              enabled: p.enabled,
              config: JSON.stringify(nextConfig),
            }
            preparedOps.push({
              op,
              kind: 'mcp-update',
              prepared: {
                id: op.resourceId,
                set,
                expectedConfigHash: fence.configHash,
                // RFC-271 T12：把授权时看到的 owner 一起带进提交事务。hash 只证明
                // 「我读到的是这一版」，不是授权——少了这道围栏，直接到达该原语的
                // 写路径可以拿他人公开资源的 id + 正确 hash 改写别人那一行。
                expectedOwnerUserId: existing.ownerUserId,
              },
            })
            break
          }
          case 'workflow': {
            const fence = op.manifestEntry?.fence
            if (fence?.kind !== 'workflow') {
              throw new ConflictError('intent-baseline-stale', 'workflow fence missing')
            }
            const prepared = await prepareWorkflowSave(
              db,
              op.resourceId,
              {
                expectedVersion: fence.version,
                clientMutationId: input.clientMutationId,
                snapshot: {
                  name: (op.payload as { name: string }).name,
                  description: (op.payload as { description: string }).description,
                  definition: WorkflowDefinitionSchema.parse(op.payload.definition),
                },
              },
              { kind: 'actor', actor },
            )
            preparedOps.push({ op, kind: 'workflow-update', prepared })
            break
          }
          case 'workgroup': {
            const fence = op.manifestEntry?.fence
            if (fence?.kind !== 'workgroup') {
              throw new ConflictError('intent-baseline-stale', 'workgroup fence missing')
            }
            const snapshot = op.payload as unknown as UpdateWorkgroup['snapshot']
            const prepared = await prepareWorkgroupSave(
              db,
              op.resourceId,
              {
                expectedVersion: fence.version,
                clientMutationId: input.clientMutationId,
                snapshot,
              } as UpdateWorkgroup,
              { kind: 'actor', actor },
            )
            preparedOps.push({ op, kind: 'workgroup-update', prepared })
            break
          }
          case 'skill': {
            // RFC-271 T14：暂存段留到 prestage（它有 FS 副作用），这里只占位。
            preparedOps.push({ op, kind: 'skill-update', staged: null as never })
            break
          }
          case 'plugin': {
            // ⚠️ T17：基线必须从**同一次**读到的完整 row 投影算 configHash。
            // 分两次读（一次算 hash、一次做捕获）会让「读之间被人改掉」的漏洞
            // 原样复现——那正是 `commitPluginPublishInTx` 的整行 CAS 要防的东西。
            const captured = await requirePluginRowForIntent(db, op.resourceId)
            const fence = op.manifestEntry?.fence
            if (fence?.kind !== 'plugin') {
              throw new ConflictError('intent-baseline-stale', 'plugin fence missing')
            }
            const currentHash = pluginOperationConfigHashOf(rowToPluginForIntent(captured))
            if (currentHash !== fence.configHash) {
              throw new ConflictError(
                'resource-operation-stale',
                'the plugin changed; reload before saving',
              )
            }
            const p = op.payload as {
              spec: string
              options?: Record<string, unknown>
              description?: string
              enabled?: boolean
            }
            preparedOps.push({
              op,
              kind: 'plugin-update',
              spec: p.spec,
              specChanged: p.spec !== captured.spec,
              captured,
              payload: {
                options: p.options ?? {},
                description: p.description ?? captured.description,
                enabled: p.enabled ?? captured.enabled,
              },
            })
            break
          }
          default:
            throw new ValidationError(
              'intent-op-unsupported',
              `${op.resourceType} update via intent is not supported yet; propose a copy instead`,
            )
        }
      } catch (err) {
        // Live-run lesson (deepseek 2026-07-28): a canonical-service schema
        // rejection (e.g. RFC-060 kind grammar on agent inputs) surfaced as an
        // unhandled ZodError → HTTP 500. Map it to a typed, op-addressed
        // validation error so the UI (and the model self-fix loop, via the
        // commit failure receipt) see actionable field paths. Typed domain
        // errors pass through; genuinely unknown faults keep failing loud.
        if (err instanceof ZodError) {
          throw new ValidationError(
            'intent-op-canonical-invalid',
            `${op.opId}: ${formatChangesetIssues(err.issues).join('; ')}`,
          )
        }
        throw err
      }
    }

    // ── prestage (design §9.4 ①②; record-then-act) ──
    for (const item of preparedOps) {
      if (item.kind === 'plugin-create' || (item.kind === 'plugin-update' && item.specChanged)) {
        // RFC-271 T17：**预铸** generation id，精确路径先落 journal 再安装。
        const generationId = ulid()
        const generationDir = plannedGenerationDir(
          item.op.resourceId,
          item.spec,
          generationId,
          deps.pluginInstallOpts?.pluginsDir,
        )
        recordArtifact({
          kind: 'plugin-install',
          pluginId: item.op.resourceId,
          ...(generationDir === null ? {} : { generationDir }),
        })
        const install = await installPlugin(item.op.resourceId, item.spec, {
          ...deps.pluginInstallOpts,
          generationId,
        })
        pluginInstalls.set(item.op.resourceId, install)
        deps.faults?.afterPluginInstall?.()
      } else if (item.kind === 'skill-update') {
        const payload = item.op.payload as {
          name: string
          description: string
          frontmatterExtra: Record<string, unknown>
          bodyMd: string
          files: Array<{ path: string; content: string }>
        }
        const staged = stageSkillVersion(
          db,
          { appHome: deps.appHome },
          item.op.resourceId,
          (stagingDir) => {
            const skillMd = `---\n${stringifyYaml(
              {
                name: payload.name,
                description: payload.description,
                ...payload.frontmatterExtra,
              },
              { lineWidth: 0 },
            )}---\n\n${payload.bodyMd}\n`
            writeFileSync(join(stagingDir, 'SKILL.md'), skillMd)
            for (const file of payload.files ?? []) {
              const abs = join(stagingDir, file.path)
              mkdirSync(dirname(abs), { recursive: true })
              writeFileSync(abs, file.content)
            }
          },
          {
            source: 'editor',
            authorUserId: actor.user.id,
            // T16：owner 围栏显式传入 —— 授权之后、提交之前的 owner 转移必须 409。
            expectedOwnerUserId: actor.user.id,
            setDescription: payload.description,
          },
        )
        ;(item as { staged: StagedSkillVersion }).staged = staged
        skillVersionStages.set(item.op.resourceId, staged)
        recordArtifact({
          kind: 'skill-version-stage',
          skillId: staged.skillId,
          opId: staged.opId ?? '',
          stagingDir: staged.stagingDir,
        })
        deps.faults?.afterSkillStage?.()
      } else if (item.kind === 'skill-create') {
        const payload = item.op.payload as {
          name: string
          description: string
          frontmatterExtra: Record<string, unknown>
          bodyMd: string
          files: Array<{ path: string; content: string }>
        }
        const stage = await stageManagedSkill(
          db,
          { appHome: deps.appHome },
          {
            name: payload.name,
            description: payload.description,
            ownerUserId: actor.user.id,
            actor,
            id: item.op.resourceId,
          },
          (filesDir) => {
            const skillMd = `---\n${stringifyYaml(
              {
                name: payload.name,
                description: payload.description,
                ...payload.frontmatterExtra,
              },
              { lineWidth: 0 },
            )}---\n\n${payload.bodyMd}\n`
            writeFileSync(join(filesDir, 'SKILL.md'), skillMd)
            for (const file of payload.files) {
              const abs = join(filesDir, file.path)
              mkdirSync(dirname(abs), { recursive: true })
              writeFileSync(abs, file.content)
            }
          },
        )
        skillStages.set(item.op.resourceId, stage)
        recordArtifact({ kind: 'skill-stage', ...stage })
        deps.faults?.afterSkillStage?.()
      }
    }

    deps.faults?.beforeTx?.()

    // ── the big transaction (design §9.4 ③) ──
    const applied: IntentApplyReceipt['applied'] = []
    const createdWorkflowRows: Array<ReturnType<typeof insertWorkflowInTx>> = []
    const createdWorkgroups: Array<ReturnType<typeof commitWorkgroupCreateInTx>> = []
    const receipt = dbTxSync(db, (tx) => {
      const cas = tx
        .update(intentApplyJournal)
        .set({ state: 'applying', updatedAt: Date.now() })
        .where(and(eq(intentApplyJournal.id, journalId), eq(intentApplyJournal.state, 'prepared')))
        .run()
      if ((cas as unknown as { changes?: number }).changes !== 1) {
        throw new ConflictError('intent-apply-unsettled', 'journal claim lost')
      }

      // Codex impl-gate P1-1: claim-time checks alone leave the prestage
      // window (npm install / skill staging) open to rebase/mount/new drafts.
      // Re-assert the session identity INSIDE the commit transaction so a
      // moved epoch or superseded draft can never land, and the epoch bump
      // below builds on the value we actually verified.
      const sessionNow = tx
        .select()
        .from(intentSessions)
        .where(eq(intentSessions.id, input.sessionId))
        .get()
      if (
        sessionNow === undefined ||
        sessionNow.contextRevision !== claim.session.contextRevision ||
        sessionNow.currentDraftId !== claim.draft.id ||
        sessionNow.inFlightTurnId !== null
      ) {
        throw new ConflictError(
          'intent-baseline-stale',
          'the session changed while the apply was staging; rebase and regenerate',
        )
      }

      // Names this very bundle is about to create, by type. Read from the
      // RESOLVED payload, so a target renamed through its `finalName` slot at
      // confirm time is keyed by the name that actually lands in the row —
      // `resolveIntentBundle` overlays the slot before we get here
      // (resolveChangeset.ts `nameOf`), and keying off the model's original
      // name would silently miss the rename.
      const bundleCreatedNames = { workflow: new Set<string>(), workgroup: new Set<string>() }
      for (const item of preparedOps) {
        if (item.op.action !== 'create') continue
        const bucket =
          item.op.resourceType === 'workflow'
            ? bundleCreatedNames.workflow
            : item.op.resourceType === 'workgroup'
              ? bundleCreatedNames.workgroup
              : null
        if (bucket === null) continue
        const name = (item.op.payload as { name?: unknown }).name
        if (typeof name === 'string' && name.length > 0) bucket.add(name)
      }

      for (const item of preparedOps) {
        switch (item.kind) {
          case 'agent-create':
            commitAgentCreateInTx(tx, item.prepared)
            break
          case 'agent-update':
            commitAgentUpdateInTx(tx, item.prepared)
            break
          case 'mcp-create':
            commitMcpCreateInTx(tx, item.prepared)
            break
          case 'mcp-update':
            commitMcpUpdateInTx(tx, item.prepared)
            break
          case 'plugin-create': {
            const install = pluginInstalls.get(item.op.resourceId)
            if (install === undefined) throw new Error('plugin install result missing')
            commitPluginCreateInTx(tx, {
              id: item.op.resourceId,
              parsed: item.parsed,
              initialAcl: {
                ownerUserId: actor.user.id,
                visibility: 'private',
                aclRevision: 0,
              },
              install,
              now: Date.now(),
            })
            break
          }
          case 'skill-create': {
            const stage = skillStages.get(item.op.resourceId)
            if (stage === undefined) throw new Error('skill stage missing')
            commitSkillReadyInTx(tx, { skillId: stage.skillId, opId: stage.opId })
            break
          }
          case 'skill-update': {
            const staged = skillVersionStages.get(item.op.resourceId)
            if (staged === undefined) throw new Error('skill version stage missing')
            commitSkillVersionInTx(tx, staged, {
              source: 'editor',
              authorUserId: actor.user.id,
              expectedOwnerUserId: actor.user.id,
              setDescription: (item.op.payload as { description: string }).description,
            })
            break
          }
          case 'plugin-update': {
            const install = pluginInstalls.get(item.op.resourceId)
            commitPluginPublishInTx(tx, item.captured, {
              spec: item.spec,
              optionsJson: JSON.stringify(item.payload.options),
              description: item.payload.description,
              enabled: item.payload.enabled,
              sourceKind: install?.sourceKind ?? item.captured.sourceKind,
              cachedPath: install?.cachedPath ?? item.captured.cachedPath,
              resolvedVersion: install?.resolvedVersion ?? item.captured.resolvedVersion,
              installedAt: install === undefined ? item.captured.installedAt : Date.now(),
              updatedAt: Math.max(Date.now(), item.captured.updatedAt + 1),
            })
            break
          }
          case 'workflow-create': {
            assertRefsUsableInTx(tx, actor, [
              {
                type: 'agent',
                domain: 'id',
                names: (item.definition.nodes ?? [])
                  .filter((n) => n.kind === 'agent-single' && typeof n.agentId === 'string')
                  .map((n) => n.agentId as string),
              },
              // RFC-243 §5.3 — call-workflow / call-workgroup select by NAME, and
              // a name is not an authorization: without these two rows the intent
              // create path is the only workflow INSERT that lets an actor adopt a
              // reference to a resource they cannot see (createWorkflow checks all
              // three at services/workflow.ts:200, copyWorkflow at :278, and the
              // save path re-diffs them at :526). It was unreachable only because
              // INTENT.md never taught the two call kinds; teaching them is what
              // makes it reachable.
              //
              // Codex impl-gate P2 — bundle-internal names are excluded rather
              // than left to in-tx visibility. Same-connection visibility only
              // covers a target whose op ran EARLIER, so relying on it would make
              // the fence order-dependent: caller-then-target would 403 while
              // target-then-caller succeeded, for the same logical bundle, and
              // nothing in the resolver's dependency graph or in INTENT.md orders
              // call refs. Excluding them is also the correct ACL answer — the
              // actor is creating those rows in this very transaction, so there
              // is no one else's row to hide behind the name.
              {
                type: 'workflow',
                names: extractWorkflowWorkflowRefs(item.definition).filter(
                  (name) => !bundleCreatedNames.workflow.has(name),
                ),
                domain: 'name',
              },
              {
                type: 'workgroup',
                names: extractWorkflowWorkgroupRefs(item.definition).filter(
                  (name) => !bundleCreatedNames.workgroup.has(name),
                ),
                domain: 'name',
              },
            ])
            const row = insertWorkflowInTx(tx, {
              // RFC-253 — the intent builder reaches this primitive DIRECTLY (no
              // route in between), which is exactly why the gate lives here.
              scriptPrincipal: { kind: 'actor', actor },
              id: item.op.resourceId,
              name: (item.op.payload as { name: string }).name,
              description: (item.op.payload as { description: string }).description,
              definition: item.definition,
              ownerUserId: actor.user.id,
              builtin: false,
              now: Date.now(),
            })
            createdWorkflowRows.push(row)
            break
          }
          case 'workflow-update': {
            const result = commitWorkflowSaveInTx(tx, item.prepared)
            if (!result.committed && result.receipt.outcome !== 'already-current') {
              throw new ConflictError('intent-baseline-stale', 'workflow save did not commit')
            }
            break
          }
          case 'workgroup-create':
            createdWorkgroups.push(commitWorkgroupCreateInTx(tx, item.prepared))
            break
          case 'workgroup-update': {
            const result = commitWorkgroupSaveInTx(tx, item.prepared)
            if (!result.committed && result.receipt.outcome !== 'already-current') {
              throw new ConflictError('intent-baseline-stale', 'workgroup save did not commit')
            }
            break
          }
        }
        applied.push({
          opId: item.op.opId,
          resourceType: item.op.resourceType,
          resourceId: item.op.resourceId,
          action: item.op.action,
          fromCopy: item.op.fromCopy,
          name: (item.op.payload as { name: string }).name,
        })
        tx.insert(intentProvenance)
          .values({
            resourceType: item.op.resourceType,
            resourceId: item.op.resourceId,
            commitId: journalId,
            sessionId: input.sessionId,
            createdAt: Date.now(),
          })
          .run()
      }

      deps.faults?.inTxAfterOps?.()

      const commitSeq = claim.session.commitSeq + 1
      // Close the context epoch (design-gate P1-5): the applied draft archives,
      // the current pointer clears, and stale fences force a fresh dump before
      // the next generation can target the new baselines.
      tx.update(intentSessions)
        .set({
          commitSeq,
          contextRevision: claim.session.contextRevision + 1,
          currentDraftId: null,
          updatedAt: Date.now(),
        })
        .where(eq(intentSessions.id, input.sessionId))
        .run()
      const receiptValue: IntentApplyReceipt = { journalId, commitSeq, applied }
      tx.update(intentApplyJournal)
        .set({
          state: 'committed',
          receiptJson: JSON.stringify(receiptValue),
          updatedAt: Date.now(),
        })
        .where(eq(intentApplyJournal.id, journalId))
        .run()
      return receiptValue
    })
    committedReceipt = receipt

    // ── roll-forward (design §9.5; idempotent) ──
    deps.faults?.afterTxBeforeRollForward?.()
    rollForwardCommitted(
      db,
      {
        skillStages: [...skillStages.values()],
        appHome: deps.appHome,
        skillVersionStages: [...skillVersionStages.values()],
      },
      log,
    )
    for (const row of createdWorkflowRows) {
      try {
        broadcastWorkflowCreated(rowToWorkflowDetail(row))
      } catch {
        /* broadcast is fire-and-forget */
      }
    }
    for (const wg of createdWorkgroups) {
      try {
        broadcastWorkgroupCreated(wg)
      } catch {
        /* broadcast is fire-and-forget */
      }
    }
    return receipt
  } catch (error) {
    if (committedReceipt !== null) {
      // The transaction is durable — the bundle IS applied. A post-commit
      // throw (roll-forward/broadcast) must never compensate or overwrite the
      // committed journal state; convergence replays the idempotent tail.
      log.warn('intent-roll-forward-crashed', {
        journalId,
        err: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    // ── compensation: reverse order, then journal 'failed' (zero visible) ──
    for (const staged of [...skillVersionStages.values()].reverse()) {
      try {
        abortStagedSkillVersion(db, staged)
      } catch (err) {
        log.warn('intent-skill-version-compensation-failed', {
          skillId: staged.skillId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    for (const stage of [...skillStages.values()].reverse()) {
      try {
        compensateManagedSkillStage(db, stage)
      } catch (err) {
        log.warn('intent-skill-compensation-failed', {
          skillId: stage.skillId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    for (const install of [...pluginInstalls.values()].reverse()) {
      try {
        await cleanupInstallGeneration(install)
      } catch (err) {
        log.warn('intent-plugin-compensation-failed', {
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    settleFailed(error)
    throw error
  } finally {
    ACTIVE_APPLY_JOURNALS.delete(journalId)
  }
}

/** Post-commit publishes. Safe to replay: finishOperation on an already
 *  finished op throws and is swallowed per item. */
function rollForwardCommitted(
  db: DbClient,
  state: {
    skillStages: Array<{ skillId: string; opId: string }>
    /** RFC-271 T14：技能原地更新的发布段。 */
    appHome?: string
    skillVersionStages?: StagedSkillVersion[]
  },
  log: Logger,
): void {
  // ⚠️ 先把**全部**已提交技能 unmark，再逐项 publish（T10 的那条注释）：放进
  // publish 里的话，先发布的已经 mark 回来，而后一个还没发布的仍带着上一代
  // admission。
  for (const staged of state.skillVersionStages ?? []) unmarkSkillBootVerified(staged.skillId)
  for (const staged of state.skillVersionStages ?? []) {
    if (state.appHome === undefined) break
    try {
      publishStagedSkillVersion(db, { appHome: state.appHome }, staged)
    } catch (err) {
      log.warn('intent-skill-publish-replayed-or-failed', {
        skillId: staged.skillId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
  for (const stage of state.skillStages) {
    try {
      dbTxSync(db, (tx) => finishOperation(tx, stage.opId))
    } catch (err) {
      log.warn('intent-skill-finish-replayed-or-failed', {
        skillId: stage.skillId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/** Boot/hourly convergence (design §9.5): sweep unsettled journal rows.
 *  prepared/applying → compensate recorded artifacts, mark failed;
 *  committed → replay the idempotent roll-forward. */
/** P2-1 — journals this PROCESS is actively applying; the converger must
 *  never treat them as crashed. Registered for the whole applyIntentChangeset
 *  window (claim → settle). */
const ACTIVE_APPLY_JOURNALS = new Set<string>()
/** P2-1 — and a floor: never reap a journal younger than this (a slow npm
 *  install crossing the hourly tick is an ACTIVE apply, not a crash). */
const CONVERGE_MIN_AGE_MS = 10 * 60 * 1000

export async function convergeIntentApplyJournal(
  db: DbClient,
  appHome: string,
  log: Logger = createLogger('intentApply'),
): Promise<{ failed: number; rolledForward: number }> {
  void appHome
  let failed = 0
  let rolledForward = 0
  const rows = await db.select().from(intentApplyJournal)
  const reapBefore = Date.now() - CONVERGE_MIN_AGE_MS
  for (const row of rows) {
    const artifacts = JSON.parse(row.preparedArtifactsJson) as JournalArtifact[]
    if (row.state === 'prepared' || row.state === 'applying') {
      // P2-1: an apply this PROCESS is running, or one still fresh enough to
      // be a slow install, is ACTIVE — reaping it would compensate a live
      // transaction's prestage and then fail its journal CAS.
      if (ACTIVE_APPLY_JOURNALS.has(row.id) || row.updatedAt > reapBefore) continue
      for (const artifact of [...artifacts].reverse()) {
        try {
          if (artifact.kind === 'skill-stage') {
            compensateManagedSkillStage(db, artifact)
          } else if (artifact.kind === 'plugin-install' && artifact.generationDir !== undefined) {
            // RFC-271 T17：精确路径事前落了库 ⇒ 这里删得准。旧行（无该字段）仍
            // 退回「靠 installer 自己的 generation GC」——不能因为格式演进就把
            // 存量 journal 判成不可补偿。
            rmSync(artifact.generationDir, { recursive: true, force: true })
          }
        } catch (err) {
          log.warn('intent-converge-compensation-failed', {
            journalId: row.id,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }
      dbTxSync(db, (tx) => {
        tx.update(intentApplyJournal)
          .set({ state: 'failed', error: 'daemon-restart before commit', updatedAt: Date.now() })
          .where(and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, row.state)))
          .run()
      })
      failed += 1
    } else if (row.state === 'committed') {
      rollForwardCommitted(
        db,
        {
          skillStages: artifacts.flatMap((a) =>
            a.kind === 'skill-stage' ? [{ skillId: a.skillId, opId: a.opId }] : [],
          ),
        },
        log,
      )
      rolledForward += 1
    }
  }
  return { failed, rolledForward }
}
