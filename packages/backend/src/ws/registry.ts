// RFC-152 — WS channel registry (double-ended, backend half).
//
// Single source of truth for every WS channel's wire surface: path regex +
// param parsing, hello frame name, broadcaster channel key, and the channel's
// auth form. RFC-147-style rule: the three auth forms are NOT flattened into
// one slot (D1) —
//   (a) `upgradeGate`  — whole-connection gate at upgrade time
//                        (task = canViewTask, memory-distill-jobs = admin);
//   (b) `frameGate`    — per-frame filtering (tasks-list / workflows /
//                        memories), with an optional `aclBypassShortCircuit`
//                        that sends synchronously without consulting the gate;
//   (c) neither        — token-only channels (repo-import).
//
// `gatedSubscribe` is the one subscription pipeline every channel goes
// through (ACL-bypass short-circuit → frameGate → error ⇒ drop the frame); it
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
import type {
  IntentSessionWsMessage,
  McpRuntimeTestWsMessage,
  PresenceWsMessage,
  MemoryDistillJobWsMessage,
  ScheduledTaskWsMessage,
  MemoryWsMessage,
  RepoImportWsMessage,
  TaskWsMessage,
  TasksListWsMessage,
  WorkgroupsWsMessage,
  WorkflowsWsMessage,
  WsControlMessage,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type {
  AuthorityFenceRecord,
  DirectRequestAuthority,
  PresenceLease,
} from '@/modules/identity-access/public/participants'
import type {
  RealtimeChannelAccess,
  RealtimeCredential,
  RealtimeCredentialAccess,
  RealtimeIdentityAccess,
} from '@/modules/runtime-management/public/participants'
import { createLogger } from '@/util/log'
import {
  AUTHORITY_CHANNEL,
  authorityBroadcaster,
  MEMORY_CHANNEL,
  MEMORY_DISTILL_JOB_CHANNEL,
  INTENT_SESSIONS_CHANNEL,
  intentSessionsBroadcaster,
  MCP_RUNTIME_TESTS_CHANNEL,
  PRESENCE_CHANNEL,
  mcpRuntimeTestsBroadcaster,
  presenceBroadcaster,
  SCHEDULED_TASK_CHANNEL,
  scheduledTaskBroadcaster,
  REPO_IMPORT_CHANNEL,
  TASK_CHANNEL,
  TASKS_LIST_CHANNEL,
  WORKGROUPS_CHANNEL,
  WORKFLOWS_CHANNEL,
  memoryBroadcaster,
  memoryDistillJobBroadcaster,
  repoImportsBroadcaster,
  taskBroadcaster,
  tasksListBroadcaster,
  workgroupsBroadcaster,
  workflowsBroadcaster,
  type WorkgroupsBroadcastContext,
  type WorkflowsBroadcastContext,
  type McpRuntimeTestBroadcastContext,
  type TasksListBroadcastContext,
} from './broadcaster'

const log = createLogger('ws.registry')

// -----------------------------------------------------------------------------
// Channel params / message maps — ConnectionData's channel union and
// safeSend's outbound union both derive from these (server.ts consumes them
// once the migration lands; until then they mirror the hand-written union).
// -----------------------------------------------------------------------------

export interface ChannelParamsByKind {
  authority: { kind: 'authority' }
  task: { kind: 'task'; taskId: string; since?: number }
  'tasks-list': { kind: 'tasks-list' }
  workflows: { kind: 'workflows' }
  workgroups: { kind: 'workgroups' }
  'repo-import': { kind: 'repo-import'; batchId: string }
  memories: { kind: 'memories' }
  'memory-distill-jobs': { kind: 'memory-distill-jobs' }
  'scheduled-tasks': { kind: 'scheduled-tasks' }
  'intent-sessions': { kind: 'intent-sessions' }
  'mcp-runtime-tests': { kind: 'mcp-runtime-tests' }
  presence: { kind: 'presence' }
}

export interface ChannelMessageByKind {
  authority: WsControlMessage
  task: TaskWsMessage
  'tasks-list': TasksListWsMessage
  workflows: WorkflowsWsMessage
  workgroups: WorkgroupsWsMessage
  'repo-import': RepoImportWsMessage
  memories: MemoryWsMessage
  'memory-distill-jobs': MemoryDistillJobWsMessage
  'scheduled-tasks': ScheduledTaskWsMessage
  'intent-sessions': IntentSessionWsMessage
  'mcp-runtime-tests': McpRuntimeTestWsMessage
  presence: PresenceWsMessage
}

/** Process-local metadata delivered beside frames; never part of JSON wire. */
export interface ChannelBroadcastContextByKind {
  authority: never
  task: never
  'tasks-list': TasksListBroadcastContext
  workflows: WorkflowsBroadcastContext
  workgroups: WorkgroupsBroadcastContext
  'repo-import': never
  memories: never
  'memory-distill-jobs': never
  'scheduled-tasks': never
  'intent-sessions': never
  'mcp-runtime-tests': McpRuntimeTestBroadcastContext
  presence: never
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
export type WsCredential = RealtimeCredential

export interface WsConnectionData {
  channel: AnyChannelParams
  /**
   * Resolved actor. RFC-212 makes this MUTABLE: the revalidation pass replaces
   * it wholesale so that `aclBypassShortCircuit` and permission-set gates
   * pick up an access change.
   * Its only writer is that pass.
   */
  actor: Actor
  /** Same opaque handle minted with `actor` at credential admission. */
  authority: DirectRequestAuthority
  /** Provider-selected channel policy; no DB/client crosses into transport. */
  channels: RealtimeChannelAccess
  /** Bound auth persistence used only by upgrade/revalidation, never frame delivery. */
  credentials: RealtimeCredentialAccess
  /** Narrow bootstrap binding; registry never composes identity-access from DB. */
  identityAccess: IdentityAccessWsBinding
  /** RFC-212 — credential fingerprint used by the revalidation pass. */
  credential: WsCredential
  /**
   * RFC-312 —— presence 的**单次释放句柄**。
   *
   * 为什么是句柄而不是布尔标记：同一条连接的释放路径今天就会被调用两次——
   * `closeConnection` 同步 untrack 一次，Bun 的 close 回调里 `handleClose` 再来一次。
   * 现状是 `Set.delete` 所以幂等；换成引用计数后天真实现会**扣两次**，
   * 结果是"关掉一个标签页，人就整体离线"。释放侧先清空本字段再调用，
   * 任何重入顺序下都只可能执行一次。
   */
  presenceLease?: PresenceLease
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
  /** RFC-312 —— `sendJson` 补发快照时的重入守卫（见该函数注释）。 */
  resyncing?: boolean
  /**
   * RFC-212 impl-gate finding 2 (Codex 2026-07-22): the revocation epoch captured
   * at the START of this connection's upgrade (before resolveActor). If it differs
   * from the current epoch by the time the connection is tracked, a revocation
   * raced the upgrade — the actor may be stale AND this connection was invisible
   * to that rescan's live snapshot — so handleOpen re-checks it once on open.
   */
  upgradeEpoch: number
  unsubscribe: () => void
  /**
   * RFC-054 W2-4 — per-connection visibility cache. tasks-list entries are
   * keyed by raw taskId; workflows entries by `wf:${workflowId}` so the two
   * id spaces never collide. memories deliberately does NOT cache (RFC-045
   * edits can move a row between scopes). Dropped with the connection.
   */
  visibilityCache: Map<string, boolean>
}

export interface IdentityAccessWsBinding extends RealtimeIdentityAccess {
  requestAuthorityRevalidation(userId: string, revision: number): void
}

/** Upgrade-time refusal; server.ts maps it onto a 403 JSON response. */
export interface WsUpgradeRefusal {
  code: string
  message: string
}

/** Context handed to per-frame gates. */
export interface FrameGateCtx {
  /** Required by provider-backed gates; optional only for pure direct gate fixtures. */
  channels?: RealtimeChannelAccess
  actor: Actor
  authority?: DirectRequestAuthority
  cache: Map<string, boolean>
  readonly [legacyFixtureField: string]: unknown
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
   * — `aclBypassShortCircuit` and several gates read `actor.permissions`.
   * Modelled as a required literal rather than an
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
  /**
   * RFC-317 T56（findings TP-06）—— 一条**能被 `pathRe` 匹中**的样例路径。
   *
   * 为什么把它放进注册表而不是留在测试里：`pathRe` 的两条关键守卫（「每条路径只匹中
   * 一个通道」「每条路径都 parse 得出来」）此前各自维护一份**手写样本数组**，而新增
   * 通道**不需要**出现在样本里。RFC-312 的 presence 通道实测同时逃过了三处样本
   * ——同一次改动里 paths-interlock 的双射断言被更新了（作者确实动过那个文件），
   * 样本数组仍然没跟上。
   *
   * 放进 `ChannelSpec` 之后，新增通道漏填样本是**编译错误**（这是必填字段），
   * 而两条守卫改为遍历 `WS_CHANNEL_KINDS`——它们要防的正是「新通道的 pathRe 意外
   * 遮蔽了既有通道」，而那种通道恰恰最不可能被人想起来加进样本里。
   */
  samplePath: string
  parse: (m: RegExpMatchArray, url: URL) => ChannelParamsByKind[K] | null
  broadcaster: WsBroadcasterLike<M, ChannelBroadcastContextByKind[K]>
  /** Broadcaster channel key — always delegates to the broadcaster.ts constants so producers can never drift. */
  channelKeyOf: (p: ChannelParamsByKind[K]) => string
  /** (a) whole-connection gate at upgrade time (task / memory-distill-jobs). */
  upgradeGate?: (
    channels: RealtimeChannelAccess,
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
   * Send synchronously to actors with `resource-acl:bypass` without consulting
   * frameGate. The shortcut is an optimization only; the same permission is
   * part of the row-visibility predicate used by the asynchronous path.
   */
  aclBypassShortCircuit?: boolean
  /** open-time extra (task `?since` replay). Runs after the hello frame. */
  onOpenExtra?: (
    ws: ServerWebSocket<WsConnectionData>,
    p: ChannelParamsByKind[K],
    channels: RealtimeChannelAccess,
  ) => Promise<void>
  /**
   * RFC-312 实现门 P1 —— **复核解冻后的重同步**。
   *
   * 为什么需要：`revalidating` 期间到达的帧是被**丢弃**的（`gatedSubscribe` 里一个
   * `return`），注释虽写作 "held back"，但既没有队列也没有重放。对 task/authority 这类
   * "收到即去 refetch" 的通道无所谓；对**累积式增量流**（presence）则是永久损坏：丢掉
   * 一条 `presence.changed` 后，订阅者会一直把该用户显示成旧状态，直到他下次翻转。
   *
   * 所以声明成通道自己的数据（与 `upgradeGate` / `frameGate` 同构），而不是在复核循环里
   * 写 `kind === 'presence'` 分支。通道若无累积状态就不实现它。
   *
   * **两个触发点**：①复核解冻后（冻结期丢帧）；②`sendJson` 检测到 Bun 把帧丢了。
   * 未实现该钩子的通道在两处都逐字维持原行为——②处此前就是忽略返回值。
   */
  resync?: (ws: ServerWebSocket<WsConnectionData>) => void
}

/**
 * RFC-312 —— 释放该连接占用的 presence 计数，**最多执行一次**。
 *
 * 先清空句柄再调用：`closeConnection` 与 Bun 的 close 回调都会走到这里，
 * 天真实现会把引用计数扣两次（症状是"关掉一个标签页，人就整体离线"）。
 * 清空在前、调用在后，任何重入顺序下都只可能执行一次。
 */
export function releasePresence(ws: ServerWebSocket<WsConnectionData>): void {
  const lease = ws.data.presenceLease
  ws.data.presenceLease = undefined
  lease?.release()
}

/**
 * RFC-312 —— 登记 presence 并装上释放句柄。**只在连接尚未进入关闭流程时登记**。
 *
 * 为什么要查 `closing`：`handleOpen` 在 epoch 复核那一步可能 `await`，客户端完全可能
 * 在这期间就关闭——此时 `handleClose` 已经跑过、句柄还不存在，等 await 回来再登记就
 * **永远不会有第二次 close 回调来释放它**，该用户会永久在线且没有任何宽限定时器能回收。
 */
export function installPresence(ws: ServerWebSocket<WsConnectionData>): void {
  if (ws.data.closing) return
  ws.data.presenceLease =
    ws.data.identityAccess.presenceConnections.open(ws.data.authority) ?? undefined
  // 双保险：若在 opened() 与装句柄之间连接已被标记关闭，立即对消。
  if (ws.data.closing) releasePresence(ws)
}

// -----------------------------------------------------------------------------
// Shared gate helpers (moved verbatim from server.ts handlers).
// -----------------------------------------------------------------------------

/**
 * Look up a task's ownerUserId once and ask canViewTask. Returns false if
 * the task no longer exists (e.g. deleted between broadcaster fire and the
 * gate running).
 */
async function taskVisibleTo(
  channels: RealtimeChannelAccess,
  actor: Actor,
  taskId: string,
): Promise<boolean> {
  return await channels.canViewTask(actor, taskId)
}

/** Cached variant for the tasks-list per-frame gate (raw taskId cache key). */
async function cachedTaskVisible(ctx: FrameGateCtx, taskId: string): Promise<boolean> {
  const cached = ctx.cache.get(taskId)
  if (cached !== undefined) return cached
  const visible = await taskVisibleTo(channelAccessOf(ctx), ctx.actor, taskId)
  ctx.cache.set(taskId, visible)
  return visible
}

/** RFC-099 — workflow-row visibility, cached under a `wf:` key prefix. */
async function cachedWorkflowVisible(ctx: FrameGateCtx, workflowId: string): Promise<boolean> {
  const key = `wf:${workflowId}`
  const cached = ctx.cache.get(key)
  if (cached !== undefined) return cached
  const visible = await channelAccessOf(ctx).canViewResource(ctx.actor, 'workflow', workflowId)
  ctx.cache.set(key, visible)
  return visible
}

async function cachedWorkgroupVisible(ctx: FrameGateCtx, workgroupId: string): Promise<boolean> {
  const key = `wg:${workgroupId}`
  const cached = ctx.cache.get(key)
  if (cached !== undefined) return cached
  const visible = await channelAccessOf(ctx).canViewResource(ctx.actor, 'workgroup', workgroupId)
  ctx.cache.set(key, visible)
  return visible
}

function hasResourceAclBypass(actor: Actor): boolean {
  return actor.permissions.has('resource-acl:bypass')
}

function channelAccessOf(ctx: FrameGateCtx): RealtimeChannelAccess {
  if (ctx.channels === undefined) throw new Error('realtime-channel-access-not-composed')
  return ctx.channels
}

function directAuthorityOf(ctx: FrameGateCtx): DirectRequestAuthority {
  if (ctx.authority === undefined) throw new Error('realtime-authority-not-composed')
  return ctx.authority
}

function visibleToAudienceSnapshot(
  actor: Actor,
  snapshot: {
    readonly visibility: 'public' | 'private'
    readonly ownerUserId: string | null
    readonly grantedUserIds: ReadonlySet<string>
  },
): boolean {
  if (hasResourceAclBypass(actor)) return true
  const privateVisible = actor.permissions.has('resource-acl:private')
  if (
    snapshot.ownerUserId === actor.user.id &&
    (snapshot.visibility === 'public' || privateVisible)
  ) {
    return true
  }
  if (!privateVisible) return snapshot.visibility === 'public'
  return snapshot.visibility === 'public' || snapshot.grantedUserIds.has(actor.user.id)
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
  // RFC-284 T10（§2.4）：判定收编快照函数自带 ACL bypass 分支，因此上游
  // shortcut 只是一条性能优化，正确性不依赖它。
  return visibleToAudienceSnapshot(actor, context)
}

function deletedWorkgroupAudienceVisible(
  actor: Actor,
  workgroupId: string,
  context: WorkgroupsBroadcastContext | undefined,
): boolean | null {
  if (
    context === undefined ||
    context.kind !== 'workgroup.deleted-audience' ||
    context.workgroupId !== workgroupId
  ) {
    return null
  }
  // RFC-284 T10（§2.4）：同 workflow 侧——判定收编快照函数。
  return visibleToAudienceSnapshot(actor, context)
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
    case 'task.members.changed':
    case 'lifecycle.alert.resolved':
      return msg.taskId
    case 'employee-case.members.changed':
      // RFC-330 —— not a task frame; gated by its own audience snapshot below.
      return null
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

function taskAudienceContextVisible(
  actor: Actor,
  taskId: string,
  context: TasksListBroadcastContext | undefined,
): boolean | null {
  if (
    context === undefined ||
    context.kind === 'employee-case.members-changed-audience' ||
    context.taskId !== taskId
  ) {
    return null
  }
  if (actor.permissions.has('tasks:read:all')) return true
  return context.visibleUserIds.has(actor.user.id)
}

/** Task `?since=N` replay — node_run_events joined via nodeRuns.taskId. */
async function replayTaskEvents(
  channels: RealtimeChannelAccess,
  taskId: string,
  since: number,
  ws: ServerWebSocket<WsConnectionData>,
): Promise<void> {
  const messages = await channels.replayTaskEvents(ws.data.actor.source, taskId, since)
  for (const message of messages) {
    sendJson(ws, message)
  }
}

// -----------------------------------------------------------------------------
// The registry.
// -----------------------------------------------------------------------------

export type WsChannelRegistry = {
  [K in WsChannelKind]: ChannelSpec<K, ChannelMessageByKind[K]>
}

export const WS_CHANNELS: WsChannelRegistry = {
  authority: {
    kind: 'authority',
    revalidation: {
      refreshActor: true,
      cache: { kind: 'none', why: 'revision-only control channel has no product frames' },
      rerunUpgradeGate: { na: 'authenticated upgrade is the complete gate' },
    },
    helloName: () => 'authority',
    pathRe: /^\/ws\/authority$/,
    samplePath: '/ws/authority',
    parse: () => ({ kind: 'authority' }),
    broadcaster: authorityBroadcaster,
    channelKeyOf: () => AUTHORITY_CHANNEL,
  },
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
    samplePath: '/ws/tasks/T1',
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
    upgradeGate: async (channels, actor, p) =>
      (await taskVisibleTo(channels, actor, p.taskId))
        ? true
        : { code: 'task-not-visible', message: 'task not visible to current actor' },
    onOpenExtra: async (ws, p, channels) => {
      if (p.since !== undefined) await replayTaskEvents(channels, p.taskId, p.since, ws)
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
    samplePath: '/ws/tasks',
    parse: () => ({ kind: 'tasks-list' }),
    broadcaster: tasksListBroadcaster,
    channelKeyOf: () => TASKS_LIST_CHANNEL,
    // RFC-054 W2-4 — per-frame RBAC filter. Every TasksListWsMessage mentions
    // exactly one task; unknown shapes drop. NO aclBypassShortCircuit:
    // canViewTask short-circuits internally on `tasks:read:all`, keeping those frames on
    // the same async path as before the registry.
    frameGate: async (ctx, msg, deliveryContext) => {
      if (msg.type === 'employee-case.members.changed') {
        // RFC-330 —— employee cases have no per-row visibility oracle on this
        // channel; the frame is delivered ONLY to the before ∪ after audience
        // frozen by the mutation (or to tasks:read:all). No snapshot ⇒ drop.
        if (
          deliveryContext === undefined ||
          deliveryContext.kind !== 'employee-case.members-changed-audience' ||
          deliveryContext.caseId !== msg.caseId
        ) {
          return false
        }
        if (ctx.actor.permissions.has('tasks:read:all')) return true
        return deliveryContext.visibleUserIds.has(ctx.actor.user.id)
      }
      const taskId = extractTaskIdFromListMessage(msg)
      if (taskId === null) return false
      if (msg.type === 'task.members.changed' || msg.type === 'task.deleted') {
        const cached = ctx.cache.get(taskId)
        const audience = taskAudienceContextVisible(ctx.actor, taskId, deliveryContext)
        // Both mutations invalidate any pre-change cached verdict. When an
        // audience snapshot exists it is authoritative even after DELETE.
        ctx.cache.delete(taskId)
        if (audience !== null) return audience
        // Preserve the legacy direct-broadcast behavior: a cached-visible
        // connection may still receive a delete after the row is gone.
        if (msg.type === 'task.deleted') return cached === true
      }
      return cachedTaskVisible(ctx, taskId)
    },
  },
  workflows: {
    kind: 'workflows',
    // RFC-212: caches under `wf:`; actors with ACL bypass take the synchronous shortcut.
    revalidation: {
      refreshActor: true,
      cache: { kind: 'prefixes', prefixes: ['wf:'] },
      rerunUpgradeGate: { na: 'no upgradeGate — this channel filters per frame' },
    },
    helloName: () => 'workflows',
    pathRe: /^\/ws\/workflows$/,
    samplePath: '/ws/workflows',
    parse: () => ({ kind: 'workflows' }),
    broadcaster: workflowsBroadcaster,
    channelKeyOf: () => WORKFLOWS_CHANNEL,
    aclBypassShortCircuit: true,
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
  workgroups: {
    kind: 'workgroups',
    revalidation: {
      refreshActor: true,
      cache: { kind: 'prefixes', prefixes: ['wg:'] },
      rerunUpgradeGate: { na: 'no upgradeGate — this channel filters per frame' },
    },
    helloName: () => 'workgroups',
    pathRe: /^\/ws\/workgroups$/,
    samplePath: '/ws/workgroups',
    parse: () => ({ kind: 'workgroups' }),
    broadcaster: workgroupsBroadcaster,
    channelKeyOf: () => WORKGROUPS_CHANNEL,
    aclBypassShortCircuit: true,
    frameGate: async (ctx, msg, deliveryContext) => {
      if (msg.type === 'workgroup.acl.updated') {
        ctx.cache.delete(`wg:${msg.workgroupId}`)
        return cachedWorkgroupVisible(ctx, msg.workgroupId)
      }
      if (msg.type === 'workgroup.deleted') {
        const cached = ctx.cache.get(`wg:${msg.workgroupId}`)
        ctx.cache.delete(`wg:${msg.workgroupId}`)
        const visibleFromAudience = deletedWorkgroupAudienceVisible(
          ctx.actor,
          msg.workgroupId,
          deliveryContext,
        )
        if (visibleFromAudience !== null) return visibleFromAudience
        return cached === true
      }
      if (msg.type === 'workgroup.created' || msg.type === 'workgroup.updated') {
        return cachedWorkgroupVisible(ctx, msg.workgroupId)
      }
      // Runtime defence in addition to the discriminated-union compile net:
      // an unrecognised future frame must never inherit an allow path.
      return false
    },
  },
  'repo-import': {
    kind: 'repo-import',
    // RFC-285 B6②：RFC-152 D4 登记的「无门」缺口在此关闭——批次自创建携
    // ownerUserId（repoBatchImport.ts），升级门=发起者 ∨ `resource-acl:bypass`；缺行与
    // 无权同形拒绝（batch-not-found），不泄露批次存在性。批次是内存 Map、
    // daemon 重启即逝，门随之自然失效（无持久化需求）。
    revalidation: {
      refreshActor: true,
      cache: { kind: 'none', why: 'gate re-derives from the live batch map each rerun' },
      rerunUpgradeGate: true,
    },
    helloName: (p) => `repo-imports/${p.batchId}`,
    pathRe: /^\/ws\/repo-imports\/([^/?#]+)$/,
    samplePath: '/ws/repo-imports/B1',
    parse: (m) => ({ kind: 'repo-import', batchId: decodeURIComponent(m[1] ?? '') }),
    broadcaster: repoImportsBroadcaster,
    channelKeyOf: (p) => REPO_IMPORT_CHANNEL(p.batchId),
    upgradeGate: async (channels, actor, p) => {
      const owner = channels.repoImportOwnerUserId(p.batchId)
      if (owner !== null && (owner === actor.user.id || hasResourceAclBypass(actor))) return true
      return { code: 'batch-not-found', message: `batch ${p.batchId} not found or expired` }
    },
  },
  memories: {
    kind: 'memories',
    // RFC-212: deliberately UNcached (RFC-045 edits move rows between scopes),
    // so clearing a cache would be a no-op here — the only stale source is the
    // frozen permissions behind aclBypassShortCircuit.
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
    samplePath: '/ws/memories',
    parse: () => ({ kind: 'memories' }),
    broadcaster: memoryBroadcaster,
    channelKeyOf: () => MEMORY_CHANNEL,
    aclBypassShortCircuit: true,
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
          return channelAccessOf(ctx).canViewMemory(directAuthorityOf(ctx), ctx.actor, {
            scopeType: msg.memory.scopeType,
            scopeId: msg.memory.scopeId,
          })
        case 'memory.candidate.promoted':
        case 'memory.archived':
        case 'memory.unarchived':
        case 'memory.deleted':
        case 'memory.updated': {
          return channelAccessOf(ctx).canViewStoredMemory(
            directAuthorityOf(ctx),
            ctx.actor,
            msg.memoryId,
          )
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
    // RFC-212/RFC-305: permission-gated whole connection; access changes re-run it.
    revalidation: {
      refreshActor: true,
      cache: { kind: 'none', why: 'no frameGate — permission gate at upgrade' },
      rerunUpgradeGate: true,
    },
    helloName: () => 'memory-distill-jobs',
    pathRe: /^\/ws\/memory-distill-jobs$/,
    samplePath: '/ws/memory-distill-jobs',
    parse: () => ({ kind: 'memory-distill-jobs' }),
    broadcaster: memoryDistillJobBroadcaster,
    channelKeyOf: () => MEMORY_DISTILL_JOB_CHANNEL,
    // RFC-305: the upgrade uses the same explicit capabilities as HTTP. Role
    // presets may supply them, but this consumer never inspects the role.
    upgradeGate: async (_channels, actor) =>
      actor.permissions.has('memory-distill-jobs:manage') && actor.permissions.has('memory:update')
        ? true
        : {
            code: 'permission-required',
            message: 'memory-distill-jobs channel requires memory-distill-jobs:manage',
          },
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
    samplePath: '/ws/scheduled-tasks',
    parse: () => ({ kind: 'scheduled-tasks' }),
    broadcaster: scheduledTaskBroadcaster,
    channelKeyOf: () => SCHEDULED_TASK_CHANNEL,
    // RFC-159 — per-frame owner filter. Every frame carries `ownerUserId`; the
    // owner + actors with `tasks:read:all` receive it, everyone else drops. No DB
    // lookup (unlike tasks-list) since the owner rides on the message.
    frameGate: async (ctx, msg) =>
      ctx.actor.permissions.has('tasks:read:all') || msg.ownerUserId === ctx.actor.user.id,
  },
  'intent-sessions': {
    kind: 'intent-sessions',
    // RFC-234/RFC-305: pure in-memory decision — creator or an actor with
    // `intent:audit`; canAuditIntentSessions is the single source.
    revalidation: {
      refreshActor: true,
      cache: { kind: 'none', why: 'pure in-memory check on actor permission + ownerUserId' },
      rerunUpgradeGate: { na: 'no upgradeGate — this channel filters per frame' },
    },
    helloName: () => 'intent-sessions',
    pathRe: /^\/ws\/intent-sessions$/,
    samplePath: '/ws/intent-sessions',
    parse: () => ({ kind: 'intent-sessions' }),
    broadcaster: intentSessionsBroadcaster,
    channelKeyOf: () => INTENT_SESSIONS_CHANNEL,
    frameGate: async (ctx, msg) =>
      ctx.actor.permissions.has('intent:audit') || msg.ownerUserId === ctx.actor.user.id,
  },
  'mcp-runtime-tests': {
    kind: 'mcp-runtime-tests',
    revalidation: {
      refreshActor: true,
      cache: {
        kind: 'none',
        why: 'pure in-memory check on actor permission and broadcast owner context',
      },
      rerunUpgradeGate: { na: 'no upgradeGate — this channel filters per frame' },
    },
    helloName: () => 'mcp-runtime-tests',
    pathRe: /^\/ws\/mcp-runtime-tests$/,
    samplePath: '/ws/mcp-runtime-tests',
    parse: () => ({ kind: 'mcp-runtime-tests' }),
    broadcaster: mcpRuntimeTestsBroadcaster,
    channelKeyOf: () => MCP_RUNTIME_TESTS_CHANNEL,
    frameGate: async (ctx, _msg, deliveryContext) =>
      deliveryContext?.kind === 'mcp-runtime-test-owner' &&
      deliveryContext.ownerUserId === ctx.actor.user.id,
  },
  // RFC-312 —— 在线状态。整条连接在升级时就被 `users:presence` 挡住，因此**没有 frameGate**：
  // 这一条直接消掉了"逐帧权限判定会连坐过滤控制帧"的整类问题。权限被收回时
  // rerunUpgradeGate 会关掉连接（4403），客户端据此清空 store——服务端不需要任何重同步协议。
  presence: {
    kind: 'presence',
    revalidation: {
      refreshActor: true,
      cache: { kind: 'none', why: 'no frameGate — whole-connection permission gate at upgrade' },
      rerunUpgradeGate: true,
    },
    helloName: () => 'presence',
    pathRe: /^\/ws\/presence$/,
    samplePath: '/ws/presence',
    parse: () => ({ kind: 'presence' }),
    broadcaster: presenceBroadcaster,
    channelKeyOf: () => PRESENCE_CHANNEL,
    upgradeGate: async (_channels, actor) =>
      actor.permissions.has('users:presence')
        ? true
        : {
            code: 'permission-required',
            message: 'presence channel requires users:presence',
          },
    // 登记 + 快照都在这里，理由有二：
    //   ①presence 只统计 /ws/presence 连接，这本来就是**通道自己的事**，
    //     放进 server.ts 会长出 per-channel 分支（rfc152-ws-task-channel 的 ratchet 正是防这个）；
    //   ②`onOpenExtra` 跑在升级门与 handleOpen 的 epoch 复核**之后**，
    //     满足"登记必须在完整鉴权之后"——否则升级途中被撤销的连接会制造一次假上线并挂满宽限期。
    // 取快照与发送之间**不得有 await**：否则会出现"增量先到被前端丢弃、旧快照后到"的永久陈旧。
    onOpenExtra: async (ws) => {
      installPresence(ws)
      sendJson(ws, {
        type: 'presence.snapshot',
        online: [...ws.data.identityAccess.presenceQuery.snapshot()],
      })
    },
    // RFC-312 实现门 P1 —— 复核冻结期间的 `presence.changed` 会被丢弃（见
    // `resync` 的类型注释），而 presence 是累积式增量流，丢一帧就永久
    // 错到该用户下次翻转。解冻后重发一次**全量快照**：它是幂等的、与开连接时走的是同一
    // 条 `applyPresenceSnapshot` 路径，因此不需要任何新的重放协议或客户端分支。
    resync: (ws) => {
      sendJson(ws, {
        type: 'presence.snapshot',
        online: [...ws.data.identityAccess.presenceQuery.snapshot()],
      })
    },
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
    channels: RealtimeChannelAccess,
    actor: Actor,
    p: AnyChannelParams,
  ) => Promise<true | WsUpgradeRefusal>
  frameGate?: (
    ctx: FrameGateCtx,
    msg: AnyChannelMessage,
    context?: AnyBroadcastContext,
  ) => Promise<boolean>
  aclBypassShortCircuit?: boolean
  onOpenExtra?: (
    ws: ServerWebSocket<WsConnectionData>,
    p: AnyChannelParams,
    channels: RealtimeChannelAccess,
  ) => Promise<void>
  resync?: (ws: ServerWebSocket<WsConnectionData>) => void
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
  channels: RealtimeChannelAccess,
  actor: Actor,
  params: AnyChannelParams,
): Promise<true | WsUpgradeRefusal> {
  const spec = erasedSpecOf(params.kind)
  if (spec.upgradeGate === undefined) return true
  return spec.upgradeGate(channels, actor, params)
}

/**
 * The one subscription pipeline (design §1): register on the broadcaster
 * channel, emit the hello frame (with `since` echoed for replay channels),
 * and gate every outgoing frame:
 *
 *   ACL-bypass short-circuit (sync send) → frameGate (async) → gate error ⇒ DROP.
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
  channels: RealtimeChannelAccess,
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
    // Row-level bypass fast path. `resource-acl:bypass` is an ordinary effective
    // account permission; the account role is irrelevant here.
    if (erased.aclBypassShortCircuit === true && hasResourceAclBypass(ws.data.actor)) {
      sendJson(ws, msg)
      return
    }
    if (erased.frameGate === undefined) {
      sendJson(ws, msg)
      return
    }
    // Fire-and-forget the async gate; a throwing gate (DB blip) falls back
    // to NOT sending — same safer-default as the unknown-shape drops.
    const gateActor = ws.data.actor
    erased
      .frameGate(
        {
          channels,
          actor: gateActor,
          authority: ws.data.authority,
          cache: ws.data.visibilityCache,
        },
        msg,
        context,
      )
      .then((visible) => {
        // RFC-305 async-continuation fence: a refresh may replace the actor
        // while frameGate awaits DB/ACL work. A verdict minted by the prior
        // authority must never authorize a later send.
        if (visible && ws.data.actor === gateActor) sendJson(ws, msg)
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
  channels: RealtimeChannelAccess,
): Promise<void> {
  const spec = WS_CHANNELS[params.kind]
  gatedSubscribe(ws, spec, params, channels)
  const erased = spec as unknown as ErasedChannelSpec
  if (erased.onOpenExtra !== undefined) {
    await erased.onOpenExtra(ws, params, channels)
  }
}

function sendJson(ws: ServerWebSocket<WsConnectionData>, msg: WsOutboundMessage): void {
  if (!authorityRevisionCurrent(ws)) return
  try {
    // RFC-312 实现门 P1 —— Bun 的 `ws.send()` 用**返回 0 表示这一帧被丢弃**（背压 / 已关闭），
    // 此前这里只 catch 异常、完全忽略返回值，于是丢弃是静默的。对"收到即 refetch"的通道
    // 无所谓；对累积式增量流则是永久损坏。让通道自己声明如何重同步：**没实现 `resync` 的
    // 通道逐字维持原行为**（照旧忽略），只有 presence 会补发一次全量快照。
    const written = ws.send(JSON.stringify(msg))
    if (written === 0) {
      const spec = erasedSpecOf(ws.data.channel.kind)
      // 重入守卫：补发的快照本身也可能被丢（背压未缓解）。只尝试一次，避免在压力下自激；
      // 仍失败就留在陈旧态，等下一帧成功时再自愈。
      if (spec.resync !== undefined && !ws.data.resyncing) {
        ws.data.resyncing = true
        try {
          spec.resync(ws)
        } finally {
          ws.data.resyncing = false
        }
      }
    }
  } catch (err) {
    log.warn('send failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** RFC-305 DB/current outbound fence. Notifications accelerate refresh, but
 * this check is authoritative when a notification is lost or a process races
 * an async frame continuation.
 *
 * **同步**是硬约束：发帧要在当前 tick 内定夺，改成 async 会让判定落到下一个微任务，
 * 而帧那时已经发出去了。Bun SQLite 的读本来就是同步的，所以这条约束不用付代价。
 *
 * RFC-317 T41 —— 这里原先直接 `db.$client.query('SELECT status, access_revision
 * FROM users WHERE id = ?')`。同步没问题，越界才是问题：`users` 是 identity-access
 * 的私表，那条字符串把它的两个列名硬编码进了传输层。列一改名，**这里 typecheck 全绿、
 * 运行期在授权围栏上失败**，而且它不是 import 边，本仓所有基于 import 的架构守卫都
 * 看不见它。现在走 identity-access 的同步 public 端口，SQL 回到拥有那张表的 context 里。 */
function authorityRevisionCurrent(ws: ServerWebSocket<WsConnectionData>): boolean {
  let fence: AuthorityFenceRecord | null
  try {
    fence = ws.data.identityAccess.authorityFence.readAuthorityFence(ws.data.actor.user.id)
  } catch (error) {
    log.warn('authority revision fence failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    onExpiredCredential?.(ws)
    return false
  }
  if (fence === null || fence.status !== 'active') {
    onExpiredCredential?.(ws)
    return false
  }
  if (fence.accessRevision === (ws.data.actor.authorityRevision ?? 0)) return true

  // Drop this frame, synchronously freeze later ones, and ask the targeted
  // revalidation pass to rebuild the actor from the committed revision.
  ws.data.revalidating = true
  ws.data.identityAccess.requestAuthorityRevalidation(ws.data.actor.user.id, fence.accessRevision)
  return false
}
