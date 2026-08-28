// RFC-310 conflict-repair System Mock E2E.
//
// This journey deliberately derives the conflict from real Git trees in the
// stateful code-host mock. The provider event is only a wake-up hint: the
// Digital Employee OS refreshes authoritative MR facts, prepares a frozen
// conflict scene, validates the Agent's file boundary, creates a two-parent
// merge commit, CAS-pushes it, and observes the provider again.

import { createEmployeeReactionRoundQueries } from '@/modules/digital-employee/composition'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  SYSTEM_MOCK_CODE_HOST_TOKEN,
  startSystemMockSuite,
  type StartedSystemMockSuite,
} from '@agent-workflow/system-mocks'

import { createInMemoryDb } from '@/db/client'
import { cachedRepos, employeeOsOutbox } from '@/db/schema'
import { composeDevelopmentEmployeePlatformWorkItems } from '@/modules/development-automation/composition/digitalEmployeePlatformWorkItems'
import { composeDevelopmentEmployeeWorkspace } from '@/modules/development-automation/composition/digitalEmployeeWorkspace'
import {
  developmentEmployeeRuntimeCodec,
  developmentEmployeeTypePackage,
  developmentExecutionContractRegistrations,
} from '@/modules/development-automation/composition/employeeTypePackage'
import { composeDigitalEmployee } from '@/modules/digital-employee/composition'
import type { ReactionExecutionPlan } from '@/modules/digital-employee/domain/runtimeModel'
import { createEmployeeInputArtifactStore } from '@/modules/digital-employee/infrastructure/inputArtifactStore'
import { digitalEmployeeLifecycleEventCatalogJson } from '@/modules/digital-employee/public/events'
import { composeEventCenter } from '@/modules/event-center/composition'
import { ExecutionContractService } from '@/modules/execution-contract/application/executionContractService'
import { collectMergeRequestFacts } from '@/modules/integration/application/mrFacts'
import { composeDevelopmentMrEffects } from '@/modules/integration/composition/codeHostEffects'
import { codeHostEventCatalogJson } from '@/modules/integration/public/events'
import { staticCachedRepositoryPreparation } from './helpers/staticCachedRepositoryPreparation'
import {
  bindCandidateDeliveryParticipant,
  bindChangeCandidateParticipant,
  bindConflictMergeParticipant,
  bindEmployeeCaseWorkspaceParticipant,
  createRepositoryPublicationTransport,
} from '@/modules/source-control/composition'

setDefaultTimeout(180_000)

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
let suite: StartedSystemMockSuite

beforeAll(async () => {
  suite = await startSystemMockSuite()
})

afterAll(async () => {
  if (suite !== undefined) await suite.close()
})

