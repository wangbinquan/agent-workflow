// RFC-234 §6 (T7) — intent-builder session routes.
//
//   POST   /api/intent-sessions                       create + first turn
//   GET    /api/intent-sessions?status=&all=1         list (own; admin audit)
//   GET    /api/intent-sessions/:id                   detail (turns/draft/slots/commits)
//   GET    /api/intent-sessions/:id/turns/:turnId/session
//                                                       shared SessionTree view
//   POST   /api/intent-sessions/:id/messages          user message → next turn
//   POST   /api/intent-sessions/:id/answers           answers → next turn
//   POST   /api/intent-sessions/:id/mount-approvals   approve/reject agent suggestions
//   POST   /api/intent-sessions/:id/mounts            explicit mount
//   DELETE /api/intent-sessions/:id/mounts/:handle    unmount root
//   POST   /api/intent-sessions/:id/rebase            new context epoch
//   POST   /api/intent-sessions/:id/cancel-turn       abort the in-flight turn
//   POST   /api/intent-sessions/:id/commit            apply the confirmed draft
//   POST   /api/intent-sessions/:id/archive|reopen
//
// Gates: `intent:read` for GET, `intent:write` for mutations (every role has
// both — D22); per-row visibility (creator + system admin) and every deeper
// authorization live in services/intent/*. Turn generation is fired
// asynchronously — failures settle into the session as error turns.

import type { Hono } from 'hono'
import {
  CommitIntentSchema,
  CreateIntentSessionSchema,
  IntentApplyReceiptSchema,
  IntentDraftDtoSchema,
  PostIntentAnswersSchema,
  PostIntentMessageSchema,
  PostIntentMountApprovalsSchema,
  IntentMountRefSchema,
  parseIntentChangeset,
  type IntentDraftDto,
  type IntentSessionDetail,
  type IntentSessionSummary,
  type IntentTurnDto,
} from '@agent-workflow/shared'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { actorOf, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { loadConfig } from '@/config'
import { intentApplyJournal, intentDrafts } from '@/db/schema'
import { NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'
import { INTENT_SESSIONS_CHANNEL, intentSessionsBroadcaster } from '@/ws/broadcaster'
import { applyIntentChangeset } from '@/services/intent/applyChangeset'
import { deriveIntentSlots } from '@/services/intent/resolveChangeset'
import {
  abortIntentTurn,
  resolveIntentTurnConfig,
  runIntentTurn,
} from '@/services/intent/turnEngine'
import { getIntentTurnSession, projectIntentTurnExecution } from '@/services/intent/turnSession'
import {
  addIntentMount,
  createIntentSession,
  getIntentSessionForActor,
  insertUserTurn,
  listIntentProvenanceForActor,
  listIntentSessionsForActor,
  listIntentTurns,
  rebaseIntentSession,
  removeIntentMount,
  sessionManifest,
  setIntentSessionStatus,
  type IntentSessionRow,
} from '@/services/intent/session'

const log = createLogger('intentRoutes')

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw new ValidationError('invalid-json', 'request body must be JSON')
  }
}

/** Zod-validated JSON-record parse — routes never `as`-cast (RFC-054 W1-7). */
const JsonRecordSchema = z.record(z.string(), z.unknown())
function parseJsonRecord(text: string): Record<string, unknown> {
  return JsonRecordSchema.parse(JSON.parse(text))
}

