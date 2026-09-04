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
  PostIntentAnswersSchema,
  PostIntentCurrentActionSchema,
  PostIntentIterationSchema,
  PostIntentRetrySchema,
  PostIntentWorkingSetChangeSchema,
  PostIntentMessageSchema,
  PostIntentMountApprovalsSchema,
  IntentMountRefSchema,
  IntentProvenanceRefSchema,
} from '@agent-workflow/shared'
import { z } from 'zod'
import { actorOf, type Actor } from '@/auth/actor'
import { registerRoute } from '@/routes/registry'
import { loadConfig } from '@/config'
import { NotFoundError, ValidationError } from '@/util/errors'
import { Paths } from '@/util/paths'
import { INTENT_SESSIONS_CHANNEL, intentSessionsBroadcaster } from '@/ws/broadcaster'
import type { IntentApplyOperations, IntentPersistence } from '@/modules/intent/public/operations'
import { canAuditIntentSessions } from '@/modules/intent/public/operations'
import {
  intentSessionListJourneyOf,
  intentSessionSummaryOf,
  newIntentSessionJourney,
} from '@/modules/intent/application/sessionSummary'
import { projectIntentSessionDetail } from '@/modules/intent/application/sessionDetail'
import { intentResourceVisibility } from '@/modules/intent/application/resourceCatalog'
import type { IntentResourceCatalogBinding } from '@/modules/intent/application/resourceCatalog'
import { cancelIntentTurn } from '@/modules/intent/application/turnEngine'
import {
  dispatchIntentTurn,
  type IntentDispatchDeps,
} from '@/modules/intent/application/dispatcher'
import { getIntentTurnSession } from '@/modules/intent/application/turnSession'
import {
  addIntentMount,
  createIntentSessionAndReserveTurn,
  decideIntentMountSuggestions,
  getIntentSessionForActor,
  insertUserTurnAndReserve,
  listIntentProvenanceForActor,
  listIntentSessionsForActor,
  rebaseIntentSession,
  removeIntentMount,
  setIntentSessionStatus,
  type ReservedIntentTurn,
} from '@/modules/intent/application/session'
import { safeJsonOrThrowInvalid } from '@/util/http'
import {
  reserveExactIntentRetry,
  reserveIntentCurrentAction,
  reserveIntentIteration,
} from '@/modules/intent/application/iteration'
import {
  activateIntentWorkingSetChange,
  cancelIntentWorkingSetChange,
  getLatestIntentWorkingSetChange,
  projectIntentWorkingSetChange,
  retryIntentWorkingSetChange,
  submitIntentWorkingSetChange,
} from '@/modules/intent/application/workingSet'
import type { DirectAuthorityBinding } from '@/modules/identity-access/public/participants'
import { directRequestAuthority } from '@/routes/operationAuthority'

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

export interface IntentSessionRouteDependencies {
  readonly configPath: string
  readonly identityAccess: IntentDispatchDeps['identityAccess']
  readonly directAuthority: DirectAuthorityBinding
  readonly intentApply: IntentApplyOperations
  readonly intentPersistence: IntentPersistence
  readonly intentTurnRuntime: Pick<IntentDispatchDeps, 'runtimeResolver' | 'dumpAuxiliary'>
  readonly resourceCatalogFor: (actor: Actor) => IntentResourceCatalogBinding
  /** Exact test seam; production composition leaves it absent. */
  readonly runTurn?: IntentDispatchDeps['runFn']
}

