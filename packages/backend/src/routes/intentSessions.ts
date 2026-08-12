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
  IntentMountRequestsSchema,
  PostIntentAnswersSchema,
  PostIntentMessageSchema,
  PostIntentMountApprovalsSchema,
  IntentMountRefSchema,
  parseIntentChangeset,
  type IntentDraftDto,
  type IntentJourneySnapshot,
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
import { projectIntentJourney } from '@/services/intent/journey'
import { listVisibleIntentResources } from '@/services/intent/resourceCatalog'
import { canAuditIntentSessions } from '@/services/resourceAcl'
import {
  cancelIntentTurn,
  resolveIntentTurnConfig,
  runIntentTurn,
  settleReservedIntentTurnStartFailure,
} from '@/services/intent/turnEngine'
import { getIntentTurnSession, projectIntentTurnExecution } from '@/services/intent/turnSession'
import {
  addIntentMount,
  createIntentSessionAndReserveTurn,
  decideIntentMountSuggestions,
  getIntentSessionForActor,
  insertUserTurnAndReserve,
  listIntentProvenanceForActor,
  listIntentSessionsForActor,
  listIntentTurns,
  rebaseIntentSession,
  removeIntentMount,
  reserveIntentRetryTurn,
  sessionManifest,
  setIntentSessionStatus,
  type ReservedIntentTurn,
  type IntentSessionRow,
} from '@/services/intent/session'
import { safeJsonOrThrowInvalid } from '@/util/http'

const log = createLogger('intentRoutes')

/** Zod-validated JSON-record parse — routes never `as`-cast (RFC-054 W1-7). */
const JsonRecordSchema = z.record(z.string(), z.unknown())
function parseJsonRecord(text: string): Record<string, unknown> {
  return JsonRecordSchema.parse(JSON.parse(text))
}