function git(cwd: string, ...args: string[]): string {
  const child = Bun.spawnSync({ cmd: ['git', ...args], cwd })
  if (child.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${child.stderr.toString()}`)
  }
  return child.stdout.toString().trim()
}

async function gitAsync(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
  return stdout.trim()
}

function directOutput(result: Record<string, unknown>): string {
  return JSON.stringify({ outcome: 'completed', ...result })
}

describe('RFC-310 Digital Employee conflict System Mock E2E', () => {
  test('real target advance -> conflict Attention -> bounded repair -> CAS merge commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-rfc310-conflict-e2e-'))
    const appHome = join(root, 'home')
    const baselineRepo = join(root, 'baseline')
    const targetClone = join(root, 'target-clone')
    const projectPath = 'rfc310/digital-employee-conflict'
    const repositoryId = 'repo-rfc310-conflict'
    const project = await suite.client.seedCodeHost({
      provider: 'gitlab',
      projectPath,
      title: 'RFC-310 conflict closure',
      defaultBranch: 'main',
      baseFiles: {
        'X.txt': 'base\n',
        'untouched.txt': 'must remain unchanged\n',
      },
    })

    try {
      await gitAsync(root, 'clone', '-q', project.repoHttpUrl, baselineRepo)
      git(baselineRepo, 'checkout', '-q', 'main')
      const baseSha = git(baselineRepo, 'rev-parse', 'HEAD')
      const db = createInMemoryDb(MIGRATIONS)
      const publicationTransport = createRepositoryPublicationTransport({ db, appHome })
      db.insert(cachedRepos)
        .values({
          id: repositoryId,
          urlHash: 'rfc310-conflict-system-mock',
          urlEnc: null,
          urlRedacted: project.repoHttpUrl,
          localPath: baselineRepo,
          defaultBranch: 'main',
          lastFetchedAt: 1,
          createdAt: 1,
        })
        .run()

      const inputArtifacts = createEmployeeInputArtifactStore(
        join(appHome, 'artifacts', 'employee-inputs'),
      )
      const workspace = composeDevelopmentEmployeeWorkspace({
        db,
        appHome,
        reactionRounds: createEmployeeReactionRoundQueries(db),
        inputArtifacts,
        repositoryPreparation: staticCachedRepositoryPreparation(db),
        sourceControl: bindEmployeeCaseWorkspaceParticipant({ publicationTransport }),
        conflictMerge: bindConflictMergeParticipant(),
      })
      const eventCenter = composeEventCenter({
        db,
        typePackageDescriptorJsons: [
          developmentEmployeeTypePackage.descriptorJson,
          digitalEmployeeLifecycleEventCatalogJson,
          codeHostEventCatalogJson,
        ],
      })

      const hostBinding = {
        provider: 'gitlab' as const,
        project: encodeURIComponent(projectPath),
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
      const mrEffects = composeDevelopmentMrEffects({
        binding: (candidateRepositoryId) =>
          candidateRepositoryId === repositoryId ? hostBinding : null,
      })
      const sourceControl = {
        ...bindChangeCandidateParticipant(),
        ...bindCandidateDeliveryParticipant({ publicationTransport }),
        ...bindEmployeeCaseWorkspaceParticipant({ publicationTransport }),
      }
      const platform = composeDevelopmentEmployeePlatformWorkItems({
        db,
        appHome,
        reactionRounds: createEmployeeReactionRoundQueries(db),
        sourceControl,
        conflictMerge: bindConflictMergeParticipant(),
        repoRemote: {
          resolve(candidateRepositoryId) {
            return candidateRepositoryId === repositoryId
              ? { remoteUrl: project.repoHttpUrl, defaultBranch: 'main' }
              : null
          },
        },
        mrEffects,
        mrFacts: {
          async collect(candidateRepositoryId, mrRef, selfMarker) {
            if (candidateRepositoryId !== repositoryId) {
              return {
                ok: false as const,
                code: 'repository-not-bound',
                detail: candidateRepositoryId,
              }
            }
            const collected = await collectMergeRequestFacts(hostBinding, mrRef, { selfMarker })
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

      const completed = new Map<
        string,
        { readonly plan: ReactionExecutionPlan; readonly outputJson: string }
      >()
      let executionOrdinal = 0
      const execution = {
        async launch(plan: ReactionExecutionPlan, attempt: { ordinal: number; mode: string }) {
          const scene = await workspace.prepare({
            planJson: JSON.stringify(plan),
            attemptJson: JSON.stringify({ ...attempt, previousError: null }),
          })
          if (scene.kind !== 'repository') {
            throw new Error(`${plan.workItemRef} requires a repository scene`)
          }
          let outputJson: string
          if (plan.workItemRef === 'analyze-implement') {
            expect(readFileSync(join(scene.workspacePath, 'X.txt'), 'utf8')).toBe('base\n')
            writeFileSync(join(scene.workspacePath, 'X.txt'), 'source change\n')
            outputJson = directOutput({
              commitMessage: 'implement source-side change',
              mergeRequestTitle: 'Implement source-side change',
              mergeRequestDescription: 'Creates the source-side change used by the conflict E2E.',
            })
          } else if (plan.workItemRef === 'repair-conflict') {
            const conflicted = readFileSync(join(scene.workspacePath, 'X.txt'), 'utf8')
            expect(conflicted).toContain('<<<<<<<')
            expect(conflicted).toContain('source change')
            expect(conflicted).toContain('target change')
            expect(readFileSync(join(scene.workspacePath, 'untouched.txt'), 'utf8')).toBe(
              'must remain unchanged\n',
            )
            writeFileSync(join(scene.workspacePath, 'X.txt'), 'source + target resolved\n')
            outputJson = directOutput({ commitMessage: 'resolve target branch conflict' })
          } else {
            throw new Error(`unexpected Agent work item: ${plan.workItemRef}`)
          }
          const executionRef = `conflict-system-mock-execution-${++executionOrdinal}`
          completed.set(executionRef, { plan, outputJson })
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
              detail: 'conflict system-mock exact resource',
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
          async validate() {
            return [{ code: 'conflict-system-mock', ok: true, detail: 'covered by E2E' }]
          },
        },
      })
      let idOrdinal = 0
      const employeeOs = composeDigitalEmployee({
        db,
        appHome,
        typePackages: [developmentEmployeeTypePackage],
        executionContracts,
        inputArtifacts,
        id: () => `conflict-os-${String(++idOrdinal).padStart(5, '0')}`,
        runtime: {
          eventCenter: eventCenter.participant,
          codecs: [developmentEmployeeRuntimeCodec],
          execution,
          platformWorkItems: platform,
        },
      })
      const typeRef = (
        JSON.parse(developmentEmployeeTypePackage.descriptorJson) as {
          readonly typeRef: { readonly typeId: string; readonly revision: number }
        }
      ).typeRef
      const typePackage = employeeOs.queries.getType(typeRef)
      const configuredWorkItems = new Set(['analyze-implement', 'repair-conflict'])
      const bindings: Array<{
        workItemRef: string
        slotRef: string
        registrationRef: { id: string; revision: number }
      }> = []
      for (const item of typePackage.authoringManifest.workItems) {
        if (!configuredWorkItems.has(item.workItemRef)) continue
        for (const role of item.toolRoleGroups) {
          for (const slot of role.bindingSlots) {
            if (!slot.required) continue
            const tool = await employeeOs.commands.createTool({
              typeRef,
              workItemRef: item.workItemRef,
              actorUserId: 'conflict-system-mock-author',
              body: {
                displayName: `${item.workItemRef}/${slot.slotRef}`,
                description: 'conflict System Mock E2E Agent',
                roleRef: role.roleRef,
                implementation: {
                  kind: 'agent' as const,
                  agentRef: { id: `conflict-agent-${item.workItemRef}`, revision: 1 },
                },
              },
            })
            bindings.push({
              workItemRef: item.workItemRef,
              slotRef: slot.slotRef,
              registrationRef: await employeeOs.commands.publishTool({
                typeRef,
                workItemRef: item.workItemRef,
                toolId: tool.id,
                actorUserId: 'conflict-system-mock-author',
              }),
            })
          }
        }
      }
      expect(bindings.map((binding) => binding.workItemRef).sort()).toEqual([
        'analyze-implement',
        'repair-conflict',
      ])
      const job = employeeOs.commands.createJobTemplate({
        typeRef,
        actorUserId: 'conflict-system-mock-author',
        body: {
          name: 'Conflict closure job',
          description: 'Delivery spine plus real conflict repair lane',
          defaultToolBindings: bindings,
        },
      })
      const jobRef = employeeOs.commands.publishJobTemplate({
        id: job.id,
        actorUserId: 'conflict-system-mock-author',
      })
      const employee = employeeOs.commands.createEmployee({
        typeRef,
        actorUserId: 'conflict-system-mock-author',
        body: {
          name: 'Conflict closure employee',
          jobTemplateRef: jobRef,
          workScope: { kind: 'repository', repositoryId },
          toolOverrides: [],
        },
      })
      expect(employee.definition.enabledWorkItemRefs).toEqual(
        expect.arrayContaining(['repair-conflict', 'publish-conflict']),
      )
      const runtime = employeeOs.runtime!
      const launched = runtime.commands.launchWork({
        employeeId: employee.id,
        actorUserId: 'conflict-requester',
        intake: {
          name: 'Close a real target-branch conflict',
          kind: 'body',
          target: { repositoryId },
          body: 'Change X.txt on the source branch and keep the MR recoverable after target moves.',
          externalId: null,
          uploads: [],
          idempotencyKey: 'rfc310-conflict-system-mock',
        },
      })

      const driveUntilIdle = async (budget = 300): Promise<void> => {
        for (let step = 0; step < budget; step += 1) {
          let progress = false
          if (runtime.worker.pumpOneDelivery()) progress = true
          if (runtime.worker.planOneReaction() !== null) progress = true
          if ((await runtime.worker.runOneOutbox()) !== 'idle') progress = true
          const inspected = await runtime.worker.inspectOneExecution()
          if (inspected !== 'idle' && inspected !== 'pending') progress = true
          if (runtime.worker.publishOneChannelResult() !== 'idle') progress = true
          if (!progress) {
            const liveCases = JSON.parse(runtime.queries.listCases()) as Array<{
              activeRoundId: string | null
            }>
            if (liveCases.some((candidate) => candidate.activeRoundId !== null)) {
              await Bun.sleep(2)
              continue
            }
            return
          }
        }
        const pendingOutbox = db
          .select()
          .from(employeeOsOutbox)
          .all()
          .filter((row) => row.state !== 'completed')
        throw new Error(
          `conflict E2E exceeded deterministic budget: ${JSON.stringify({
            projection: JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson),
            pendingOutbox,
          })}`,
        )
      }

      await driveUntilIdle()
      let projection = JSON.parse(runtime.queries.getCase(launched.caseRef.id).projectionJson) as {
        case: { state: string; currentWorkItemRef: string | null }
        contexts: Array<{ typeId: string; state: Record<string, unknown> }>
        rounds: Array<{
          workItemRef: string
          ruleId: string
          state: string
          createdAt: number
        }>
        attention: Array<{ eventTypeRef: { id: string }; subject: { subjectRef: string } }>
      }
      const initialMrContext = projection.contexts.find(
        (context) => context.typeId === 'development.merge-request',
      )
      if (initialMrContext === undefined) {
        throw new Error(
          `conflict E2E did not produce its initial MR: ${JSON.stringify(projection)}`,
        )
      }
      const initialMr = initialMrContext.state
      const mrRef = String(initialMr.providerMrRef)
      const mergeRequestRef = String(initialMr.mergeRequestRef)
      const sourceHead = String(initialMr.headSha)
      expect(initialMr).toMatchObject({
        status: 'active',
        targetSha: baseSha,
        mergeableState: 'mergeable',
        readyToMerge: false,
      })
      expect(projection.case).toMatchObject({ state: 'waiting', currentWorkItemRef: null })
      expect(projection.attention.map((attention) => attention.eventTypeRef.id).sort()).toEqual([
        'development.conflict-updated',
        'development.lifecycle-updated',
      ])
      expect(git(baselineRepo, 'show', `${sourceHead}:X.txt`)).toBe('source change')

      await gitAsync(root, 'clone', '-q', project.repoHttpUrl, targetClone)
      git(targetClone, 'config', 'user.email', 'target@system-mock.test')
      git(targetClone, 'config', 'user.name', 'Target System Mock')
      writeFileSync(join(targetClone, 'X.txt'), 'target change\n')
      git(targetClone, 'add', 'X.txt')
      git(
        targetClone,
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '-m',
        'advance target with conflicting change',
      )
      const targetSha = git(targetClone, 'rev-parse', 'HEAD')
      await gitAsync(targetClone, 'push', '-q', 'origin', 'HEAD:refs/heads/main')

      const conflictedFacts = await collectMergeRequestFacts(hostBinding, mrRef, {
        selfMarker: launched.caseRef.id,
      })
      expect(conflictedFacts).toMatchObject({
        ok: true,
        snapshot: {
          headSha: sourceHead,
          targetSha,
          mergeableState: 'conflict',
        },
      })
      eventCenter.commands.observe({
        sourceRef: { id: 'code-host.activity', revision: 1 },
        eventTypeRef: { id: 'development.conflict-updated', revision: 2 },
        subject: { typeId: 'merge-request', subjectRef: mergeRequestRef },
        occurredAt: Date.now(),
        dedupeKey: `conflict:${mrRef}:${targetSha}`,
        summary: 'the target branch introduced a real Git conflict',
        payloadArtifactRef: null,
      })
      await driveUntilIdle()

      projection = JSON.parse(
        runtime.queries.getCase(launched.caseRef.id).projectionJson,
      ) as typeof projection
      const repairedMr = projection.contexts.find(
        (context) => context.typeId === 'development.merge-request',
      )!.state
      const repairedHead = String(repairedMr.headSha)
      expect(repairedHead).not.toBe(sourceHead)
      expect(repairedMr).toMatchObject({
        factsHeadSha: repairedHead,
        targetSha,
        mergeableState: 'mergeable',
        readyToMerge: false,
      })
      const chronologicalConflictRounds = [...projection.rounds]
        .sort(
          (left, right) =>
            left.createdAt - right.createdAt || left.workItemRef.localeCompare(right.workItemRef),
        )
        .filter(
          (round) =>
            round.ruleId === 'handle-conflict' ||
            round.workItemRef === 'repair-conflict' ||
            round.workItemRef === 'publish-conflict',
        )
      expect(chronologicalConflictRounds).toEqual([
        expect.objectContaining({
          ruleId: 'handle-conflict',
          workItemRef: 'observe-mr',
          state: 'completed',
        }),
        expect.objectContaining({ workItemRef: 'repair-conflict', state: 'completed' }),
        expect.objectContaining({ workItemRef: 'publish-conflict', state: 'completed' }),
      ])
      const publishConflictAt = chronologicalConflictRounds.at(-1)!.createdAt
      expect(
        projection.rounds.some(
          (round) =>
            round.workItemRef === 'observe-mr' &&
            round.state === 'completed' &&
            round.createdAt > publishConflictAt,
        ),
      ).toBe(true)
      expect(git(baselineRepo, 'show', `${repairedHead}:X.txt`)).toBe('source + target resolved')
      expect(git(baselineRepo, 'show', `${repairedHead}:untouched.txt`)).toBe(
        'must remain unchanged',
      )
      const parents = git(baselineRepo, 'rev-list', '--parents', '-n', '1', repairedHead).split(' ')
      expect(parents).toEqual([repairedHead, sourceHead, targetSha])
      expect(
        await gitAsync(
          targetClone,
          'ls-remote',
          project.repoHttpUrl,
          `refs/heads/${String(initialMr.sourceBranch)}`,
        ),
      ).toStartWith(`${repairedHead}\t`)
      const finalFacts = await collectMergeRequestFacts(hostBinding, mrRef, {
        selfMarker: launched.caseRef.id,
      })
      expect(finalFacts).toMatchObject({
        ok: true,
        snapshot: {
          headSha: repairedHead,
          targetSha,
          mergeableState: 'mergeable',
        },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