export function mountIntentSessionRoutes(app: Hono, deps: IntentSessionRouteDependencies): void {
  const appHome = Paths.root

  function fireTurn(
    sessionId: string,
    actor: Actor,
    configSnapshot: ReturnType<typeof loadConfig>,
    reservation: ReservedIntentTurn,
  ): Promise<void> {
    return dispatchIntentTurn(
      {
        persistence: deps.intentPersistence,
        identityAccess: deps.identityAccess,
        appHome,
        configSnapshot,
        ...deps.intentTurnRuntime,
        resourceCatalogFor: deps.resourceCatalogFor,
        ...(deps.runTurn === undefined ? {} : { runFn: deps.runTurn }),
      },
      sessionId,
      actor,
      reservation,
    )
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
        deps.intentPersistence,
        intentResourceVisibility(deps.resourceCatalogFor(actor)),
        actor,
        parsed.data,
      )
      void fireTurn(session.id, actor, config, reservation)
      return c.json(
        intentSessionSummaryOf(session, {
          includeOwner: false,
          journey: newIntentSessionJourney(session),
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
      const rows = await listIntentSessionsForActor(deps.intentPersistence, actor, {
        ...(status === undefined ? {} : { status }),
        all,
        ...(before === undefined ? {} : { before }),
        ...(paged ? { limit: limit + 1 } : {}),
      })
      const hasMore = paged && rows.length > limit
      const visibleRows = hasMore ? rows.slice(0, limit) : rows
      const items = visibleRows.map((row) =>
        intentSessionSummaryOf(row, { includeOwner, journey: intentSessionListJourneyOf(row) }),
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
      return c.json(
        await projectIntentSessionDetail(
          deps.intentPersistence,
          actor,
          c.req.param('id'),
          deps.resourceCatalogFor(actor),
        ),
      )
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
      const session = await getIntentSessionForActor(
        deps.intentPersistence,
        actor,
        c.req.param('id'),
      )
      return c.json(
        await getIntentTurnSession(deps.intentPersistence, session.id, c.req.param('turnId')),
      )
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
        deps.intentPersistence,
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
        deps.intentPersistence,
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
      path: '/api/intent-sessions/:id/iterations',
      permissions: ['intent:write'],
      tokenAccess: 'allow',
      summary: 'Refine, continue, or regenerate an Intent candidate',
    },
    async (c) => {
      const parsed = PostIntentIterationSchema.safeParse(
        await safeJsonOrThrowInvalid(c.req.raw, 'request body must be JSON'),
      )
      if (!parsed.success) {
        throw new ValidationError('intent-invalid', 'invalid iteration payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const sessionId = c.req.param('id')
      const config = loadIntentTurnConfigSnapshot()
      const generated = await reserveIntentIteration(
        deps.intentPersistence,
        actor,
        sessionId,
        parsed.data,
        config.intentBuilderMaxGenerateRounds ?? 50,
      )
      if (generated.reservation !== null) {
        void fireTurn(sessionId, actor, config, generated.reservation)
        emitSessionUpdated(sessionId, actor.user.id)
      }
      return c.json(generated.receipt, generated.receipt.replayed ? 200 : 202)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/intent-sessions/:id/current-action',
      permissions: ['intent:write'],
      tokenAccess: 'allow',
      summary: 'Answer questions and decide resource suggestions in one action',
    },
    async (c) => {
      const parsed = PostIntentCurrentActionSchema.safeParse(
        await safeJsonOrThrowInvalid(c.req.raw, 'request body must be JSON'),
      )
      if (!parsed.success) {
        throw new ValidationError('intent-invalid', 'invalid current-action payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const sessionId = c.req.param('id')
      const config = loadIntentTurnConfigSnapshot()
      const generated = await reserveIntentCurrentAction(
        deps.intentPersistence,
        intentResourceVisibility(deps.resourceCatalogFor(actor)),
        actor,
        sessionId,
        parsed.data,
        config.intentBuilderMaxGenerateRounds ?? 50,
      )
      if (generated.reservation !== null) {
        void fireTurn(sessionId, actor, config, generated.reservation)
        emitSessionUpdated(sessionId, actor.user.id)
      }
      return c.json(generated.receipt, generated.receipt.replayed ? 200 : 202)
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
      const receipt = await decideIntentMountSuggestions(
        deps.intentPersistence,
        intentResourceVisibility(deps.resourceCatalogFor(actor)),
        actor,
        sessionId,
        parsed.data,
      )
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
      const result = await addIntentMount(
        deps.intentPersistence,
        intentResourceVisibility(deps.resourceCatalogFor(actor)),
        actor,
        c.req.param('id'),
        parsed.data,
      )
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
        deps.intentPersistence,
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
      path: '/api/intent-sessions/:id/working-set',
      permissions: ['intent:write'],
      tokenAccess: 'allow',
      summary: 'Stage and refresh the Intent working context',
    },
    async (c) => {
      const parsed = PostIntentWorkingSetChangeSchema.safeParse(
        await safeJsonOrThrowInvalid(c.req.raw, 'request body must be JSON'),
      )
      if (!parsed.success) {
        throw new ValidationError('intent-invalid', 'invalid working-context payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const sessionId = c.req.param('id')
      const config = loadIntentTurnConfigSnapshot()
      const visibility = intentResourceVisibility(deps.resourceCatalogFor(actor))
      const submitted = await submitIntentWorkingSetChange(
        deps.intentPersistence,
        visibility,
        actor,
        sessionId,
        parsed.data,
        config.intentBuilderMaxGenerateRounds ?? 50,
      )
      if (submitted.shouldInterrupt) {
        await cancelIntentTurn(deps.intentPersistence, actor, sessionId)
        const next = await activateIntentWorkingSetChange(
          deps.intentPersistence,
          visibility,
          actor,
          sessionId,
          config.intentBuilderMaxGenerateRounds ?? 50,
          submitted.change.id,
        )
        if (next.reservation !== null) {
          void fireTurn(sessionId, actor, config, next.reservation)
        }
      } else if (submitted.reservation !== null) {
        void fireTurn(sessionId, actor, config, submitted.reservation)
      }
      emitSessionUpdated(sessionId, actor.user.id)
      const latest = await getLatestIntentWorkingSetChange(deps.intentPersistence, sessionId)
      return c.json(
        latest === null ? submitted.change : projectIntentWorkingSetChange(latest),
        submitted.reservation === null && !submitted.shouldInterrupt ? 202 : 201,
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/intent-sessions/:id/working-set/:changeId',
      permissions: ['intent:write'],
      tokenAccess: 'allow',
      summary: 'Dismiss a queued or failed Intent working-context update',
    },
    async (c) => {
      const actor = actorOf(c)
      const sessionId = c.req.param('id')
      const result = await cancelIntentWorkingSetChange(
        deps.intentPersistence,
        actor,
        sessionId,
        c.req.param('changeId'),
      )
      emitSessionUpdated(sessionId, actor.user.id)
      return c.json(result)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/intent-sessions/:id/working-set/:changeId/retry',
      permissions: ['intent:write'],
      tokenAccess: 'allow',
      summary: 'Retry a failed Intent working-context update',
    },
    async (c) => {
      const actor = actorOf(c)
      const sessionId = c.req.param('id')
      const config = loadIntentTurnConfigSnapshot()
      const result = await retryIntentWorkingSetChange(
        deps.intentPersistence,
        intentResourceVisibility(deps.resourceCatalogFor(actor)),
        actor,
        sessionId,
        c.req.param('changeId'),
        config.intentBuilderMaxGenerateRounds ?? 50,
      )
      if (result.reservation !== null) {
        void fireTurn(sessionId, actor, config, result.reservation)
      }
      emitSessionUpdated(sessionId, actor.user.id)
      return c.json(result.change, result.reservation === null ? 200 : 202)
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
      const result = await rebaseIntentSession(deps.intentPersistence, actor, c.req.param('id'))
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
      const session = await getIntentSessionForActor(
        deps.intentPersistence,
        actor,
        c.req.param('id'),
      )
      if (session.ownerUserId !== actor.user.id) {
        // Codex impl-gate P2-4: owner-only mutations keep the 404 shape — the
        // admin read bypass must not leak a distinguishable 422 here.
        throw new NotFoundError('intent-session-not-found', 'intent session not found')
      }
      const parsed = PostIntentRetrySchema.safeParse(
        await safeJsonOrThrowInvalid(c.req.raw, 'request body must be JSON'),
      )
      if (!parsed.success) {
        throw new ValidationError('intent-invalid', 'invalid retry payload', {
          issues: parsed.error.issues,
        })
      }
      const config = loadIntentTurnConfigSnapshot()
      const generated = await reserveExactIntentRetry(
        deps.intentPersistence,
        actor,
        session.id,
        parsed.data,
        config.intentBuilderMaxGenerateRounds ?? 50,
      )
      if (generated.reservation !== null) {
        void fireTurn(session.id, actor, config, generated.reservation)
        emitSessionUpdated(session.id, actor.user.id)
      }
      return c.json(generated.receipt, generated.receipt.replayed ? 200 : 202)
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
      const session = await getIntentSessionForActor(
        deps.intentPersistence,
        actor,
        c.req.param('id'),
      )
      if (session.ownerUserId !== actor.user.id) {
        // Admin READ bypass never cancels another user's turn — 404 shape (P2-4).
        throw new NotFoundError('intent-session-not-found', 'intent session not found')
      }
      const aborted = await cancelIntentTurn(deps.intentPersistence, actor, session.id)
      if (aborted) {
        const config = loadIntentTurnConfigSnapshot()
        const next = await activateIntentWorkingSetChange(
          deps.intentPersistence,
          intentResourceVisibility(deps.resourceCatalogFor(actor)),
          actor,
          session.id,
          config.intentBuilderMaxGenerateRounds ?? 50,
        )
        if (next.reservation !== null) {
          void fireTurn(session.id, actor, config, next.reservation)
        }
        emitSessionUpdated(session.id, actor.user.id)
      }
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
      const authority = directRequestAuthority(deps.directAuthority, actor)
      const receipt = await deps.intentApply.apply({
        actor,
        authority,
        command: {
          sessionId: c.req.param('id'),
          clientMutationId: parsed.data.clientMutationId,
          draftRevision: parsed.data.draftRevision,
          draftHash: parsed.data.draftHash,
          decisions: parsed.data.decisions,
        },
      })
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
      await setIntentSessionStatus(deps.intentPersistence, actor, c.req.param('id'), 'archived')
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
      await setIntentSessionStatus(deps.intentPersistence, actor, c.req.param('id'), 'active')
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
      const parsed = IntentProvenanceRefSchema.safeParse({
        resourceType: c.req.param('resourceType'),
        resourceId: c.req.param('resourceId'),
      })
      if (!parsed.success) {
        throw new ValidationError('intent-invalid', 'invalid provenance ref', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const rows = await listIntentProvenanceForActor(
        deps.intentPersistence,
        intentResourceVisibility(deps.resourceCatalogFor(actor)),
        actor,
        parsed.data,
      )
      return c.json(rows)
    },
  )
}
