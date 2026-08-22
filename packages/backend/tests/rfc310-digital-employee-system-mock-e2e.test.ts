// RFC-310 Digital Employee OS system-mock journey.
//
// External requirement and pipeline systems are real HTTP mocks and their
// adapters are real child programs. The model lane is deterministic by design
// in tests; Git candidate/commit/CAS push and the OS Context+Event lifecycle are
// production participants.

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
import { ExecutionContractService } from '@/modules/execution-contract/application/executionContractService'
import {
  createDevelopmentAdapter,
  publishDevelopmentAdapter,
} from '@/modules/integration/application/developmentAdapterCommands'
import { composeApprovalGatewayRunner } from '@/modules/integration/composition/approvalGateway'
import { composeDevelopmentMrEffects } from '@/modules/integration/composition/codeHostEffects'
import { collectMergeRequestFacts } from '@/modules/integration/application/mrFacts'
import { createSqliteDevelopmentAdapterStore } from '@/modules/integration/infrastructure/sqliteDevelopmentAdapterStore'
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

function naturalEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
    ...extra,
  }
}

async function runAdapter(input: {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}): Promise<string> {
  const child = Bun.spawn({
    cmd: [process.execPath, input.file, ...input.args],
    cwd: input.cwd,
    env: naturalEnv(input.env),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`adapter exited ${exitCode}: ${stderr.slice(-2_000)}`)
  return stdout.trim()
}

function output(
  plan: ReactionExecutionPlan,
  body: {
    readonly summary: string
    readonly contextPatches?: readonly object[]
    readonly artifactRefs?: readonly string[]
    readonly deliveryContent?: {
      readonly commitMessage: string
      readonly mergeRequestTitle: string
      readonly mergeRequestDescription: string
    }
    readonly reviewReplies?: readonly {
      readonly threadRef: string
      readonly revision: string
      readonly disposition: 'addressed' | 'needs-human'
      readonly replyBody: string
    }[]
  },
): string {
  return JSON.stringify({
    schemaVersion: 1,
    roundRef: plan.roundRef,
    executionNonce: plan.executionNonce,
    status: 'ok',
    summary: body.summary,
    ...(body.deliveryContent === undefined ? {} : { deliveryContent: body.deliveryContent }),
    ...(body.reviewReplies === undefined ? {} : { reviewReplies: [...body.reviewReplies] }),
    contextPatches: [...(body.contextPatches ?? [])],
    effectSuggestions: [],
    artifactRefs: [...(body.artifactRefs ?? [])],
  })
}

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
  test('external ID -> MR -> cross-repository employee -> approval -> large evidence -> merged', async () => {
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

    await suite.client.seedRequirement({
      externalId: 'REQ-OS-42',
      revision: 'r7',
      title: 'Implement the generated Java greeting',
      files: [
        {
          fileId: 'body',
          name: 'requirement.md',
          role: 'body',
          mediaType: 'text/markdown',
          content: '# Requirement\nGenerate src/Main.java and keep the MR green.\n',
        },
        {
          fileId: 'design',
          name: 'design.md',
          role: 'design',
          mediaType: 'text/markdown',
          content: '# Design\nUse a deterministic greeting.\n',
        },
      ],
    })

    const inputArtifacts = createEmployeeInputArtifactStore(
      join(appHome, 'artifacts', 'employee-inputs'),
    )
    const workspace = composeDevelopmentEmployeeWorkspace({
      db,
      appHome,
      inputArtifacts,
      sourceControl: bindEmployeeCaseWorkspaceParticipant(),
      conflictMerge: bindConflictMergeParticipant(),
    })
    const eventCenter = composeEventCenter({
      db,
      typePackageDescriptorJsons: [
        developmentEmployeeTypePackage.descriptorJson,
        digitalEmployeeLifecycleEventCatalogJson,
      ],
    })
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
    const approvalGateway = composeApprovalGatewayRunner(db, {
      approvalMockUrl: suite.endpoints.developmentApprovalBaseUrl,
    })

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
          const issue = contexts.find((context) => context.typeId === 'development.issue-handling')!
          const issueState = JSON.parse(issue.stateJson) as {
            request: { externalId: string | null }
            materialArtifactRefs: string[]
          }
          expect(inputEnvelope.contractInput.materialTargetDirectory).toBe(
            externalMaterialDirectory,
          )
          const sink = join(scene.workspacePath, externalMaterialDirectory)
          const adapterEnvelope = JSON.parse(
            await runAdapter({
              file: join(SYSTEM_MOCKS, 'requirement-adapter-cli.ts'),
              args: ['--acquire', issueState.request.externalId!],
              cwd: scene.workspacePath,
              env: {
                AW_ADAPTER_SINK: sink,
                AW_REQUIREMENT_MOCK_URL: suite.endpoints.developmentRequirementBaseUrl,
              },
            }),
          ) as { files: Array<{ relativePath: string }> }
          const materialRefs = adapterEnvelope.files.map(
            (file) => `${externalMaterialDirectory}/${file.relativePath}`,
          )
          outputJson = output(plan, {
            summary: `取得 ${materialRefs.length} 个需求文件`,
            contextPatches: [
              {
                contextId: issue.id,
                contextTypeId: issue.typeId,
                schemaVersion: 1,
                expectedRevision: issue.revision,
                lifecycleState: 'active',
                stateJson: JSON.stringify({
                  ...(JSON.parse(issue.stateJson) as object),
                  materialArtifactRefs: materialRefs,
                }),
                artifactRefs: materialRefs,
              },
            ],
            artifactRefs: materialRefs,
          })
        } else if (plan.workItemRef === 'analyze-implement') {
          const issue = contexts.find((context) => context.typeId === 'development.issue-handling')!
          const issueState = JSON.parse(issue.stateJson) as { materialArtifactRefs: string[] }
          const requirement = join(
            scene.workspacePath,
            issueState.materialArtifactRefs.find((ref) => ref.endsWith('/files/requirement.md'))!,
          )
          expect(readFileSync(requirement, 'utf8')).toContain('Generate src/Main.java')
          mkdirSync(join(scene.workspacePath, 'src'), { recursive: true })
          writeFileSync(
            join(scene.workspacePath, 'src', 'Main.java'),
            'public final class Main { public static String greeting() { return "hello"; } }\n',
          )
          outputJson = output(plan, {
            summary: '实现 Java greeting 并完成本地检查',
            deliveryContent: {
              commitMessage:
                'implement Java greeting\n\nGenerate the requested source and preserve uploaded materials.',
              mergeRequestTitle: 'Implement Java greeting',
              mergeRequestDescription:
                '## Summary\n\nImplements the requested Java greeting and its verification.',
            },
          })
        } else if (plan.workItemRef === 'collect-pipeline') {
          const mr = contexts.find((context) => context.typeId === 'development.merge-request')!
          const currentPipeline = contexts.find(
            (context) => context.typeId === 'development.pipeline',
          )
          const mrState = JSON.parse(mr.stateJson) as {
            mergeRequestRef: string
            headSha: string
          }
          const sink = join(scene.workspacePath, pipelineMount)
          expect(inputEnvelope.contractInput.pipelineDirectory).toBe(pipelineMount)
          const adapterEnvelope = JSON.parse(
            await runAdapter({
              file: join(SYSTEM_MOCKS, 'pipeline-adapter-cli.ts'),
              args: ['--collect-pipeline', mrState.headSha],
              cwd: scene.workspacePath,
              env: {
                AW_ADAPTER_SINK: sink,
                AW_PIPELINE_MOCK_URL: suite.endpoints.developmentPipelineBaseUrl,
                AW_PIPELINE_HEAD: mrState.headSha,
              },
            }),
          ) as {
            completeness: string
            providerHeadSha: string | null
            gates: Array<{ required: boolean; status: string; failureCategories: string[] }>
          }
          const required = adapterEnvelope.gates.filter((gate) => gate.required)
          const passed =
            adapterEnvelope.completeness === 'complete' &&
            adapterEnvelope.providerHeadSha === mrState.headSha &&
            required.every((gate) => gate.status === 'pass')
          const evidenceRef = `${pipelineMount}/`
          outputJson = output(plan, {
            summary: passed ? '当前 head 的全部门禁已通过' : '当前 head 仍有失败门禁',
            contextPatches: [
              {
                contextId: currentPipeline?.id ?? null,
                contextTypeId: 'development.pipeline',
                schemaVersion: 1,
                expectedRevision: currentPipeline?.revision ?? null,
                lifecycleState: 'active',
                stateJson: JSON.stringify({
                  status: passed ? 'passed' : 'failed',
                  mergeRequestRef: mrState.mergeRequestRef,
                  headSha: mrState.headSha,
                  evidenceArtifactRef: evidenceRef,
                  failureTypes: [
                    ...new Set(
                      required.flatMap((gate) =>
                        gate.status === 'pass' ? [] : gate.failureCategories,
                      ),
                    ),
                  ],
                }),
                artifactRefs: [evidenceRef],
              },
            ],
            artifactRefs: [evidenceRef],
          })
        } else if (plan.workItemRef === 'classify-pipeline') {
          const pipeline = contexts.find((context) => context.typeId === 'development.pipeline')!
          const pipelineState = JSON.parse(pipeline.stateJson) as {
            headSha: string
            evidenceArtifactRef: string
            failureTypes: string[]
          }
          expect(pipelineState.failureTypes).toContain('external-dependency')
          outputJson = output(plan, {
            summary: '识别到需要另一个仓库先完成的外部依赖',
            contextPatches: [
              {
                contextId: null,
                contextTypeId: 'development.problem-set',
                schemaVersion: 1,
                expectedRevision: null,
                lifecycleState: 'active',
                stateJson: JSON.stringify({
                  status: 'active',
                  source: 'pipeline',
                  headSha: pipelineState.headSha,
                  remainingTypes: ['external-dependency'],
                  problems: [
                    {
                      problemId: `external-dependency:${pipelineState.headSha}`,
                      type: 'external-dependency',
                      summary: '依赖仓库需要先完成配套变更',
                      evidenceArtifactRefs: [pipelineState.evidenceArtifactRef],
                    },
                  ],
                }),
                artifactRefs: [pipelineState.evidenceArtifactRef],
              },
            ],
            artifactRefs: [pipelineState.evidenceArtifactRef],
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
          outputJson = output(plan, {
            summary: '完整读取检视线程树并修复代码',
            deliveryContent: {
              commitMessage:
                'address review feedback\n\nApply the requested greeting adjustment and verification.',
              mergeRequestTitle: 'Implement Java greeting',
              mergeRequestDescription:
                '## Summary\n\nImplements the greeting and addresses all current review feedback.',
            },
            reviewReplies: resolutionState.threads.map((thread) => ({
              threadRef: thread.threadRef,
              revision: thread.revision,
              disposition: 'addressed',
              replyBody: '已按完整讨论上下文调整 greeting 的实现。',
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
          outputJson = output(plan, {
            summary: '根据当前 MR head 生成确定性审批草稿',
            contextPatches: [
              {
                contextId: null,
                contextTypeId: 'development.approval',
                schemaVersion: 1,
                expectedRevision: null,
                lifecycleState: 'active',
                stateJson: JSON.stringify({
                  status: 'draft',
                  approvalType: 'gate-change',
                  adapterRef: approvalAdapterRef,
                  validatedDraftRef: `approval-draft:${plan.caseRef.id}:${mergeRequestState.headSha}`,
                  mergeRequestRef: mergeRequestState.mergeRequestRef,
                  headSha: mergeRequestState.headSha,
                  subjectRef: null,
                  deadlineAt: null,
                  idempotencyKey: null,
                  correlationRef: null,
                  externalRequestRef: null,
                  submittedRevision: null,
                  observedRevision: null,
                  evidenceRef: null,
                }),
                artifactRefs: [],
              },
            ],
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
            errorCode: validation.errorCode,
            errorDetail: validation.errorDetail,
          }
        }
        return { kind: 'completed' as const, executionRef, outputJson: done.outputJson }
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
      db,
      appHome,
      approvalGateway,
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
              approvalHold: repositoryId === 'repo-system-mock',
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
        async resolve(ref) {
          if (ref.id !== approvalAdapterRef.id || ref.revision !== approvalAdapterRef.revision) {
            return null
          }
          return {
            ref,
            purpose: 'approval-gateway',
            available: true,
            closureSummary: 'system-mock exact approval connection',
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
    const typeRef = { typeId: 'development', revision: 5 }
    const typePackage = employeeOs.queries.getType(typeRef)
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
            (candidate) => candidate.contractId === item.workContractRef.contractId,
          )!
          const implementation =
            item.workItemRef === 'prepare-materials' || item.workItemRef === 'collect-pipeline'
              ? {
                  kind: 'program' as const,
                  runtimeKind: 'bash' as const,
                  source:
                    "printf 'fixture only; the E2E binds the real system adapter participant\\n'",
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
              connectionRef:
                contract.requiredConnectionPurpose === null ? null : approvalAdapterRef,
            },
          })
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
        connectionRef: null,
      },
    })
    const pipelineRepairRef = await employeeOs.commands.publishTool({
      typeRef,
      workItemRef: 'repair-pipeline',
      toolId: pipelineRepairTool.id,
      actorUserId: 'system-mock-author',
    })
    const dependencyJob = employeeOs.commands.createJobTemplate({
      typeRef,
      actorUserId: 'system-mock-author',
      body: {
        name: '依赖仓库 Java 岗位',
        description: '在另一个仓库完成配套变更',
        defaultToolBindings: bindings,
        orderedDispatchConfigurations: [
          {
            classifierWorkItemRef: 'classify-pipeline',
            routes: [
              {
                routeRef: 'other-pipeline-failure',
                displayName: '其他流水线错误',
                description: '依赖仓库的通用修复兜底',
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
    const launched = runtime.commands.launchWork({
      employeeId: employeeRef.id,
      actorUserId: 'requester',
      intake: {
        kind: 'external-id',
        target: { repositoryId: 'repo-system-mock' },
        body: null,
        externalId: 'REQ-OS-42',
        uploads: [],
        idempotencyKey: 'REQ-OS-42:r7',
      },
    })
    const caseId = launched.caseRef.id

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
        ) as { rounds?: unknown[] }
        return {
          ...candidate,
          recentRounds: candidateProjection.rounds?.slice(0, 3) ?? [],
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
    }
    const parentMrHead = mrHeads.get('repo-system-mock')!
    const mr = projection.contexts.find(
      (context) => context.typeId === 'development.merge-request',
    )!
    expect(mr.state).toMatchObject({ status: 'active', headSha: parentMrHead })
    expect(
      readFileSync(
        join(
          appHome,
          'workspaces',
          'employee-cases',
          caseId,
          'scene',
          'workspace',
          '.agent-workflow',
          'inputs',
          'requirements',
          caseId,
          'external',
          'files',
          'design.md',
        ),
        'utf8',
      ),
    ).toContain('deterministic greeting')
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

    // The first parent pipeline reports an external dependency. The fixed
    // type package must select collaboration, never ask the Agent to invent a
    // repair strategy or choose a target employee.
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
      ],
    })
    eventCenter.commands.observe({
      sourceRef: { id: 'code-host.activity', revision: 1 },
      eventTypeRef: { id: 'development.pipeline-check-due', revision: 1 },
      subject: { typeId: 'merge-request', subjectRef: 'repo-system-mock!42' },
      occurredAt: Date.now(),
      dedupeKey: `pipeline:${parentMrHead}:external-dependency`,
      summary: 'pipeline requires a dependency repository change',
      payloadArtifactRef: null,
    })
    await driveUntilIdle()
    projection = JSON.parse(runtime.queries.getCase(caseId).projectionJson) as typeof projection
    expect(projection.case).toMatchObject({ state: 'waiting', currentWorkItemRef: null })
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
    expect(
      dependencyProjection.contexts.find(
        (context) => context.typeId === 'development.issue-handling',
      )?.state,
    ).toMatchObject({ repositoryRef: 'repo-system-mock-dependency' })
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
    const largeLogBytes = 2 * 1024 * 1024 + 17
    await suite.client.seedDevelopmentPipeline({
      headSha: parentMrHead,
      targetSha: git(baselineRepo, 'rev-parse', 'HEAD'),
      gates: [
        {
          gateKey: 'compile',
          required: true,
          status: 'pass',
          runRef: 'run-compile-42',
          attempt: 2,
          retryability: 'safe',
          failureCategories: [],
          logs: [{ logId: 'compile-output', bytes: largeLogBytes }],
        },
      ],
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
    const pendingApproval = projection.contexts.find(
      (context) => context.typeId === 'development.approval',
    )!
    expect(pendingApproval.state).toMatchObject({
      status: 'pending',
      adapterRef: approvalAdapterRef,
      externalRequestRef: 'APP-00001',
    })
    const approvalSnapshot = await suite.client.snapshot()
    expect(approvalSnapshot.approvals).toHaveLength(1)
    expect(approvalSnapshot.approvals[0]).toMatchObject({
      idempotencyKey: pendingApproval.state.idempotencyKey,
      correlationRef: pendingApproval.state.correlationRef,
    })

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
      occurredAt: Date.now() + 3,
      dedupeKey: `approval:${pendingApproval.state.correlationRef}:approved`,
      summary: 'external dependency change approved',
      payloadArtifactRef: null,
    })
    await driveUntilIdle()
    projection = JSON.parse(runtime.queries.getCase(caseId).projectionJson) as typeof projection
    expect(
      projection.contexts.find((context) => context.typeId === 'development.approval')?.state,
    ).toMatchObject({ status: 'approved', evidenceRef: 'approval-evidence:APP-00001' })
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
      'pipeline',
      caseId,
      'logs',
      'compile',
      'compile-output.log',
    )
    expect(existsSync(downloadedLog)).toBe(true)
    expect(statSync(downloadedLog).size).toBe(largeLogBytes)

    mrStates.set('repo-system-mock', 'merged')
    eventCenter.commands.observe({
      sourceRef: { id: 'code-host.activity', revision: 1 },
      eventTypeRef: { id: 'development.lifecycle-updated', revision: 2 },
      subject: { typeId: 'merge-request', subjectRef: 'repo-system-mock!42' },
      occurredAt: Date.now() + 4,
      dedupeKey: `lifecycle:${parentMrHead}:merged`,
      summary: 'MR merged by committer',
      payloadArtifactRef: null,
    })
    await driveUntilIdle()
    projection = JSON.parse(runtime.queries.getCase(caseId).projectionJson) as typeof projection
    expect(projection.case.state).toBe('terminal')
    expect(
      projection.contexts.find((context) => context.typeId === 'development.merge-request')?.state,
    ).toMatchObject({ status: 'merged' })

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
        kind: 'external-id',
        target: { repositoryId: 'repo-system-mock-delivery-only' },
        body: null,
        externalId: 'REQ-OS-42',
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
        kind: 'external-id',
        target: { repositoryId: 'repo-system-mock-review' },
        body: null,
        externalId: 'REQ-OS-42',
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