function sessionSummary(
  row: IntentSessionRow & { currentDraftRevision?: number | null },
  opts: { includeOwner: boolean },
): IntentSessionSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    contextRevision: row.contextRevision,
    turnSeq: row.turnSeq,
    commitSeq: row.commitSeq,
    inFlight: row.inFlightTurnId !== null,
    currentDraftRevision: row.currentDraftRevision ?? null,
    ...(opts.includeOwner ? { ownerUserId: row.ownerUserId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function mountIntentSessionRoutes(app: Hono, deps: AppDeps): void {
  const appHome = Paths.root

  async function fireTurn(sessionId: string, actor: Actor): Promise<void> {
    const EXECUTION_BROADCAST_THROTTLE_MS = 500
    let lastExecutionBroadcastAt = 0
    let pendingExecution: { sessionId: string; turnId: string; eventSeq: number } | undefined
    let executionTimer: ReturnType<typeof setTimeout> | undefined
    const flushExecution = (): void => {
      if (pendingExecution === undefined) return
      const event = pendingExecution
      pendingExecution = undefined
      lastExecutionBroadcastAt = Date.now()
      intentSessionsBroadcaster.broadcast(INTENT_SESSIONS_CHANNEL, {
        type: 'intent.turn.execution.updated',
        sessionId: event.sessionId,
        turnId: event.turnId,
        eventSeq: event.eventSeq,
        ownerUserId: actor.user.id,
      })
    }
    const queueExecution = (event: {
      sessionId: string
      turnId: string
      eventSeq: number
    }): void => {
      if (pendingExecution === undefined || event.eventSeq >= pendingExecution.eventSeq) {
        pendingExecution = event
      }
      const remaining = EXECUTION_BROADCAST_THROTTLE_MS - (Date.now() - lastExecutionBroadcastAt)
      if (remaining <= 0) {
        if (executionTimer !== undefined) clearTimeout(executionTimer)
        executionTimer = undefined
        flushExecution()
        return
      }
      if (executionTimer !== undefined) return
      executionTimer = setTimeout(() => {
        executionTimer = undefined
        flushExecution()
      }, remaining)
      executionTimer.unref?.()
    }
    try {
      const cfg = loadConfig(deps.configPath)
      const config = await resolveIntentTurnConfig(deps.db, cfg)
      await runIntentTurn(
        {
          db: deps.db,
          appHome,
          config,
          onSessionEvent: (event) => {
            if (
              event.type === 'intent.turn.execution.updated' &&
              event.turnId !== undefined &&
              event.eventSeq !== undefined
            ) {
              queueExecution({
                sessionId: event.sessionId,
                turnId: event.turnId,
                eventSeq: event.eventSeq,
              })
              return
            }
            if (event.type === 'intent.turn.started' || event.type === 'intent.turn.finished') {
              if (event.type === 'intent.turn.finished') flushExecution()
              intentSessionsBroadcaster.broadcast(INTENT_SESSIONS_CHANNEL, {
                type: event.type,
                sessionId: event.sessionId,
                turnId: event.turnId ?? '',
                ownerUserId: actor.user.id,
              })
            }
          },
          ...(deps.containmentCoordinator === undefined
            ? {}
            : { containmentCoordinator: deps.containmentCoordinator }),
          ...(deps.intentTestDependencies?.runFn === undefined
            ? {}
            : { runFn: deps.intentTestDependencies.runFn }),
        },
        { sessionId, actor },
      )
    } catch (err) {
      // Pre-spawn refusals (budget, runtime unsupported) have no turn row to
      // settle into — surface via log; the UI sees state via polling/WS.
      log.warn('intent-turn-fire-failed', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      })
    } finally {
      if (executionTimer !== undefined) clearTimeout(executionTimer)
      flushExecution()
    }
  }

  function emitSessionUpdated(sessionId: string, ownerUserId: string): void {
    intentSessionsBroadcaster.broadcast(INTENT_SESSIONS_CHANNEL, {
      type: 'intent.session.updated',
      sessionId,
      ownerUserId,
    })
  }

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/intent-sessions',
      permissions: ['intent:write'],
      tokenAccess: 'allow',
      summary: 'Create an intent session',
    },
    async (c) => {
      const parsed = CreateIntentSessionSchema.safeParse(await safeJson(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('intent-invalid', 'invalid intent session payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const { session } = await createIntentSession(deps.db, actor, parsed.data)
      void fireTurn(session.id, actor)
      return c.json(sessionSummary(session, { includeOwner: false }), 201)
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/intent-sessions',
      permissions: ['intent:read'],
      tokenAccess: 'allow',
      summary: 'List intent sessions',
    },
    async (c) => {
      const actor = actorOf(c)
      const statusRaw = c.req.query('status')
      const status = statusRaw === 'active' || statusRaw === 'archived' ? statusRaw : undefined
      const all = c.req.query('all') === '1'
      const rows = await listIntentSessionsForActor(deps.db, actor, {
        ...(status === undefined ? {} : { status }),
        all,
      })
      return c.json(rows.map((row) => sessionSummary(row, { includeOwner: all })))
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/intent-sessions/:id',
      permissions: ['intent:read'],
      tokenAccess: 'allow',
      summary: 'Get one intent session',
    },
    async (c) => {
      const actor = actorOf(c)
      const session = await getIntentSessionForActor(deps.db, actor, c.req.param('id'))
      const turns = await listIntentTurns(deps.db, session.id)
      const turnDtos: IntentTurnDto[] = turns.map((t) => ({
        id: t.id,
        seq: t.seq,
        role: t.role,
        kind: t.kind,
        content: parseJsonRecord(t.contentJson),
        contextRevision: t.contextRevision,
        runMeta: t.runMetaJson === null ? null : parseJsonRecord(t.runMetaJson),
        execution: projectIntentTurnExecution(t),
        createdAt: t.createdAt,
      }))
      let currentDraft: IntentDraftDto | null = null
      if (session.currentDraftId !== null) {
        const draft = (
          await deps.db
            .select()
            .from(intentDrafts)
            .where(eq(intentDrafts.id, session.currentDraftId))
            .limit(1)
        )[0]
        if (draft !== undefined) {
          const parsedChangeset = parseIntentChangeset(draft.changesetJson)
          const slots = parsedChangeset.ok
            ? deriveIntentSlots(sessionManifest(session), parsedChangeset.changeset).slots
            : []
          currentDraft = {
            id: draft.id,
            revision: draft.revision,
            changeset: JSON.parse(draft.changesetJson),
            validation: IntentDraftDtoSchema.shape.validation.parse(
              JSON.parse(draft.validationJson),
            ),
            slots,
            draftHash: draft.draftHash,
            contextRevision: draft.contextRevision,
            stale: draft.contextRevision !== session.contextRevision,
            createdAt: draft.createdAt,
          }
        }
      }
      const commits = (
        await deps.db
          .select()
          .from(intentApplyJournal)
          .where(eq(intentApplyJournal.sessionId, session.id))
      ).map((row) => ({
        journalId: row.id,
        draftId: row.draftId,
        state: row.state,
        receipt:
          row.receiptJson === null
            ? null
            : IntentApplyReceiptSchema.parse(JSON.parse(row.receiptJson)),
        error: row.error,
        createdAt: row.createdAt,
      }))
      const mounts = sessionManifest(session)
        .filter((entry) => entry.root)
        .map((entry) => ({
          handle: entry.handle,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          detail: entry.detail,
        }))
      const detail: IntentSessionDetail = {
        session: {
          ...sessionSummary(session, { includeOwner: session.ownerUserId !== actor.user.id }),
          currentDraftRevision: currentDraft?.revision ?? null,
        },
        mounts,
        turns: turnDtos,
        currentDraft,
        commits,
      }
      return c.json(detail)
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/intent-sessions/:id/turns/:turnId/session',
      permissions: ['intent:read'],
      tokenAccess: 'allow',
      summary: 'Intent turn session view',
    },
    async (c) => {
      const actor = actorOf(c)
      const session = await getIntentSessionForActor(deps.db, actor, c.req.param('id'))
      return c.json(await getIntentTurnSession(deps.db, session.id, c.req.param('turnId')))
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/intent-sessions/:id/messages',
      permissions: ['intent:write'],
      tokenAccess: 'allow',
      summary: 'Send an intent message',
    },
    async (c) => {
      const parsed = PostIntentMessageSchema.safeParse(await safeJson(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('intent-invalid', 'invalid message payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const sessionId = c.req.param('id')
      const { turnId } = await insertUserTurn(deps.db, actor, sessionId, 'message', {
        message: parsed.data.message,
      })
      void fireTurn(sessionId, actor)
      return c.json({ turnId }, 202)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/intent-sessions/:id/answers',
      permissions: ['intent:write'],
      tokenAccess: 'allow',
      summary: 'Answer intent questions',
    },
    async (c) => {
      const parsed = PostIntentAnswersSchema.safeParse(await safeJson(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('intent-invalid', 'invalid answers payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const sessionId = c.req.param('id')
      const { turnId } = await insertUserTurn(deps.db, actor, sessionId, 'answers', {
        answers: parsed.data.answers,
      })
      void fireTurn(sessionId, actor)
      return c.json({ turnId }, 202)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/intent-sessions/:id/mount-approvals',
      permissions: ['intent:write'],
      tokenAccess: 'allow',
      summary: 'Approve an intent mount',
    },
    async (c) => {
      const parsed = PostIntentMountApprovalsSchema.safeParse(await safeJson(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('intent-invalid', 'invalid mount approvals payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const sessionId = c.req.param('id')
      const mounted: Array<{ handle: string }> = []
      for (const ref of parsed.data.approve) {
        mounted.push(await addIntentMount(deps.db, actor, sessionId, ref))
      }
      await insertUserTurn(deps.db, actor, sessionId, 'mount-approval', {
        approved: mounted.map((m) => m.handle),
        rejected: parsed.data.rejectNames,
      })
      emitSessionUpdated(sessionId, actor.user.id)
      return c.json({ mounted: mounted.map((m) => m.handle) })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/intent-sessions/:id/mounts',
      permissions: ['intent:write'],
      tokenAccess: 'allow',
      summary: 'Mount a resource into an intent session',
    },
    async (c) => {
      const parsed = IntentMountRefSchema.safeParse(await safeJson(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('intent-invalid', 'invalid mount payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const result = await addIntentMount(deps.db, actor, c.req.param('id'), parsed.data)
      emitSessionUpdated(c.req.param('id'), actor.user.id)
      return c.json(result, 201)
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/intent-sessions/:id/mounts/:handle',
      permissions: ['intent:write'],
      tokenAccess: 'allow',
      summary: 'Unmount a resource',
    },
    async (c) => {
      const actor = actorOf(c)
      const result = await removeIntentMount(
        deps.db,
        actor,
        c.req.param('id'),
        decodeURIComponent(c.req.param('handle')),
      )
      emitSessionUpdated(c.req.param('id'), actor.user.id)
      return c.json(result)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/intent-sessions/:id/rebase',
      permissions: ['intent:write'],
      tokenAccess: 'allow',
      summary: 'Rebase an intent session',
    },
    async (c) => {
      const actor = actorOf(c)
      const result = await rebaseIntentSession(deps.db, actor, c.req.param('id'))
      emitSessionUpdated(c.req.param('id'), actor.user.id)
      return c.json(result)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/intent-sessions/:id/retry',
      permissions: ['intent:write'],
      tokenAccess: 'allow',
      summary: 'Retry an intent turn',
    },
    async (c) => {
      const actor = actorOf(c)
      const session = await getIntentSessionForActor(deps.db, actor, c.req.param('id'))
      if (session.ownerUserId !== actor.user.id) {
        // Codex impl-gate P2-4: owner-only mutations keep the 404 shape — the
        // admin read bypass must not leak a distinguishable 422 here.
        throw new NotFoundError('intent-session-not-found', 'intent session not found')
      }
      void fireTurn(session.id, actor)
      return c.json({ ok: true }, 202)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/intent-sessions/:id/cancel-turn',
      permissions: ['intent:write'],
      tokenAccess: 'allow',
      summary: 'Cancel the in-flight intent turn',
    },
    async (c) => {
      const actor = actorOf(c)
      const session = await getIntentSessionForActor(deps.db, actor, c.req.param('id'))
      if (session.ownerUserId !== actor.user.id) {
        // Admin READ bypass never cancels another user's turn — 404 shape (P2-4).
        throw new NotFoundError('intent-session-not-found', 'intent session not found')
      }
      return c.json({ aborted: abortIntentTurn(session.id) })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/intent-sessions/:id/commit',
      permissions: ['intent:write'],
      tokenAccess: 'allow',
      summary: 'Commit an intent changeset',
    },
    async (c) => {
      const parsed = CommitIntentSchema.safeParse(await safeJson(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('intent-invalid', 'invalid commit payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const cfg = loadConfig(deps.configPath)
      const receipt = await applyIntentChangeset(
        {
          db: deps.db,
          appHome,
          actor,
          executionPolicy: { defaultRuntime: cfg.defaultRuntime ?? null },
        },
        {
          sessionId: c.req.param('id'),
          clientMutationId: parsed.data.clientMutationId,
          draftRevision: parsed.data.draftRevision,
          draftHash: parsed.data.draftHash,
          decisions: parsed.data.decisions,
        },
      )
      intentSessionsBroadcaster.broadcast(INTENT_SESSIONS_CHANNEL, {
        type: 'intent.apply.committed',
        sessionId: c.req.param('id'),
        journalId: receipt.journalId,
        ownerUserId: actor.user.id,
      })
      return c.json(receipt)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/intent-sessions/:id/archive',
      permissions: ['intent:write'],
      tokenAccess: 'allow',
      summary: 'Archive an intent session',
    },
    async (c) => {
      const actor = actorOf(c)
      await setIntentSessionStatus(deps.db, actor, c.req.param('id'), 'archived')
      emitSessionUpdated(c.req.param('id'), actor.user.id)
      return c.json({ ok: true })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/intent-sessions/:id/reopen',
      permissions: ['intent:write'],
      tokenAccess: 'allow',
      summary: 'Reopen an intent session',
    },
    async (c) => {
      const actor = actorOf(c)
      await setIntentSessionStatus(deps.db, actor, c.req.param('id'), 'active')
      emitSessionUpdated(c.req.param('id'), actor.user.id)
      return c.json({ ok: true })
    },
  )

  // AC-11 resource-side provenance badge. Uniform-empty read: invisible
  // resource, foreign session, or no provenance all return [] — the endpoint
  // never confirms resource existence nor another user's intent activity.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/intent-provenance/:resourceType/:resourceId',
      permissions: ['intent:read'],
      tokenAccess: 'allow',
      summary: 'Intent provenance for a resource',
    },
    async (c) => {
      const parsed = IntentMountRefSchema.safeParse({
        resourceType: c.req.param('resourceType'),
        resourceId: c.req.param('resourceId'),
      })
      if (!parsed.success) {
        throw new ValidationError('intent-invalid', 'invalid provenance ref', {
          issues: parsed.error.issues,
        })
      }
      const rows = await listIntentProvenanceForActor(deps.db, actorOf(c), parsed.data)
      return c.json(rows)
    },
  )
}
