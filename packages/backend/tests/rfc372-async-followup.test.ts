// RFC-372 review follow-up O8 (design/RFC-372-mindmap-clarify/review-followups-20261014.md §4.7).
//
// WHY THIS EXISTS: a follow-up used to hold its HTTP request open for the whole model
// run, so a page refresh lost "generating", collaborators never saw it, and failures
// existed only as that one response. The request is now accepted once its checks pass
// (202), the model runs in the background, and the round detail reports the running
// generation or its last failure (kept ten minutes, cleared by the next start).
import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import {
  ClarifyQuestionSchema,
  clarifyContentKey,
  clarifyFollowupContext,
  type ClarifyFollowup,
} from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { nodeRuns, tasks, workflows } from '@/db/schema'
import { mountClarifyRoutes } from '@/routes/clarify'
import { createClarifyRound } from '@/services/clarify/service'
import { errorHandler } from '@/util/errors'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'
import {
  CLARIFY_FOLLOWUP_FAILURE_TTL_MS,
  createClarifyFollowupOperations,
} from '@/modules/collaboration/application/clarifyFollowup'
import type {
  ClarifyFollowupEvents,
  ClarifyFollowupGenerator,
  ClarifyFollowupStore,
} from '@/modules/collaboration/application/ports/clarifyFollowup'
import { composeCollaborationRouteOperations } from '@/modules/collaboration/composition/collaborationRouteOperations'
import {
  assertClarifyFollowupIdle,
  clarifyFollowupActivity,
} from '@/modules/collaboration/infrastructure/clarifyFollowupActivity'
import { clarifyFollowupEvents } from '@/modules/collaboration/infrastructure/collaborationClarifyDraftEventPublisher'
import { createClarifyFollowupStore } from '@/modules/collaboration/infrastructure/clarifyFollowupStore'
import type { CollaborationRouteOperations } from '@/modules/collaboration/public/participants'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const editor = { userId: 'fixture', displayName: 'Reviewer', role: 'owner' as const }
const generated =
  '<workflow-clarify>' +
  JSON.stringify({
    questions: [
      ClarifyQuestionSchema.parse({
        id: 'new',
        title: 'Question new',
        kind: 'single',
        options: ['A', 'B'],
        mindmap: { categoryPath: ['Scope'] },
      }),
    ],
  }) +
  '</workflow-clarify>'