function sessionSummary(
  row: IntentSessionRow & { currentDraftRevision?: number | null },
  opts: {
    includeOwner: boolean
    journey: IntentJourneySnapshot
    currentDraftRevision?: number | null
  },
): IntentSessionSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    contextRevision: row.contextRevision,
    turnSeq: row.turnSeq,
    commitSeq: row.commitSeq,
    inFlight: row.inFlightTurnId !== null,
    currentDraftRevision: opts.currentDraftRevision ?? row.currentDraftRevision ?? null,
    journey: opts.journey,
    ...(opts.includeOwner ? { ownerUserId: row.ownerUserId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

const IntentListCursorSchema = z
  .object({ updatedAt: z.number().int().min(0), id: z.string().min(1).max(128) })
  .strict()

function decodeIntentListCursor(raw: string): { updatedAt: number; id: string } {
  if (raw.length > 512) {
    throw new ValidationError('intent-invalid', 'invalid intent list cursor')
  }
  try {
    const parsed = IntentListCursorSchema.safeParse(
      JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')),
    )
    if (parsed.success) return parsed.data
  } catch {
    // Same public shape for malformed base64 and malformed JSON.
  }
  throw new ValidationError('intent-invalid', 'invalid intent list cursor')
}

function encodeIntentListCursor(row: { updatedAt: number; id: string }): string {
  return Buffer.from(JSON.stringify(row), 'utf8').toString('base64url')
}

export function mountIntentSessionRoutes(app: Hono, deps: AppDeps): void {
  const appHome = Paths.root

  async function fireTurn(
    sessionId: string,
    actor: Actor,
    configSnapshot: ReturnType<typeof loadConfig>,
    reservation: ReservedIntentTurn,
  ): Promise<void> {
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
      const config = await resolveIntentTurnConfig(deps.db, configSnapshot)
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
          ...(deps.intentTestDependencies?.runFn === undefined
            ? {}
            : { runFn: deps.intentTestDependencies.runFn }),
        },
        { sessionId, actor, reservation },
      )
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      const settled = settleReservedIntentTurnStartFailure(deps.db, {
        sessionId,
        actor,
        reservation,
        detail,
      })
      log.warn('intent-turn-fire-failed', {
        sessionId,
        err: detail,
        settled,
      })
      if (settled) {
        intentSessionsBroadcaster.broadcast(INTENT_SESSIONS_CHANNEL, {
          type: 'intent.turn.finished',
          sessionId,
          turnId: reservation.turnId,
          ownerUserId: actor.user.id,
        })
      }
    } finally {
      if (executionTimer !== undefined) clearTimeout(executionTimer)
      flushExecution()
    }
  }

  function loadIntentTurnConfigSnapshot(): ReturnType<typeof loadConfig> {
    return loadConfig(deps.configPath)
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
      const parsed = CreateIntentSessionSchema.safeParse(
        await safeJsonOrThrowInvalid(c.req.raw, 'request body must be JSON'),
      )
      if (!parsed.success) {
        throw new ValidationError('intent-invalid', 'invalid intent session payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const config = loadIntentTurnConfigSnapshot()
      const { session, reservation } = await createIntentSessionAndReserveTurn(
        deps.db,
        actor,
        parsed.data,
      )
      void fireTurn(session.id, actor, config, reservation)
      return c.json(
        sessionSummary(session, {
          includeOwner: false,
          journey: projectIntentJourney({
            status: session.status,
            contextRevision: session.contextRevision,
            commitSeq: session.commitSeq,
            inFlight: true,
            latestAgentTurnKind: 'running',
            currentDraft: null,
          }),
        }),
        201,
      )
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
      const includeOwner = all && canAuditIntentSessions(actor)
      const paged = c.req.query('page') === '1'
      const limitRaw = c.req.query('limit')
      const limit = limitRaw === undefined || limitRaw === '' ? 12 : Number.parseInt(limitRaw, 10)
      if (paged && (!/^\d+$/.test(limitRaw ?? '12') || limit < 1 || limit > 50)) {
        throw new ValidationError('intent-invalid', 'intent list limit must be between 1 and 50')
      }
      // Pagination is additive. Legacy array callers keep their old semantics
      // even if an unrelated client already used a `cursor` query key.
      const cursorRaw = paged ? c.req.query('cursor') : undefined
      const before = cursorRaw === undefined ? undefined : decodeIntentListCursor(cursorRaw)
      const rows = await listIntentSessionsForActor(deps.db, actor, {
        ...(status === undefined ? {} : { status }),
        all,
        ...(before === undefined ? {} : { before }),
        ...(paged ? { limit: limit + 1 } : {}),
      })
      const hasMore = paged && rows.length > limit
      const visibleRows = hasMore ? rows.slice(0, limit) : rows
      const items = visibleRows.map((row) =>
        sessionSummary(row, {
          includeOwner,
          journey: projectIntentJourney({
            status: row.status,
            contextRevision: row.contextRevision,
            commitSeq: row.commitSeq,
            inFlight: row.inFlightTurnId !== null,
            ...(row.latestAgentTurnKind === null
              ? {}
              : { latestAgentTurnKind: row.latestAgentTurnKind }),
            currentDraft:
              row.currentDraftId === null || row.currentDraftContextRevision === null
                ? null
                : {
                    id: row.currentDraftId,
                    contextRevision: row.currentDraftContextRevision,
                    validationErrors: row.currentDraftValidationErrors,
                  },
            ...(row.latestCommit === null ? {} : { latestCommit: row.latestCommit }),
          }),
        }),
      )
      if (!paged) return c.json(items)
      const last = visibleRows.at(-1)
      return c.json({
        items,
        nextCursor:
          hasMore && last !== undefined
            ? encodeIntentListCursor({ updatedAt: last.updatedAt, id: last.id })
            : null,
      })
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
        scratchRetained: t.scratchRetained,
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
      )
        .map((row) => ({
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
        .sort((a, b) => b.createdAt - a.createdAt || b.journalId.localeCompare(a.journalId))
      const visibleResources = await listVisibleIntentResources(deps.db, actor)
      const visibleByKey = new Map(
        visibleResources.map((resource) => [
          `${resource.resourceType}:${resource.resourceId}`,
          resource,
        ]),
      )
      const mounts = sessionManifest(session)
        .filter((entry) => entry.root)
        .map((entry) => ({
          handle: entry.handle,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          displayName: visibleByKey.get(`${entry.resourceType}:${entry.resourceId}`)?.name ?? null,
          detail: entry.detail,
        }))
      const latestAgentTurn = [...turnDtos].reverse().find((turn) => turn.role === 'agent')
      const hasLaterApproval =
        latestAgentTurn === undefined
          ? false
          : turnDtos.some(
              (turn) => turn.kind === 'mount-approval' && turn.seq > latestAgentTurn.seq,
            )
      let mountSuggestions: IntentSessionDetail['mountSuggestions'] = null
      if (
        latestAgentTurn !== undefined &&
        (latestAgentTurn.kind === 'questions' || latestAgentTurn.kind === 'changeset') &&
        latestAgentTurn.contextRevision === session.contextRevision &&
        !hasLaterApproval
      ) {
        const parsedRequests = IntentMountRequestsSchema.safeParse(
          latestAgentTurn.content.mountRequests,
        )
        if (parsedRequests.success) {
          const mountedKeys = new Set(
            mounts.map((mount) => `${mount.resourceType}:${mount.resourceId}`),
          )
          const seen = new Set<string>()
          const items = parsedRequests.data.flatMap((request) => {
            const key = `${request.resourceType}\u0000${request.name}`
            if (seen.has(key)) return []
            seen.add(key)
            return [
              {
                resourceType: request.resourceType,
                name: request.name,
                reason: request.reason ?? null,
                candidates: visibleResources
                  .filter(
                    (resource) =>
                      resource.resourceType === request.resourceType &&
                      resource.name === request.name &&
                      !mountedKeys.has(`${resource.resourceType}:${resource.resourceId}`),
                  )
                  .map((resource) => ({
                    resourceId: resource.resourceId,
                    name: resource.name,
                    description: resource.description,
                  })),
              },
            ]
          })
          if (items.length > 0) {
            mountSuggestions = {
              sourceTurnId: latestAgentTurn.id,
              sourceTurnSeq: latestAgentTurn.seq,
              contextRevision: session.contextRevision,
              items,
            }
          }
        }
      }
      const journey = projectIntentJourney({
        status: session.status,
        contextRevision: session.contextRevision,
        commitSeq: session.commitSeq,
        inFlight: session.inFlightTurnId !== null,
        ...(latestAgentTurn === undefined ? {} : { latestAgentTurnKind: latestAgentTurn.kind }),
        currentDraft:
          currentDraft === null
            ? null
            : {
                id: currentDraft.id,
                contextRevision: currentDraft.contextRevision,
                validationErrors: currentDraft.validation.errors,
              },
        ...(commits[0] === undefined
          ? {}
          : { latestCommit: { draftId: commits[0].draftId, state: commits[0].state } }),
      })
      const detail: IntentSessionDetail = {
        session: {
          ...sessionSummary(session, {
            includeOwner: session.ownerUserId !== actor.user.id,
            journey,
            currentDraftRevision: currentDraft?.revision ?? null,
          }),
        },
        mounts,
        mountSuggestions,
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
      const parsed = PostIntentMessageSchema.safeParse(
        await safeJsonOrThrowInvalid(c.req.raw, 'request body must be JSON'),
      )
      if (!parsed.success) {
        throw new ValidationError('intent-invalid', 'invalid message payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const sessionId = c.req.param('id')
      const config = loadIntentTurnConfigSnapshot()
      const { turnId, reservation } = await insertUserTurnAndReserve(
        deps.db,
        actor,
        sessionId,
        'message',
        { message: parsed.data.message },
        config.intentBuilderMaxGenerateRounds ?? 50,
      )
      void fireTurn(sessionId, actor, config, reservation)
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
      const parsed = PostIntentAnswersSchema.safeParse(
        await safeJsonOrThrowInvalid(c.req.raw, 'request body must be JSON'),
      )
      if (!parsed.success) {
        throw new ValidationError('intent-invalid', 'invalid answers payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const sessionId = c.req.param('id')
      const config = loadIntentTurnConfigSnapshot()
      const { turnId, reservation } = await insertUserTurnAndReserve(
        deps.db,
        actor,
        sessionId,
        'answers',
        { answers: parsed.data.answers },
        config.intentBuilderMaxGenerateRounds ?? 50,
      )
      void fireTurn(sessionId, actor, config, reservation)
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
      const parsed = PostIntentMountApprovalsSchema.safeParse(
        await safeJsonOrThrowInvalid(c.req.raw, 'request body must be JSON'),
      )
      if (!parsed.success) {
        throw new ValidationError('intent-invalid', 'invalid mount approvals payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const sessionId = c.req.param('id')
      const receipt = await decideIntentMountSuggestions(deps.db, actor, sessionId, parsed.data)
      emitSessionUpdated(sessionId, actor.user.id)
      return c.json(receipt)
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
      const parsed = IntentMountRefSchema.safeParse(
        await safeJsonOrThrowInvalid(c.req.raw, 'request body must be JSON'),
      )
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
      const config = loadIntentTurnConfigSnapshot()
      const reservation = await reserveIntentRetryTurn(
        deps.db,
        actor,
        session.id,
        config.intentBuilderMaxGenerateRounds ?? 50,
      )
      void fireTurn(session.id, actor, config, reservation)
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
      const aborted = cancelIntentTurn(deps.db, actor, session.id)
      if (aborted) emitSessionUpdated(session.id, actor.user.id)
      return c.json({ aborted })
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
      const parsed = CommitIntentSchema.safeParse(
        await safeJsonOrThrowInvalid(c.req.raw, 'request body must be JSON'),
      )
      if (!parsed.success) {
        throw new ValidationError('intent-invalid', 'invalid commit payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const receipt = await applyIntentChangeset(
        {
          db: deps.db,
          appHome,
          actor,
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
