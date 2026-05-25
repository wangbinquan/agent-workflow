// RFC-062 PR-B — test-only harness for replay-driving an actor
// against a frozen workflow snapshot.
//
// NOT a test file (no .test suffix); imported by
// rfc062-snapshot-replay.test.ts.

import { eq } from 'drizzle-orm'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DbClient } from '../src/db/client'
import { events as eventsTable, tasks, workflows } from '../src/db/schema'
import { writeEvents } from '../src/services/writeEvents'
import { taskActorRegistry } from '../src/scheduler-v2/actorRegistry'
import { MockRunnerAdapter } from '../src/scheduler-v2/runnerAdapter'
import { runTaskActorViaProduction } from '../src/scheduler-v2/launcher'
import type { SpawnRequest } from '../src/scheduler-v2/taskActorTick'
import type { Event, WorkflowDefinition } from '@agent-workflow/shared'
import { RawEventSchema, decodeEvent, type RawEvent } from '@agent-workflow/shared'

export interface ScriptedPortOutput {
  name: string
  content: string
}

export interface ScriptedAgentOutput {
  matchNode: string
  matchIter: number
  ports: ScriptedPortOutput[]
}

export interface SnapshotFixture {
  $comment?: string
  $schema_version: number
  workflow: WorkflowDefinition
  inputs: Record<string, string>
  scriptedAgentOutputs: ScriptedAgentOutput[]
  expectedTerminalKind: 'task-completed' | 'task-failed' | 'task-canceled'
  expectedEvents: {
    mustContainInOrder: string[]
  }
}

/**
 * Extends MockRunnerAdapter to drive scripted agent outputs from a
 * fixture. On each spawn():
 *   1. Match (req.scope.nodeId, req.scope.iter) against fixture
 *      scriptedAgentOutputs.
 *   2. Write the matched `ports` as `attempt-output-captured` events
 *      against the task's events table (the real runner emits these
 *      mid-attempt; we just batch them at spawn time since the mock
 *      has no subprocess).
 *   3. Call simulateExit(attemptId, 'success') so the actor wakes
 *      with attempt-exit and runs onAttemptFinished('success').
 *
 * Unmatched spawn → throws. The test harness catches and surfaces
 * the message so failures pinpoint which (nodeId, iter) the actor
 * dispatched that wasn't in the fixture.
 */
export class ScriptedRunnerAdapter extends MockRunnerAdapter {
  readonly fixtureCalls: Array<{ nodeId: string; iter: number; attemptId: string }> = []

  constructor(
    private readonly scripted: ScriptedAgentOutput[],
    private readonly db: DbClient,
    private readonly taskId: string,
  ) {
    super()
  }

  override async spawn(req: SpawnRequest): Promise<void> {
    this.spawned.push(req)
    this.fixtureCalls.push({
      nodeId: req.scope.nodeId,
      iter: req.scope.iter,
      attemptId: req.attemptId,
    })
    const match = this.scripted.find(
      (s) => s.matchNode === req.scope.nodeId && s.matchIter === req.scope.iter,
    )
    if (!match) {
      throw new Error(
        `ScriptedRunnerAdapter: unexpected dispatch nodeId=${req.scope.nodeId} iter=${req.scope.iter} ` +
          `(scripted entries: ${this.scripted
            .map((s) => `${s.matchNode}@${s.matchIter}`)
            .join(', ')})`,
      )
    }
    // Write attempt-output-captured events one per port. Each event
    // increments the ts cursor by 1ms so the (ts, id) ordering reflects
    // emission order (mirrors how the real runner writes them as
    // envelopes arrive on stdout).
    if (match.ports.length > 0) {
      await writeEvents(
        this.db,
        match.ports.map((p) => ({
          taskId: this.taskId,
          kind: 'attempt-output-captured' as const,
          nodeId: req.scope.nodeId,
          loopIter: req.scope.loopIter,
          shardKey: req.scope.shardKey,
          iter: req.scope.iter,
          attemptId: req.attemptId,
          actor: 'system',
          payload: { portName: p.name, content: p.content },
        })),
      )
    }
    // Fire the exit wake on next microtask so the actor's spawn call
    // returns first (matches the real runner where exit is async).
    queueMicrotask(() => {
      try {
        this.simulateExit(req.attemptId, 'success')
      } catch {
        /* test driver may have torn down the registry already */
      }
    })
  }
}

/**
 * Insert a workflows + tasks row sufficient for the launcher to
 * start; returns the populated taskId.
 */