async function seed(h: ProviderHarness) {
  const taskId = randomUUID(),
    workflowId = randomUUID(),
    askingNodeRunId = randomUUID()
  const definition = {
    $schema_version: 7,
    inputs: [],
    nodes: [
      { id: 'asking', kind: 'agent-single', agentName: 'asking' },
      {
        id: 'gate',
        kind: 'clarify',
        interactionMode: 'mindmap',
        mindmap: { categories: ['Scope'], instructions: '' },
      },
    ],
    edges: [],
    outputs: [],
  }
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'async-followup',
    definition: JSON.stringify(definition),
    schemaVersion: 7,
  })
  await h.db.insert(tasks).values({
    id: taskId,
    name: 'async-followup',
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/rfc372-async-followup',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'fixture',
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  await h.db
    .insert(nodeRuns)
    .values({ id: askingNodeRunId, taskId, nodeId: 'asking', status: 'done', iteration: 0 })
  const round = await createClarifyRound({
    db: h.db,
    taskId,
    askingNodeId: 'asking',
    askingNodeRunId,
    intermediaryNodeId: 'gate',
    kind: 'self',
    askingShardKey: null,
    iteration: 0,
    questions: [
      ClarifyQuestionSchema.parse({
        id: 'a',
        title: 'Question a',
        kind: 'single',
        options: ['A', 'B'],
        mindmap: { categoryPath: ['Scope'] },
      }),
    ],
  })
  const store = createClarifyFollowupStore(h.db, { publish: async () => {} })
  const request = async (basis?: string): Promise<ClarifyFollowup> => {
    const snapshot = await store.read(round.intermediaryNodeRunId, 'a')
    return {
      requestId: randomUUID(),
      parentQuestionId: 'a',
      instruction: '',
      basis:
        basis ??
        clarifyContentKey(clarifyFollowupContext(snapshot.questions, snapshot.drafts, 'a')),
    }
  }
  return { taskId, nodeRunId: round.intermediaryNodeRunId, store, request }
}

/** A model run the test finishes, fails or sees aborted. */
function controlledGenerator() {
  const runs: { finish(text: string): void; fail(error: unknown): void }[] = []
  const generator: ClarifyFollowupGenerator = {
    generate: ({ signal }) =>
      new Promise<string>((finish, fail) => {
        runs.push({ finish, fail })
        signal.addEventListener('abort', () => fail(new Error('native process killed')))
      }),
  }
  return { generator, runs }
}

function operations(store: ClarifyFollowupStore, generator: ClarifyFollowupGenerator) {
  let clock = 1_000_000
  const changes: string[] = []
  const events: ClarifyFollowupEvents = { changed: (input) => changes.push(input.nodeRunId) }
  const followup = createClarifyFollowupOperations(store, generator, clarifyFollowupActivity, {
    events,
    now: () => clock,
  })
  return {
    followup,
    changes,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describeEachProvider('RFC-372 O8: follow-ups generate in the background', (h) => {
  test('an accepted request answers running and the round reports it until the questions land', async () => {
    const fixture = await seed(h)
    const model = controlledGenerator()
    const { followup, changes } = operations(fixture.store, model.generator)
    const request = await fixture.request()

    expect(await followup.start(fixture.nodeRunId, request, editor)).toEqual({ state: 'running' })
    // An identical retry joins the same generation instead of conflicting.
    expect(await followup.start(fixture.nodeRunId, request, editor)).toEqual({ state: 'running' })
    const settled = followup.append(fixture.nodeRunId, request, editor)
    expect(model.runs).toHaveLength(1)
    expect(followup.status(fixture.nodeRunId)).toEqual({
      requestId: request.requestId,
      state: 'running',
      target: 'a',
      startedAt: 1_000_000,
    })
    expect(changes).toEqual([fixture.nodeRunId])
    expect(() => assertClarifyFollowupIdle(fixture.nodeRunId)).toThrow(
      'follow-up is being generated',
    )

    model.runs[0]!.finish(generated)
    expect(await settled).toEqual({ questionIds: [`fq-${request.requestId}-0`] })
    expect(followup.status(fixture.nodeRunId)).toBeUndefined()
    expect(changes).toEqual([fixture.nodeRunId, fixture.nodeRunId])
    const round = await fixture.store.read(fixture.nodeRunId, 'a')
    expect(round.questions.map((q) => q.id)).toEqual(['a', `fq-${request.requestId}-0`])
  })

  test('a request already applied answers done without generating again', async () => {
    const fixture = await seed(h)
    const model = controlledGenerator()
    const { followup } = operations(fixture.store, model.generator)
    const request = await fixture.request()
    await followup.start(fixture.nodeRunId, request, editor)
    const settled = followup.append(fixture.nodeRunId, request, editor)
    model.runs[0]!.finish(generated)
    await settled

    expect(await followup.start(fixture.nodeRunId, request, editor)).toEqual({
      state: 'done',
      questionIds: [`fq-${request.requestId}-0`],
    })
    expect(model.runs).toHaveLength(1)
  })

  test('failed checks still reject the request itself and leave no failure behind', async () => {
    const fixture = await seed(h)
    const model = controlledGenerator()
    const { followup, changes } = operations(fixture.store, model.generator)
    const stale = await fixture.request('v2:outdated')

    await expect(followup.start(fixture.nodeRunId, stale, editor)).rejects.toMatchObject({
      code: 'clarify-followup-stale',
      status: 409,
    })
    expect(model.runs).toHaveLength(0)
    expect(followup.status(fixture.nodeRunId)).toBeUndefined()
    expect(clarifyFollowupActivity.current(fixture.nodeRunId)).toBeUndefined()
    expect(changes).toEqual([])
  })

  test('a failed generation stays visible for ten minutes or until the next one starts', async () => {
    const fixture = await seed(h)
    const model = controlledGenerator()
    const { followup, changes, advance } = operations(fixture.store, model.generator)
    const first = await fixture.request()
    await followup.start(fixture.nodeRunId, first, editor)
    const failed = followup.append(fixture.nodeRunId, first, editor)
    advance(5_000)
    model.runs[0]!.finish('no envelope')
    await expect(failed).rejects.toMatchObject({ code: 'clarify-followup-invalid' })

    const failure = {
      requestId: first.requestId,
      state: 'failed' as const,
      target: 'a',
      startedAt: 1_000_000,
      error: {
        code: 'clarify-followup-invalid',
        message: 'Expected 1–4 valid classified questions.',
      },
    }
    expect(followup.status(fixture.nodeRunId)).toEqual(failure)
    expect(changes).toHaveLength(2)
    // The round is free again and nothing was appended.
    expect(clarifyFollowupActivity.current(fixture.nodeRunId)).toBeUndefined()
    expect((await fixture.store.read(fixture.nodeRunId, 'a')).questions).toHaveLength(1)
    advance(CLARIFY_FOLLOWUP_FAILURE_TTL_MS - 1)
    expect(followup.status(fixture.nodeRunId)).toEqual(failure)

    const second = await fixture.request()
    await followup.start(fixture.nodeRunId, second, editor)
    expect(followup.status(fixture.nodeRunId)).toMatchObject({
      requestId: second.requestId,
      state: 'running',
    })
    const failedAgain = followup.append(fixture.nodeRunId, second, editor)
    model.runs[1]!.finish('still no envelope')
    await expect(failedAgain).rejects.toMatchObject({ code: 'clarify-followup-invalid' })
    expect(followup.status(fixture.nodeRunId)).toMatchObject({ requestId: second.requestId })
    advance(CLARIFY_FOLLOWUP_FAILURE_TTL_MS)
    expect(followup.status(fixture.nodeRunId)).toBeUndefined()
  })

  test('canceling stops reporting the generation and records it as canceled once settled', async () => {
    const fixture = await seed(h)
    const model = controlledGenerator()
    const { followup } = operations(fixture.store, model.generator)
    const request = await fixture.request()
    await followup.start(fixture.nodeRunId, request, editor)
    const settled = followup.append(fixture.nodeRunId, request, editor)

    await followup.cancel(fixture.nodeRunId, request.requestId)
    expect(followup.status(fixture.nodeRunId)?.state).not.toBe('running')
    // A canceled generation no longer blocks submitting the round.
    expect(() => assertClarifyFollowupIdle(fixture.nodeRunId)).not.toThrow()
    await expect(settled).rejects.toMatchObject({ code: 'clarify-followup-canceled' })
    expect(followup.status(fixture.nodeRunId)).toMatchObject({
      requestId: request.requestId,
      state: 'failed',
      error: { code: 'clarify-followup-canceled' },
    })
    // The canceled request ID stays canceled; a retry needs a new one.
    await expect(followup.start(fixture.nodeRunId, request, editor)).rejects.toMatchObject({
      code: 'clarify-followup-canceled',
    })
  })

  test('an unexpected generator error is reported the way the HTTP layer answers it', async () => {
    const fixture = await seed(h)
    const model = controlledGenerator()
    const { followup } = operations(fixture.store, model.generator)
    const request = await fixture.request()
    await followup.start(fixture.nodeRunId, request, editor)
    const settled = followup.append(fixture.nodeRunId, request, editor)
    model.runs[0]!.fail(new Error('runtime exited with code 1 at /private/path'))
    await expect(settled).rejects.toThrow('runtime exited')
    expect(followup.status(fixture.nodeRunId)?.error).toEqual({
      code: 'internal-error',
      message: 'internal server error',
    })
  })

  test('the round detail carries the follow-up state and the task channel announces it', async () => {
    const fixture = await seed(h)
    const model = controlledGenerator()
    const composed = composeCollaborationRouteOperations({
      db: h.db,
      context: {} as never,
      followupGenerator: model.generator,
    })
    const frames: unknown[] = []
    const unsubscribe = taskBroadcaster.subscribe(TASK_CHANNEL(fixture.taskId), (frame) =>
      frames.push(frame),
    )
    try {
      expect((await composed.clarify.detail(fixture.nodeRunId)).followup).toBeUndefined()
      const request = await fixture.request()
      await composed.clarify.followup!.start(fixture.nodeRunId, request, editor)
      const settled = composed.clarify.followup!.append(fixture.nodeRunId, request, editor)
      expect((await composed.clarify.detail(fixture.nodeRunId)).followup).toMatchObject({
        requestId: request.requestId,
        state: 'running',
        target: 'a',
      })
      expect(frames).toEqual([
        expect.objectContaining({
          id: -1,
          type: 'clarify.followup.updated',
          nodeRunId: fixture.nodeRunId,
        }),
      ])
      model.runs[0]!.finish(generated)
      await settled
      const detail = await composed.clarify.detail(fixture.nodeRunId)
      expect(detail.followup).toBeUndefined()
      expect(detail.questions.map((q) => q.id)).toContain(`fq-${request.requestId}-0`)
      expect(
        frames.filter((frame) => (frame as { type: string }).type === 'clarify.followup.updated'),
      ).toHaveLength(2)
    } finally {
      unsubscribe()
    }
  })
})

describe('RFC-372 O8: follow-up route and events', () => {
  test('the route answers 202 while generating and 200 for an applied request', async () => {
    const app = new Hono()
    const actor = buildActor({
      user: {
        id: 'reviewer',
        username: 'reviewer',
        displayName: 'Reviewer',
        role: 'admin',
        status: 'active',
      },
      source: 'session',
    })
    app.use('*', async (c: Context, next) => {
      c.set('actor', actor)
      await next()
    })
    app.onError(errorHandler)
    const answers = [{ state: 'running' as const }, { state: 'done' as const, questionIds: ['x'] }]
    mountClarifyRoutes(app, {
      clarify: { followup: { start: async () => answers.shift()! } },
      access: {
        resolveClarifyTask: async () => ({
          roundExists: true,
          nodeRunExists: true,
          taskId: 'task',
          task: {},
          actorRole: 'owner',
          visible: true,
        }),
      },
    } as unknown as CollaborationRouteOperations)
    const post = () =>
      app.request('/api/clarify/gate/followup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: randomUUID(), parentQuestionId: 'q1', basis: 'v2:b' }),
      })
    const running = await post()
    expect(running.status).toBe(202)
    expect(await running.json()).toEqual({ state: 'running' })
    const done = await post()
    expect(done.status).toBe(200)
    expect(await done.json()).toEqual({ state: 'done', questionIds: ['x'] })
  })

  test('the infrastructure publisher emits a synthetic task-channel frame', () => {
    const frames: unknown[] = []
    const unsubscribe = taskBroadcaster.subscribe(TASK_CHANNEL('task-o8'), (frame) =>
      frames.push(frame),
    )
    try {
      clarifyFollowupEvents.changed({ taskId: 'task-o8', nodeRunId: 'gate-run', roundId: 'round' })
    } finally {
      unsubscribe()
    }
    expect(frames).toEqual([
      {
        id: -1,
        type: 'clarify.followup.updated',
        nodeRunId: 'gate-run',
        roundId: 'round',
        ts: expect.any(Number),
      },
    ])
  })
})
