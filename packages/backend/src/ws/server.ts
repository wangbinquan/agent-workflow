// WebSocket server adapter for Bun.serve().
//
// Bun's WebSocket API splits work between `fetch` (does `server.upgrade()`)
// and `websocket` handlers (open/message/close). This module exposes
// `buildWebSocketAdapter(deps)` which returns both, so the daemon entry point
// stays a thin shim around `Bun.serve({ fetch, websocket })`.
//
// Channels:
//   /ws/tasks/{taskId}    — single-task detail; `?since=N` replays events
//   /ws/tasks             — task list
//   /ws/workflows         — workflow list + editor multi-tab sync
//
// Token auth: `?token=` matches AppDeps.token exactly (constant-time).
//
// On open, the server emits a `hello` control frame so the client knows the
// subscription is live.

import type {
  MemoryDistillJobWsMessage,
  MemoryWsMessage,
  RepoImportWsMessage,
  TaskWsMessage,
  TasksListWsMessage,
  WorkflowsWsMessage,
  WsControlMessage,
} from '@agent-workflow/shared'
import type { ServerWebSocket } from 'bun'
import { eq } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import { resolveActor } from '@/auth/session'
import type { DbClient } from '@/db/client'
import { tasks } from '@/db/schema'
import { canViewTask } from '@/services/taskCollab'
import { createLogger } from '@/util/log'
import {
  MEMORY_CHANNEL,
  MEMORY_DISTILL_JOB_CHANNEL,
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
} from './broadcaster'

const log = createLogger('ws.server')

interface ConnectionData {
  channel:
    | { kind: 'task'; taskId: string; since?: number }
    | { kind: 'tasks-list' }
    | { kind: 'workflows' }
    | { kind: 'repo-import'; batchId: string }
    | { kind: 'memories' }
    | { kind: 'memory-distill-jobs' }
  /**
   * The resolved actor that owns this connection. Pinned at upgrade time so
   * per-actor logging / per-user channel filtering doesn't need a second
   * DB round-trip on every broadcast.
   */
  actor: Actor
  unsubscribe: () => void
  /**
   * RFC-054 W2-4 fix — per-task visibility cache for the `/ws/tasks` list
   * channel. The broadcaster fires every task event globally; this cache
   * remembers whether the connection's actor is allowed to see each
   * taskId mentioned in an outgoing frame, so we only do the canViewTask
   * DB lookup once per (connection, taskId) pair. Cleared on close.
   *
   * For the per-task `/ws/tasks/{taskId}` channel a single visibility
   * check at upgrade time gates the WHOLE connection (see tryUpgrade);
   * no cache needed.
   */
  visibilityCache: Map<string, boolean>
}

export interface WebSocketAdapterDeps {
  /**
   * Legacy daemon-token value used to bootstrap a daemon before any user
   * exists. Continues to upgrade WS connections as the `__system__` admin
   * actor (via auth/session.ts:resolveActor) so the single-user / scripted
   * daemon mode keeps working alongside the OIDC/PAT paths introduced by
   * RFC-036.
   */
  daemonToken: string
  db: DbClient
}

export interface WebSocketAdapter {
  /**
   * Try to upgrade a WebSocket request. Returns true if handled (caller
   * should return without producing a Response), false if the request isn't
   * a WS endpoint at all, or a Response to send back when the upgrade is
   * refused (bad token, unknown channel, etc.).
   *
   * Async because token resolution (RFC-036) may hit the DB to validate a
   * session token or PAT before the upgrade is allowed.
   */
  tryUpgrade(req: Request, server: { upgrade: BunUpgradeFn }): Promise<true | false | Response>

  /**
   * Bun.serve `websocket` handler tree. Pass directly to Bun.serve().
   */
  handlers: {
    open(ws: ServerWebSocket<ConnectionData>): void | Promise<void>
    close(ws: ServerWebSocket<ConnectionData>): void
    message(ws: ServerWebSocket<ConnectionData>, msg: string | Buffer): void
  }
}

type BunUpgradeFn = (req: Request, opts: { data: ConnectionData }) => boolean