export function seedFixtureTask(
  db: DbClient,
  fixture: SnapshotFixture,
  taskId: string = 't-fixture',
): { worktreePath: string; repoPath: string; appHome: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc062-fixture-'))
  const worktreePath = join(tmp, 'wt')
  const repoPath = join(tmp, 'repo')
  const appHome = join(tmp, 'home')

  db.insert(workflows)
    .values({
      id: 'wf-fixture',
      name: 'rfc062-fixture-wf',
      schemaVersion: fixture.$schema_version,
      definition: JSON.stringify(fixture.workflow),
    })
    .run()
  db.insert(tasks)
    .values({
      id: taskId,
      name: 'rfc062-fixture-task',
      workflowId: 'wf-fixture',
      workflowSnapshot: JSON.stringify(fixture.workflow),
      repoPath,
      worktreePath,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'pending',
      inputs: JSON.stringify(fixture.inputs),
      startedAt: Date.now(),
    })
    .run()
  return { worktreePath, repoPath, appHome }
}

/**
 * Drive the actor + scripted runner against a fixture until terminal
 * state or `timeoutMs` elapses. Returns the decoded events table +
 * final tasks.status for assertions.
 *
 * Pump strategy: launch actor (background promise), then poll the
 * tasks.status column every 20ms. Once terminal, abort the actor's
 * controller + close its queue + await the launch promise. If the
 * polling reaches timeoutMs without terminal, the test fails with a
 * timeout message including the actor's last-known state.
 */
export async function driveSnapshotToCompletion(opts: {
  db: DbClient
  taskId: string
  fixture: SnapshotFixture
  worktreePath: string
  repoPath: string
  appHome: string
  timeoutMs?: number
}): Promise<{ events: Event[]; finalStatus: string }> {
  const { db, taskId, fixture } = opts
  const runner = new ScriptedRunnerAdapter(fixture.scriptedAgentOutputs, db, taskId)

  // Pre-register the actor + bind the runner's wake producer BEFORE
  // kicking the launcher. The launcher's own register call is
  // idempotent, so this is safe. Without the early bind, the
  // ScriptedRunnerAdapter's simulateExit calls have no queue to push
  // attempt-exit wakes onto and the actor never sees the success
  // signal — the attempt sits forever and the task stays in 'running'.
  const actor = taskActorRegistry.register(taskId)
  runner.bindWakeProducer(actor.queue)

  const launchP = runTaskActorViaProduction({
    db,
    taskId,
    workflow: fixture.workflow,
    inputsMap: fixture.inputs,
    worktreePath: opts.worktreePath,
    repoPath: opts.repoPath,
    appHome: opts.appHome,
    runnerAdapterOverride: runner,
  }).catch(() => {
    /* terminal cancel path resolves the launcher; we handle status below */
  })

  const deadline = Date.now() + (opts.timeoutMs ?? 10_000)
  let finalStatus = 'unknown'
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
    const row = db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get() as { status: string } | undefined
    finalStatus = row?.status ?? 'unknown'
    if (finalStatus === 'done' || finalStatus === 'failed' || finalStatus === 'canceled') {
      break
    }
  }

  // Tear down the actor so the launcher's promise resolves.
  const teardownActor = taskActorRegistry.get(taskId)
  teardownActor?.abortController.abort()
  teardownActor?.queue.close()
  await launchP

  const rawEvents = db
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.taskId, taskId))
    .all() as RawEvent[]
  const events = rawEvents.map((r) => decodeEvent(RawEventSchema.parse(r)))
  return { events, finalStatus }
}

/**
 * Encode an event's identity for the `mustContainInOrder` assertion.
 * Format: `<kind>` for task-level events, `<kind>:<nodeId>` for
 * scope-bound events. Keeps the assertion strings readable while
 * tolerating timestamp / payload differences.
 */
export function eventToken(e: Event): string {
  if (e.nodeId === null || e.nodeId === undefined || e.nodeId === '') {
    return e.kind
  }
  return `${e.kind}:${e.nodeId}`
}

/**
 * Assert that `tokens` appears as a subsequence (not subarray) of the
 * decoded event log. Throws a descriptive message on mismatch.
 */
export function assertContainsInOrder(actual: Event[], expected: string[]): void {
  const tokens = actual.map(eventToken)
  let cursor = 0
  for (const want of expected) {
    let found = -1
    for (let i = cursor; i < tokens.length; i++) {
      if (tokens[i] === want) {
        found = i
        break
      }
    }
    if (found < 0) {
      throw new Error(
        `expected event token "${want}" at or after index ${cursor}, ` +
          `but got tokens: [${tokens.join(', ')}]`,
      )
    }
    cursor = found + 1
  }
}
