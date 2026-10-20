// RFC-382: reproduce the former PostgreSQL session wiring, then prove real gate work precedes drive once.
import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { gitStashSnapshot } from '@/util/git'
import {
  tasks,
  nodeRuns,
  taskExecutionIntents,
  taskQuestions,
  taskExecutionEffects,
  taskExecutionEffectAttempts,
  collaborationGateOperations,
} from '@/db/schema'
import {
  DefaultTaskDriveCoordinator,
  resolveTaskDriveConfig,
  skipRepositoryPreparation,
} from '@/modules/task-execution/composition/taskDriveLegacy'
import { createGateContinuationDriver } from '@/modules/task-execution/public/participants'
import { createClarifyRound } from '@/services/clarify/service'
import { prepareClarifyDecision } from '@/services/clarifyDecision'
import { autoDispatchClarifyRound } from '@/modules/collaboration/infrastructure/clarify/autoDispatch'
import { finishCommittedClarifyAutoDispatch } from '@/modules/collaboration/infrastructure/clarify/autoDispatch'
import { acceptHumanGateDecisionTx } from '@/modules/task-execution/infrastructure/taskDecisionParticipant'
import {
  humanGateNodeProjectionFence,
  humanGateNodeProjectionMember,
} from '@/modules/task-execution/domain/humanGateContinuation'
import { validatedWorkspaceRollbackPlan } from '@/modules/collaboration/domain/workspaceRollbackPlan'
import { encodeReviewDecisionManifest } from '@/modules/collaboration/domain/reviewDecision'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { describeEachProvider } from './helpers/eachProvider'
import { taskBundleInput, seedBundleTask } from './helpers/daemonTaskExecutionBundle'
import { mintSequenceRun } from './helpers/rfc374Fixtures'

// This is precisely C6's former omission. Its lifecycle and scheduler are the real provider's;
// removing a pre-drive step from the bundle would make the paired fixed assertions fail.
async function formerSession(bundle: ReturnType<ReturnType<typeof taskBundleInput>['compose']>) {
  return new DefaultTaskDriveCoordinator({
    runtime: resolveTaskDriveConfig(await bundle.runConfiguration()),
    lifecycle: bundle.driverLifecycle,
    repositoryPreparation: skipRepositoryPreparation,
    engineOrchestrator: {
      drive: (context) =>
        bundle.runtime.schedulerDriver.drive({
          taskId: context.taskId,
          appHome: context.runtime.appHome,
          ...context.runtime.runtime,
          signal: context.signal,
          executionContext: context.execution,
        }),
    },
    failureReporter: { report() {} },
  })
}

