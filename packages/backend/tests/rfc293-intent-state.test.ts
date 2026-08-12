import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { CreateAgentSchema, DEFAULT_CONFIG } from '@agent-workflow/shared'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { resumeQueuedIntentWorkingSets } from '../src/services/intent/dispatcher'
import {
  intentDraftResolutions,
  intentDrafts,
  intentSessions,
  intentTurns,
  intentWorkingSetChanges,
} from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import {
  reserveExactIntentRetry,
  reserveIntentCurrentAction,
  reserveIntentIteration,
} from '../src/services/intent/iteration'
import {
  createIntentSession,
  insertUserTurnAndReserve,
  sessionManifest,
} from '../src/services/intent/session'
import { cancelIntentTurn, INTENT_BUILDER_SYSTEM_PROMPT } from '../src/services/intent/turnEngine'
import {
  activateIntentWorkingSetChange,
  retryIntentWorkingSetChange,
  submitIntentWorkingSetChange,
} from '../src/services/intent/workingSet'
import { createUser } from '../src/services/users'
import { seedBuiltinRuntimes } from '../src/services/runtimeRegistry'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '../src/services/systemAgentRun'
import { emptySystemAgentOutputEvidence } from '../src/services/systemAgentRun'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

let db: DbClient
let actor: Actor

test('intent builder keeps the ordinary runtime tool surface', () => {
  expect(INTENT_BUILDER_SYSTEM_PROMPT).toContain('ordinary runtime tools')
  expect(INTENT_BUILDER_SYSTEM_PROMPT).not.toContain('NO shell')
  expect(INTENT_BUILDER_SYSTEM_PROMPT).not.toContain('NO network')
  expect(INTENT_BUILDER_SYSTEM_PROMPT).not.toContain('NO write access')
})

beforeEach(async () => {
  db = createInMemoryDb(MIGRATIONS)
  await seedBuiltinRuntimes(db)
  const owner = await createUser(db, {
    username: `owner-${ulid().toLowerCase()}`,
    displayName: 'Owner',
    role: 'user',
    password: 'longEnoughPassword',
  })
  actor = buildActor({
    user: {
      id: owner.id,
      username: owner.username,
      displayName: owner.displayName,
      role: owner.role,
      status: owner.status,
    },
    source: 'session',
  })
})

async function createBareSession(message = 'build it') {
  return (await createIntentSession(db, actor, { message })).session
}

function seedFakeRoot(sessionId: string): void {
  db.update(intentSessions)
    .set({
      contextManifestJson: JSON.stringify([
        {
          handle: 'res#agent#1',
          resourceType: 'agent',
          resourceId: 'legacy-resource',
          root: true,
          detail: false,
        },
      ]),
      handleWatermarkJson: JSON.stringify({ agent: 1 }),
    })
    .where(eq(intentSessions.id, sessionId))
    .run()
}

function insertDraft(sessionId: string) {
  const id = ulid()
  const hash = `sha256:${'a'.repeat(64)}`
  db.insert(intentDrafts)
    .values({
      id,
      sessionId,
      revision: 1,
      changesetJson: JSON.stringify({ $schema_version: 1, ops: [] }),
      validationJson: JSON.stringify({ errors: [], credentialFindings: [] }),
      draftHash: hash,
      contextRevision: 0,
      createdAt: Date.now(),
    })
    .run()
  db.update(intentSessions)
    .set({ currentDraftId: id })
    .where(eq(intentSessions.id, sessionId))
    .run()
  return { id, hash }
}

