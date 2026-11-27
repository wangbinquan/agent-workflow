// Regression guard (RFC-628): a digital employee preempted by an event before it posts "reply with
// repair result" still posts that reply afterwards.
//
// 2026-11-27, a real case on GitLab (recorded in design/RFC-616-process-metrics/plan.md §4.7): the
// employee pushed its review repair and its next step was "reply with repair result". Reading the
// merge request facts collided with the head moving and blocked the step; commit 033f5fafe fixed that
// first half (the read collects again). After the user resumed the case, the lifecycle update caused
// by the employee's own push preempted the step and the reply was never posted: the reviewer only saw
// "received, working on it".
//
// This is the system-level lock (design §6 G1) on the same arrangement as the review protocol of
// tests/rfc310-digital-employee-system-mock-e2e.test.ts:2444-2624: the real stateful GitLab system
// mock and its MR facts/reply adapters, real Git candidate, commit and CAS push, the real workspace,
// runtime and platform work items; only the Agent is deterministic. A stepping helper stops the case
// exactly where the reply (or the freeze of the uncommitted repair) is the next step, and an event is
// injected there:
// 1. the repair is pushed, a lifecycle update arrives before the reply → exactly one "handled in
//    commit …" reply lands in the thread and the ledger is replied;
// 2. the repair is done but not committed, a review update with a new comment arrives → the repair is
//    still committed and pushed, the old thread gets its reply, the new thread is acknowledged next.
//
// Like the original journey this runs on both providers, so each run resets the out-of-process mocks
// and uses its own disk root.
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { legacyShapedReactionExecution } from './helpers/legacyShapedReactionExecution'
import {
  composeDigitalEmployee,
  createEmployeeReactionRoundQueries,
} from '@/modules/digital-employee/composition'
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import {
  SYSTEM_MOCK_CODE_HOST_TOKEN,
  startSystemMockSuite,
  type StartedSystemMockSuite,
} from '@agent-workflow/system-mocks'
import { composeDevelopmentEmployeePlatformWorkItems } from '@/modules/development-automation/composition/digitalEmployeePlatformWorkItems'
import { composeDevelopmentEmployeeWorkspace } from '@/modules/development-automation/composition/digitalEmployeeWorkspace'
import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'
import {
  developmentEmployeeRuntimeCodec,
  developmentExecutionContractRegistrations,
} from '@/modules/development-automation/application/employeeTypePackage'
import { ExecutionContractService } from '@/modules/execution-contract/application/executionContractService'
import { createDevelopmentMrEffects } from '@/modules/integration/application/developmentCodeHostDelivery'
import { collectMergeRequestFacts } from '@/modules/integration/application/mrFacts'
import { codeHostRequests } from '@/modules/integration/composition'
import type { ReactionExecutionPlan } from '@/modules/digital-employee/domain/runtimeModel'
import { createEmployeeInputArtifactStore } from '@/modules/digital-employee/infrastructure/inputArtifactStore'
import { digitalEmployeeLifecycleEventCatalogJson } from '@/modules/digital-employee/public/events'
import {
  bindCandidateDeliveryParticipant,
  bindChangeCandidateParticipant,
  bindConflictMergeParticipant,
  bindEmployeeCaseWorkspaceParticipant,
  createFileConflictMergeWorkspaceEffects,
  createFileEmployeeCaseWorkspaceEffectsFactory,
  createLocalRepositoryCandidateEffects,
} from '@/modules/source-control/composition'
import { composeEventCenter, standaloneEventCenterSelections } from './helpers/eventCenter'
import { describeEachProvider } from './helpers/eachProvider'
import { staticCachedRepositoryPreparation } from './helpers/staticCachedRepositoryPreparation'
import { standaloneDigitalEmployeeSelections } from './helpers/digitalEmployeeSelections'
import {
  composeStandalonePlatformWorkItemEvidence,
  graphDeliveryWithoutDesign,
  unusedEmployeePlatformProviders,
} from './helpers/developmentAutomation'
import { createFileAutomationWorkspaceEffectsFactory } from '@/modules/development-automation/infrastructure/local/fileAutomationWorkspaceEffects'
import { createFileRepositoryBaselineEffectsFactory } from '@/modules/development-automation/infrastructure/local/fileRepositoryBaselineEffects'

setDefaultTimeout(180_000)

const REPOSITORY = 'repo-rfc628-review'
const PROJECT_PATH = 'rfc628/reply-after-preemption'
let suite: StartedSystemMockSuite
const roots: string[] = []