describeEachProvider('RFC-382 gate pre-drive baseline and session regression', (harness) => {
  for (const baseline of [true, false]) {
    test(`${baseline ? 'former C6' : 'bundle'}: clarify commit-edge interruption ${baseline ? 'leaves' : 'converges'} durable work before scheduling`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'rfc382-clarify-'))
      try {
        const fixture = taskBundleInput(harness, home),
          bundle = fixture.compose(),
          db = harness.db
        const seeded = await seedBundleTask(harness, home, 'running', false),
          taskId = seeded.taskId
        await db
          .update(tasks)
          .set({
            workflowSnapshot: JSON.stringify({
              $schema_version: 4,
              inputs: [],
              nodes: [
                { id: 'P', kind: 'agent-single', agentName: 'agent-p' },
                { id: 'CL', kind: 'clarify', title: 'cl' },
              ],
              edges: [],
              outputs: [],
            }),
          })
          .where(eq(tasks.id, taskId))
        const asking = await mintSequenceRun(db, taskId, { nodeId: 'P', status: 'awaiting_human' })
        const round = await createClarifyRound({
          kind: 'self',
          db,
          taskId,
          askingNodeId: 'P',
          askingNodeRunId: asking,
          askingShardKey: null,
          intermediaryNodeId: 'CL',
          iteration: 0,
          questions: [
            {
              id: 'q',
              title: 'choose',
              kind: 'single',
              recommended: false,
              options: [
                { label: 'A', description: '', recommended: false, recommendationReason: '' },
                { label: 'B', description: '', recommended: false, recommendationReason: '' },
              ],
            },
          ],
        })
        const answers = [
          {
            questionId: 'q',
            selectedOptionIndices: [0],
            selectedOptionLabels: ['A'],
            customText: '',
          },
        ]
        const prepared = await prepareClarifyDecision({
          db,
          taskId,
          roundId: round.round.id,
          originNodeRunId: round.intermediaryNodeRunId,
          actorUserId: 'u1',
          actorRole: 'owner',
          answers,
          directive: 'stop',
          taskRevision: (await seeded.row()).lifecycleEventRevision,
          decision: { idempotencyKey: ulid() },
        })
        await expect(
          autoDispatchClarifyRound({
            db,
            memoryDistillEnqueuer: fixture.input.memory.memoryOperations.distillCommands,
            originNodeRunId: round.intermediaryNodeRunId,
            answers,
            directive: 'stop',
            actor: { userId: 'u1', role: 'owner' },
            committedOperationId: prepared.operationId,
            decisionParticipant: prepared.participant,
            afterSealCommit: async () => {
              throw new Error('rfc382-commit-edge-interruption')
            },
          }),
        ).rejects.toThrow('rfc382-commit-edge-interruption')
        const [intent] = await db
          .select()
          .from(taskExecutionIntents)
          .where(eq(taskExecutionIntents.taskId, taskId))
        const before = await db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId))
        expect(before.some((q) => q.dispatchedAt === null)).toBe(true)
        let checks = 0
        const scheduled = Promise.withResolvers<void>()
        fixture.schedulerDriver.drive = async () => {
          try {
            const questions = await db
              .select()
              .from(taskQuestions)
              .where(eq(taskQuestions.taskId, taskId))
            expect(questions.some((q) => q.dispatchedAt === null)).toBe(baseline)
            checks++
          } finally {
            scheduled.resolve()
          }
        }
        const coordinator = baseline ? await formerSession(bundle) : bundle.coordinator
        await createGateContinuationDriver({ isDriving: bundle.isTaskActive, coordinator })({
          taskId,
          continuationRef: intent!.id,
        })
        await scheduled.promise
        await bundle.executionModule.runtimeRegistry.awaitReleasedSettled(taskId)
        expect(checks).toBe(1)
        if (!baseline) {
          const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
          await finishCommittedClarifyAutoDispatch({
            db,
            memoryDistillEnqueuer: fixture.input.memory.memoryOperations.distillCommands,
            operationId: prepared.operationId,
            expectedTaskId: taskId,
            expectedOriginNodeRunId: round.intermediaryNodeRunId,
            expectedContinuationRef: intent!.id,
          })
          expect(await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).toHaveLength(
            runs.length,
          )
        }
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test(`${baseline ? 'former C6' : 'bundle'}: review continuation ${baseline ? 'skips' : 'settles'} real workspace rollback before scheduling`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'rfc382-review-'))
      try {
        const git = (...args: string[]) =>
          execFileSync('git', ['-C', home, ...args], { encoding: 'utf8' }).trim()
        git('init', '-q', '-b', 'main')
        git('config', 'user.name', 'Fixture')
        git('config', 'user.email', 'fixture@example.test')
        writeFileSync(join(home, 'document.txt'), 'original')
        git('add', 'document.txt')
        git(
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.test',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-qm',
          'fixture',
        )
        writeFileSync(join(home, 'document.txt'), 'ask-time')
        const snapshot = await gitStashSnapshot(home)
        writeFileSync(join(home, 'document.txt'), 'changed')
        const fixture = taskBundleInput(harness, home),
          bundle = fixture.compose(),
          db = harness.db
        const seeded = await seedBundleTask(harness, home, 'running', false),
          taskId = seeded.taskId
        await db.update(tasks).set({ status: 'awaiting_review' }).where(eq(tasks.id, taskId))
        const source = await mintSequenceRun(db, taskId, { nodeId: 'writer', status: 'done' })
        await db
          .update(nodeRuns)
          .set({
            status: 'canceled',
            preSnapshot: snapshot,
            supersededByReview: 'rejected',
            rolledBack: false,
          })
          .where(eq(nodeRuns.id, source))
        const rerun = await mintSequenceRun(db, taskId, {
          nodeId: 'writer',
          status: 'pending',
          retryIndex: 1,
          cause: 'review-reject',
        })
        const plan = validatedWorkspaceRollbackPlan({
          taskId,
          targets: [
            {
              sourceNodeRunId: source,
              worktreePath: home,
              worktreeDirName: '.',
              snapshot,
              ordinal: 0,
            },
          ],
        })
        const operationId = ulid(),
          gateRef = `review:${taskId}:1`,
          now = Date.now()
        const decision = await databaseSessionFor(db).transaction(async (tx) => {
          const rows = await tx.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
          const revision = (await tx.select().from(tasks).where(eq(tasks.id, taskId)).get())!
            .lifecycleEventRevision
          await tx.insert(collaborationGateOperations).values({
            id: operationId,
            taskId,
            gateKind: 'review',
            operationKind: 'decide',
            gateRef,
            idempotencyKey: operationId,
            requestHash: 'a'.repeat(64),
            expectedTaskRevision: revision,
            expectedGateRevision: 1,
            state: 'committed',
            resultGateRevision: 2,
            receiptJson: '{}',
            createdAt: now,
            updatedAt: now,
            committedAt: now,
            manifestJson: encodeReviewDecisionManifest({
              schemaVersion: 1,
              kind: 'review-decision',
              sourceNodeRunIds: [source],
              rerunNodeRunIds: [rerun],
              workspaceRollbackPlan: plan,
              request: {
                schemaVersion: 1,
                taskId,
                gateKind: 'review',
                operationKind: 'decide',
                gateRef,
                actorUserId: null,
                expectedTaskRevision: revision,
                expectedGateRevision: 1,
                payload: {
                  kind: 'review-decision',
                  decision: 'rejected',
                  reviewIteration: 0,
                  rejectReason: null,
                  commentsJson: '[]',
                  selectionsJson: '[]',
                },
              },
            }),
          })
          return acceptHumanGateDecisionTx(tx, {
            taskId,
            gate: { kind: 'review', ref: gateRef },
            expectedTaskRevision: revision,
            expectedNodeProjection: humanGateNodeProjectionFence(
              rows.map(humanGateNodeProjectionMember),
            ),
            continuationLineage: { sourceNodeRunIds: [source], rerunNodeRunIds: [rerun] },
            workspaceRollbackPlan: { operationId, planDigest: plan.digest },
            operationId,
            now,
          })
        })
        let checks = 0
        const scheduled = Promise.withResolvers<void>()
        fixture.schedulerDriver.drive = async () => {
          try {
            expect(readFileSync(join(home, 'document.txt'), 'utf8')).toBe(
              baseline ? 'changed' : 'ask-time',
            )
            const [row] = await db.select().from(nodeRuns).where(eq(nodeRuns.id, source))
            expect(row!.rolledBack).toBe(!baseline)
            const effects = await db
              .select()
              .from(taskExecutionEffects)
              .where(eq(taskExecutionEffects.taskId, taskId))
            expect(effects[0]!.state).toBe(baseline ? 'open' : 'succeeded')
            checks++
          } finally {
            scheduled.resolve()
          }
        }
        const coordinator = baseline ? await formerSession(bundle) : bundle.coordinator
        await createGateContinuationDriver({ isDriving: bundle.isTaskActive, coordinator })({
          taskId,
          continuationRef: decision.continuationRef,
        })
        await scheduled.promise
        await bundle.executionModule.runtimeRegistry.awaitReleasedSettled(taskId)
        expect(checks).toBe(1)
        const attempts = await db.select().from(taskExecutionEffectAttempts)
        expect(attempts).toHaveLength(baseline ? 0 : 1)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })
  }
})
