// RFC-152 — WS channel registry (double-ended, backend half).
//
// Single source of truth for every WS channel's wire surface: path regex +
// param parsing, hello frame name, broadcaster channel key, and the channel's
// auth form. RFC-147-style rule: the three auth forms are NOT flattened into
// one slot (D1) —
//   (a) `upgradeGate`  — whole-connection gate at upgrade time
//                        (task = canViewTask, memory-distill-jobs = admin);
//   (b) `frameGate`    — per-frame filtering (tasks-list / workflows /
//                        memories), with an optional `adminShortCircuit`
//                        that sends synchronously without consulting the gate;
//   (c) neither        — token-only channels (repo-import).
//
// `gatedSubscribe` is the one subscription pipeline every channel goes
// through (admin short-circuit → frameGate → error ⇒ drop the frame); it
// replaces the three hand-copied per-frame blocks that used to live in
// server.ts handleOpen. Behavior is intentionally bit-identical to the
// pre-registry code — the frame-level lock suites (tests/ws.test.ts,
// rfc099-ws-acl-filter, ws-repo-imports, ws-auth-multi-token) must stay
// green without modification across the migration.
//
// Design-gate revisions folded in (design.md §1):
//   - NO `cacheBustOn` slot. The workflows frameGate needs OPPOSITE cache
//     orderings for two message types ('workflow.acl.updated' busts the
//     cached visibility BEFORE gating so a just-granted connection receives
//     the frame; 'workflow.deleted' reads the OLD cache entry before busting
//     so a previously-visible connection receives the delete). A single
//     declarative bust slot cannot express both, so the workflows frameGate
//     owns its cache lifecycle inline.
//   - memories frameGate contract is per-variant: 'memory.candidate.created'
//     checks the scope carried in the frame; every memoryId-carrying variant
//     re-resolves the row (no cache — RFC-045 edits can move rows between
//     scopes); 'memory.superseded' (oldId/newId, no memoryId) KEEPS the
//     current non-admin drop (zero-behavior-change migration; the resulting
//     "stranger frontends may go stale" is a registered known limitation).

