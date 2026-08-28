// RFC-310 Digital Employee OS system-mock journey.
//
// Issue ingress is normalized by the real webhook/Event Center path. Pipeline
// and approval systems are real HTTP mocks and their adapters are real child
// programs. The model lane is deterministic by design
// in tests; Git candidate/commit/CAS push and the OS Context+Event lifecycle are
// production participants.

import { createEmployeeReactionRoundQueries } from '@/modules/digital-employee/composition'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'

import {
  SYSTEM_MOCK_CODE_HOST_TOKEN,
  startSystemMockSuite,
  type StartedSystemMockSuite,
} from '@agent-workflow/system-mocks'

import { createInMemoryDb } from '@/db/client'
import { cachedRepos, employeeOsOutbox, webhookDeliveries, webhookEndpoints } from '@/db/schema'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { composeDevelopmentEmployeePlatformWorkItems } from '@/modules/development-automation/composition/digitalEmployeePlatformWorkItems'
import type { PipelineEvidencePort } from '@/modules/development-automation/application/ports/reconcilerPorts'
import { composeDevelopmentEmployeeWorkspace } from '@/modules/development-automation/composition/digitalEmployeeWorkspace'
import {
  developmentEmployeeRuntimeCodec,
  developmentEmployeeTypePackage,
  developmentExecutionContractRegistrations,
} from '@/modules/development-automation/composition/employeeTypePackage'
import { ExecutionContractService } from '@/modules/execution-contract/application/executionContractService'
import {
  createDevelopmentAdapter,
  publishDevelopmentAdapter,
} from '@/modules/integration/application/developmentAdapterCommands'
import { composeApprovalGatewayRunner } from '@/modules/integration/composition/approvalGateway'
import { composeDevelopmentMrEffects } from '@/modules/integration/composition/codeHostEffects'
import { createPipelineEvidenceAdapter } from '@/modules/integration/infrastructure/developmentPipelineAdapter'
import type { AdapterFailureReceipt } from '@/modules/integration/infrastructure/developmentAdapterRunner'
import { createDbAdapterBindingResolver } from '@/modules/integration/infrastructure/developmentRequirementSourceAdapter'
import { collectMergeRequestFacts } from '@/modules/integration/application/mrFacts'
import { staticCachedRepositoryPreparation } from './helpers/staticCachedRepositoryPreparation'
import { createSqliteDevelopmentAdapterStore } from '@/modules/integration/infrastructure/sqliteDevelopmentAdapterStore'
import type { DigitalEmployeeWorkStartPort } from '@/modules/integration/public/participants'
import { codeHostEventCatalogJson } from '@/modules/integration/public/events'
import { composeDigitalEmployee } from '@/modules/digital-employee/composition'
import type { ReactionExecutionPlan } from '@/modules/digital-employee/domain/runtimeModel'
import { createEmployeeInputArtifactStore } from '@/modules/digital-employee/infrastructure/inputArtifactStore'
import { digitalEmployeeLifecycleEventCatalogJson } from '@/modules/digital-employee/public/events'
import { composeEventCenter } from '@/modules/event-center/composition'
import {
  bindCandidateDeliveryParticipant,
  bindChangeCandidateParticipant,
  bindConflictMergeParticipant,
  bindEmployeeCaseWorkspaceParticipant,
} from '@/modules/source-control/composition'
import { mountWebhookIngressRoutes } from '@/routes/webhooks'
import type { AppDeps } from '@/server'
import { createUser } from '@/services/users'
import { createWebhookDispatcher } from '@/services/webhook/webhookDispatch'

setDefaultTimeout(180_000)

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SYSTEM_MOCKS = resolve(import.meta.dir, '..', '..', 'system-mocks', 'src', 'development')
const root = mkdtempSync(join(tmpdir(), 'rfc310-os-system-mock-'))
let suite: StartedSystemMockSuite

beforeAll(async () => {
  suite = await startSystemMockSuite()
})

