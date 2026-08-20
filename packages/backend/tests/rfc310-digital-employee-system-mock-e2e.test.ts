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
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { startSystemMockSuite, type StartedSystemMockSuite } from '@agent-workflow/system-mocks'

import { createInMemoryDb } from '@/db/client'
import { cachedRepos, employeeOsOutbox } from '@/db/schema'
import { composeDevelopmentEmployeePlatformWorkItems } from '@/modules/development-automation/composition/digitalEmployeePlatformWorkItems'
import { composeDevelopmentEmployeeWorkspace } from '@/modules/development-automation/composition/digitalEmployeeWorkspace'
import {
  developmentEmployeeRuntimeCodec,
  developmentEmployeeTypePackage,
} from '@/modules/development-automation/composition/employeeTypePackage'
import {
  createDevelopmentAdapter,
  publishDevelopmentAdapter,
} from '@/modules/integration/application/developmentAdapterCommands'
import { composeApprovalGatewayRunner } from '@/modules/integration/composition/approvalGateway'
import { createSqliteDevelopmentAdapterStore } from '@/modules/integration/infrastructure/sqliteDevelopmentAdapterStore'
import { composeDigitalEmployee } from '@/modules/digital-employee/composition'
import type { ReactionExecutionPlan } from '@/modules/digital-employee/domain/runtimeModel'
import { createEmployeeInputArtifactStore } from '@/modules/digital-employee/infrastructure/inputArtifactStore'
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
  },
): string {
  return JSON.stringify({
    schemaVersion: 1,
    roundRef: plan.roundRef,
    executionNonce: plan.executionNonce,
    status: 'ok',
    summary: body.summary,
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
      typePackageDescriptorJsons: [developmentEmployeeTypePackage.descriptorJson],
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
    let executionOrdinal = 0
    const execution = {
      async launch(plan: ReactionExecutionPlan, attempt: { ordinal: number; mode: string }) {
        const scene = await workspace.prepare({
          planJson: JSON.stringify(plan),
          attemptJson: JSON.stringify({ ...attempt, previousError: null }),
        })
        if (scene.kind !== 'repository')
          throw new Error(`${plan.workItemRef} needs repository scene`)
        const requirementsMount = scene.platformInputPaths.find((path) =>
          path.startsWith('.agent-workflow/inputs/requirements/'),
        )!
        const pipelineMount = scene.platformInputPaths.find((path) =>
          path.startsWith('.agent-workflow/pipeline/'),
        )!
        const contexts = contextsOf(plan)
        let outputJson: string
        if (plan.workItemRef === 'prepare-materials') {
          const issue = contexts.find((context) => context.typeId === 'development.issue-handling')!
          const issueState = JSON.parse(issue.stateJson) as {
            request: { externalId: string | null }
            materialArtifactRefs: string[]
          }
          const sink = join(scene.workspacePath, requirementsMount)
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
            (file) => `${requirementsMount}/${file.relativePath}`,
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
          outputJson = output(plan, { summary: '实现 Java greeting 并完成本地检查' })
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
        } else if (plan.workItemRef === 'prepare-approval') {
          const delegation = contexts.find(
            (context) => context.typeId === 'development.delegation',
          )!
          expect(JSON.parse(delegation.stateJson)).toMatchObject({ status: 'satisfied' })
          expect(plan.connectionRef).toEqual(approvalAdapterRef)
          outputJson = output(plan, {
            summary: '根据协同仓库结果生成确定性审批草稿',
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
                  validatedDraftRef: `approval-draft:${plan.caseRef.id}:${delegation.revision}`,
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
    ])
    const mrStates = new Map<string, 'opened' | 'merged'>([
      ['repo-system-mock', 'opened'],
      ['repo-system-mock-dependency', 'opened'],
    ])
    const mrHeads = new Map<string, string>()
    const mrDescriptions = new Map<string, string>()
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
        async ensure(repositoryId, request) {
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
        async observe(repositoryId) {
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
        async collect(repositoryId) {
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
              approvalHold: true,
              mergedCommitSha: state === 'merged' ? head : null,
              unresolvedReviewCount: 0,
              reviewThreads: [],
            },
          }
        },
      },
    })

    let idOrdinal = 0
    const employeeOs = composeDigitalEmployee({
      db,
      appHome,
      typePackages: [developmentEmployeeTypePackage],
      inputArtifacts,
      id: () => `os-${String(++idOrdinal).padStart(5, '0')}`,
      resourceCatalog: {
        async resolveAgent(ref) {
          return {
            kind: 'agent' as const,
            ref,
            name: ref.id,
            available: true,
            closureSummary: 'system-mock exact Agent',
          }
        },
        async resolveWorkflow(ref) {
          return {
            kind: 'workflow' as const,
            ref,
            name: ref.id,
            available: true,
            closureSummary: 'system-mock exact Workflow',
          }
        },
      },
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
      fixtureRunner: {
        async validate() {
          return [{ code: 'system-mock-fixture', ok: true, detail: 'covered by journey' }]
        },
      },
      runtime: {
        eventCenter: eventCenter.participant,
        codecs: [developmentEmployeeRuntimeCodec],
        execution,
        platformWorkItems: platform,
      },
    })
    const typeRef = { typeId: 'development', revision: 1 }
    const typePackage = employeeOs.queries.getType(typeRef)
    const bindings: Array<{
      workItemRef: string
      slotRef: string
      registrationRef: { id: string; revision: number }
    }> = []
    for (const item of typePackage.authoringManifest.workItems) {
      for (const role of item.toolRoleGroups) {
        for (const slot of role.bindingSlots) {
          if (!slot.required) continue
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
    const dependencyJob = employeeOs.commands.createJobTemplate({
      typeRef,
      actorUserId: 'system-mock-author',
      body: {
        name: '依赖仓库 Java 岗位',
        description: '在另一个仓库完成配套变更',
        defaultToolBindings: bindings,
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
        enabled: true,
        workScope: { kind: 'repository', repositoryId: 'repo-system-mock-dependency' },
        toolOverrides: [],
      },
    })
    const dependencyEmployeeRef = employeeOs.commands.publishEmployee({
      id: dependencyEmployee.id,
      actorUserId: 'system-mock-author',
    })
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
        enabled: true,
        workScope: { kind: 'repository', repositoryId: 'repo-system-mock' },
        toolOverrides: [],
      },
    })
    const employeeRef = employeeOs.commands.publishEmployee({
      id: employee.id,
      actorUserId: 'system-mock-author',
    })
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
        `Digital Employee OS journey exceeded deterministic step budget: ${JSON.stringify({ cases, pendingOutbox })}`,
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
      sourceRef: { id: 'development.code-host-state', revision: 1 },
      eventTypeRef: { id: 'development.pipeline-updated', revision: 1 },
      subject: { typeId: 'merge-request', subjectRef: 'repo-system-mock!42' },
      occurredAt: Date.now(),
      dedupeKey: `pipeline:${parentMrHead}:external-dependency`,
      summary: 'pipeline requires a dependency repository change',
      payloadArtifactRef: null,
    })
    await driveUntilIdle()
    projection = JSON.parse(runtime.queries.getCase(caseId).projectionJson) as typeof projection
    expect(projection.case).toMatchObject({ state: 'waiting', currentWorkItemRef: null })
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
      sourceRef: { id: 'development.code-host-state', revision: 1 },
      eventTypeRef: { id: 'development.pipeline-updated', revision: 1 },
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
      sourceRef: { id: 'development.code-host-state', revision: 1 },
      eventTypeRef: { id: 'development.lifecycle-updated', revision: 1 },
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
      sourceRef: { id: 'development.code-host-state', revision: 1 },
      eventTypeRef: { id: 'development.lifecycle-updated', revision: 1 },
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
  })
})