describe('RFC-293 Intent working state', () => {
  test('idle working-context save applies once and reserves its automatic successor', async () => {
    const session = await createBareSession()
    seedFakeRoot(session.id)
    const input = {
      clientMutationId: ulid(),
      expectedTurnSeq: 1,
      expectedContextRevision: 0,
      mode: 'after-current' as const,
      delta: { additions: [], removals: ['res#agent#1'] },
    }

    const submitted = submitIntentWorkingSetChange(db, actor, session.id, input, 50)
    expect(submitted.change.state).toBe('applied')
    if (submitted.reservation === null) throw new Error('automatic successor was not reserved')
    const fresh = db.select().from(intentSessions).where(eq(intentSessions.id, session.id)).get()!
    expect(fresh.contextRevision).toBe(1)
    expect([submitted.change.resultingTurnId, fresh.inFlightTurnId]).toEqual([
      submitted.reservation.turnId,
      submitted.reservation.turnId,
    ])
    expect(sessionManifest(fresh)[0]?.root).toBe(false)
    expect(
      db
        .select()
        .from(intentTurns)
        .where(eq(intentTurns.sessionId, session.id))
        .all()
        .map((t) => t.kind),
    ).toEqual(['message', 'message', 'running'])

    const replay = submitIntentWorkingSetChange(db, actor, session.id, input, 50)
    expect(replay.change.id).toBe(submitted.change.id)
    expect(replay.reservation).toBeNull()
  })

  test('running save queues, cancel drains exactly one successor, and a failed delta is replaceable', async () => {
    const session = await createBareSession()
    seedFakeRoot(session.id)
    await insertUserTurnAndReserve(db, actor, session.id, 'message', { message: 'running' }, 50)
    const running = db.select().from(intentSessions).where(eq(intentSessions.id, session.id)).get()!
    const queued = submitIntentWorkingSetChange(
      db,
      actor,
      session.id,
      {
        clientMutationId: ulid(),
        expectedTurnSeq: running.turnSeq,
        expectedContextRevision: running.contextRevision,
        mode: 'after-current',
        delta: { additions: [], removals: ['res#agent#1'] },
      },
      50,
    )
    expect(queued.change.state).toBe('queued')
    expect(queued.reservation).toBeNull()
    expect(cancelIntentTurn(db, actor, session.id)).toBe(true)
    const drained = activateIntentWorkingSetChange(db, actor, session.id, 50)
    expect(drained.reservation).not.toBeNull()
    expect(activateIntentWorkingSetChange(db, actor, session.id, 50).reservation).toBeNull()

    const failedSession = await createBareSession('fail and replace')
    const failed = submitIntentWorkingSetChange(
      db,
      actor,
      failedSession.id,
      {
        clientMutationId: ulid(),
        expectedTurnSeq: 1,
        expectedContextRevision: 0,
        mode: 'after-current',
        delta: { additions: [], removals: ['res#agent#404'] },
      },
      50,
    )
    expect(failed.change.state).toBe('failed')
    expect(
      retryIntentWorkingSetChange(db, actor, failedSession.id, failed.change.id, 50).change?.state,
    ).toBe('failed')
    seedFakeRoot(failedSession.id)
    const replacement = submitIntentWorkingSetChange(
      db,
      actor,
      failedSession.id,
      {
        clientMutationId: ulid(),
        expectedTurnSeq: 1,
        expectedContextRevision: 0,
        mode: 'after-current',
        replacesChangeId: failed.change.id,
        delta: { additions: [], removals: ['res#agent#1'] },
      },
      50,
    )
    expect(replacement.change.state).toBe('applied')
    expect(
      db
        .select()
        .from(intentWorkingSetChanges)
        .where(eq(intentWorkingSetChanges.id, failed.change.id))
        .get()?.state,
    ).toBe('canceled')
  })

  test('refine keeps the source current; discard is permanent across failure retry', async () => {
    const session = await createBareSession()
    const draft = insertDraft(session.id)
    const refined = reserveIntentIteration(
      db,
      actor,
      session.id,
      {
        mode: 'refine-current',
        clientMutationId: ulid(),
        expectedTurnSeq: 1,
        expectedContextRevision: 0,
        sourceDraftId: draft.id,
        sourceDraftHash: draft.hash,
        feedback: 'make it simpler',
      },
      50,
    )
    expect(refined.reservation).not.toBeNull()
    expect(
      db.select().from(intentSessions).where(eq(intentSessions.id, session.id)).get()
        ?.currentDraftId,
    ).toBe(draft.id)
    expect(cancelIntentTurn(db, actor, session.id)).toBe(true)

    const afterRefine = db
      .select()
      .from(intentSessions)
      .where(eq(intentSessions.id, session.id))
      .get()!
    const regenerated = reserveIntentIteration(
      db,
      actor,
      session.id,
      {
        mode: 'regenerate',
        clientMutationId: ulid(),
        expectedTurnSeq: afterRefine.turnSeq,
        expectedContextRevision: 0,
        sourceDraftId: draft.id,
        sourceDraftHash: draft.hash,
      },
      50,
    )
    expect(regenerated.reservation).not.toBeNull()
    expect(
      db.select().from(intentSessions).where(eq(intentSessions.id, session.id)).get()
        ?.currentDraftId,
    ).toBeNull()
    expect(
      db
        .select()
        .from(intentDraftResolutions)
        .where(eq(intentDraftResolutions.draftId, draft.id))
        .get()?.reason,
    ).toBe('discarded')
    expect(cancelIntentTurn(db, actor, session.id)).toBe(true)
    const failedTurn = db
      .select()
      .from(intentTurns)
      .where(eq(intentTurns.id, regenerated.receipt.agentTurnId))
      .get()!
    const retried = reserveExactIntentRetry(
      db,
      actor,
      session.id,
      {
        clientMutationId: ulid(),
        sourceTurnId: failedTurn.id,
        expectedTurnSeq: failedTurn.seq,
        expectedContextRevision: 0,
      },
      50,
    )
    expect(retried.reservation).not.toBeNull()
    expect(
      db.select().from(intentSessions).where(eq(intentSessions.id, session.id)).get()
        ?.currentDraftId,
    ).toBeNull()
    expect(
      db
        .select()
        .from(intentDraftResolutions)
        .where(eq(intentDraftResolutions.draftId, draft.id))
        .get()?.reason,
    ).toBe('discarded')
  })

  test('continues from a committed checkpoint with no current candidate', async () => {
    const session = await createBareSession()
    db.update(intentSessions).set({ commitSeq: 3 }).where(eq(intentSessions.id, session.id)).run()
    const continued = reserveIntentIteration(
      db,
      actor,
      session.id,
      {
        mode: 'continue-checkpoint',
        clientMutationId: ulid(),
        expectedTurnSeq: 1,
        expectedContextRevision: 0,
        sourceCommitSeq: 3,
        feedback: 'add a review workflow',
      },
      50,
    )
    expect(continued.reservation).not.toBeNull()
    expect(continued.receipt.replayed).toBe(false)
  })

  test('questions and resource suggestions submit as one action and one successor', async () => {
    const session = await createBareSession()
    const agent = await createAgent(
      db,
      CreateAgentSchema.parse({ name: 'auditor', description: 'Audits changes' }),
      { ownerUserId: actor.user.id, actor },
    )
    const sourceTurnId = ulid()
    db.insert(intentTurns)
      .values({
        id: sourceTurnId,
        sessionId: session.id,
        seq: 2,
        role: 'agent',
        kind: 'questions',
        contentJson: JSON.stringify({
          questions: [
            { id: 'q1', question: 'Scope?', options: ['small', 'large'], multiSelect: false },
          ],
          mountRequests: [{ resourceType: 'agent', name: 'auditor', reason: 'reuse the reviewer' }],
        }),
        contextRevision: 0,
        createdAt: Date.now(),
      })
      .run()
    db.update(intentSessions).set({ turnSeq: 2 }).where(eq(intentSessions.id, session.id)).run()
    const input = {
      clientMutationId: ulid(),
      sourceTurnId,
      expectedTurnSeq: 2,
      expectedContextRevision: 0,
      answers: [{ id: 'q1', picked: ['small'] }],
      decisions: [
        {
          resourceType: 'agent' as const,
          name: 'auditor',
          action: 'approve' as const,
          resourceId: agent.id,
        },
      ],
    }
    const action = reserveIntentCurrentAction(db, actor, session.id, input, 50)
    expect(action.reservation).not.toBeNull()
    const fresh = db.select().from(intentSessions).where(eq(intentSessions.id, session.id)).get()!
    expect(fresh.turnSeq).toBe(4)
    expect(fresh.contextRevision).toBe(1)
    expect(
      sessionManifest(fresh)
        .filter((entry) => entry.root)
        .map((entry) => entry.resourceId),
    ).toEqual([agent.id])
    expect(
      db
        .select()
        .from(intentTurns)
        .where(eq(intentTurns.sessionId, session.id))
        .all()
        .map((turn) => turn.kind),
    ).toEqual(['message', 'questions', 'answers', 'running'])
    const replay = reserveIntentCurrentAction(db, actor, session.id, input, 50)
    expect(replay.receipt).toEqual({ ...action.receipt, replayed: true })
    expect(replay.reservation).toBeNull()
  })

  test('boot recovery resumes an idle queued working-context successor without a browser', async () => {
    const session = await createBareSession('resume after restart')
    seedFakeRoot(session.id)
    await insertUserTurnAndReserve(db, actor, session.id, 'message', { message: 'running' }, 50)
    const running = db.select().from(intentSessions).where(eq(intentSessions.id, session.id)).get()!
    const queued = submitIntentWorkingSetChange(
      db,
      actor,
      session.id,
      {
        clientMutationId: ulid(),
        expectedTurnSeq: running.turnSeq,
        expectedContextRevision: running.contextRevision,
        mode: 'after-current',
        delta: { additions: [], removals: ['res#agent#1'] },
      },
      50,
    )
    expect(queued.change.state).toBe('queued')
    expect(cancelIntentTurn(db, actor, session.id)).toBe(true)
    const runFn = async (opts: SystemAgentRunOptions): Promise<SystemAgentRunResult> => {
      const nonce = /nonce="([^"]+)"/.exec(opts.prompt)?.[1] ?? ''
      const changeset = JSON.stringify({
        $schema_version: 1,
        ops: [
          {
            opId: 'op-1',
            action: 'create',
            resourceType: 'agent',
            tempRef: '$new:resumed',
            payload: {
              name: 'resumed-agent',
              description: 'resumed',
              outputs: ['result'],
              bodyMd: 'Resume.',
            },
          },
        ],
      })
      return {
        status: 'ok',
        exitCode: 0,
        eventText:
          `<workflow-output nonce="${nonce}">` +
          '<port name="summary">resumed</port>' +
          `<port name="changeset">${changeset}</port>` +
          '</workflow-output>',
        stderrTail: '',
        durationMs: 1,
        scratchDir: '/tmp/rfc293-resumed',
        scratchRetained: false,
        outputEvidence: emptySystemAgentOutputEvidence(),
      }
    }
    expect(
      await resumeQueuedIntentWorkingSets({
        db,
        appHome: '/tmp',
        configSnapshot: DEFAULT_CONFIG,
        runFn,
      }),
    ).toBe(1)
    for (let i = 0; i < 100; i++) {
      const fresh = db.select().from(intentSessions).where(eq(intentSessions.id, session.id)).get()
      if (fresh?.inFlightTurnId === null) break
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    }
    const fresh = db.select().from(intentSessions).where(eq(intentSessions.id, session.id)).get()!
    expect(fresh.inFlightTurnId).toBeNull()
    expect(fresh.currentDraftId).not.toBeNull()
    expect(
      db
        .select()
        .from(intentWorkingSetChanges)
        .where(eq(intentWorkingSetChanges.id, queued.change.id))
        .get()?.state,
    ).toBe('applied')
  })
})