afterAll(async () => {
  if (suite !== undefined) await suite.close()
  rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  const process = Bun.spawnSync({ cmd: ['git', ...args], cwd })
  if (process.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${process.stderr.toString()}`)
  }
  return process.stdout.toString().trim()
}

// The mock's internal Git transport maps to a real bare repository under the
// system temp root. Using that path keeps Git real while the MR API remains a
// real HTTP system mock (the same arrangement as RFC-310's full journey test).
function mockRepoDiskPath(repoHttpUrl: string): string {
  const pathname = decodeURIComponent(new URL(repoHttpUrl).pathname)
  return join(realpathSync(tmpdir()), pathname.replace(/^\/git\//, ''))
}

function directOutput(body: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(body)
}

const STANDARD_ISSUE_BODY =
  '# Generate src/Main.java and keep the MR green\n\nImplement the generated Java greeting and repair every required gate.'

function contextsOf(plan: ReactionExecutionPlan): Array<{
  id: string
  revision: number
  typeId: string
  stateJson: string
}> {
  const envelope = JSON.parse(plan.inputEnvelopeJson) as { contextsJson: string }
  return JSON.parse(envelope.contextsJson) as ReturnType<typeof contextsOf>
}

describe('RFC-310 Digital Employee OS system mock E2E', () => {
  test('signed ISSUE -> Event Center -> MR -> red gates -> repair -> ready -> merged', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const appHome = join(root, 'home')
    const baselineRepo = join(root, 'baseline')
    const remoteRepo = join(root, 'remote.git')
    const dependencyBaselineRepo = join(root, 'dependency-baseline')
    const dependencyRemoteRepo = join(root, 'dependency-remote.git')
    const deliveryOnlyBaselineRepo = join(root, 'delivery-only-baseline')
    const deliveryOnlyRemoteRepo = join(root, 'delivery-only-remote.git')
    const reviewBaselineRepo = join(root, 'review-baseline')
    const reviewProjectPath = 'rfc310/digital-employee-os-review'
    mkdirSync(baselineRepo, { recursive: true })
    git(baselineRepo, 'init', '-q', '-b', 'main')
    writeFileSync(join(baselineRepo, 'README.md'), '# system-mock baseline\n')
    git(baselineRepo, 'add', '-A')
    git(
      baselineRepo,
      '-c',
      'user.email=system-mock@example.com',
      '-c',
      'user.name=system-mock',
      'commit',
      '-q',
      '-m',
      'baseline',
    )
    mkdirSync(remoteRepo, { recursive: true })
    git(remoteRepo, 'init', '-q', '--bare')
    mkdirSync(dependencyBaselineRepo, { recursive: true })
    git(dependencyBaselineRepo, 'init', '-q', '-b', 'main')
    writeFileSync(join(dependencyBaselineRepo, 'README.md'), '# dependency baseline\n')
    git(dependencyBaselineRepo, 'add', '-A')
    git(
      dependencyBaselineRepo,
      '-c',
      'user.email=system-mock@example.com',
      '-c',
      'user.name=system-mock',
      'commit',
      '-q',
      '-m',
      'dependency baseline',
    )
    mkdirSync(dependencyRemoteRepo, { recursive: true })
    git(dependencyRemoteRepo, 'init', '-q', '--bare')
    mkdirSync(deliveryOnlyBaselineRepo, { recursive: true })
    git(deliveryOnlyBaselineRepo, 'init', '-q', '-b', 'main')
    writeFileSync(join(deliveryOnlyBaselineRepo, 'README.md'), '# delivery-only baseline\n')
    git(deliveryOnlyBaselineRepo, 'add', '-A')
    git(
      deliveryOnlyBaselineRepo,
      '-c',
      'user.email=system-mock@example.com',
      '-c',
      'user.name=system-mock',
      'commit',
      '-q',
      '-m',
      'delivery-only baseline',
    )
    mkdirSync(deliveryOnlyRemoteRepo, { recursive: true })
    git(deliveryOnlyRemoteRepo, 'init', '-q', '--bare')
    const reviewProject = await suite.client.seedCodeHost({
      provider: 'gitlab',
      projectPath: reviewProjectPath,
      title: 'Digital Employee OS review protocol',
      defaultBranch: 'main',
      baseFiles: { README: '# review system-mock baseline\n' },
    })
    const reviewRemoteRepo = mockRepoDiskPath(reviewProject.gitTransportUrl)
    git(root, 'clone', '-q', reviewRemoteRepo, reviewBaselineRepo)
    git(reviewBaselineRepo, 'checkout', '-q', 'main')
    // Deliberately leave the target branch without a remote ref. Ordinary MR
    // readiness consumes the exact target SHA from code-host facts; fetching a
    // target branch is reserved for constructing a real conflict-repair scene.
    db.insert(cachedRepos)
      .values({
        id: 'repo-system-mock',
        urlHash: 'rfc310-system-mock',
        urlEnc: null,
        urlRedacted: remoteRepo,
        localPath: baselineRepo,
        defaultBranch: 'main',
        lastFetchedAt: 1,
        createdAt: 1,
      })
      .run()
    db.insert(cachedRepos)
      .values({
        id: 'repo-system-mock-dependency',
        urlHash: 'rfc310-system-mock-dependency',
        urlEnc: null,
        urlRedacted: dependencyRemoteRepo,
        localPath: dependencyBaselineRepo,
        defaultBranch: 'main',
        lastFetchedAt: 1,
        createdAt: 1,
      })
      .run()
    db.insert(cachedRepos)
      .values({
        id: 'repo-system-mock-delivery-only',
        urlHash: 'rfc310-system-mock-delivery-only',
        urlEnc: null,
        urlRedacted: deliveryOnlyRemoteRepo,
        localPath: deliveryOnlyBaselineRepo,
        defaultBranch: 'main',
        lastFetchedAt: 1,
        createdAt: 1,
      })
      .run()
    db.insert(cachedRepos)
      .values({
        id: 'repo-system-mock-review',
        urlHash: 'rfc310-system-mock-review',
        urlEnc: null,
        urlRedacted: reviewProject.repoHttpUrl,
        localPath: reviewBaselineRepo,
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
      sourceControl: bindEmployeeCaseWorkspaceParticipant(),
      conflictMerge: bindConflictMergeParticipant(),
    })
    const webhookSecret = 'rfc310-issue-ingress-secret'
    const webhookSecretBox = createSecretBoxFromKey(Buffer.alloc(32, 27))
    const webhookOwner = await createUser(db, {
      username: 'rfc310-issue-owner',
      displayName: 'RFC-310 Issue Owner',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    db.insert(webhookEndpoints)
      .values({
        id: 'rfc310-issue-endpoint',
        name: 'RFC-310 ISSUE ingress',
        provider: 'gitlab',
        urlToken: 'rfc310_issue_ingress',
        secretEnc: webhookSecretBox.seal(webhookSecret),
        enabled: true,
      })
      .run()
    let workStartDelegate: DigitalEmployeeWorkStartPort['launch'] | null = null
    const digitalEmployeeWorkStart: DigitalEmployeeWorkStartPort = {
      launch(input) {
        if (workStartDelegate === null) throw new Error('digital employee WorkStart is not bound')
        return workStartDelegate(input)
      },
    }
    const webhookDispatcher = createWebhookDispatcher({
      db,
      configPath: join(appHome, 'config.json'),
      secretBox: webhookSecretBox,
      getDefaultRuntime: async () => null,
      digitalEmployeeWorkStart,
    })
    const eventCenter = composeEventCenter({
      db,
      typePackageDescriptorJsons: [
        developmentEmployeeTypePackage.descriptorJson,
        digitalEmployeeLifecycleEventCatalogJson,
        codeHostEventCatalogJson,
      ],
      automationWorkStart: {
        launch: (input) => webhookDispatcher.dispatchEventTarget(input),
      },
    })
    const webhookApp = new Hono()
    mountWebhookIngressRoutes(webhookApp, {
      db,
      configPath: join(appHome, 'config.json'),
      secretBox: webhookSecretBox,
      webhookDispatcher,
      digitalEmployeeEventCenter: eventCenter,
    } as unknown as AppDeps)
    const adapterStore = createSqliteDevelopmentAdapterStore(db)
    const adapterIdentity = createDevelopmentAdapter(
      adapterStore,
      { userId: 'system-mock-author', actorHasScriptsAuthor: true },
      {
        name: 'system-mock approval gateway',
        content: {
          schemaVersion: 1,
          purpose: 'approval-gateway',
          operations: ['submit', 'lookup-by-idempotency-key', 'observe'],
          contractVersion: 1,
          executableRef: join(SYSTEM_MOCKS, 'approval-adapter-cli.ts'),
          parameterSchemaRef: null,
          connectionRef: null,
          secretProjection: [],
          outputBudget: {
            maxFiles: 10,
            maxFileBytes: 1024 * 1024,
            maxTotalBytes: 8 * 1024 * 1024,
          },
          timeoutMs: 30_000,
        },
        now: 1,
      },
    )
    const approvalAdapterRevision = publishDevelopmentAdapter(
      adapterStore,
      { userId: 'system-mock-author', actorHasScriptsAuthor: true },
      { id: adapterIdentity.id, now: 2 },
    )
    const approvalAdapterRef = {
      id: adapterIdentity.id,
      revision: approvalAdapterRevision.revision,
    }
    const pipelineAdapterIdentity = createDevelopmentAdapter(
      adapterStore,
      { userId: 'system-mock-author', actorHasScriptsAuthor: true },
      {
        name: 'system-mock pipeline gateway',
        content: {
          schemaVersion: 1,
          purpose: 'pipeline-gate',
          operations: ['collect', 'trigger', 'rerun'],
          contractVersion: 1,
          executableRef: join(SYSTEM_MOCKS, 'pipeline-adapter-cli.ts'),
          parameterSchemaRef: null,
          connectionRef: null,
          secretProjection: [],
          outputBudget: {
            maxFiles: 100,
            maxFileBytes: 8 * 1024 * 1024,
            maxTotalBytes: 32 * 1024 * 1024,
          },
          timeoutMs: 30_000,
        },
        now: 3,
      },
    )
    const pipelineAdapterRevision = publishDevelopmentAdapter(
      adapterStore,
      { userId: 'system-mock-author', actorHasScriptsAuthor: true },
      { id: pipelineAdapterIdentity.id, now: 4 },
    )
    const pipelineConnectionRef = {
      id: pipelineAdapterIdentity.id,
      revision: pipelineAdapterRevision.revision,
    }
    const connectionByPurpose = {
      'pipeline-gate': pipelineConnectionRef,
      'approval-gateway': approvalAdapterRef,
    } as const
    const approvalGateway = composeApprovalGatewayRunner(db, {
      approvalMockUrl: suite.endpoints.developmentApprovalBaseUrl,
    })
    const pipelineRunner = createPipelineEvidenceAdapter({
      resolveBinding: createDbAdapterBindingResolver((id, revision) =>
        adapterStore.getRevision(id, revision),
      ),
      extraEnv: { AW_PIPELINE_MOCK_URL: suite.endpoints.developmentPipelineBaseUrl },
      secretSource: {},
    })
    const pipelineFailure = (failure: AdapterFailureReceipt) => ({
      ok: false as const,
      failure,
    })
    const pipelineEvidence: PipelineEvidencePort = {
      async collect(input) {
        const stagedRoot = mkdtempSync(join(tmpdir(), 'rfc323-system-mock-pipeline-'))
        const result = await pipelineRunner.collect({ ...input, sinkPath: stagedRoot })
        if (!result.ok) {
          rmSync(stagedRoot, { recursive: true, force: true })
          return pipelineFailure(result.failure)
        }
        return {
          ok: true as const,
          envelope: result.envelope,
          stagedRoot,
          outputBudget: result.outputBudget,
          cleanup: () => rmSync(stagedRoot, { recursive: true, force: true }),
        }
      },
      async trigger(input) {
        const stagedRoot = mkdtempSync(join(tmpdir(), 'rfc323-system-mock-trigger-'))
        try {
          const result = await pipelineRunner.trigger({ ...input, sinkPath: stagedRoot })
          if (!result.ok) return pipelineFailure(result.failure)
          return {
            ok: true,
            runRef: result.envelope.runRef,
            providerReceiptRef: result.envelope.providerReceiptRef,
            adopted: result.envelope.adopted,
          }
        } finally {
          rmSync(stagedRoot, { recursive: true, force: true })
        }
      },
      async rerun(input) {
        const stagedRoot = mkdtempSync(join(tmpdir(), 'rfc323-system-mock-rerun-'))
        try {
          const result = await pipelineRunner.rerun({ ...input, sinkPath: stagedRoot })
          if (!result.ok) return pipelineFailure(result.failure)
          return {
            ok: true,
            runRef: result.envelope.runRef,
            attempt: result.envelope.attempt,
            providerReceiptRef: result.envelope.providerReceiptRef,
          }
        } finally {
          rmSync(stagedRoot, { recursive: true, force: true })
        }
      },
    }

    const completed = new Map<
      string,
      { readonly plan: ReactionExecutionPlan; readonly outputJson: string }
    >()
    const reviewRepairInputs: Array<{
      readonly threadRef: string
      readonly bodies: readonly string[]
    }> = []
    let executionOrdinal = 0
    const execution = {
      async launch(plan: ReactionExecutionPlan, attempt: { ordinal: number; mode: string }) {
        const scene = await workspace.prepare({
          planJson: JSON.stringify(plan),
          attemptJson: JSON.stringify({ ...attempt, previousError: null }),
        })
        if (scene.kind !== 'repository')
          throw new Error(`${plan.workItemRef} needs repository scene`)
        const inputEnvelope = JSON.parse(plan.inputEnvelopeJson) as {
          contractInput: Record<string, unknown>
          platformPaths: {
            requirementDirectory: string
            externalMaterialDirectory: string
            pipelineDirectory: string
          }
        }
        const externalMaterialDirectory = inputEnvelope.platformPaths.externalMaterialDirectory
        const pipelineMount = inputEnvelope.platformPaths.pipelineDirectory
        const contexts = contextsOf(plan)
        let outputJson: string
        if (plan.workItemRef === 'prepare-materials') {
          expect(plan.connectionRef).toBeNull()
          const issue = contexts.find((context) => context.typeId === 'development.issue-handling')!
          const issueState = JSON.parse(issue.stateJson) as {
            request: { kind: string; body: string | null; externalId: string | null }
            materialArtifactRefs: string[]
          }
          expect(issueState.request).toMatchObject({ kind: 'body', externalId: null })
          expect(issueState.request.body).toContain('Generate src/Main.java')
          expect(inputEnvelope.contractInput.materialTargetDirectory).toBe(
            externalMaterialDirectory,
          )
          outputJson = directOutput({ outcome: 'completed' })
        } else if (plan.workItemRef === 'analyze-implement') {
          const issue = contexts.find((context) => context.typeId === 'development.issue-handling')!
          const issueState = JSON.parse(issue.stateJson) as {
            request: { kind: string; body: string | null }
          }
          const delegated = issueState.request.body?.includes('development.cross-repository-work')
          if (delegated) {
            expect(issueState.request.kind).toBe('body')
            expect(issueState.request.body).toContain(
              '"assignedFailureType": "external-dependency"',
            )
            expect(issueState.request.body).toContain('repo-system-mock-dependency')
            expect(issueState.request.body).not.toContain('当前仓库需要修复编译失败')
          } else {
            expect(issueState.request.kind).toBe('body')
            expect(issueState.request.body).toContain('Generate src/Main.java')
          }
          mkdirSync(join(scene.workspacePath, 'src'), { recursive: true })
          writeFileSync(
            join(scene.workspacePath, 'src', 'Main.java'),
            'public final class Main { public static String greeting() { return "hello"; } }\n',
          )
          outputJson = directOutput({
            outcome: 'completed',
            commitMessage: delegated
              ? 'implement delegated dependency contract'
              : 'implement Java greeting\n\nGenerate the requested source and preserve uploaded materials.',
            mergeRequestTitle: delegated
              ? 'Implement delegated dependency contract'
              : 'Implement Java greeting',
            mergeRequestDescription: delegated
              ? '## Summary\n\nImplements the frozen cross-repository dependency request.'
              : '## Summary\n\nImplements the requested Java greeting and its verification.',
          })
        } else if (plan.workItemRef === 'classify-pipeline') {
          const pipeline = contexts.find((context) => context.typeId === 'development.pipeline')!
          const pipelineState = JSON.parse(pipeline.stateJson) as {
            checks: Array<{ checkRef: string; status: string }>
          }
          const failedChecks = pipelineState.checks.filter((check) =>
            ['failed', 'canceled'].includes(check.status),
          )
          expect(failedChecks.length).toBeGreaterThan(0)
          const groups = [
            ...(() => {
              const refs = failedChecks
                .filter((check) => check.checkRef === 'external-dependency')
                .map((check) => check.checkRef)
              return refs.length === 0 ? [] : [{ type: 'external-dependency', checkRefs: refs }]
            })(),
            ...(() => {
              const refs = failedChecks
                .filter((check) => check.checkRef !== 'external-dependency')
                .map((check) => check.checkRef)
              return refs.length === 0 ? [] : [{ type: 'other-pipeline-failure', checkRefs: refs }]
            })(),
          ]
          outputJson = directOutput({
            outcome: 'completed',
            groups,
          })
        } else if (plan.workItemRef === 'repair-pipeline') {
          const problemSet = contexts.find(
            (context) => context.typeId === 'development.problem-set',
          )!
          const problemState = JSON.parse(problemSet.stateJson) as {
            remainingTypes: string[]
            problems: Array<{ type: string; evidenceArtifactRefs: string[] }>
          }
          expect(inputEnvelope.contractInput.assignedFailureType).toBe('other-pipeline-failure')
          expect(problemState.remainingTypes).toContain('other-pipeline-failure')
          expect(
            problemState.problems.find((problem) => problem.type === 'other-pipeline-failure')
              ?.evidenceArtifactRefs,
          ).toEqual([expect.stringContaining(`${pipelineMount}/`)])
          const sourceFile = join(scene.workspacePath, 'src', 'Main.java')
          expect(readFileSync(sourceFile, 'utf8')).toContain('return "hello"')
          writeFileSync(
            sourceFile,
            'public final class Main { public static String greeting() { return "hello pipeline-fixed"; } }\n',
          )
          outputJson = directOutput({
            outcome: 'completed',
            commitMessage:
              'repair pipeline failure\n\nUse the collected gate evidence to repair the current head.',
          })
        } else if (plan.workItemRef === 'repair-feedback') {
          const problemSet = contexts.find(
            (context) => context.typeId === 'development.problem-set',
          )!
          const resolution = contexts.find(
            (context) => context.typeId === 'development.review-resolution',
          )!
          const problemState = JSON.parse(problemSet.stateJson) as {
            problems: Array<{
              problemId: string
              reviewThread: {
                threadRef: string
                messages: Array<{ body: string }>
              }
            }>
          }
          const resolutionState = JSON.parse(resolution.stateJson) as {
            status: string
            mergeRequestRef: string
            sourceHeadSha: string
            publishedHeadSha: string | null
            commitSha: string | null
            threads: Array<{
              threadRef: string
              revision: string
              acknowledgement: { marker: string; noteRef: string } | null
              disposition: 'addressed' | 'needs-human' | null
              replyBody: string | null
              finalReply: { marker: string; noteRef: string } | null
            }>
          }
          for (const problem of problemState.problems) {
            reviewRepairInputs.push({
              threadRef: problem.reviewThread.threadRef,
              bodies: problem.reviewThread.messages.map((message) => message.body),
            })
          }
          const sourceFile = join(scene.workspacePath, 'src', 'Main.java')
          expect(readFileSync(sourceFile, 'utf8')).toContain('return "hello"')
          writeFileSync(
            sourceFile,
            'public final class Main { public static String greeting() { return "hello reviewed"; } }\n',
          )
          outputJson = directOutput({
            outcome: 'completed',
            commitMessage:
              'address review feedback\n\nApply the requested greeting adjustment and verification.',
            replies: resolutionState.threads.map((thread) => ({
              threadRef: thread.threadRef,
              reply: '已按完整讨论上下文调整 greeting 的实现。',
            })),
          })
        } else if (plan.workItemRef === 'prepare-approval') {
          const mergeRequest = contexts.find(
            (context) => context.typeId === 'development.merge-request',
          )!
          const mergeRequestState = JSON.parse(mergeRequest.stateJson) as {
            mergeRequestRef: string
            headSha: string
          }
          expect(plan.connectionRef).toEqual(approvalAdapterRef)
          outputJson = directOutput({
            outcome: 'completed',
            draft: `## 变更审批\n\nMR ${mergeRequestState.mergeRequestRef} 当前版本 ${mergeRequestState.headSha} 的门禁已通过，请审批。`,
          })
        } else {
          throw new Error(`unexpected test execution work item: ${plan.workItemRef}`)
        }
        const executionRef = `system-mock-execution-${++executionOrdinal}`
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
            // RFC-317 T31（DE-03）—— 类别原样转发，system mock 不自己判：这条链上
            // 「边界违规要换干净场景」正是被测的性质，mock 一旦自己编类别就测不到了。
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

    const repositoryFixtures = new Map([
      ['repo-system-mock', { baselineRepo, remoteRepo, mrRef: '42' }],
      [
        'repo-system-mock-dependency',
        { baselineRepo: dependencyBaselineRepo, remoteRepo: dependencyRemoteRepo, mrRef: '84' },
      ],
      [
        'repo-system-mock-delivery-only',
        {
          baselineRepo: deliveryOnlyBaselineRepo,
          remoteRepo: deliveryOnlyRemoteRepo,
          mrRef: '126',
        },
      ],
      [
        'repo-system-mock-review',
        { baselineRepo: reviewBaselineRepo, remoteRepo: reviewRemoteRepo, mrRef: 'provider' },
      ],
    ])
    const mrStates = new Map<string, 'opened' | 'merged'>([
      ['repo-system-mock', 'opened'],
      ['repo-system-mock-dependency', 'opened'],
      ['repo-system-mock-delivery-only', 'opened'],
    ])
    const approvalRequiredRepositoryIds = new Set(['repo-system-mock'])
    const mrHeads = new Map<string, string>()
    const mrRefs = new Map<string, string>()
    const mrDescriptions = new Map<string, string>()
    const reviewHostBinding = {
      provider: 'gitlab' as const,
      project: encodeURIComponent(reviewProjectPath),
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
    const reviewMrEffects = composeDevelopmentMrEffects({
      binding: (repositoryId) =>
        repositoryId === 'repo-system-mock-review' ? reviewHostBinding : null,
    })
    const platform = composeDevelopmentEmployeePlatformWorkItems({
      reactionRounds: createEmployeeReactionRoundQueries(db),
      db,
      appHome,
      approvalGateway,
      pipelineEvidence,
      conflictMerge: bindConflictMergeParticipant(),
      sourceControl: {
        ...bindChangeCandidateParticipant(),
        ...bindCandidateDeliveryParticipant(),
        ...bindEmployeeCaseWorkspaceParticipant(),
      },
      repoRemote: {
        resolve(repositoryId) {
          const fixture = repositoryFixtures.get(repositoryId)
          return fixture === undefined
            ? null
            : { remoteUrl: fixture.remoteRepo, defaultBranch: 'main' }
        },
      },
      mrEffects: {
        async reply(repositoryId, request) {
          if (repositoryId === 'repo-system-mock-review') {
            return await reviewMrEffects.reply(repositoryId, request)
          }
          return {
            ok: true as const,
            noteRef: `note:${request.threadRef}:${request.selfMarker}`,
          }
        },
        async ensure(repositoryId, request) {
          if (repositoryId === 'repo-system-mock-review') {
            const ensured = await reviewMrEffects.ensure(repositoryId, request)
            if (ensured.ok) {
              if (ensured.mr.sourceSha !== null) mrHeads.set(repositoryId, ensured.mr.sourceSha)
              mrRefs.set(repositoryId, ensured.mr.mrRef)
            }
            return ensured
          }
          const fixture = repositoryFixtures.get(repositoryId)!
          mrDescriptions.set(repositoryId, request.description ?? '')
          const head = git(fixture.remoteRepo, 'rev-parse', `refs/heads/${request.sourceBranch}`)
          mrHeads.set(repositoryId, head)
          return {
            ok: true as const,
            mr: {
              mrRef: fixture.mrRef,
              webUrl: `https://system-mock.example/${repositoryId}/mr/${fixture.mrRef}`,
              state: mrStates.get(repositoryId)!,
              sourceSha: head,
              created: true,
            },
          }
        },
        async observe(repositoryId, mrRef) {
          if (repositoryId === 'repo-system-mock-review') {
            return await reviewMrEffects.observe(repositoryId, mrRef)
          }
          const fixture = repositoryFixtures.get(repositoryId)!
          return {
            ok: true as const,
            observation: {
              state: mrStates.get(repositoryId)!,
              sourceSha: mrHeads.get(repositoryId)!,
              targetBranch: 'main',
              webUrl: `https://system-mock.example/${repositoryId}/mr/${fixture.mrRef}`,
            },
          }
        },
      },
      mrFacts: {
        async collect(repositoryId, mrRef, selfMarker) {
          if (repositoryId === 'repo-system-mock-review') {
            const collected = await collectMergeRequestFacts(reviewHostBinding, mrRef, {
              selfMarker,
            })
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
          }
          const fixture = repositoryFixtures.get(repositoryId)!
          const state = mrStates.get(repositoryId)!
          const head = mrHeads.get(repositoryId)!
          return {
            ok: true as const,
            snapshot: {
              state,
              headSha: head,
              targetSha: git(fixture.baselineRepo, 'rev-parse', 'HEAD'),
              targetBranch: 'main',
              draft: false,
              mergeableState: 'mergeable' as const,
              approvalHold: approvalRequiredRepositoryIds.has(repositoryId),
              mergedCommitSha: state === 'merged' ? head : null,
              unresolvedReviewCount: 0,
              reviewThreads: [],
            },
          }
        },
      },
    })

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
            detail: 'system-mock exact resource',
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
          return [{ code: 'system-mock-program-fixture', ok: true, detail: 'covered by journey' }]
        },
      },
    })
    const employeeOs = composeDigitalEmployee({
      db,
      appHome,
      typePackages: [developmentEmployeeTypePackage],
      executionContracts,
      inputArtifacts,
      id: () => `os-${String(++idOrdinal).padStart(5, '0')}`,
      connectionCatalog: {
        resolve(ref) {
          const match = Object.entries(connectionByPurpose).find(
            ([, candidate]) => candidate.id === ref.id && candidate.revision === ref.revision,
          )
          if (match === undefined) return null
          return {
            ref,
            purpose: match[0],
            available: true,
            visible: true,
            contentDigest: '0'.repeat(64),
            closureSummary: `system-mock exact ${match[0]} connection`,
          }
        },
      },
      runtime: {
        eventCenter: eventCenter.participant,
        codecs: [developmentEmployeeRuntimeCodec],
        execution,
        platformWorkItems: platform,
      },
    })
    // 从内置包的 descriptor **派生**，不手抄修订号。
    // 这条测试本来写死 `revision: 6`，内置包升到 7 之后它就红在
    // `employee type not found: development@6`——一个与被测行为毫无关系的失败，
    // 而且每次内置包升版都要再修一次。手抄的常量必然过期（RFC-317 一路在讲的同一件事）。
    const typeRef = (
      JSON.parse(developmentEmployeeTypePackage.descriptorJson) as {
        readonly typeRef: { readonly typeId: string; readonly revision: number }
      }
    ).typeRef
    const typePackage = employeeOs.queries.getType(typeRef)
    const pipelineProblemDefinitions = [
      {
        routeRef: 'external-dependency',
        displayName: '外部仓库依赖',
        description: '调起另一个数字员工处理依赖仓库',
        fallback: false,
      },
      {
        routeRef: 'other-pipeline-failure',
        displayName: '其他流水线错误',
        description: '交给通用流水线修复 Agent',
        fallback: true,
      },
    ]
    const bindings: Array<{
      workItemRef: string
      slotRef: string
      registrationRef: { id: string; revision: number }
    }> = []
    for (const item of typePackage.authoringManifest.workItems) {
      for (const role of item.toolRoleGroups) {
        for (const slot of role.bindingSlots) {
          if (!slot.required && item.workItemRef !== 'prepare-materials') continue
          const contract = typePackage.workContracts.find(
            (candidate) =>
              candidate.contractId === item.workContractRef.contractId &&
              candidate.version === item.workContractRef.version,
          )!
          const implementation =
            item.workItemRef === 'prepare-materials'
              ? {
                  kind: 'program' as const,
                  runtimeKind: 'bash' as const,
                  source: `printf '%s\\n' '{"outcome":"completed"}'`,
                  runtimeProfileRef: { id: 'builtin:script-runtime', revision: 1 },
                }
              : contract.allowedToolKinds.includes('agent')
                ? {
                    kind: 'agent' as const,
                    agentRef: { id: `system-mock-agent-${item.workItemRef}`, revision: 1 },
                  }
                : {
                    kind: 'workflow' as const,
                    workflowRef: { id: `system-mock-workflow-${item.workItemRef}`, revision: 1 },
                  }
          const tool = await employeeOs.commands.createTool({
            typeRef,
            workItemRef: item.workItemRef,
            actorUserId: 'system-mock-author',
            body: {
              displayName: `${item.workItemRef}/${slot.slotRef}`,
              description: 'system-mock journey tool',
              roleRef: role.roleRef,
              implementation,
              ...(item.workItemRef === 'classify-pipeline'
                ? { dispatchRouteDefinitions: pipelineProblemDefinitions }
                : {}),
              ...(item.workItemRef === 'repair-pipeline'
                ? {
                    acceptedDispatchRoutes: [
                      { classifierWorkItemRef: 'classify-pipeline', routeRefs: ['*'] },
                    ],
                  }
                : {}),
            },
          })
          expect(
            tool.validationReceipt.status,
            `${item.workItemRef}/${slot.slotRef}: ${JSON.stringify(tool.validationReceipt.checks)}`,
          ).toBe('valid')
          bindings.push({
            workItemRef: item.workItemRef,
            slotRef: slot.slotRef,
            registrationRef: await employeeOs.commands.publishTool({
              typeRef,
              workItemRef: item.workItemRef,
              toolId: tool.id,
              actorUserId: 'system-mock-author',
            }),
          })
        }
      }
    }
    const pipelineRepairTool = await employeeOs.commands.createTool({
      typeRef,
      workItemRef: 'repair-pipeline',
      actorUserId: 'system-mock-author',
      body: {
        displayName: 'system-mock 通用流水线修复 Agent',
        description: '处理岗位配置路由到流水线修复职责的错误类型',
        roleRef: 'repairer',
        implementation: {
          kind: 'agent',
          agentRef: { id: 'system-mock-agent-repair-pipeline', revision: 1 },
        },
        acceptedDispatchRoutes: [{ classifierWorkItemRef: 'classify-pipeline', routeRefs: ['*'] }],
      },
    })
    const pipelineRepairRef = await employeeOs.commands.publishTool({
      typeRef,
      workItemRef: 'repair-pipeline',
      toolId: pipelineRepairTool.id,
      actorUserId: 'system-mock-author',
    })
    const defaultAdapterBindings = [
      {
        laneId: 'care-pipeline',
        slotRef: 'primary',
        adapterRef: pipelineConnectionRef,
      },
      {
        laneId: 'care-approval',
        slotRef: 'primary',
        adapterRef: approvalAdapterRef,
      },
    ]
    const dependencyJob = employeeOs.commands.createJobTemplate({
      typeRef,
      actorUserId: 'system-mock-author',
      body: {
        name: '依赖仓库 Java 岗位',
        description: '在另一个仓库完成配套变更',
        defaultToolBindings: bindings,
        defaultAdapterBindings,
        orderedDispatchConfigurations: [
          {
            classifierWorkItemRef: 'classify-pipeline',
            routes: [
              {
                routeRef: 'external-dependency',
                displayName: '外部仓库依赖',
                description: '调起另一个数字员工处理依赖仓库',
                destinationWorkItemRef: 'repair-pipeline',
                registrationRef: pipelineRepairRef,
                fallback: false,
              },
              {
                routeRef: 'other-pipeline-failure',
                displayName: '其他流水线错误',
                description: '交给通用流水线修复 Agent',
                destinationWorkItemRef: 'repair-pipeline',
                registrationRef: pipelineRepairRef,
                fallback: true,
              },
            ],
          },
        ],
      },
    })
    const dependencyJobRef = employeeOs.commands.publishJobTemplate({
      id: dependencyJob.id,
      actorUserId: 'system-mock-author',
    })
    const dependencyEmployee = employeeOs.commands.createEmployee({
      typeRef,
      actorUserId: 'system-mock-author',
      body: {
        name: '依赖仓库数字员工',
        jobTemplateRef: dependencyJobRef,
        workScope: { kind: 'repository', repositoryId: 'repo-system-mock-dependency' },
        toolOverrides: [],
      },
    })
    const dependencyEmployeeRef = {
      id: dependencyEmployee.id,
      revision: dependencyEmployee.revision,
    }
    const job = employeeOs.commands.createJobTemplate({
      typeRef,
      actorUserId: 'system-mock-author',
      body: {
        name: 'Java system-mock 岗位',
        description: '需求、流水线、跨仓协同和外部审批完整链路',
        defaultToolBindings: bindings,
        defaultAdapterBindings,
        defaultCollaborationBindings: [
          {
            workItemRef: 'delegate',
            memberRef: 'dependency-repository',
            targetEmployeeRef: dependencyEmployeeRef,
            invocationContractId: 'development.cross-repository-work',
            joinMode: 'all',
            quorum: null,
          },
        ],
        orderedDispatchConfigurations: [
          {
            classifierWorkItemRef: 'classify-pipeline',
            routes: [
              {
                routeRef: 'external-dependency',
                displayName: '外部仓库依赖',
                description: '调起另一个数字员工处理依赖仓库',
                destinationWorkItemRef: 'delegate',
                registrationRef: null,
                fallback: false,
              },
              {
                routeRef: 'other-pipeline-failure',
                displayName: '其他流水线错误',
                description: '交给通用流水线修复 Agent',
                destinationWorkItemRef: 'repair-pipeline',
                registrationRef: pipelineRepairRef,
                fallback: true,
              },
            ],
          },
        ],
      },
    })
    const jobRef = employeeOs.commands.publishJobTemplate({
      id: job.id,
      actorUserId: 'system-mock-author',
    })
    const employee = employeeOs.commands.createEmployee({
      typeRef,
      actorUserId: 'system-mock-author',
      body: {
        name: 'Java system-mock 数字员工',
        jobTemplateRef: jobRef,
        workScope: { kind: 'repository', repositoryId: 'repo-system-mock' },
        toolOverrides: [],
      },
    })
    const employeeRef = { id: employee.id, revision: employee.revision }
    const optionalLaneIds = new Set(
      typePackage.authoringManifest.lifecycleRegions.flatMap((region) =>
        region.responsibilityLanes.filter((lane) => lane.optional).map((lane) => lane.laneId),
      ),
    )
    const coreWorkItemRefs = typePackage.authoringManifest.workItems
      .filter(
        (item) =>
          item.responsibilityLaneId === null || !optionalLaneIds.has(item.responsibilityLaneId),
      )
      .map((item) => item.workItemRef)
    const coreBindings = bindings.filter((binding) =>
      coreWorkItemRefs.includes(binding.workItemRef),
    )
    const runtime = employeeOs.runtime!
    workStartDelegate = (input) => {
      const launched = runtime.commands.launchWork({
        employeeId: input.employeeId,
        actorUserId: input.actorUserId,
        intake: input.intake,
        eventOrigin: input.origin,
      })
      return { caseId: launched.caseRef.id }
    }
    const issueRule = eventCenter.responseRules.commands.create(
      {
        name: 'ISSUE 交给研发数字员工',
        enabled: true,
        eventTypeRef: { id: 'code-host.issue.labeled', revision: 1 },
        subjectMatch: 'all',
        subjectPattern: null,
        target: {
          kind: 'digital-employee',
          refId: employeeRef.id,
          intakeKind: 'body',
          // Public employee authoring contracts use camelCase form refs. Keep
          // this full ingress chain as the regression for Event Center accepting
          // and rendering the real `repositoryId` target field.
          target: { repositoryId: 'repo-system-mock' },
          valueTemplate:
            '# {{trigger.code_host.issue_title}}\n\n{{trigger.code_host.issue_body}}\n\nIssue: {{trigger.code_host.issue_iid}}\nURL: {{trigger.code_host.issue_url}}',
        },
      },
      {
        userId: webhookOwner.id,
        canOverrideOwner: false,
        hasPermission: () => true,
      },
    )
    const issueBody = JSON.stringify({
      object_kind: 'issue',
      project: {
        id: 310,
        path_with_namespace: 'rfc310/digital-employee-os',
        git_http_url: 'https://gitlab.example/rfc310/digital-employee-os.git',
        git_ssh_url: 'git@gitlab.example:rfc310/digital-employee-os.git',
        web_url: 'https://gitlab.example/rfc310/digital-employee-os',
        default_branch: 'main',
      },
      user: { username: 'issue-author' },
      labels: [{ title: 'aw:implement' }],
      object_attributes: {
        iid: 'REQ-OS-42',
        title: 'Generate src/Main.java and keep the MR green',
        description: 'Implement a deterministic greeting and repair every required gate.',
        url: 'https://gitlab.example/rfc310/digital-employee-os/-/issues/42',
        action: 'update',
      },
      changes: {
        labels: { previous: [], current: [{ title: 'aw:implement' }] },
      },
    })
    const issueResponse = await webhookApp.request('/webhooks/gitlab/rfc310_issue_ingress', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gitlab-event': 'Issue Hook',
        'x-gitlab-event-uuid': 'rfc310-issue-labeled-delivery',
        'x-gitlab-token': webhookSecret,
      },
      body: issueBody,
    })
    expect(issueResponse.status).toBe(200)
    const issueReceipt = (await issueResponse.json()) as { deliveryId: string; status: string }
    expect(issueReceipt.status).toBe('received')
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await eventCenter.worker.runOneNotification()
      const accepted = eventCenter.queries.operations
        .deliveryStatuses()
        .some(
          (delivery) =>
            delivery.subscriber.subscriberRef === `event-response-rule:${issueRule.id}` &&
            delivery.state === 'accepted',
        )
      if ((JSON.parse(runtime.queries.listCases()) as unknown[]).length > 0 && accepted) break
      await Bun.sleep(1)
    }
    const ingressCases = JSON.parse(runtime.queries.listCases()) as Array<{ id: string }>
    expect(ingressCases).toHaveLength(1)
    const caseId = ingressCases[0]!.id
    expect(
      eventCenter.queries.operations
        .eventRecordPage({ page: 1, limit: 100, sourceId: 'code-host.activity' })
        .items.filter((event) => event.eventTypeRef.id === 'code-host.issue.labeled')
        .map((event) => event.eventTypeRef.id),
    ).toEqual(['code-host.issue.labeled'])
    expect(
      eventCenter.queries.operations
        .deliveryStatuses()
        .find(
          (delivery) => delivery.subscriber.subscriberRef === `event-response-rule:${issueRule.id}`,
        ),
    ).toMatchObject({ state: 'accepted' })
    expect(
      db
        .select({ status: webhookDeliveries.status })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, issueReceipt.deliveryId))
        .get(),
    ).toEqual({ status: 'matched' })

    const driveUntilIdle = async (budget = 300): Promise<void> => {
      for (let step = 0; step < budget; step += 1) {
        let progress = false
        if (runtime.worker.pumpOneDelivery()) progress = true
        if (runtime.worker.planOneReaction() !== null) progress = true
        // Keep the same owner order as the production OS worker: a round
        // planned in this turn must be able to dispatch its durable outbox in
        // the same turn. Otherwise a sub-millisecond test turn can observe the
        // newly written nextAttemptAt before the wall clock reaches it and
        // incorrectly call a live Case idle.
        const outbox = await runtime.worker.runOneOutbox()
        if (outbox !== 'idle') progress = true
        const inspected = await runtime.worker.inspectOneExecution()
        if (inspected !== 'idle' && inspected !== 'pending') progress = true
        if (runtime.worker.publishOneChannelResult() !== 'idle') progress = true
        if (!progress) {
          // The durable outbox uses a millisecond retry timestamp. A fully
          // deterministic adapter can finish inside that same millisecond, so
          // one idle probe is not proof that an active round is quiescent.
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
      const cases = JSON.parse(runtime.queries.listCases()) as Array<{
        id: string
        state: string
        currentWorkItemRef: string | null
        activeRoundId: string | null
      }>
      const caseDiagnostics = cases.map((candidate) => {
        const candidateProjection = JSON.parse(
          runtime.queries.getCase(candidate.id).projectionJson,
        ) as { rounds?: Array<Record<string, unknown>> }
        const summarizeRound = (round: Record<string, unknown> | undefined) =>
          round === undefined
            ? null
            : {
                id: round.id,
                workItemRef: round.workItemRef,
                state: round.state,
                executionRef: round.executionRef,
                attemptOrdinal: round.attemptOrdinal,
                outputJson:
                  typeof round.outputJson === 'string'
                    ? round.outputJson.slice(0, 2_000)
                    : round.outputJson,
              }
        const rounds = candidateProjection.rounds ?? []
        return {
          ...candidate,
          activeRound: summarizeRound(rounds.find((round) => round.id === candidate.activeRoundId)),
          recentRounds: rounds.slice(-3).map(summarizeRound),
        }
      })
      const pendingOutbox = db
        .select()
        .from(employeeOsOutbox)
        .all()
        .filter((row) => row.state !== 'completed')
        .map((row) => ({
          id: row.id,
          caseId: row.caseId,
          kind: row.kind,
          state: row.state,
          attemptCount: row.attemptCount,
          nextAttemptAt: row.nextAttemptAt,
          now: Date.now(),
          lastError: row.lastError,
        }))
      throw new Error(
        `Digital Employee OS journey exceeded deterministic step budget: ${JSON.stringify({ cases: caseDiagnostics, pendingOutbox })}`,
      )
    }

    await driveUntilIdle()
    let projection = JSON.parse(runtime.queries.getCase(caseId).projectionJson) as {
      case: {
        state: string
        currentWorkItemRef: string | null
        employeeRef: { id: string; revision: number }
      }
      contexts: Array<{ typeId: string; state: Record<string, unknown> }>
      channels: Array<{
        childCaseId: string
        state: string
        targetEmployeeRef: { id: string; revision: number }
      }>
      rounds: Array<{
        id: string
        workItemRef: string
        state: string
        executionRef: string | null
        toolRef: { id: string; revision: number } | null
        workContractRef: { contractId: string; version: number }
        inputContextRefsJson: string
        planJson: string
        outputJson: string | null
        attemptOrdinal: number
        createdAt: number
        updatedAt: number
        settledAt: number | null
      }>
      reviewGates: Array<{
        parentWorkItemRef: string
        optionRef: string
        state: string
        /** RFC-310：人工检视闸口回指的那次执行；未到达的闸口为 null。 */
        executionRef: string | null
      }>
    }
    const chronologicalRounds = [...projection.rounds].sort(
      (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    )
    expect(chronologicalRounds.slice(0, 2).map((round) => round.workItemRef)).toEqual([
      'prepare-materials',
      'analyze-implement',
    ])
    // `executionRef` 是 RFC-310 新增的回指：闸口要能把人带到**具体哪一次执行**去完成
    // 检视，否则前端只知道「有个闸口在等」却不知道等在哪。这里钉死具体的
    // `system-mock-execution-1` 而不是「非空即可」——标准 Issue 的 prepare-materials
    // 由平台处理，不占用外部 executor；本用例整条链路都是确定性 system
    // mock（上一条断言同样钉死了轮次的精确顺序），所以这个 id 是可预言的；它要是漂了，
    // 说明 mock 的确定性真的坏了，那正是本用例该报的事。
    expect(projection.reviewGates).toContainEqual({
      parentWorkItemRef: 'analyze-implement',
      optionRef: 'review-implementation-plan',
      state: 'skipped',
      executionRef: 'system-mock-execution-1',
    })
    const parentMrHead = mrHeads.get('repo-system-mock')!
    // RFC-323: approval drafting is downstream of terminal pipeline evidence.
    // A pending gate must not submit a draft that becomes stale before repair.
    expect(
      projection.contexts.find((context) => context.typeId === 'development.approval'),
    ).toBeUndefined()
    const mr = projection.contexts.find(
      (context) => context.typeId === 'development.merge-request',
    )!
    expect(mr.state).toMatchObject({ status: 'active', headSha: parentMrHead })
    const rootIssue = projection.contexts.find(
      (context) => context.typeId === 'development.issue-handling',
    )!
    expect(rootIssue.state).toMatchObject({
      request: { kind: 'body', externalId: null },
    })
    expect((rootIssue.state.request as { body: string }).body).toContain(
      'Generate src/Main.java and keep the MR green',
    )
    expect((rootIssue.state.request as { body: string }).body).toContain('Issue: REQ-OS-42')
    expect(git(remoteRepo, 'show', `${parentMrHead}:src/Main.java`)).toContain('return "hello"')
    expect(git(remoteRepo, 'show', '-s', '--format=%B', parentMrHead)).toContain(
      `Agent-Workflow-Case: ${caseId}`,
    )
    expect(mrDescriptions.get('repo-system-mock')).toContain(`Agent-Workflow-Case: ${caseId}`)
    expect(
      JSON.parse(
        runtime.queries.findByExternalSubject('merge-request', 'repo-system-mock!42')!
          .projectionJson,
      ).case.id,
    ).toBe(caseId)

    const pipelineClassifierCount = () =>
      projection.rounds.filter((round) => round.workItemRef === 'classify-pipeline').length
    const classifierCountBeforeInconclusiveFacts = pipelineClassifierCount()
    const emitParentPipelineWake = (suffix: string, summary: string, occurredAt: number) => {
      eventCenter.commands.observe({
        sourceRef: { id: 'code-host.activity', revision: 1 },
        eventTypeRef: { id: 'development.pipeline-check-due', revision: 1 },
        subject: { typeId: 'merge-request', subjectRef: 'repo-system-mock!42' },
        occurredAt,
        dedupeKey: `pipeline:${parentMrHead}:${suffix}`,
        summary,
        payloadArtifactRef: null,
      })
    }

    // Provider facts that are partial, temporarily unavailable, or bound to a
    // different head are all inconclusive. They must remain pending: neither
    // "all pass" nor the failure classifier may run from those snapshots.
    await suite.client.seedDevelopmentPipeline({
      headSha: parentMrHead,
      targetSha: git(baselineRepo, 'rev-parse', 'HEAD'),
      partial: true,
      gates: [
        {
          gateKey: 'compile',
          required: true,
          status: 'pass',
          runRef: 'run-partial-42',
          attempt: 1,
          retryability: 'safe',
          failureCategories: [],
          logs: [],
        },
      ],
    })
    emitParentPipelineWake('partial', 'provider omitted the head binding', Date.now())
    await driveUntilIdle()
    projection = JSON.parse(runtime.queries.getCase(caseId).projectionJson) as typeof projection
    expect(
      projection.contexts.find((context) => context.typeId === 'development.pipeline')?.state,
    ).toMatchObject({ status: 'pending', headSha: parentMrHead, failureTypes: [] })
    expect(pipelineClassifierCount()).toBe(classifierCountBeforeInconclusiveFacts)

    const requestsBeforeOutage = (await suite.client.requests('development-pipeline')).filter(
      (request) => request.path.endsWith(`/pipelines/${parentMrHead}`),
    ).length
    await suite.client.addFault({
      service: 'development-pipeline',
      method: 'GET',
      pathPrefix: `/development-pipeline/pipelines/${parentMrHead}`,
      status: 503,
      times: 1,
    })
    emitParentPipelineWake(
      'transient-outage',
      'provider returns one transient outage before recovering',
      Date.now() + 1,
    )
    await driveUntilIdle(2_000)
    projection = JSON.parse(runtime.queries.getCase(caseId).projectionJson) as typeof projection
    expect(projection.case).toMatchObject({ state: 'waiting', blockReason: null })
    expect(
      projection.contexts.find((context) => context.typeId === 'development.pipeline')?.state,
    ).toMatchObject({ status: 'pending', headSha: parentMrHead, failureTypes: [] })
    expect(pipelineClassifierCount()).toBe(classifierCountBeforeInconclusiveFacts)
    const requestsAfterOutage = (await suite.client.requests('development-pipeline')).filter(
      (request) => request.path.endsWith(`/pipelines/${parentMrHead}`),
    ).length
    expect(requestsAfterOutage - requestsBeforeOutage).toBeGreaterThanOrEqual(2)

    const wrongProviderHead = 'f'.repeat(40)
    await suite.client.seedDevelopmentPipeline({
      headSha: parentMrHead,
      targetSha: git(baselineRepo, 'rev-parse', 'HEAD'),
      headRace: { flipAfterReads: 0, newHeadSha: wrongProviderHead },
      gates: [
        {
          gateKey: 'compile',
          required: true,
          status: 'pass',
          runRef: 'run-wrong-head-42',
          attempt: 1,
          retryability: 'safe',
          failureCategories: [],
          logs: [],
        },
      ],
    })
    emitParentPipelineWake(
      'wrong-head',
      'provider returned a different head than the MR snapshot',
      Date.now() + 2,
    )
    await driveUntilIdle()
    projection = JSON.parse(runtime.queries.getCase(caseId).projectionJson) as typeof projection
    expect(
      projection.contexts.find((context) => context.typeId === 'development.pipeline')?.state,
    ).toMatchObject({ status: 'pending', headSha: parentMrHead, failureTypes: [] })
    expect(pipelineClassifierCount()).toBe(classifierCountBeforeInconclusiveFacts)

    const expectedTargetSha = git(baselineRepo, 'rev-parse', 'HEAD')
    const wrongProviderTarget = 'e'.repeat(40)
    await suite.client.seedDevelopmentPipeline({
      headSha: parentMrHead,
      targetSha: expectedTargetSha,
      targetRace: { flipAfterReads: 0, newTargetSha: wrongProviderTarget },
      gates: [
        {
          gateKey: 'compile',
          required: true,
          status: 'pass',
          runRef: 'run-wrong-target-42',
          attempt: 1,
          retryability: 'safe',
          failureCategories: [],
          logs: [],
        },
      ],
    })
    emitParentPipelineWake(
      'wrong-target',
      'provider returned gates bound to an advanced target snapshot',
      Date.now() + 3,
    )
    await driveUntilIdle()
    projection = JSON.parse(runtime.queries.getCase(caseId).projectionJson) as typeof projection
    expect(
      projection.contexts.find((context) => context.typeId === 'development.pipeline')?.state,
    ).toMatchObject({
      status: 'pending',
      headSha: parentMrHead,
      targetSha: expectedTargetSha,
      failureTypes: [],
    })
    expect(pipelineClassifierCount()).toBe(classifierCountBeforeInconclusiveFacts)

    // The first parent pipeline reports both an external dependency and an
    // ordinary current-repository compile failure. The fixed route order must
    // run collaboration first, then the configured repair Agent; neither the
    // classifier nor the Agent may choose the next handler.
    const largeLogBytes = 2 * 1024 * 1024 + 17
    await suite.client.seedDevelopmentPipeline({
      headSha: parentMrHead,
      targetSha: git(baselineRepo, 'rev-parse', 'HEAD'),
      gates: [
        {
          gateKey: 'external-dependency',
          required: true,
          status: 'fail',
          runRef: 'run-dependency-42',
          attempt: 1,
          retryability: 'unsafe',
          failureCategories: ['external-dependency'],
          logs: [{ logId: 'dependency-output', bytes: 4096 }],
        },
        {
          gateKey: 'compile',
          required: true,
          status: 'fail',
          runRef: 'run-compile-42',
          attempt: 1,
          retryability: 'safe',
          failureCategories: ['compile-error'],
          logs: [{ logId: 'compile-failure-output', bytes: largeLogBytes }],
        },
      ],
    })
    eventCenter.commands.observe({
      sourceRef: { id: 'code-host.activity', revision: 1 },
      eventTypeRef: { id: 'development.pipeline-check-due', revision: 1 },
      subject: { typeId: 'merge-request', subjectRef: 'repo-system-mock!42' },
      occurredAt: Date.now(),
      dedupeKey: `pipeline:${parentMrHead}:external-dependency-and-compile`,
      summary: 'pipeline requires a dependency repository change and a local compile repair',
      payloadArtifactRef: null,
    })
    await driveUntilIdle()
    projection = JSON.parse(runtime.queries.getCase(caseId).projectionJson) as typeof projection
    expect(projection.case).toMatchObject({ state: 'waiting', currentWorkItemRef: null })
    const failedCompileEvidenceRef = (
      projection.contexts.find((context) => context.typeId === 'development.pipeline')?.state
        .checks as Array<{ checkRef: string; evidenceFiles?: string[] }> | undefined
    )
      ?.find((check) => check.checkRef === 'compile')
      ?.evidenceFiles?.find((path) => path.endsWith('/logs/compile/compile-failure-output.log'))
    if (failedCompileEvidenceRef === undefined) {
      throw new Error('failed compile evidence was not frozen into the pipeline Context')
    }
    expect(failedCompileEvidenceRef).toMatch(
      new RegExp(
        `^\\.agent-workflow/pipeline/${caseId}/[^/]+/logs/compile/compile-failure-output\\.log$`,
      ),
    )
    const delegatedRound = [...projection.rounds]
      .reverse()
      .find((round) => round.workItemRef === 'delegate')
    expect(delegatedRound).toBeDefined()
    expect(JSON.parse(delegatedRound!.planJson)).toMatchObject({
      toolSlotRef: 'collaboration',
      implementationKind: 'collaboration',
    })
    expect(Array.isArray(JSON.parse(delegatedRound!.inputContextRefsJson))).toBe(true)
    expect(delegatedRound).toMatchObject({
      state: 'completed',
      attemptOrdinal: 0,
      workContractRef: { version: 1 },
    })
    expect(typeof delegatedRound!.settledAt).toBe('number')
    expect(projection.channels).toEqual([
      expect.objectContaining({
        state: 'open',
        targetEmployeeRef: dependencyEmployeeRef,
      }),
    ])
    const dependencyCaseId = projection.channels[0]!.childCaseId
    let dependencyProjection = JSON.parse(
      runtime.queries.getCase(dependencyCaseId).projectionJson,
    ) as typeof projection
    expect(dependencyProjection.case).toMatchObject({
      state: 'waiting',
      employeeRef: dependencyEmployeeRef,
    })
    const delegatedIssue = dependencyProjection.contexts.find(
      (context) => context.typeId === 'development.issue-handling',
    )?.state as
      | {
          repositoryRef: string
          request: { kind: string; body: string | null; externalId: string | null }
          materialArtifactRefs: string[]
          deliveryContent: unknown
        }
      | undefined
    expect(delegatedIssue).toMatchObject({
      repositoryRef: 'repo-system-mock-dependency',
      request: { kind: 'body', externalId: null },
      deliveryContent: {
        mergeRequestTitle: 'Implement delegated dependency contract',
      },
    })
    expect(delegatedIssue?.request.body).toContain('development.cross-repository-work')
    expect(delegatedIssue?.request.body).toContain('"assignedFailureType": "external-dependency"')
    expect(delegatedIssue?.request.body).toContain('repo-system-mock-dependency')
    expect(delegatedIssue?.request.body).not.toContain('当前仓库需要修复编译失败')
    expect(delegatedIssue?.request.body).toContain('.agent-workflow/pipeline/')
    expect(delegatedIssue?.materialArtifactRefs).toEqual([])
    const dependencyMrHead = mrHeads.get('repo-system-mock-dependency')!
    expect(git(dependencyRemoteRepo, 'show', `${dependencyMrHead}:src/Main.java`)).toContain(
      'return "hello"',
    )

    await suite.client.seedDevelopmentPipeline({
      headSha: dependencyMrHead,
      targetSha: git(dependencyBaselineRepo, 'rev-parse', 'HEAD'),
      gates: [
        {
          gateKey: 'compile',
          required: true,
          status: 'pass',
          runRef: 'run-dependency-84',
          attempt: 1,
          retryability: 'safe',
          failureCategories: [],
          logs: [{ logId: 'compile-output', bytes: 1024 }],
        },
      ],
    })
    eventCenter.commands.observe({
      sourceRef: { id: 'code-host.activity', revision: 1 },
      eventTypeRef: { id: 'development.pipeline-check-due', revision: 1 },
      subject: {
        typeId: 'merge-request',
        subjectRef: 'repo-system-mock-dependency!84',
      },
      occurredAt: Date.now() + 1,
      dedupeKey: `pipeline:${dependencyMrHead}:pass`,
      summary: 'dependency repository pipeline passed',
      payloadArtifactRef: null,
    })
    await driveUntilIdle()
    dependencyProjection = JSON.parse(
      runtime.queries.getCase(dependencyCaseId).projectionJson,
    ) as typeof projection
    expect(
      dependencyProjection.contexts.find(
        (context) => context.typeId === 'development.merge-request',
      )?.state,
    ).toMatchObject({ readyToMerge: true })

    mrStates.set('repo-system-mock-dependency', 'merged')
    eventCenter.commands.observe({
      sourceRef: { id: 'code-host.activity', revision: 1 },
      eventTypeRef: { id: 'development.lifecycle-updated', revision: 2 },
      subject: {
        typeId: 'merge-request',
        subjectRef: 'repo-system-mock-dependency!84',
      },
      occurredAt: Date.now() + 2,
      dedupeKey: `lifecycle:${dependencyMrHead}:merged`,
      summary: 'dependency MR merged by its committer',
      payloadArtifactRef: null,
    })
    await driveUntilIdle()
    dependencyProjection = JSON.parse(
      runtime.queries.getCase(dependencyCaseId).projectionJson,
    ) as typeof projection
    expect(dependencyProjection.case.state).toBe('terminal')

    projection = JSON.parse(runtime.queries.getCase(caseId).projectionJson) as typeof projection
    expect(
      projection.contexts.find((context) => context.typeId === 'development.delegation')?.state,
    ).toMatchObject({ status: 'satisfied' })
    expect(mrHeads.get('repo-system-mock')).toBe(parentMrHead)
    expect(
      projection.contexts.find((context) => context.typeId === 'development.pipeline')?.state,
    ).toMatchObject({ status: 'pending', headSha: parentMrHead, failureTypes: [] })
    expect(
      projection.contexts.find((context) => context.typeId === 'development.problem-set')?.state,
    ).toMatchObject({ status: 'resolved', remainingTypes: [] })

    // Fresh provider evidence now confirms that the cross-repository problem
    // is gone while the ordinary compile failure remains. The pending pipeline
    // Attention resumes exactly once and routes that frozen fallback category
    // to the configured current-repository repair Agent.
    await suite.client.seedDevelopmentPipeline({
      headSha: parentMrHead,
      targetSha: git(baselineRepo, 'rev-parse', 'HEAD'),
      gates: [
        {
          gateKey: 'compile',
          required: true,
          status: 'fail',
          runRef: 'run-compile-42',
          attempt: 2,
          retryability: 'safe',
          failureCategories: ['compile-error'],
          logs: [{ logId: 'compile-failure-output', bytes: largeLogBytes }],
        },
      ],
    })
    eventCenter.commands.observe({
      sourceRef: { id: 'code-host.activity', revision: 1 },
      eventTypeRef: { id: 'development.pipeline-check-due', revision: 1 },
      subject: { typeId: 'merge-request', subjectRef: 'repo-system-mock!42' },
      occurredAt: Date.now() + 3,
      dedupeKey: `pipeline:${parentMrHead}:compile-only`,
      summary: 'dependency is satisfied and the current repository compile gate remains red',
      payloadArtifactRef: null,
    })
    await driveUntilIdle()
    projection = JSON.parse(runtime.queries.getCase(caseId).projectionJson) as typeof projection
    const repairedParentMrHead = mrHeads.get('repo-system-mock')!
    expect(repairedParentMrHead).not.toBe(parentMrHead)
    expect(git(remoteRepo, 'show', `${repairedParentMrHead}:src/Main.java`)).toContain(
      'return "hello pipeline-fixed"',
    )
    expect(
      [...projection.rounds].reverse().find((round) => round.workItemRef === 'repair-pipeline'),
    ).toMatchObject({ state: 'completed' })
    expect(
      projection.contexts.find((context) => context.typeId === 'development.pipeline')?.state,
    ).toMatchObject({ status: 'pending', headSha: repairedParentMrHead })

    await suite.client.seedDevelopmentPipeline({
      headSha: repairedParentMrHead,
      targetSha: git(baselineRepo, 'rev-parse', 'HEAD'),
      gates: [
        {
          gateKey: 'compile',
          required: true,
          status: 'pass',
          runRef: 'run-compile-42',
          attempt: 3,
          retryability: 'safe',
          failureCategories: [],
          logs: [{ logId: 'compile-output', bytes: 1024 }],
        },
      ],
    })
    eventCenter.commands.observe({
      sourceRef: { id: 'code-host.activity', revision: 1 },
      eventTypeRef: { id: 'development.pipeline-check-due', revision: 1 },
      subject: { typeId: 'merge-request', subjectRef: 'repo-system-mock!42' },
      occurredAt: Date.now() + 4,
      dedupeKey: `pipeline:${repairedParentMrHead}:pass`,
      summary: 'repaired parent repository pipeline passed',
      payloadArtifactRef: null,
    })
    await driveUntilIdle()
    projection = JSON.parse(runtime.queries.getCase(caseId).projectionJson) as typeof projection
    const pendingApproval = projection.contexts.find(
      (context) => context.typeId === 'development.approval',
    )!
    expect(pendingApproval.state).toMatchObject({
      status: 'pending',
      headSha: repairedParentMrHead,
      adapterRef: approvalAdapterRef,
      externalRequestRef: 'APP-00001',
    })
    const approvalSnapshot = await suite.client.snapshot()
    expect(approvalSnapshot.approvals).toHaveLength(1)
    expect(approvalSnapshot.approvals).toEqual([
      expect.objectContaining({
        idempotencyKey: pendingApproval.state.idempotencyKey,
        correlationRef: pendingApproval.state.correlationRef,
      }),
    ])

    // Make the next authoritative approval observation terminal, and make the
    // parent pipeline green before that result resumes collect-pipeline.
    await suite.client.seedDevelopmentApproval({
      idempotencyKey: String(pendingApproval.state.idempotencyKey),
      statuses: ['approved'],
    })
    eventCenter.commands.observe({
      sourceRef: { id: 'development.approval-state', revision: 1 },
      eventTypeRef: { id: 'development.approval-updated', revision: 1 },
      subject: {
        typeId: 'external-approval',
        subjectRef: String(pendingApproval.state.subjectRef),
      },
      occurredAt: Date.now() + 5,
      dedupeKey: `approval:${pendingApproval.state.correlationRef}:approved`,
      summary: 'external dependency change approved',
      payloadArtifactRef: null,
    })
    await driveUntilIdle()
    projection = JSON.parse(runtime.queries.getCase(caseId).projectionJson) as typeof projection
    expect(
      projection.contexts.find((context) => context.typeId === 'development.approval')?.state,
    ).toMatchObject({
      status: 'approved',
      evidenceRef: `approval-evidence:${String(pendingApproval.state.externalRequestRef)}`,
    })
    const readyMr = projection.contexts.find(
      (context) => context.typeId === 'development.merge-request',
    )!
    expect(readyMr.state).toMatchObject({
      readyToMerge: true,
      approvalHold: true,
      mergeableState: 'mergeable',
      unresolvedReviewCount: 0,
    })
    expect(projection.case.state).toBe('waiting')
    const downloadedLog = join(
      appHome,
      'workspaces',
      'employee-cases',
      caseId,
      'scene',
      'workspace',
      '.agent-workflow',
      ...failedCompileEvidenceRef.replace(/^\.agent-workflow\//, '').split('/'),
    )
    expect(existsSync(downloadedLog)).toBe(true)
    expect(statSync(downloadedLog).size).toBe(largeLogBytes)

    // A target-only advance invalidates both the ready projection and the
    // previously green gate snapshot even though the source head is unchanged.
    // The Case may become ready again only after a gate snapshot bound to the
    // new target arrives.
    writeFileSync(join(baselineRepo, 'TARGET.md'), '# advanced target\n')
    git(baselineRepo, 'add', 'TARGET.md')
    git(
      baselineRepo,
      '-c',
      'user.email=target-advance@example.com',
      '-c',
      'user.name=target-advance',
      'commit',
      '-q',
      '-m',
      'advance target branch',
    )
    const advancedTargetSha = git(baselineRepo, 'rev-parse', 'HEAD')
    expect(advancedTargetSha).not.toBe(expectedTargetSha)
    eventCenter.commands.observe({
      sourceRef: { id: 'code-host.activity', revision: 1 },
      eventTypeRef: { id: 'development.lifecycle-updated', revision: 2 },
      subject: { typeId: 'merge-request', subjectRef: 'repo-system-mock!42' },
      occurredAt: Date.now() + 6,
      dedupeKey: `target:${repairedParentMrHead}:${advancedTargetSha}`,
      summary: 'target branch advanced while the source head stayed unchanged',
      payloadArtifactRef: null,
    })
    await driveUntilIdle()
    projection = JSON.parse(runtime.queries.getCase(caseId).projectionJson) as typeof projection
    expect(
      projection.contexts.find((context) => context.typeId === 'development.merge-request')?.state,
    ).toMatchObject({
      headSha: repairedParentMrHead,
      targetSha: advancedTargetSha,
      readyToMerge: false,
    })
    expect(
      projection.contexts.find((context) => context.typeId === 'development.pipeline')?.state,
    ).toMatchObject({
      status: 'pending',
      headSha: repairedParentMrHead,
      targetSha: advancedTargetSha,
      failureTypes: [],
    })

    await suite.client.seedDevelopmentPipeline({
      headSha: repairedParentMrHead,
      targetSha: advancedTargetSha,
      gates: [
        {
          gateKey: 'compile',
          required: true,
          status: 'pass',
          runRef: 'run-compile-target-advanced-42',
          attempt: 4,
          retryability: 'safe',
          failureCategories: [],
          logs: [{ logId: 'compile-output-target-advanced', bytes: 1024 }],
        },
      ],
    })
    emitParentPipelineWake(
      'target-advanced-pass',
      'the source head passed against the advanced target snapshot',
      Date.now() + 7,
    )
    await driveUntilIdle()
    projection = JSON.parse(runtime.queries.getCase(caseId).projectionJson) as typeof projection
    expect(
      projection.contexts.find((context) => context.typeId === 'development.pipeline')?.state,
    ).toMatchObject({
      status: 'passed',
      headSha: repairedParentMrHead,
      targetSha: advancedTargetSha,
      failureTypes: [],
    })
    expect(
      projection.contexts.find((context) => context.typeId === 'development.merge-request')?.state,
    ).toMatchObject({ readyToMerge: true, targetSha: advancedTargetSha })

    mrStates.set('repo-system-mock', 'merged')
    eventCenter.commands.observe({
      sourceRef: { id: 'code-host.activity', revision: 1 },
      eventTypeRef: { id: 'development.lifecycle-updated', revision: 2 },
      subject: { typeId: 'merge-request', subjectRef: 'repo-system-mock!42' },
      occurredAt: Date.now() + 8,
      dedupeKey: `lifecycle:${repairedParentMrHead}:merged`,
      summary: 'MR merged by committer',
      payloadArtifactRef: null,
    })
    await driveUntilIdle()
    projection = JSON.parse(runtime.queries.getCase(caseId).projectionJson) as typeof projection
    expect(projection.case.state).toBe('terminal')
    expect(
      projection.contexts.find((context) => context.typeId === 'development.merge-request')?.state,
    ).toMatchObject({ status: 'merged' })

    // Terminal approval receipts are business-distinct, while a transport
    // outage is not terminal at all. Each Case gets its own repository/MR so
    // the OS external-subject uniqueness fence stays real. The first Case also
    // sees one injected 503 and proves the pending Attention can wake it again
    // without a manual resume.
    for (const [index, approvalStatus] of (
      ['rejected', 'expired', 'unavailable'] as const
    ).entries()) {
      const terminalRepositoryId = `repo-system-mock-approval-${approvalStatus}`
      const terminalBaselineRepo = join(root, `approval-${approvalStatus}-baseline`)
      const terminalRemoteRepo = join(root, `approval-${approvalStatus}-remote.git`)
      mkdirSync(terminalBaselineRepo, { recursive: true })
      git(terminalBaselineRepo, 'init', '-q', '-b', 'main')
      writeFileSync(
        join(terminalBaselineRepo, 'README.md'),
        `# ${approvalStatus} approval baseline\n`,
      )
      git(terminalBaselineRepo, 'add', '-A')
      git(
        terminalBaselineRepo,
        '-c',
        'user.email=system-mock@example.com',
        '-c',
        'user.name=system-mock',
        'commit',
        '-q',
        '-m',
        `${approvalStatus} approval baseline`,
      )
      mkdirSync(terminalRemoteRepo, { recursive: true })
      git(terminalRemoteRepo, 'init', '-q', '--bare')
      db.insert(cachedRepos)
        .values({
          id: terminalRepositoryId,
          urlHash: `rfc310-system-mock-approval-${approvalStatus}`,
          urlEnc: null,
          urlRedacted: terminalRemoteRepo,
          localPath: terminalBaselineRepo,
          defaultBranch: 'main',
          lastFetchedAt: 1,
          createdAt: 1,
        })
        .run()
      repositoryFixtures.set(terminalRepositoryId, {
        baselineRepo: terminalBaselineRepo,
        remoteRepo: terminalRemoteRepo,
        mrRef: String(310 + index),
      })
      mrStates.set(terminalRepositoryId, 'opened')
      approvalRequiredRepositoryIds.add(terminalRepositoryId)

      const terminalEmployee = employeeOs.commands.createEmployee({
        typeRef,
        actorUserId: 'system-mock-author',
        body: {
          name: `${approvalStatus} approval employee`,
          jobTemplateRef: jobRef,
          workScope: { kind: 'repository', repositoryId: terminalRepositoryId },
          toolOverrides: [],
        },
      })
      const terminalLaunch = runtime.commands.launchWork({
        employeeId: terminalEmployee.id,
        actorUserId: 'approval-requester',
        intake: {
          name: `Approval ${approvalStatus} branch`,
          kind: 'body',
          target: { repositoryId: terminalRepositoryId },
          body: STANDARD_ISSUE_BODY,
          externalId: null,
          uploads: [],
          idempotencyKey: `REQ-OS-42:approval-${approvalStatus}`,
        },
      })
      await driveUntilIdle()
      let terminalProjection = JSON.parse(
        runtime.queries.getCase(terminalLaunch.caseRef.id).projectionJson,
      ) as typeof projection
      const terminalMrHead = mrHeads.get(terminalRepositoryId)!
      await suite.client.seedDevelopmentPipeline({
        headSha: terminalMrHead,
        targetSha: git(terminalBaselineRepo, 'rev-parse', 'HEAD'),
        gates: [
          {
            gateKey: 'compile',
            required: true,
            status: 'pass',
            runRef: `run-${approvalStatus}-approval`,
            attempt: 1,
            retryability: 'safe',
            failureCategories: [],
            logs: [],
          },
        ],
      })
      eventCenter.commands.observe({
        sourceRef: { id: 'code-host.activity', revision: 1 },
        eventTypeRef: { id: 'development.pipeline-check-due', revision: 1 },
        subject: {
          typeId: 'merge-request',
          subjectRef: `${terminalRepositoryId}!${repositoryFixtures.get(terminalRepositoryId)!.mrRef}`,
        },
        occurredAt: Date.now() + 90 + index,
        dedupeKey: `pipeline:${terminalMrHead}:approval-${approvalStatus}`,
        summary: `pipeline passed before ${approvalStatus} approval scenario`,
        payloadArtifactRef: null,
      })
      await driveUntilIdle()
      terminalProjection = JSON.parse(
        runtime.queries.getCase(terminalLaunch.caseRef.id).projectionJson,
      ) as typeof projection
      let terminalApproval = terminalProjection.contexts.find(
        (context) => context.typeId === 'development.approval',
      )!
      expect(terminalApproval.state).toMatchObject({
        status: 'pending',
        adapterRef: approvalAdapterRef,
      })

      if (approvalStatus === 'rejected') {
        await suite.client.addFault({
          service: 'development-approval',
          method: 'GET',
          pathPrefix: `/development-approval/approvals/${String(
            terminalApproval.state.correlationRef,
          )}`,
          status: 503,
          times: 1,
        })
        eventCenter.commands.observe({
          sourceRef: { id: 'development.approval-state', revision: 1 },
          eventTypeRef: { id: 'development.approval-updated', revision: 1 },
          subject: {
            typeId: 'external-approval',
            subjectRef: String(terminalApproval.state.subjectRef),
          },
          occurredAt: Date.now() + 100,
          dedupeKey: `approval:${terminalApproval.state.correlationRef}:transient-outage`,
          summary: 'one transient approval provider outage',
          payloadArtifactRef: null,
        })
        await driveUntilIdle()
        terminalProjection = JSON.parse(
          runtime.queries.getCase(terminalLaunch.caseRef.id).projectionJson,
        ) as typeof projection
        terminalApproval = terminalProjection.contexts.find(
          (context) => context.typeId === 'development.approval',
        )!
        expect(terminalProjection.case).toMatchObject({ state: 'waiting', blockReason: null })
        expect(terminalApproval.state).toMatchObject({ status: 'pending' })
      }

      await suite.client.seedDevelopmentApproval({
        idempotencyKey: String(terminalApproval.state.idempotencyKey),
        statuses: [approvalStatus],
      })
      eventCenter.commands.observe({
        sourceRef: { id: 'development.approval-state', revision: 1 },
        eventTypeRef: { id: 'development.approval-updated', revision: 1 },
        subject: {
          typeId: 'external-approval',
          subjectRef: String(terminalApproval.state.subjectRef),
        },
        occurredAt: Date.now() + 200 + index,
        dedupeKey: `approval:${terminalApproval.state.correlationRef}:${approvalStatus}`,
        summary: `external approval ended as ${approvalStatus}`,
        payloadArtifactRef: null,
      })
      await driveUntilIdle()
      terminalProjection = JSON.parse(
        runtime.queries.getCase(terminalLaunch.caseRef.id).projectionJson,
      ) as typeof projection
      terminalApproval = terminalProjection.contexts.find(
        (context) => context.typeId === 'development.approval',
      )!
      expect(terminalProjection.case).toMatchObject({
        state: 'blocked',
        currentWorkItemRef: 'observe-approval',
        blockReason: expect.stringContaining(approvalStatus),
      })
      expect(terminalApproval.state).toMatchObject({
        status: approvalStatus,
        evidenceRef: null,
      })
    }

    // A second employee intentionally has none of the review, pipeline,
    // conflict, collaboration, or approval lanes configured. It must still
    // publish, create an MR, subscribe only to capabilities it owns, and track
    // the MR lifecycle until a committer merges it.
    const deliveryOnlyJob = employeeOs.commands.createJobTemplate({
      typeRef,
      actorUserId: 'system-mock-author',
      body: {
        name: '只交付 MR 的 system-mock 岗位',
        description: '不配置任何可选看护与修绿泳道',
        defaultToolBindings: coreBindings,
      },
    })
    const deliveryOnlyJobRef = employeeOs.commands.publishJobTemplate({
      id: deliveryOnlyJob.id,
      actorUserId: 'system-mock-author',
    })
    const deliveryOnlyEmployee = employeeOs.commands.createEmployee({
      typeRef,
      actorUserId: 'system-mock-author',
      body: {
        name: '只交付 MR 的数字员工',
        jobTemplateRef: deliveryOnlyJobRef,
        workScope: { kind: 'repository', repositoryId: 'repo-system-mock-delivery-only' },
        toolOverrides: [],
      },
    })
    const deliveryOnlyEmployeeRef = {
      id: deliveryOnlyEmployee.id,
      revision: deliveryOnlyEmployee.revision,
    }
    expect(
      employeeOs.queries.getEmployee(deliveryOnlyEmployee.id).definition.enabledWorkItemRefs,
    ).toEqual(coreWorkItemRefs)

    const deliveryOnlyLaunch = runtime.commands.launchWork({
      employeeId: deliveryOnlyEmployeeRef.id,
      actorUserId: 'requester',
      intake: {
        name: '交付 REQ-OS-42',
        kind: 'body',
        target: { repositoryId: 'repo-system-mock-delivery-only' },
        body: STANDARD_ISSUE_BODY,
        externalId: null,
        uploads: [],
        idempotencyKey: 'REQ-OS-42:delivery-only',
      },
    })
    await driveUntilIdle()
    const deliveryOnlyProjection = JSON.parse(
      runtime.queries.getCase(deliveryOnlyLaunch.caseRef.id).projectionJson,
    ) as {
      case: { state: string; currentWorkItemRef: string | null }
      contexts: Array<{ typeId: string; state: Record<string, unknown> }>
      attention: Array<{ eventTypeRef: { id: string } }>
    }
    const deliveryOnlyMrHead = mrHeads.get('repo-system-mock-delivery-only')!
    expect(deliveryOnlyProjection.case).toMatchObject({
      state: 'waiting',
      currentWorkItemRef: null,
    })
    expect(
      deliveryOnlyProjection.contexts.find(
        (context) => context.typeId === 'development.merge-request',
      )?.state,
    ).toMatchObject({
      status: 'active',
      headSha: deliveryOnlyMrHead,
      readyToMerge: false,
    })
    expect(deliveryOnlyProjection.attention.map((attention) => attention.eventTypeRef.id)).toEqual([
      'development.lifecycle-updated',
    ])
    expect(git(deliveryOnlyRemoteRepo, 'show', `${deliveryOnlyMrHead}:src/Main.java`)).toContain(
      'return "hello"',
    )

    mrStates.set('repo-system-mock-delivery-only', 'merged')
    eventCenter.commands.observe({
      sourceRef: { id: 'code-host.activity', revision: 1 },
      eventTypeRef: { id: 'development.lifecycle-updated', revision: 2 },
      subject: { typeId: 'merge-request', subjectRef: 'repo-system-mock-delivery-only!126' },
      occurredAt: Date.now() + 5,
      dedupeKey: `lifecycle:${deliveryOnlyMrHead}:merged`,
      summary: 'delivery-only MR merged by committer',
      payloadArtifactRef: null,
    })
    await driveUntilIdle()
    expect(
      JSON.parse(runtime.queries.getCase(deliveryOnlyLaunch.caseRef.id).projectionJson).case,
    ).toMatchObject({ state: 'terminal', terminalKind: 'merged' })

    // The review lane uses the real stateful GitLab system mock. A review event
    // is only a wake-up hint: the employee first refreshes authoritative MR
    // facts, freezes the root plus every reply, acknowledges the thread, lets
    // the Agent repair it, publishes a new commit, and replies with that commit.
    // The platform's own two replies must not create another repair round.
    const reviewJob = employeeOs.commands.createJobTemplate({
      typeRef,
      actorUserId: 'system-mock-author',
      body: {
        name: '检视闭环 system-mock 岗位',
        description: '只启用交付与检视意见修复泳道',
        defaultToolBindings: bindings.filter(
          (binding) =>
            coreWorkItemRefs.includes(binding.workItemRef) ||
            binding.workItemRef === 'repair-feedback',
        ),
      },
    })
    const reviewJobRef = employeeOs.commands.publishJobTemplate({
      id: reviewJob.id,
      actorUserId: 'system-mock-author',
    })
    const reviewEmployee = employeeOs.commands.createEmployee({
      typeRef,
      actorUserId: 'system-mock-author',
      body: {
        name: '检视闭环数字员工',
        jobTemplateRef: reviewJobRef,
        workScope: { kind: 'repository', repositoryId: 'repo-system-mock-review' },
        toolOverrides: [],
      },
    })
    const reviewEmployeeRef = { id: reviewEmployee.id, revision: reviewEmployee.revision }
    const reviewLaunch = runtime.commands.launchWork({
      employeeId: reviewEmployeeRef.id,
      actorUserId: 'requester',
      intake: {
        name: '检视并修复 REQ-OS-42',
        kind: 'body',
        target: { repositoryId: 'repo-system-mock-review' },
        body: STANDARD_ISSUE_BODY,
        externalId: null,
        uploads: [],
        idempotencyKey: 'REQ-OS-42:review-protocol',
      },
    })
    await driveUntilIdle()
    const reviewCaseId = reviewLaunch.caseRef.id
    const reviewMrRef = mrRefs.get('repo-system-mock-review')!
    const reviewMrNumber = Number(reviewMrRef)
    const reviewHeadBeforeRepair = mrHeads.get('repo-system-mock-review')!
    const rootReview = await suite.client.mutateCodeHost({
      kind: 'add-review-comment',
      provider: 'gitlab',
      projectPath: reviewProjectPath,
      number: reviewMrNumber,
      threadId: 'review-thread-1',
      body: '根意见：请让 greeting 明确体现已经完成检视修复。',
      actor: { username: 'human-reviewer' },
    })
    const rootMessage = rootReview.mergeRequests
      .find((candidate) => candidate.number === reviewMrNumber)!
      .reviewComments.find((comment) => comment.body.startsWith('根意见：'))!
    const secondReview = await suite.client.mutateCodeHost({
      kind: 'add-review-comment',
      provider: 'gitlab',
      projectPath: reviewProjectPath,
      number: reviewMrNumber,
      threadId: 'review-thread-1',
      inReplyToId: rootMessage.id,
      body: '第一轮回复：不要只改说明，代码返回值也要变化。',
      actor: { username: 'human-reviewer' },
    })
    const secondMessage = secondReview.mergeRequests
      .find((candidate) => candidate.number === reviewMrNumber)!
      .reviewComments.find((comment) => comment.body.startsWith('第一轮回复：'))!
    await suite.client.mutateCodeHost({
      kind: 'add-review-comment',
      provider: 'gitlab',
      projectPath: reviewProjectPath,
      number: reviewMrNumber,
      threadId: 'review-thread-1',
      inReplyToId: secondMessage.id,
      body: '第二轮回复：修复后请说明对应提交。',
      actor: { username: 'maintainer-reviewer' },
    })
    eventCenter.commands.observe({
      sourceRef: { id: 'code-host.activity', revision: 1 },
      eventTypeRef: { id: 'development.review-updated', revision: 2 },
      subject: { typeId: 'merge-request', subjectRef: `repo-system-mock-review!${reviewMrRef}` },
      occurredAt: Date.now() + 6,
      dedupeKey: `review:${reviewMrRef}:three-message-tree`,
      summary: 'review thread received two rounds of human replies',
      payloadArtifactRef: null,
    })
    await driveUntilIdle()
    expect(reviewRepairInputs).toEqual([
      {
        threadRef: 'review-thread-1',
        bodies: [
          '根意见：请让 greeting 明确体现已经完成检视修复。',
          '第一轮回复：不要只改说明，代码返回值也要变化。',
          '第二轮回复：修复后请说明对应提交。',
        ],
      },
    ])
    const reviewHeadAfterRepair = mrHeads.get('repo-system-mock-review')!
    expect(reviewHeadAfterRepair).not.toBe(reviewHeadBeforeRepair)
    expect(git(reviewRemoteRepo, 'show', `${reviewHeadAfterRepair}:src/Main.java`)).toContain(
      'hello reviewed',
    )
    let reviewSnapshot = await suite.client.snapshot()
    let reviewComments = reviewSnapshot.codeHosts
      .find((host) => host.projectPath === reviewProjectPath)!
      .mergeRequests.find((candidate) => candidate.number === reviewMrNumber)!.reviewComments
    expect(reviewComments).toHaveLength(5)
    expect(
      reviewComments.some(
        (comment) =>
          comment.body.includes('已收到该检视意见，正在处理。') &&
          comment.body.includes(`aw-self:${reviewCaseId}:review-received:`),
      ),
    ).toBe(true)
    expect(
      reviewComments.some(
        (comment) =>
          comment.body.includes(reviewHeadAfterRepair.slice(0, 12)) &&
          comment.body.includes('已按完整讨论上下文调整 greeting 的实现。') &&
          comment.body.includes(`aw-self:${reviewCaseId}:review-resolved:`),
      ),
    ).toBe(true)
    const replyCountBeforeReplay = reviewComments.length
    eventCenter.commands.observe({
      sourceRef: { id: 'code-host.activity', revision: 1 },
      eventTypeRef: { id: 'development.review-updated', revision: 2 },
      subject: { typeId: 'merge-request', subjectRef: `repo-system-mock-review!${reviewMrRef}` },
      occurredAt: Date.now() + 7,
      dedupeKey: `review:${reviewMrRef}:self-replies-only`,
      summary: 'only platform replies changed the provider thread',
      payloadArtifactRef: null,
    })
    await driveUntilIdle()
    reviewSnapshot = await suite.client.snapshot()
    reviewComments = reviewSnapshot.codeHosts
      .find((host) => host.projectPath === reviewProjectPath)!
      .mergeRequests.find((candidate) => candidate.number === reviewMrNumber)!.reviewComments
    expect(reviewComments).toHaveLength(replyCountBeforeReplay)

    await suite.client.mutateCodeHost({
      kind: 'set-mr-state',
      provider: 'gitlab',
      projectPath: reviewProjectPath,
      number: reviewMrNumber,
      state: 'merged',
    })
    eventCenter.commands.observe({
      sourceRef: { id: 'code-host.activity', revision: 1 },
      eventTypeRef: { id: 'development.lifecycle-updated', revision: 2 },
      subject: { typeId: 'merge-request', subjectRef: `repo-system-mock-review!${reviewMrRef}` },
      occurredAt: Date.now() + 8,
      dedupeKey: `lifecycle:${reviewHeadAfterRepair}:merged`,
      summary: 'review employee MR merged by committer',
      payloadArtifactRef: null,
    })
    await driveUntilIdle()
    expect(JSON.parse(runtime.queries.getCase(reviewCaseId).projectionJson).case).toMatchObject({
      state: 'terminal',
      terminalKind: 'merged',
    })
  })
})