import type { ServerWebSocket } from 'bun'
import { and, asc, eq, gt } from 'drizzle-orm'
import type {
  MemoryDistillJobWsMessage,
  ScheduledTaskWsMessage,
  MemoryWsMessage,
  RepoImportWsMessage,
  TaskWsMessage,
  TasksListWsMessage,
  WorkflowsWsMessage,
  WsControlMessage,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { memories as memoriesTable, nodeRunEvents, nodeRuns, tasks, workflows } from '@/db/schema'
import { canViewMemory } from '@/services/memory'
import { canViewResource } from '@/services/resourceAcl'
import { canViewTask } from '@/services/taskCollab'
import { createLogger } from '@/util/log'
import {
  MEMORY_CHANNEL,
  MEMORY_DISTILL_JOB_CHANNEL,
  SCHEDULED_TASK_CHANNEL,
  scheduledTaskBroadcaster,
  REPO_IMPORT_CHANNEL,
  TASK_CHANNEL,
  TASKS_LIST_CHANNEL,
  WORKFLOWS_CHANNEL,
  memoryBroadcaster,
  memoryDistillJobBroadcaster,
  repoImportsBroadcaster,
  taskBroadcaster,
  tasksListBroadcaster,
  workflowsBroadcaster,
  type WorkflowsBroadcastContext,
} from './broadcaster'

const log = createLogger('ws.registry')

// -----------------------------------------------------------------------------
// Channel params / message maps — ConnectionData's channel union and
// safeSend's outbound union both derive from these (server.ts consumes them
// once the migration lands; until then they mirror the hand-written union).
// -----------------------------------------------------------------------------

export interface ChannelParamsByKind {
  task: { kind: 'task'; taskId: string; since?: number }
  'tasks-list': { kind: 'tasks-list' }
  workflows: { kind: 'workflows' }
  'repo-import': { kind: 'repo-import'; batchId: string }
  memories: { kind: 'memories' }
  'memory-distill-jobs': { kind: 'memory-distill-jobs' }
  'scheduled-tasks': { kind: 'scheduled-tasks' }
}

export interface ChannelMessageByKind {
  task: TaskWsMessage
  'tasks-list': TasksListWsMessage
  workflows: WorkflowsWsMessage
  'repo-import': RepoImportWsMessage
  memories: MemoryWsMessage
  'memory-distill-jobs': MemoryDistillJobWsMessage
  'scheduled-tasks': ScheduledTaskWsMessage
}

/** Process-local metadata delivered beside frames; never part of JSON wire. */
export interface ChannelBroadcastContextByKind {
  task: never
  'tasks-list': never
  workflows: WorkflowsBroadcastContext
  'repo-import': never
  memories: never
  'memory-distill-jobs': never
  'scheduled-tasks': never
}

export type WsChannelKind = keyof ChannelParamsByKind
export type AnyChannelParams = ChannelParamsByKind[WsChannelKind]
export type AnyChannelMessage = ChannelMessageByKind[WsChannelKind]
/** Everything the WS server may write to a socket (channel frames + control). */
export type WsOutboundMessage = AnyChannelMessage | WsControlMessage

/**
 * Per-connection data pinned at upgrade time. Structurally identical to the
 * ConnectionData server.ts has always used; server.ts aliases this type once
 * the task channel migrates (PR-4).
 */
/**
 * RFC-212 — how to re-check this connection's credential WITHOUT keeping the
 * plaintext token around. `hash` feeds `lookupActive{Session,Pat}ByHash`, which
 * run the exact same query the upgrade path ran.
 *
 * Storing the raw token instead would be strictly worse: `util/log.ts`'s
 * `formatVal` JSON.stringifies arbitrary objects with no redaction, so a single
 * `log.debug('…', { data: ws.data })` while debugging would write a long-lived
 * credential into the rotated daemon log.
 */
export type WsCredential =
  | {
      readonly kind: 'session' | 'pat'
      readonly hash: string
      /**
       * RFC-212 — credential expiry, captured at upgrade. Natural expiry has no
       * write hook to fire a revocation, so the frame path does a purely local
       * `now > expiresAt` check (zero DB). `null` = a PAT with no expiry.
       */
      readonly expiresAt: number | null
    }
  /** Legacy daemon token — process-level admin, nothing to look up. */
  | { readonly kind: 'daemon' }

export interface WsConnectionData {
  channel: AnyChannelParams
  /**
   * Resolved actor. RFC-212 makes this MUTABLE: the revalidation pass replaces
   * it wholesale so that `adminShortCircuit` (which reads
   * `actor.user.role` per frame) and permission-set gates pick up a demotion.
   * Its only writer is that pass.
   */
  actor: Actor
  /** RFC-212 — credential fingerprint used by the revalidation pass. */
  credential: WsCredential
  /**
   * RFC-212 — set synchronously right before `ws.close()`, so a frame that
   * arrives between the close call and Bun's async close callback is dropped.
   * `broadcaster.broadcast` is a synchronous for-of, so without this the socket
   * keeps receiving during that window.
   */
  closing: boolean
  /**
   * RFC-212 impl-gate (Codex 2026-07-22): set SYNCHRONOUSLY by the revocation
   * trigger BEFORE the async revalidation pass runs, so the synchronous broadcast
   * for-of cannot deliver a frame under the connection's OLD actor/permissions
   * while the pass is still re-resolving it. The pass clears it once the actor is
   * refreshed (or the connection is closed). Without this, a task-member removal
   * that commits, then fires the fire-and-forget rescan, still leaked frames to
   * the running subscription during every `await` inside the serial rescan.
   */
  revalidating: boolean
  unsubscribe: () => void
  /**
   * RFC-054 W2-4 — per-connection visibility cache. tasks-list entries are
   * keyed by raw taskId; workflows entries by `wf:${workflowId}` so the two
   * id spaces never collide. memories deliberately does NOT cache (RFC-045
   * edits can move a row between scopes). Dropped with the connection.
   */
  visibilityCache: Map<string, boolean>
}

/** Upgrade-time refusal; server.ts maps it onto a 403 JSON response. */
export interface WsUpgradeRefusal {
  code: string
  message: string
}

/** Context handed to per-frame gates. */
export interface FrameGateCtx {
  db: DbClient
  actor: Actor
  cache: Map<string, boolean>
}

/** Structural view of a TypedBroadcaster — gatedSubscribe only subscribes. */
export interface WsBroadcasterLike<M, C = never> {
  subscribe(channel: string, listener: (msg: M, context: C | undefined) => void): () => void
}

/**
 * RFC-212 — how a channel must be re-checked when authorization is revoked.
 *
 * REQUIRED on every ChannelSpec. `WsChannelRegistry` is a mapped type over
 * `WsChannelKind`, so adding a channel without declaring this is a COMPILE
 * error — which is the whole point: the audit found 7 channels x 4 revocation
 * kinds = 28 cells with exactly one implemented, precisely because the matrix
 * only ever existed in someone's head.
 * See design/RFC-212-ws-authorization-revalidation §3.4.
 */
export interface ChannelRevalidation {
  /**
   * Always true. Replacing `ws.data.actor` is what makes a demotion take effect
   * — `adminShortCircuit` reads `actor.user.role` per frame and several gates
   * read `actor.permissions`. Modelled as a required literal rather than an
   * optional flag so no channel can silently opt out.
   */
  readonly refreshActor: true
  /**
   * Whether this channel actually keeps a per-connection visibility cache.
   * Most do NOT — stating that explicitly stops "cleared the cache" from being
   * mistaken for "re-checked this channel".
   */
  readonly cache:
    | { readonly kind: 'none'; readonly why: string }
    | { readonly kind: 'prefixes'; readonly prefixes: readonly string[] }
  /** Re-run `upgradeGate` after a revocation. Channels without one say why. */
  readonly rerunUpgradeGate: boolean | { readonly na: string }
}

export interface ChannelSpec<K extends WsChannelKind, M> {
  kind: K
  /** RFC-212 — required; see ChannelRevalidation. */
  revalidation: ChannelRevalidation
  /** hello-frame channel name (parametrized channels compose with params). */
  helloName: (p: ChannelParamsByKind[K]) => string
  pathRe: RegExp
  parse: (m: RegExpMatchArray, url: URL) => ChannelParamsByKind[K] | null
  broadcaster: WsBroadcasterLike<M, ChannelBroadcastContextByKind[K]>
  /** Broadcaster channel key — always delegates to the broadcaster.ts constants so producers can never drift. */
  channelKeyOf: (p: ChannelParamsByKind[K]) => string
  /** (a) whole-connection gate at upgrade time (task / memory-distill-jobs). */
  upgradeGate?: (
    db: DbClient,
    actor: Actor,
    p: ChannelParamsByKind[K],
  ) => Promise<true | WsUpgradeRefusal>
  /** (b) per-frame filter (tasks-list / workflows / memories). */
  frameGate?: (
    ctx: FrameGateCtx,
    msg: M,
    context?: ChannelBroadcastContextByKind[K],
  ) => Promise<boolean>
  /**
   * Send synchronously to admins without consulting frameGate. Matches the
   * pre-registry code exactly: true for workflows/memories (their handlers
   * short-circuited on role==='admin'); false for tasks-list (canViewTask
   * already short-circuits internally on `tasks:read:all`, and the frame
   * stays on the async path like before).
   */
  adminShortCircuit?: boolean
  /** open-time extra (task `?since` replay). Runs after the hello frame. */
  onOpenExtra?: (
    ws: ServerWebSocket<WsConnectionData>,
    p: ChannelParamsByKind[K],
    db: DbClient,
  ) => Promise<void>
}

// -----------------------------------------------------------------------------
// Shared gate helpers (moved verbatim from server.ts handlers).
// -----------------------------------------------------------------------------

/**
 * Look up a task's ownerUserId once and ask canViewTask. Returns false if
 * the task no longer exists (e.g. deleted between broadcaster fire and the
 * gate running).
 */
async function taskVisibleTo(db: DbClient, actor: Actor, taskId: string): Promise<boolean> {
  const rows = await db
    .select({ id: tasks.id, ownerUserId: tasks.ownerUserId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (rows.length === 0) return false
  return canViewTask(db, actor, rows[0]!)
}

/** Cached variant for the tasks-list per-frame gate (raw taskId cache key). */
async function cachedTaskVisible(ctx: FrameGateCtx, taskId: string): Promise<boolean> {
  const cached = ctx.cache.get(taskId)
  if (cached !== undefined) return cached
  const visible = await taskVisibleTo(ctx.db, ctx.actor, taskId)
  ctx.cache.set(taskId, visible)
  return visible
}

/** RFC-099 — workflow-row visibility, cached under a `wf:` key prefix. */
async function cachedWorkflowVisible(ctx: FrameGateCtx, workflowId: string): Promise<boolean> {
  const key = `wf:${workflowId}`
  const cached = ctx.cache.get(key)
  if (cached !== undefined) return cached
  const rows = await ctx.db
    .select({
      id: workflows.id,
      ownerUserId: workflows.ownerUserId,
      visibility: workflows.visibility,
    })
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .limit(1)
  const visible =
    rows.length === 0 ? false : await canViewResource(ctx.db, ctx.actor, 'workflow', rows[0]!)
  ctx.cache.set(key, visible)
  return visible
}

/**
 * Resolve a deleted workflow against the audience captured before DELETE.
 * `null` means no matching out-of-band context was supplied, so legacy direct
 * broadcaster callers may fall back to the connection's old visibility cache.
 */
function deletedWorkflowAudienceVisible(
  actor: Actor,
  workflowId: string,
  context: WorkflowsBroadcastContext | undefined,
): boolean | null {
  if (
    context === undefined ||
    context.kind !== 'workflow.deleted-audience' ||
    context.workflowId !== workflowId
  ) {
    return null
  }
  if (context.visibility === 'public') return true
  if (context.ownerUserId === actor.user.id) return true
  return context.grantedUserIds.has(actor.user.id)
}

/**
 * Extract the task id a TasksListWsMessage refers to. Unknown / future
 * variants return null, which makes the gate DROP the frame — safer than
 * leaking by accident (RFC-054 W2-4).
 */
function extractTaskIdFromListMessage(msg: TasksListWsMessage): string | null {
  switch (msg.type) {
    case 'task.created':
      return msg.task.id
    case 'task.status':
      return msg.taskId
    case 'task.deleted':
      return msg.taskId
    case 'lifecycle.alert':
      // lifecycle.alert carries the alert payload's taskId.
      // Defensive narrowing — payload shape may evolve.
      return typeof (msg as unknown as { taskId?: string }).taskId === 'string'
        ? (msg as unknown as { taskId: string }).taskId
        : null
    default:
      return null
  }
}

/** Task `?since=N` replay — node_run_events joined via nodeRuns.taskId. */
async function replayTaskEvents(
  db: DbClient,
  taskId: string,
  since: number,
  ws: ServerWebSocket<WsConnectionData>,
): Promise<void> {
  const rows = await db
    .select({
      id: nodeRunEvents.id,
      nodeRunId: nodeRunEvents.nodeRunId,
      ts: nodeRunEvents.ts,
      kind: nodeRunEvents.kind,
      payload: nodeRunEvents.payload,
    })
    .from(nodeRunEvents)
    .innerJoin(nodeRuns, eq(nodeRunEvents.nodeRunId, nodeRuns.id))
    .where(and(eq(nodeRuns.taskId, taskId), gt(nodeRunEvents.id, since)))
    .orderBy(asc(nodeRunEvents.id))

  for (const r of rows) {
    let payload: unknown
    try {
      payload = JSON.parse(r.payload)
    } catch {
      payload = r.payload
    }
    const msg: TaskWsMessage = {
      id: r.id,
      type: 'node.event',
      nodeRunId: r.nodeRunId,
      ts: r.ts,
      kind: r.kind,
      payload,
    }
    sendJson(ws, msg)
  }
}

// -----------------------------------------------------------------------------
// The registry.
// -----------------------------------------------------------------------------

export type WsChannelRegistry = {
  [K in WsChannelKind]: ChannelSpec<K, ChannelMessageByKind[K]>
}

export const WS_CHANNELS: WsChannelRegistry = {
  task: {
    kind: 'task',
    // RFC-212: gated once at upgrade (taskVisibleTo); a member removal must
    // therefore re-run that gate. No frame cache — no frameGate at all.
    revalidation: {
      refreshActor: true,
      cache: {
        kind: 'none',
        why: 'no frameGate — every frame forwards once the upgrade gate passed',
      },
      rerunUpgradeGate: true,
    },
    helloName: (p) => `tasks/${p.taskId}`,
    pathRe: /^\/ws\/tasks\/([^/?#]+)$/,
    parse: (m, url) => {
      const p: ChannelParamsByKind['task'] = {
        kind: 'task',
        taskId: decodeURIComponent(m[1] ?? ''),
      }
      const since = url.searchParams.get('since')
      if (since !== null && since !== '' && Number.isInteger(Number(since))) {
        p.since = Number(since)
      }
      return p
    },
    broadcaster: taskBroadcaster,
    channelKeyOf: (p) => TASK_CHANNEL(p.taskId),
    // RFC-054 W2-4 — the per-task channel is gated ONCE at upgrade time; every
    // subsequent frame flows ungated (no frameGate).
    upgradeGate: async (db, actor, p) =>
      (await taskVisibleTo(db, actor, p.taskId))
        ? true
        : { code: 'task-not-visible', message: 'task not visible to current actor' },
    onOpenExtra: async (ws, p, db) => {
      if (p.since !== undefined) await replayTaskEvents(db, p.taskId, p.since, ws)
    },
  },
  'tasks-list': {
    kind: 'tasks-list',
    // RFC-212: caches per-task visibility under the RAW taskId. Stale sources
    // are BOTH the cached `true` and the frozen actor (canViewTask short-circuits
    // internally on `tasks:read:all`, so a demotion must reach it).
    revalidation: {
      refreshActor: true,
      cache: { kind: 'prefixes', prefixes: [''] },
      rerunUpgradeGate: { na: 'no upgradeGate — this channel filters per frame' },
    },
    helloName: () => 'tasks',
    pathRe: /^\/ws\/tasks$/,
    parse: () => ({ kind: 'tasks-list' }),
    broadcaster: tasksListBroadcaster,
    channelKeyOf: () => TASKS_LIST_CHANNEL,
    // RFC-054 W2-4 — per-frame RBAC filter. Every TasksListWsMessage mentions
    // exactly one task; unknown shapes drop. NO adminShortCircuit: canViewTask
    // short-circuits internally on `tasks:read:all`, keeping admin frames on
    // the same async path as before the registry.
    frameGate: async (ctx, msg) => {
      const taskId = extractTaskIdFromListMessage(msg)
      if (taskId === null) return false
      return cachedTaskVisible(ctx, taskId)
    },
  },
  workflows: {
    kind: 'workflows',
    // RFC-212: caches under `wf:`; also short-circuits on actor.user.role.
    revalidation: {
      refreshActor: true,
      cache: { kind: 'prefixes', prefixes: ['wf:'] },
      rerunUpgradeGate: { na: 'no upgradeGate — this channel filters per frame' },
    },
    helloName: () => 'workflows',
    pathRe: /^\/ws\/workflows$/,
    parse: () => ({ kind: 'workflows' }),
    broadcaster: workflowsBroadcaster,
    channelKeyOf: () => WORKFLOWS_CHANNEL,
    adminShortCircuit: true,
    // RFC-099 — per-frame ACL filter with a self-owned cache lifecycle (the
    // two special-cased types need OPPOSITE bust/read orderings, see header):
    //   - 'workflow.acl.updated': bust FIRST, then gate — the ACL just
    //     changed, so a connection granted access mid-stream receives this
    //     very frame (and subsequent updates) with fresh visibility.
    //   - 'workflow.deleted': the row is already gone. Prefer the transaction-
    //     captured process-local audience so cold owner/grantee/public sockets
    //     receive it; direct legacy/test broadcasts without context retain the
    //     OLD-cache fallback. Either path busts the cache afterward.
    frameGate: async (ctx, msg, deliveryContext) => {
      if (msg.type === 'workflow.acl.updated') {
        ctx.cache.delete(`wf:${msg.workflowId}`)
        return cachedWorkflowVisible(ctx, msg.workflowId)
      }
      if (msg.type === 'workflow.deleted') {
        const cached = ctx.cache.get(`wf:${msg.workflowId}`)
        ctx.cache.delete(`wf:${msg.workflowId}`)
        const visibleFromAudience = deletedWorkflowAudienceVisible(
          ctx.actor,
          msg.workflowId,
          deliveryContext,
        )
        if (visibleFromAudience !== null) return visibleFromAudience
        return cached === true
      }
      return cachedWorkflowVisible(ctx, msg.workflowId)
    },
  },
  'repo-import': {
    kind: 'repo-import',
    // RFC-212: no gate of any kind (RFC-152 D4 leftover). Revalidation can only
    // enforce credential validity here; adding a gate is out of scope and is
    // recorded as a known gap rather than papered over.
    revalidation: {
      refreshActor: true,
      cache: { kind: 'none', why: 'ungated channel — nothing is filtered per frame' },
      rerunUpgradeGate: { na: 'RFC-152 D4 leftover: this channel has no gate at all' },
    },
    helloName: (p) => `repo-imports/${p.batchId}`,
    pathRe: /^\/ws\/repo-imports\/([^/?#]+)$/,
    parse: (m) => ({ kind: 'repo-import', batchId: decodeURIComponent(m[1] ?? '') }),
    broadcaster: repoImportsBroadcaster,
    channelKeyOf: (p) => REPO_IMPORT_CHANNEL(p.batchId),
    // Token-only channel. Batch-ownership validation is a registered
    // leftover (RFC-152 D4), NOT silently added here.
  },
  memories: {
    kind: 'memories',
    // RFC-212: deliberately UNcached (RFC-045 edits move rows between scopes),
    // so clearing a cache would be a no-op here — the only stale source is the
    // frozen actor behind adminShortCircuit.
    revalidation: {
      refreshActor: true,
      cache: {
        kind: 'none',
        why: 'deliberately uncached — RFC-045 edits move rows between scopes',
      },
      rerunUpgradeGate: { na: 'no upgradeGate — this channel filters per frame' },
    },
    helloName: () => 'memories',
    pathRe: /^\/ws\/memories$/,
    parse: () => ({ kind: 'memories' }),
    broadcaster: memoryBroadcaster,
    channelKeyOf: () => MEMORY_CHANNEL,
    adminShortCircuit: true,
    // RFC-099 (D12) — per-variant scope-visibility contract:
    //   - 'memory.candidate.created' carries the scope inline.
    //   - the five memoryId-carrying variants re-resolve scope from the row
    //     (no cache: memory events are low-frequency and RFC-045 edits can
    //     move a row between scopes); row already hard-deleted ⇒ drop (only
    //     admins, short-circuited above, get those frames).
    //   - 'memory.superseded' (oldId/newId, NO memoryId) keeps the current
    //     non-admin drop — zero-behavior-change migration; "stranger
    //     frontends may go stale on supersede" is a known registered
    //     limitation, improving it is out of scope here.
    frameGate: async (ctx, msg) => {
      switch (msg.type) {
        case 'memory.candidate.created':
          return canViewMemory(ctx.db, ctx.actor, {
            scopeType: msg.memory.scopeType,
            scopeId: msg.memory.scopeId,
          })
        case 'memory.candidate.promoted':
        case 'memory.archived':
        case 'memory.unarchived':
        case 'memory.deleted':
        case 'memory.updated': {
          const rows = await ctx.db
            .select({ scopeType: memoriesTable.scopeType, scopeId: memoriesTable.scopeId })
            .from(memoriesTable)
            .where(eq(memoriesTable.id, msg.memoryId))
            .limit(1)
          const row = rows[0]
          if (row === undefined) return false
          return canViewMemory(ctx.db, ctx.actor, row)
        }
        case 'memory.superseded':
          return false
        default:
          // Future variants without an explicit contract drop — safer than
          // leaking by accident (mirrors the unknown-shape default above).
          return false
      }
    },
  },
  'memory-distill-jobs': {
    kind: 'memory-distill-jobs',
    // RFC-212: admin-only whole-connection gate; a demotion must re-run it.
    revalidation: {
      refreshActor: true,
      cache: { kind: 'none', why: 'no frameGate — admin-only gate at upgrade' },
      rerunUpgradeGate: true,
    },
    helloName: () => 'memory-distill-jobs',
    pathRe: /^\/ws\/memory-distill-jobs$/,
    parse: () => ({ kind: 'memory-distill-jobs' }),
    broadcaster: memoryDistillJobBroadcaster,
    channelKeyOf: () => MEMORY_DISTILL_JOB_CHANNEL,
    // RFC-152 P0 (682de313) — declared admin-only since RFC-041 (4 comment
    // sites + all HTTP routes requireAdmin) but the WS upgrade never
    // enforced it. Same gate as HTTP: non-admin upgrades are 403-refused.
    upgradeGate: async (_db, actor) =>
      actor.user.role === 'admin'
        ? true
        : { code: 'admin-required', message: 'memory-distill-jobs channel is admin-only' },
  },
  'scheduled-tasks': {
    kind: 'scheduled-tasks',
    // RFC-212: pure in-memory decision (actor.permissions + msg.ownerUserId),
    // no cache — the stale source is the frozen permission set.
    revalidation: {
      refreshActor: true,
      cache: { kind: 'none', why: 'pure in-memory check on actor.permissions + ownerUserId' },
      rerunUpgradeGate: { na: 'no upgradeGate — this channel filters per frame' },
    },
    helloName: () => 'scheduled-tasks',
    pathRe: /^\/ws\/scheduled-tasks$/,
    parse: () => ({ kind: 'scheduled-tasks' }),
    broadcaster: scheduledTaskBroadcaster,
    channelKeyOf: () => SCHEDULED_TASK_CHANNEL,
    // RFC-159 — per-frame owner filter. Every frame carries `ownerUserId`; the
    // owner + `tasks:read:all` admins receive it, everyone else drops. No DB
    // lookup (unlike tasks-list) since the owner rides on the message.
    frameGate: async (ctx, msg) =>
      ctx.actor.permissions.has('tasks:read:all') || msg.ownerUserId === ctx.actor.user.id,
  },
}

/** Registry iteration order == the pre-registry parseChannel check order. */
export const WS_CHANNEL_KINDS = Object.keys(WS_CHANNELS) as readonly WsChannelKind[]

// -----------------------------------------------------------------------------
// Erased dispatch — the ONE place where the spec/params correlation is cast
// away (TS cannot correlate a union of ChannelSpec<K, M> pairs at a dynamic
// WS_CHANNELS[kind] lookup site).
// -----------------------------------------------------------------------------

interface ErasedChannelSpec {
  kind: WsChannelKind
  revalidation: ChannelRevalidation
  helloName: (p: AnyChannelParams) => string
  pathRe: RegExp
  parse: (m: RegExpMatchArray, url: URL) => AnyChannelParams | null
  channelKeyOf: (p: AnyChannelParams) => string
  broadcaster: WsBroadcasterLike<AnyChannelMessage, AnyBroadcastContext>
  upgradeGate?: (
    db: DbClient,
    actor: Actor,
    p: AnyChannelParams,
  ) => Promise<true | WsUpgradeRefusal>
  frameGate?: (
    ctx: FrameGateCtx,
    msg: AnyChannelMessage,
    context?: AnyBroadcastContext,
  ) => Promise<boolean>
  adminShortCircuit?: boolean
  onOpenExtra?: (
    ws: ServerWebSocket<WsConnectionData>,
    p: AnyChannelParams,
    db: DbClient,
  ) => Promise<void>
}

type AnyBroadcastContext = ChannelBroadcastContextByKind[WsChannelKind]

export function erasedSpecOf(kind: WsChannelKind): ErasedChannelSpec {
  return WS_CHANNELS[kind] as unknown as ErasedChannelSpec
}

// -----------------------------------------------------------------------------
// Public pipeline.
// -----------------------------------------------------------------------------

/** Iterate the registry's pathRes; first match parses. null = unknown channel. */
export function parseWsChannel(url: URL): AnyChannelParams | null {
  for (const kind of WS_CHANNEL_KINDS) {
    const spec = erasedSpecOf(kind)
    const m = spec.pathRe.exec(url.pathname)
    if (m !== null) return spec.parse(m, url)
  }
  return null
}

/** Run the channel's upgrade gate, if any. true = proceed with the upgrade. */
export async function checkUpgradeGate(
  db: DbClient,
  actor: Actor,
  params: AnyChannelParams,
): Promise<true | WsUpgradeRefusal> {
  const spec = erasedSpecOf(params.kind)
  if (spec.upgradeGate === undefined) return true
  return spec.upgradeGate(db, actor, params)
}

/**
 * The one subscription pipeline (design §1): register on the broadcaster
 * channel, emit the hello frame (with `since` echoed for replay channels),
 * and gate every outgoing frame:
 *
 *   admin short-circuit (sync send) → frameGate (async) → gate error ⇒ DROP.
 *
 * Channels without a frameGate forward every frame (their gate, if any, ran
 * at upgrade time).
 */
/**
 * RFC-212 — hook invoked when the frame path finds an expired credential.
 * Registered by connections.ts (which owns the close sequence) so registry.ts
 * never imports connections.ts — that back-edge would create a module cycle,
 * which the single-binary build is sensitive to (see memory
 * reference_binary_build_module_cycle).
 */
let onExpiredCredential: ((ws: ServerWebSocket<WsConnectionData>) => void) | undefined
export function setExpiredCredentialHandler(
  fn: (ws: ServerWebSocket<WsConnectionData>) => void,
): void {
  onExpiredCredential = fn
}

export function gatedSubscribe(
  ws: ServerWebSocket<WsConnectionData>,
  spec: WsChannelRegistry[WsChannelKind],
  params: AnyChannelParams,
  db: DbClient,
): void {
  const erased = spec as unknown as ErasedChannelSpec
  const channelKey = erased.channelKeyOf(params)
  ws.data.unsubscribe = erased.broadcaster.subscribe(channelKey, (msg, context) => {
    // RFC-212 — a revalidation pass that decided to close this socket sets
    // `closing` and unsubscribes synchronously, but a frame already mid-fan-out
    // (broadcast is a synchronous for-of) can still reach here. Drop it. This
    // check is synchronous, so it does not affect the two delivery-ordering
    // locks in rfc152-ws-channel-registry.test.ts (closing is false there).
    //
    // RFC-212 impl-gate: `revalidating` is the same synchronous short-circuit, but
    // set for the DURATION of an in-flight revocation rescan — the frame is held
    // back until the pass has re-resolved this connection's actor (then it clears
    // the flag) or closed it. Both flags are false on the hot path.
    if (ws.data.closing || ws.data.revalidating) return
    // RFC-212 T7 — natural expiry has no write hook to fire a revocation, so a
    // silently-expired credential would otherwise keep this socket alive past
    // its TTL. Purely local `now > expiresAt` comparison — zero DB, so AC-6 is
    // untouched. onExpiredCredential closes it out-of-band on the next tick.
    const cred = ws.data.credential
    if (cred.kind !== 'daemon' && cred.expiresAt !== null && Date.now() > cred.expiresAt) {
      onExpiredCredential?.(ws)
      return
    }
    if (erased.adminShortCircuit === true && ws.data.actor.user.role === 'admin') {
      sendJson(ws, msg)
      return
    }
    if (erased.frameGate === undefined) {
      sendJson(ws, msg)
      return
    }
    // Fire-and-forget the async gate; a throwing gate (DB blip) falls back
    // to NOT sending — same safer-default as the unknown-shape drops.
    erased
      .frameGate({ db, actor: ws.data.actor, cache: ws.data.visibilityCache }, msg, context)
      .then((visible) => {
        if (visible) sendJson(ws, msg)
      })
      .catch((err) => {
        log.warn('frame gate threw', {
          channel: channelKey,
          err: err instanceof Error ? err.message : String(err),
        })
      })
  })
  const hello: WsControlMessage = { type: 'hello', channel: erased.helloName(params) }
  // Replay channels (task ?since=N) echo the anchor back in the hello frame.
  const since = (params as { since?: unknown }).since
  if (typeof since === 'number') hello.since = since
  sendJson(ws, hello)
}

/** open-time entry: gatedSubscribe + the channel's onOpenExtra (task replay). */
export async function openWsChannel(
  ws: ServerWebSocket<WsConnectionData>,
  params: AnyChannelParams,
  db: DbClient,
): Promise<void> {
  const spec = WS_CHANNELS[params.kind]
  gatedSubscribe(ws, spec, params, db)
  const erased = spec as unknown as ErasedChannelSpec
  if (erased.onOpenExtra !== undefined) {
    await erased.onOpenExtra(ws, params, db)
  }
}

function sendJson(ws: ServerWebSocket<WsConnectionData>, msg: WsOutboundMessage): void {
  try {
    ws.send(JSON.stringify(msg))
  } catch (err) {
    log.warn('send failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