beforeAll(async () => {
  suite = await startSystemMockSuite()
})

afterAll(async () => {
  if (suite !== undefined) await suite.close()
  for (const created of roots) rmSync(created, { recursive: true, force: true })
})

/** The out-of-process mocks are not reset by the database harness; every run starts from zero. */
async function freshExternalWorld(): Promise<string> {
  await suite.client.reset()
  const created = mkdtempSync(join(tmpdir(), 'rfc628-system-mock-'))
  roots.push(created)
  return created
}

function git(cwd: string, ...args: string[]): string {
  const process = Bun.spawnSync({ cmd: ['git', ...args], cwd })
  if (process.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${process.stderr.toString()}`)
  }
  return process.stdout.toString().trim()
}

/** The mock's internal Git transport maps to a real bare repository under the system temp root. */
function mockRepoDiskPath(repoHttpUrl: string): string {
  const pathname = decodeURIComponent(new URL(repoHttpUrl).pathname)
  return join(realpathSync(tmpdir()), pathname.replace(/^\/git\//, ''))
}

function contextsOf(plan: ReactionExecutionPlan): Array<{ typeId: string; stateJson: string }> {
  const envelope = JSON.parse(plan.inputEnvelopeJson) as { contextsJson: string }
  return JSON.parse(envelope.contextsJson) as Array<{ typeId: string; stateJson: string }>
}

describeEachProvider(
  'RFC-628 reply after preemption on the GitLab system mock（双引擎）',
  (harness) => {
    test('a preempted reply still lands once; an uncommitted repair is still pushed and replied before new feedback', async () => {
      const db = harness.db
      const root = await freshExternalWorld()
      const appHome = join(root, 'home')
      const baselineRepo = join(root, 'review-baseline')
      const project = await suite.client.seedCodeHost({
        provider: 'gitlab',
        projectPath: PROJECT_PATH,
        title: 'RFC-628 reply after preemption',
        defaultBranch: 'main',
        baseFiles: { README: '# RFC-628 review baseline\n' },
      })
      const remoteRepo = mockRepoDiskPath(project.gitTransportUrl)
      git(root, 'clone', '-q', remoteRepo, baselineRepo)
      git(baselineRepo, 'checkout', '-q', 'main')
      const { cachedRepos, employeeCases } = tablesOf(db)
      await insertOne(db, cachedRepos, {
        id: REPOSITORY,
        urlHash: 'rfc628-system-mock-review',
        urlEnc: null,
        urlRedacted: project.repoHttpUrl,
        localPath: baselineRepo,
        defaultBranch: 'main',
        lastFetchedAt: 1,
        createdAt: 1,
      })

      const inputArtifacts = createEmployeeInputArtifactStore(
        join(appHome, 'artifacts', 'employee-inputs'),
      )
      const workspace = composeDevelopmentEmployeeWorkspace({
        graphDelivery: graphDeliveryWithoutDesign(),
        automationWorkspaceEffects: createFileAutomationWorkspaceEffectsFactory(),
        db,
        appHome,
        reactionRounds: createEmployeeReactionRoundQueries(db),
        inputArtifacts,
        repositoryPreparation: staticCachedRepositoryPreparation(db),
        sourceControl: bindEmployeeCaseWorkspaceParticipant({
          effects: createFileEmployeeCaseWorkspaceEffectsFactory(),
        }),
        conflictMerge: bindConflictMergeParticipant({
          effects: createFileConflictMergeWorkspaceEffects(),
        }),
      })
      const eventCenter = await composeEventCenter({
        ...standaloneEventCenterSelections(),
        db,
        typePackageDescriptorJsons: [
          developmentEmployeeTypePackage.descriptorJson,
          digitalEmployeeLifecycleEventCatalogJson,
        ],
        automation: { kind: 'observation-only' },
      })

      // ------------------------------------------------------------ deterministic Agent
      const completed = new Map<string, { plan: ReactionExecutionPlan; outputJson: string }>()
      let executionOrdinal = 0
      let repairOrdinal = 0
      const execution = {
        async launch(plan: ReactionExecutionPlan, attempt: { ordinal: number; mode: string }) {
          const scene = await workspace.prepare({
            planJson: JSON.stringify(plan),
            attemptJson: JSON.stringify({ ...attempt, previousError: null }),
          })
          if (scene.kind !== 'repository') throw new Error(`${plan.workItemRef} needs a repository`)
          let output: Record<string, unknown>
          if (plan.workItemRef === 'analyze-implement') {
            mkdirSync(join(scene.workspacePath, 'src'), { recursive: true })
            writeFileSync(
              join(scene.workspacePath, 'src', 'Booking.java'),
              'public final class Booking { public static boolean occupied() { return false; } }\n',
            )
            output = {
              outcome: 'completed',
              commitMessage: 'feat: add the booking rule',
              mergeRequestTitle: 'Add the booking rule',
              mergeRequestDescription: '## Summary\n\nAdds the booking rule.',
            }
          } else if (plan.workItemRef === 'repair-feedback') {
            const problemSet = contextsOf(plan).find(
              (context) => context.typeId === 'development.problem-set',
            )!
            const problems = (
              JSON.parse(problemSet.stateJson) as {
                problems: Array<{ reviewThread: { threadRef: string } }>
              }
            ).problems
            repairOrdinal += 1
            writeFileSync(
              join(scene.workspacePath, 'src', 'Booking.java'),
              `public final class Booking { public static boolean occupied() { return ${repairOrdinal} > 0; } }\n`,
            )
            output = {
              outcome: 'completed',
              commitMessage: `fix: address review round ${repairOrdinal}`,
              replies: problems.map((problem) => ({
                threadRef: problem.reviewThread.threadRef,
                reply: `已按检视意见调整预约规则（第 ${repairOrdinal} 轮）。`,
              })),
            }
          } else {
            throw new Error(`unexpected RFC-628 execution work item: ${plan.workItemRef}`)
          }
          const executionRef = `rfc628-system-mock-execution-${++executionOrdinal}`
          completed.set(executionRef, { plan, outputJson: JSON.stringify(output) })
          return { executionRef }
        },
        async inspect(executionRef: string) {
          const done = completed.get(executionRef)
          if (done === undefined) return { kind: 'pending' as const, executionRef }
          const validation = await workspace.validate({
            roundRef: done.plan.roundRef,
            taskStatus: 'done',
            outputJson: done.outputJson,
          })
          if (!validation.ok) {
            return {
              kind: 'failed' as const,
              executionRef,
              errorClass: validation.errorClass,
              errorCode: validation.errorCode,
              errorDetail: validation.errorDetail,
              metering: { sourceRef: executionRef, durationMs: 0, totalTokens: 0 },
            }
          }
          return {
            kind: 'completed' as const,
            executionRef,
            outputJson: done.outputJson,
            metering: { sourceRef: executionRef, durationMs: 0, totalTokens: 0 },
          }
        },
        async cancel() {},
      }

      // ------------------------------------------------------------ real GitLab system mock
      const hostBinding = {
        provider: 'gitlab' as const,
        project: encodeURIComponent(PROJECT_PATH),
        requests: codeHostRequests,
        call: {
          connection: {
            provider: 'gitlab' as const,
            baseUrl: suite.endpoints.gitlabApiBaseUrl,
            repositoryUrlPrefixes: [],
            token: SYSTEM_MOCK_CODE_HOST_TOKEN,
            rejectUnauthorized: true,
          },
          ctx: { ports: {} },
        },
      }
      const mrEffects = createDevelopmentMrEffects({
        binding: (repositoryId) => (repositoryId === REPOSITORY ? hostBinding : null),
      })
      let mrRef: string | null = null
      const platform = composeDevelopmentEmployeePlatformWorkItems({
        ...unusedEmployeePlatformProviders(),
        graphDelivery: graphDeliveryWithoutDesign(),
        automationWorkspaceEffects: createFileAutomationWorkspaceEffectsFactory(),
        repositoryBaselines: createFileRepositoryBaselineEffectsFactory(),
        evidenceArtifacts: composeStandalonePlatformWorkItemEvidence({ appHome }),
        reactionRounds: createEmployeeReactionRoundQueries(db),
        db,
        appHome,
        conflictMerge: bindConflictMergeParticipant({
          effects: createFileConflictMergeWorkspaceEffects(),
        }),
        sourceControl: {
          ...bindChangeCandidateParticipant({
            candidateEffects: createLocalRepositoryCandidateEffects(),
          }),
          ...bindCandidateDeliveryParticipant({
            candidateEffects: createLocalRepositoryCandidateEffects(),
          }),
          ...bindEmployeeCaseWorkspaceParticipant({
            effects: createFileEmployeeCaseWorkspaceEffectsFactory(),
          }),
        },
        repoRemote: {
          resolve: (repositoryId) =>
            repositoryId === REPOSITORY ? { remoteUrl: remoteRepo, defaultBranch: 'main' } : null,
        },
        mrEffects: {
          reply: (repositoryId, request) => mrEffects.reply(repositoryId, request),
          observe: (repositoryId, ref) => mrEffects.observe(repositoryId, ref),
          async ensure(repositoryId, request) {
            const ensured = await mrEffects.ensure(repositoryId, request)
            if (ensured.ok) mrRef = ensured.mr.mrRef
            return ensured
          },
        },
        mrFacts: {
          async collect(repositoryId, ref, selfMarker) {
            if (repositoryId !== REPOSITORY)
              throw new Error(`unexpected repository ${repositoryId}`)
            const collected = await collectMergeRequestFacts(hostBinding, ref, { selfMarker })
            if (!collected.ok) return collected
            return {
              ok: true as const,
              snapshot: {
                state: collected.snapshot.state,
                headSha: collected.snapshot.headSha,
                targetSha: collected.snapshot.targetSha,
                targetBranch: collected.snapshot.targetBranch,
                draft: collected.snapshot.draft,
                mergeableState: collected.snapshot.mergeableState,
                approvalHold: collected.snapshot.approvalHold,
                mergedCommitSha: collected.snapshot.mergedCommitSha,
                unresolvedReviewCount: collected.snapshot.threads.filter(
                  (thread) => !thread.resolved && thread.authorClass !== 'self',
                ).length,
                reviewThreads: collected.snapshot.threads.map((thread) => ({
                  threadRef: thread.threadRef,
                  revision: thread.revision,
                  authorClass: thread.authorClass,
                  resolved: thread.resolved,
                  body: thread.lastBody,
                  path: thread.path,
                  messages: thread.messages,
                })),
              },
            }
          },
        },
      })

      // ------------------------------------------------------------ employee
      let idOrdinal = 0
      const executionContracts = new ExecutionContractService({
        registrations: developmentExecutionContractRegistrations,
        resources: {
          async inspect({ implementation }) {
            const ref =
              implementation.kind === 'agent' ? implementation.agentRef : implementation.workflowRef
            return {
              kind: implementation.kind,
              name: ref.id,
              available: true,
              detail: 'RFC-628 system-mock exact resource',
              declaredContractRefs:
                implementation.kind === 'agent'
                  ? developmentExecutionContractRegistrations.map(
                      (registration) => registration.contractRef,
                    )
                  : null,
            }
          },
        },
        programFixtures: {
          async run() {
            throw new Error('the RFC-628 system mock binds no program tool')
          },
        },
      })
      const employeeOs = composeDigitalEmployee({
        ...standaloneDigitalEmployeeSelections({ db, appHome }),
        db,
        appHome,
        typePackages: [developmentEmployeeTypePackage],
        executionContracts,
        inputArtifacts,
        id: () => `rfc628-os-${String(++idOrdinal).padStart(5, '0')}`,
        runtime: {
          eventCenter: eventCenter.participant,
          codecs: [developmentEmployeeRuntimeCodec],
          reactionExecution: legacyShapedReactionExecution(execution),
          platformWorkItems: platform,
        },
      })
      const runtime = employeeOs.runtime!
      const typeRef = (
        JSON.parse(developmentEmployeeTypePackage.descriptorJson) as {
          readonly typeRef: { readonly typeId: string; readonly revision: number }
        }
      ).typeRef
      const typePackage = await employeeOs.queries.getType(typeRef)
      const bindings: Array<{
        workItemRef: string
        slotRef: string
        registrationRef: { id: string; revision: number }
      }> = []
      for (const item of typePackage.authoringManifest.workItems) {
        if (item.workItemRef !== 'analyze-implement' && item.workItemRef !== 'repair-feedback')
          continue
        for (const role of item.toolRoleGroups) {
          for (const slot of role.bindingSlots) {
            // Optional slots (the implementation-plan writer) stay unbound, as in the review job.
            if (!slot.required) continue
            const tool = await employeeOs.commands.createTool({
              typeRef,
              workItemRef: item.workItemRef,
              actorUserId: 'rfc628-author',
              body: {
                displayName: `${item.workItemRef}/${slot.slotRef}`,
                description: 'RFC-628 system-mock tool',
                roleRef: role.roleRef,
                implementation: {
                  kind: 'agent',
                  agentRef: { id: `rfc628-agent-${item.workItemRef}`, revision: 1 },
                },
              },
            })
            expect(tool.validationReceipt.status).toBe('valid')
            bindings.push({
              workItemRef: item.workItemRef,
              slotRef: slot.slotRef,
              registrationRef: await employeeOs.commands.publishTool({
                typeRef,
                workItemRef: item.workItemRef,
                toolId: tool.id,
                actorUserId: 'rfc628-author',
              }),
            })
          }
        }
      }
      const job = await employeeOs.commands.createJobTemplate({
        typeRef,
        actorUserId: 'rfc628-author',
        body: {
          name: 'RFC-628 检视闭环岗位',
          description: '只启用交付与检视意见修复泳道',
          defaultToolBindings: bindings,
        },
      })
      const jobRef = await employeeOs.commands.publishJobTemplate({
        id: job.id,
        actorUserId: 'rfc628-author',
      })
      const employee = await employeeOs.commands.createEmployee({
        typeRef,
        actorUserId: 'rfc628-author',
        body: {
          name: 'RFC-628 检视闭环数字员工',
          jobTemplateRef: jobRef,
          workScope: { kind: 'repository', repositoryId: REPOSITORY },
          toolOverrides: [],
        },
      })

      // ------------------------------------------------------------ driving
      let caseId = ''
      const caseRow = async () => {
        const [row] = await db
          .select({
            state: employeeCases.state,
            currentWorkItemRef: employeeCases.currentWorkItemRef,
            activeRoundId: employeeCases.activeRoundId,
          })
          .from(employeeCases)
          .where(eq(employeeCases.id, caseId))
        return row!
      }
      const ledger = async () => {
        const projection = JSON.parse((await runtime.queries.getCase(caseId)).projectionJson) as {
          contexts: Array<{ typeId: string; state: { status?: string } }>
        }
        return projection.contexts.find(
          (context) => context.typeId === 'development.review-resolution',
        )?.state
      }
      const steps: ReadonlyArray<() => Promise<boolean>> = [
        async () => await runtime.worker.pumpOneDelivery(),
        async () => (await runtime.worker.planOneReaction()) !== null,
        async () => (await runtime.worker.runOneOutbox()) !== 'idle',
        async () => (await runtime.worker.dispatchOneReaction()) !== 'idle',
        async () => {
          const inspected = await runtime.worker.inspectOneExecution()
          return inspected !== 'idle' && inspected !== 'pending'
        },
        async () => (await runtime.worker.publishOneChannelResult()) !== 'idle',
      ]
      const driveUntilIdle = async (budget = 400): Promise<void> => {
        for (let turn = 0; turn < budget; turn += 1) {
          let progress = false
          for (const step of steps) if (await step()) progress = true
          if (!progress) {
            // A millisecond outbox retry timestamp can still be ahead of the wall clock.
            if ((await caseRow()).activeRoundId !== null) {
              await Bun.sleep(2)
              continue
            }
            return
          }
        }
        throw new Error(
          `RFC-628 journey exceeded its step budget: ${JSON.stringify(await caseRow())}`,
        )
      }
      /** RFC-628: advance until the case's next work item is `workItemRef`, before it is planned. */
      const stepUntilNext = async (workItemRef: string, budget = 400): Promise<void> => {
        const reached = async () => {
          const row = await caseRow()
          return (
            row.state === 'active' &&
            row.currentWorkItemRef === workItemRef &&
            row.activeRoundId === null
          )
        }
        for (let turn = 0; turn < budget; turn += 1) {
          let progress = false
          for (const step of steps) {
            if (await reached()) return
            if (await step()) progress = true
          }
          if (!progress) {
            if (await reached()) return
            if ((await caseRow()).activeRoundId !== null) {
              await Bun.sleep(2)
              continue
            }
            throw new Error(
              `RFC-628 case went idle before ${workItemRef} was next: ${JSON.stringify(await caseRow())}`,
            )
          }
        }
        throw new Error(
          `RFC-628 case did not reach ${workItemRef}: ${JSON.stringify(await caseRow())}`,
        )
      }
      let eventOrdinal = 0
      const observe = async (
        eventTypeId: 'development.review-updated' | 'development.lifecycle-updated',
        summary: string,
      ) => {
        eventOrdinal += 1
        await eventCenter.commands.observe({
          sourceRef: { id: 'code-host.activity', revision: 1 },
          eventTypeRef: { id: eventTypeId, revision: 2 },
          subject: { typeId: 'merge-request', subjectRef: `${REPOSITORY}!${mrRef}` },
          occurredAt: Date.now() + eventOrdinal,
          dedupeKey: `rfc628:${eventTypeId}:${eventOrdinal}`,
          summary,
          payloadArtifactRef: null,
        })
      }
      const mergeRequest = async () => {
        const snapshot = await suite.client.snapshot()
        return snapshot.codeHosts
          .find((host) => host.projectPath === PROJECT_PATH)!
          .mergeRequests.find((candidate) => candidate.number === Number(mrRef))!
      }
      const threadComments = async (threadId: string) =>
        (await mergeRequest()).reviewComments.filter((comment) => comment.threadId === threadId)
      const resolvedReplies = async (threadId: string) =>
        (await threadComments(threadId)).filter((comment) =>
          comment.body.includes(`aw-self:${caseId}:review-resolved:`),
        )
      const receivedReplies = async (threadId: string) =>
        (await threadComments(threadId)).filter((comment) =>
          comment.body.includes(`aw-self:${caseId}:review-received:`),
        )
      const addReview = async (threadId: string, body: string) => {
        await suite.client.mutateCodeHost({
          kind: 'add-review-comment',
          provider: 'gitlab',
          projectPath: PROJECT_PATH,
          number: Number(mrRef),
          threadId,
          body,
          actor: { username: 'human-reviewer' },
        })
      }

      const launched = await runtime.commands.launchWork({
        employeeId: employee.id,
        actorUserId: 'requester',
        intake: {
          name: 'RFC-628 预约规则',
          kind: 'body',
          target: { repositoryId: REPOSITORY },
          body: '# Add the booking rule\n\nReject a booking for an occupied slot.',
          externalId: null,
          uploads: [],
          idempotencyKey: 'rfc628:system-mock',
        },
      })
      caseId = launched.caseRef.id
      await driveUntilIdle()
      expect(mrRef).not.toBeNull()
      expect(await caseRow()).toMatchObject({ state: 'waiting', currentWorkItemRef: null })

      // 1. The repair is pushed; the lifecycle update caused by that push arrives before the reply.
      const headBeforeFirstRepair = (await mergeRequest()).headSha
      await addReview('rfc628-thread-1', '请让占用判断真正检查时间段。')
      await observe('development.review-updated', 'a reviewer commented')
      await stepUntilNext('reply-feedback')
      expect((await mergeRequest()).headSha).not.toBe(headBeforeFirstRepair)
      expect(await receivedReplies('rfc628-thread-1')).toHaveLength(1)
      expect(await resolvedReplies('rfc628-thread-1')).toHaveLength(0)
      await observe('development.lifecycle-updated', 'the employee pushed its repair')
      await driveUntilIdle()
      const firstReplies = await resolvedReplies('rfc628-thread-1')
      expect(firstReplies).toHaveLength(1)
      expect(firstReplies[0]!.body).toContain((await mergeRequest()).headSha.slice(0, 12))
      expect((await ledger())?.status).toBe('replied')
      expect(await caseRow()).toMatchObject({ state: 'waiting' })

      // 2. The repair is done but not committed; a review update with a new comment arrives.
      await addReview('rfc628-thread-2', '取消的预约不应占用时间段。')
      await observe('development.review-updated', 'a second thread')
      await stepUntilNext('prepare-change')
      const headBeforeSecondPush = (await mergeRequest()).headSha
      expect(await receivedReplies('rfc628-thread-2')).toHaveLength(1)
      await addReview('rfc628-thread-3', '同一用户不能重复预约同一时间段。')
      await observe('development.review-updated', 'a third thread while the repair is uncommitted')
      await driveUntilIdle()
      expect((await mergeRequest()).headSha).not.toBe(headBeforeSecondPush)
      expect(await resolvedReplies('rfc628-thread-2')).toHaveLength(1)
      expect(await receivedReplies('rfc628-thread-3')).toHaveLength(1)
      expect(await resolvedReplies('rfc628-thread-3')).toHaveLength(1)
      // The earlier threads are never answered twice.
      expect(await resolvedReplies('rfc628-thread-1')).toHaveLength(1)
      expect(await receivedReplies('rfc628-thread-1')).toHaveLength(1)
      expect((await ledger())?.status).toBe('replied')
      expect(await caseRow()).toMatchObject({ state: 'waiting' })
    })
  },
)