const WS_PATH_RE = {
  task: /^\/ws\/tasks\/([^/?#]+)$/,
  list: /^\/ws\/tasks$/,
  flows: /^\/ws\/workflows$/,
  repoImport: /^\/ws\/repo-imports\/([^/?#]+)$/,
  memories: /^\/ws\/memories$/,
  memoryDistillJobs: /^\/ws\/memory-distill-jobs$/,
}

export function buildWebSocketAdapter(deps: WebSocketAdapterDeps): WebSocketAdapter {
  // Pre-allocate the daemon-token Buffer once — `resolveActor` does a
  // length-check + timing-safe equality, so we avoid Buffer.from() per
  // upgrade attempt.
  const daemonTokenBuf = Buffer.from(deps.daemonToken, 'utf-8')

  function parseChannel(url: URL): ConnectionData['channel'] | null {
    const m = WS_PATH_RE.task.exec(url.pathname)
    if (m !== null) {
      const ch: ConnectionData['channel'] = {
        kind: 'task',
        taskId: decodeURIComponent(m[1] ?? ''),
      }
      const since = url.searchParams.get('since')
      if (since !== null && since !== '' && Number.isInteger(Number(since))) {
        ch.since = Number(since)
      }
      return ch
    }
    if (WS_PATH_RE.list.test(url.pathname)) return { kind: 'tasks-list' }
    if (WS_PATH_RE.flows.test(url.pathname)) return { kind: 'workflows' }
    const rm = WS_PATH_RE.repoImport.exec(url.pathname)
    if (rm !== null) {
      return { kind: 'repo-import', batchId: decodeURIComponent(rm[1] ?? '') }
    }
    if (WS_PATH_RE.memories.test(url.pathname)) return { kind: 'memories' }
    if (WS_PATH_RE.memoryDistillJobs.test(url.pathname)) return { kind: 'memory-distill-jobs' }
    return null
  }

  async function tryUpgrade(
    req: Request,
    server: { upgrade: BunUpgradeFn },
  ): Promise<true | false | Response> {
    const url = new URL(req.url)
    if (!url.pathname.startsWith('/ws/')) return false
    const channel = parseChannel(url)
    if (channel === null) {
      return new Response(
        JSON.stringify({ error: { code: 'ws-unknown-channel', message: 'unknown ws channel' } }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      )
    }
    const queryToken = url.searchParams.get('token')
    if (queryToken === null || queryToken === '') {
      return new Response(
        JSON.stringify({ error: { code: 'auth-required', message: 'invalid or missing token' } }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      )
    }
    // RFC-036 — accept session tokens (aws_s_…), PATs (aws_pat_…) and the
    // legacy daemon token, the same set the HTTP `multiAuth` middleware
    // recognises. Previously this branch only ran `timingSafeEquals` against
    // the static daemon token, so any client that logged in via OIDC and
    // received a session token failed every WS upgrade with 401 — the
    // SessionTab fell back to remount-on-tab-switch refetches and looked
    // "not live" even though the runner was broadcasting correctly.
    let actor: Actor | null = null
    try {
      actor = await resolveActor(deps.db, queryToken, daemonTokenBuf)
    } catch (err) {
      log.warn('upgrade-token-resolve-threw', {
        err: err instanceof Error ? err.message : String(err),
      })
    }
    if (actor === null) {
      return new Response(
        JSON.stringify({ error: { code: 'auth-required', message: 'invalid or missing token' } }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      )
    }
    // RFC-054 W2-4 fix — per-task channel upgrade is gated by
    // canViewTask. The tasks-list channel does per-frame filtering
    // (see handleOpen below) because the channel itself enumerates
    // all tasks system-wide.
    if (channel.kind === 'task') {
      const visible = await isTaskVisibleTo(deps.db, actor, channel.taskId)
      if (!visible) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'task-not-visible',
              message: 'task not visible to current actor',
            },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        )
      }
    }
    const data: ConnectionData = {
      channel,
      actor,
      unsubscribe: () => {
        /* set on open */
      },
      visibilityCache: new Map<string, boolean>(),
    }
    const ok = server.upgrade(req, { data })
    if (!ok) {
      return new Response('upgrade-failed', { status: 426 })
    }
    return true
  }

  /**
   * Look up a task's ownerUserId once and ask canViewTask. Returns false
   * if the task no longer exists (e.g. just got deleted between
   * broadcaster fire + this handler running).
   */
  async function isTaskVisibleTo(db: DbClient, actor: Actor, taskId: string): Promise<boolean> {
    const rows = await db
      .select({ id: tasks.id, ownerUserId: tasks.ownerUserId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
    if (rows.length === 0) return false
    return canViewTask(db, actor, rows[0]!)
  }

  /**
   * Cached variant: stores the result per-connection so a hot task
   * status stream doesn't N+1 the DB. The cache is bounded by the
   * number of distinct tasks the connection sees, which is bounded by
   * the system's total task count — acceptable for v1.
   */
  async function cachedIsTaskVisible(
    ws: ServerWebSocket<ConnectionData>,
    taskId: string,
  ): Promise<boolean> {
    const cached = ws.data.visibilityCache.get(taskId)
    if (cached !== undefined) return cached
    const visible = await isTaskVisibleTo(deps.db, ws.data.actor, taskId)
    ws.data.visibilityCache.set(taskId, visible)
    return visible
  }

  async function handleOpen(ws: ServerWebSocket<ConnectionData>): Promise<void> {
    const ch = ws.data.channel
    log.debug('open', { channel: ch })
    let hello: WsControlMessage

    switch (ch.kind) {
      case 'task': {
        const channelKey = TASK_CHANNEL(ch.taskId)
        ws.data.unsubscribe = taskBroadcaster.subscribe(channelKey, (msg: TaskWsMessage) => {
          safeSend(ws, msg)
        })
        hello = { type: 'hello', channel: `tasks/${ch.taskId}` }
        if (ch.since !== undefined) hello.since = ch.since
        safeSend(ws, hello)
        if (ch.since !== undefined) {
          await replayTaskEvents(deps.db, ch.taskId, ch.since, ws)
        }
        return
      }
      case 'tasks-list': {
        // RFC-054 W2-4 fix — per-frame RBAC filter. Every TasksListWsMessage
        // mentions exactly one task; pull the task id, run canViewTask
        // (cached per connection), and drop the frame if not visible.
        // Admins (`tasks:read:all`) shortcut to true inside canViewTask
        // so this stays O(1) DB lookup for the global view.
        ws.data.unsubscribe = tasksListBroadcaster.subscribe(
          TASKS_LIST_CHANNEL,
          (msg: TasksListWsMessage) => {
            const taskId = extractTaskIdFromListMessage(msg)
            if (taskId === null) {
              // Defensive: future TasksListWsMessage variants without a
              // taskId would skip the gate. We default to NOT sending
              // unknown shapes — safer than leaking by accident.
              return
            }
            // Fire-and-forget the async check; if visible, send. If the
            // check throws (DB blip), fall back to NOT sending — same
            // safer-default as the unknown-shape branch above.
            cachedIsTaskVisible(ws, taskId)
              .then((visible) => {
                if (visible) safeSend(ws, msg)
              })
              .catch((err) => {
                log.warn('tasks-list visibility check threw', {
                  taskId,
                  err: err instanceof Error ? err.message : String(err),
                })
              })
          },
        )
        safeSend(ws, { type: 'hello', channel: 'tasks' } satisfies WsControlMessage)
        return
      }
      case 'workflows': {
        ws.data.unsubscribe = workflowsBroadcaster.subscribe(
          WORKFLOWS_CHANNEL,
          (msg: WorkflowsWsMessage) => safeSend(ws, msg),
        )
        safeSend(ws, { type: 'hello', channel: 'workflows' } satisfies WsControlMessage)
        return
      }
      case 'repo-import': {
        ws.data.unsubscribe = repoImportsBroadcaster.subscribe(
          REPO_IMPORT_CHANNEL(ch.batchId),
          (msg: RepoImportWsMessage) => safeSend(ws, msg),
        )
        safeSend(ws, {
          type: 'hello',
          channel: `repo-imports/${ch.batchId}`,
        } satisfies WsControlMessage)
        return
      }
      case 'memories': {
        ws.data.unsubscribe = memoryBroadcaster.subscribe(MEMORY_CHANNEL, (msg: MemoryWsMessage) =>
          safeSend(ws, msg),
        )
        safeSend(ws, { type: 'hello', channel: 'memories' } satisfies WsControlMessage)
        return
      }
      case 'memory-distill-jobs': {
        ws.data.unsubscribe = memoryDistillJobBroadcaster.subscribe(
          MEMORY_DISTILL_JOB_CHANNEL,
          (msg: MemoryDistillJobWsMessage) => safeSend(ws, msg),
        )
        safeSend(ws, {
          type: 'hello',
          channel: 'memory-distill-jobs',
        } satisfies WsControlMessage)
        return
      }
    }
  }

  function handleClose(ws: ServerWebSocket<ConnectionData>): void {
    try {
      ws.data.unsubscribe()
    } catch (err) {
      log.warn('unsubscribe threw', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function handleMessage(_ws: ServerWebSocket<ConnectionData>, _msg: string | Buffer): void {
    // v1: clients are read-only on these channels. Ignore inbound frames.
  }

  return {
    tryUpgrade,
    handlers: {
      open: handleOpen,
      close: handleClose,
      message: handleMessage,
    },
  }
}

async function replayTaskEvents(
  _db: DbClient,
  _taskId: string,
  _since: number,
  _ws: ServerWebSocket<ConnectionData>,
): Promise<void> {
  // RFC-061 follow-up: the legacy node_run_events stream replay has been
  // retired. The actor writes attempt-subagent-* events into the
  // projection `events` table but those events have a ULID id, not the
  // legacy autoincrement int cursor the WS contract uses. Live
  // updates are temporarily silenced; the frontend's per-node Events
  // tab continues to work via REST polling on
  // GET /api/tasks/:id/node-runs/:nodeRunId/events (which already reads
  // the projection — see services/taskRunsProjection.ts). A native
  // events-stream WS replay lands with the /tasks/:id/timeline route in
  // a follow-up PR.
}

/**
 * Extract the task id a TasksListWsMessage refers to. Each shape in the
 * discriminated union mentions exactly one task; if the union grows a
 * new variant in the future, the default-null branch causes the WS
 * server to DROP the frame (safer than leaking by accident — see
 * RFC-054 W2-4 fix in handleOpen for `tasks-list`).
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

function safeSend(
  ws: ServerWebSocket<ConnectionData>,
  msg:
    | TaskWsMessage
    | TasksListWsMessage
    | WorkflowsWsMessage
    | RepoImportWsMessage
    | MemoryWsMessage
    | MemoryDistillJobWsMessage
    | WsControlMessage,
): void {
  try {
    ws.send(JSON.stringify(msg))
  } catch (err) {
    log.warn('send failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
