// RFC-310 OS: locks one durable Case scene from uploaded repository placement
// through fresh-scene rollback, ChangeCandidate, platform commit/CAS push and MR ensure.

import { createEmployeeReactionRoundQueries } from '@/modules/digital-employee/composition'
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb } from '@/db/client'
import {
  cachedRepos,
  employeeCaseWorkspaces,
  employeeCases,
  employeeChangeCandidates,
  employeeReactionRounds,
} from '@/db/schema'
import { composeDevelopmentEmployeePlatformWorkItems } from '@/modules/development-automation/composition/digitalEmployeePlatformWorkItems'
import { composeDevelopmentEmployeeWorkspace } from '@/modules/development-automation/composition/digitalEmployeeWorkspace'
import {
  bindCandidateDeliveryParticipant,
  bindChangeCandidateParticipant,
  bindConflictMergeParticipant,
  bindEmployeeCaseWorkspaceParticipant,
} from '@/modules/source-control/composition'
import { createEmployeeInputArtifactStore } from '@/modules/digital-employee/infrastructure/inputArtifactStore'
import type { ReactionExecutionPlan as EmployeeReactionExecutionPlan } from '@/modules/digital-employee/domain/runtimeModel'
import { canonicalDigest } from '@/modules/development-automation/domain/canonicalJson'

setDefaultTimeout(120_000)

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const root = mkdtempSync(join(tmpdir(), 'rfc310-os-delivery-'))

afterAll(() => rmSync(root, { recursive: true, force: true }))

function git(cwd: string, ...args: string[]): string {
  const process = Bun.spawnSync({ cmd: ['git', ...args], cwd })
  if (process.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${process.stderr.toString()}`)
  }
  return process.stdout.toString().trim()
}

function plan(input: {
  roundRef: string
  caseRef: string
  workItemRef: string
  contexts: readonly object[]
  workspacePolicy?: EmployeeReactionExecutionPlan['workspacePolicy']
  allowedEffectKinds?: readonly string[]
}): EmployeeReactionExecutionPlan {
  return {
    schemaVersion: 1,
    roundRef: input.roundRef,
    executionNonce: 'a'.repeat(64),
    caseRef: { id: input.caseRef, revision: 1 },
    inputContextRefs: [],
    triggeringEventRef: `continuation:${input.workItemRef}`,
    workItemRef: input.workItemRef,
    toolSlotRef: 'default',
    workContractRef: { contractId: `development.${input.workItemRef}`, version: 1 },
    toolRegistrationRef: null,
    connectionRef: null,
    implementationRef: null,
    implementationKind: input.workspacePolicy === undefined ? 'system' : 'agent',
    implementationJson: null,
    inputSchemaId: 'development.input.v1',
    outputSchemaId: 'development.output.v1',
    semanticValidatorId: 'development.validator',
    executionPolicyRevision: 1,
    roundBudgetMs: 60_000,
    externalWaitDeadlineMs: 86_400_000,
    allowedEffectKinds: [...(input.allowedEffectKinds ?? [])],
    workspacePolicy: input.workspacePolicy ?? {
      mode: 'none',
      businessChangeOnOk: 'forbidden',
      writablePrefixes: [],
      platformWritePrefixes: [],
    },
    inputEnvelopeJson: JSON.stringify({
      contextsJson: JSON.stringify(input.contexts),
      executionEnvironmentJson: JSON.stringify({
        kind: 'cached-repository',
        cachedRepoId: 'repo-1',
      }),
    }),
  }
}

describe('RFC-310 Digital Employee OS shared workspace and platform delivery', () => {
  test('upload target and Agent edits survive the Case, fresh retry restores the round scene, and only platform code publishes MR', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const baselineRepo = join(root, 'baseline')
    const remoteRepo = join(root, 'remote.git')
    const appHome = join(root, 'home')
    mkdirSync(baselineRepo, { recursive: true })
    git(baselineRepo, 'init', '-q', '-b', 'main')
    writeFileSync(join(baselineRepo, 'README.md'), '# baseline\n')
    mkdirSync(join(baselineRepo, 'config'), { recursive: true })
    writeFileSync(join(baselineRepo, 'config/existing.txt'), 'old value\n')
    writeFileSync(join(baselineRepo, 'config/already.txt'), 'already supplied\n')
    writeFileSync(join(baselineRepo, 'config/editable-same.txt'), 'same upload baseline\n')
    git(baselineRepo, 'add', '-A')
    git(
      baselineRepo,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=test',
      'commit',
      '-q',
      '-m',
      'baseline',
    )
    const baselineSha = git(baselineRepo, 'rev-parse', 'HEAD')
    mkdirSync(remoteRepo, { recursive: true })
    git(remoteRepo, 'init', '-q', '--bare')
    db.insert(cachedRepos)
      .values({
        id: 'repo-1',
        urlHash: 'deadbeef',
        urlEnc: null,
        urlRedacted: remoteRepo,
        localPath: baselineRepo,
        defaultBranch: 'main',
        lastFetchedAt: 1,
        createdAt: 1,
      })
      .run()
    db.insert(employeeCases)
      .values({
        id: 'case-1',
        employeeId: 'employee-1',
        employeeRevision: 1,
        typeId: 'development',
        typeRevision: 1,
        primaryContextId: 'issue-context',
        executionPolicyRevision: 1,
        state: 'active',
        terminalKind: null,
        blockReason: null,
        currentWorkItemRef: 'analyze-implement',
        activeRoundId: 'round-analyze',
        revision: 1,
        writerGeneration: 1,
        createdAt: 1,
        updatedAt: 1,
        terminalAt: null,
      })
      .run()

    const artifactStore = createEmployeeInputArtifactStore(
      join(appHome, 'artifacts', 'employee-inputs'),
    )
    const uploadSource = join(root, 'requirement.md')
    writeFileSync(uploadSource, '# Required acceptance\n')
    const artifact = await artifactStore.putFile(uploadSource)
    const replacementSource = join(root, 'replacement.txt')
    writeFileSync(replacementSource, 'replacement value\n')
    const replacementArtifact = await artifactStore.putFile(replacementSource)
    const alreadySource = join(root, 'already.txt')
    writeFileSync(alreadySource, 'already supplied\n')
    const alreadyArtifact = await artifactStore.putFile(alreadySource)
    const editableSameSource = join(root, 'editable-same.txt')
    writeFileSync(editableSameSource, 'same upload baseline\n')
    const editableSameArtifact = await artifactStore.putFile(editableSameSource)
    const issueState = {
      status: 'active',
      subjectRef: 'REQ-42',
      repositoryRef: 'repo-1',
      request: {
        kind: 'body-and-files',
        body: 'Implement deterministic delivery',
        externalId: null,
        uploads: [
          {
            artifactRef: `employee-input:${artifact.blobRef}`,
            targetPath: 'docs/requirements/REQ-42.md',
            originalName: 'requirement.md',
          },
          {
            artifactRef: `employee-input:${replacementArtifact.blobRef}`,
            targetPath: 'config/existing.txt',
            originalName: 'replacement.txt',
          },
          {
            artifactRef: `employee-input:${alreadyArtifact.blobRef}`,
            targetPath: 'config/already.txt',
            originalName: 'already.txt',
          },
          {
            artifactRef: `employee-input:${editableSameArtifact.blobRef}`,
            targetPath: 'config/editable-same.txt',
            originalName: 'editable-same.txt',
          },
        ],
      },
      materialArtifactRefs: [
        `employee-input:${artifact.blobRef}`,
        `employee-input:${replacementArtifact.blobRef}`,
        `employee-input:${alreadyArtifact.blobRef}`,
        `employee-input:${editableSameArtifact.blobRef}`,
      ],
    }
    const issueContext = {
      id: 'issue-context',
      revision: 1,
      typeId: 'development.issue-handling',
      stateJson: JSON.stringify(issueState),
    }
    const writePolicy = {
      mode: 'write' as const,
      businessChangeOnOk: 'required' as const,
      writablePrefixes: [],
      platformWritePrefixes: [],
    }
    const analyzePlan = plan({
      roundRef: 'round-analyze',
      caseRef: 'case-1',
      workItemRef: 'analyze-implement',
      contexts: [issueContext],
      workspacePolicy: writePolicy,
    })
    db.insert(employeeReactionRounds)
      .values({
        id: 'round-analyze',
        caseId: 'case-1',
        caseRevision: 1,
        inboxId: null,
        employeeId: 'employee-1',
        employeeRevision: 1,
        ruleId: 'continue-analyze',
        workItemRef: 'analyze-implement',
        workContractId: 'development.analyze-implement',
        workContractVersion: 1,
        toolId: null,
        toolRevision: null,
        executionPolicyRevision: 1,
        inputContextRefsJson: '[]',
        planJson: JSON.stringify(analyzePlan),
        state: 'running',
        executionRef: 'task-1',
        outputJson: null,
        attemptOrdinal: 0,
        createdAt: 2,
        updatedAt: 2,
        settledAt: null,
      })
      .run()

    const workspace = composeDevelopmentEmployeeWorkspace({
      db,
      appHome,
      reactionRounds: createEmployeeReactionRoundQueries(db),
      inputArtifacts: artifactStore,
      sourceControl: bindEmployeeCaseWorkspaceParticipant(),
      conflictMerge: bindConflictMergeParticipant(),
      now: () => 10,
    })
    const first = await workspace.prepare({
      planJson: JSON.stringify(analyzePlan),
      attemptJson: JSON.stringify({ ordinal: 0, mode: 'initial', previousError: null }),
    })
    expect(first.kind).toBe('repository')
    if (first.kind !== 'repository') return
    expect(readFileSync(join(first.workspacePath, 'docs/requirements/REQ-42.md'), 'utf8')).toBe(
      '# Required acceptance\n',
    )
    expect(readFileSync(join(first.workspacePath, 'config/existing.txt'), 'utf8')).toBe(
      'replacement value\n',
    )
    expect(readFileSync(join(first.workspacePath, 'config/already.txt'), 'utf8')).toBe(
      'already supplied\n',
    )
    expect(readFileSync(join(first.workspacePath, 'config/editable-same.txt'), 'utf8')).toBe(
      'same upload baseline\n',
    )
    mkdirSync(join(first.workspacePath, 'src'), { recursive: true })
    writeFileSync(join(first.workspacePath, 'src', 'feature.ts'), 'export const feature = 1\n')
    expect(
      await workspace.validate({
        roundRef: 'round-analyze',
        taskStatus: 'done',
        outputJson: JSON.stringify({ status: 'ok' }),
      }),
    ).toEqual({ ok: true })

    const fresh = await workspace.prepare({
      planJson: JSON.stringify(analyzePlan),
      attemptJson: JSON.stringify({
        ordinal: 1,
        mode: 'fresh-scene',
        previousError: 'bad envelope',
      }),
    })
    expect(fresh.kind).toBe('repository')
    if (fresh.kind !== 'repository') return
    expect(() => readFileSync(join(fresh.workspacePath, 'src', 'feature.ts'))).toThrow()
    mkdirSync(join(fresh.workspacePath, 'src'), { recursive: true })
    writeFileSync(join(fresh.workspacePath, 'src', 'feature.ts'), 'export const feature = 2\n')
    writeFileSync(
      join(fresh.workspacePath, 'config/editable-same.txt'),
      'same upload edited by agent\n',
    )
    expect(
      await workspace.validate({
        roundRef: 'round-analyze',
        taskStatus: 'done',
        outputJson: JSON.stringify({ status: 'ok' }),
      }),
    ).toEqual({ ok: true })
    db.update(employeeReactionRounds)
      .set({
        state: 'completed',
        outputJson: JSON.stringify({ status: 'ok', summary: 'Implement feature' }),
        settledAt: 20,
      })
      .run()
    const deliveryIssueContext = {
      ...issueContext,
      revision: 2,
      stateJson: JSON.stringify({
        ...issueState,
        deliveryContent: {
          commitMessage:
            'implement deterministic delivery\n\nApply the requested repository files and feature change.',
          mergeRequestTitle: 'Implement deterministic delivery',
          mergeRequestDescription:
            '## Summary\n\nApply the requested repository files and feature change.',
        },
      }),
    }

    const preparePlan = plan({
      roundRef: 'round-prepare',
      caseRef: 'case-1',
      workItemRef: 'prepare-change',
      contexts: [deliveryIssueContext],
      allowedEffectKinds: ['source-control.candidate'],
    })
    db.insert(employeeReactionRounds)
      .values({
        id: 'round-prepare',
        caseId: 'case-1',
        caseRevision: 2,
        inboxId: null,
        employeeId: 'employee-1',
        employeeRevision: 1,
        ruleId: 'continue-prepare',
        workItemRef: 'prepare-change',
        workContractId: 'development.prepare-change',
        workContractVersion: 1,
        toolId: null,
        toolRevision: null,
        executionPolicyRevision: 1,
        inputContextRefsJson: '[]',
        planJson: JSON.stringify(preparePlan),
        state: 'planned',
        executionRef: null,
        outputJson: null,
        attemptOrdinal: 0,
        createdAt: 30,
        updatedAt: 30,
        settledAt: null,
      })
      .run()
    let ensureCalls = 0
    let approvalSubmits = 0
    let approvalObserves = 0
    let observedHead: string | null = null
    let observedTargetSha: string | null = null
    const platform = composeDevelopmentEmployeePlatformWorkItems({
      reactionRounds: createEmployeeReactionRoundQueries(db),
      db,
      appHome,
      conflictMerge: bindConflictMergeParticipant(),
      sourceControl: {
        ...bindChangeCandidateParticipant(),
        ...bindCandidateDeliveryParticipant(),
        ...bindEmployeeCaseWorkspaceParticipant(),
      },
      repoRemote: { resolve: () => ({ remoteUrl: remoteRepo, defaultBranch: 'main' }) },
      mrEffects: {
        async reply() {
          return { ok: true as const, noteRef: 'note-1' }
        },
        async ensure() {
          ensureCalls += 1
          return {
            ok: true,
            mr: {
              mrRef: '42',
              webUrl: 'https://code.example/mr/42',
              state: 'opened',
              sourceSha: null,
              created: true,
            },
          }
        },
        async observe() {
          return {
            ok: true,
            observation: {
              state: 'opened',
              sourceSha: observedHead,
              targetBranch: 'main',
              webUrl: 'https://code.example/mr/42',
            },
          }
        },
      },
      mrFacts: {
        async collect() {
          return {
            ok: true as const,
            snapshot: {
              state: 'opened' as const,
              headSha: observedHead,
              targetSha: observedTargetSha,
              targetBranch: 'main',
              draft: false,
              mergeableState: 'mergeable' as const,
              approvalHold: false,
              mergedCommitSha: null,
              unresolvedReviewCount: 0,
              reviewThreads: [],
            },
          }
        },
      },
      approvalGateway: {
        async lookupByIdempotencyKey() {
          return null
        },
        async submit(intent) {
          approvalSubmits += 1
          return {
            ok: true as const,
            receipt: {
              intentDigest: canonicalDigest(intent),
              correlationRef: 'approval-correlation-1',
              externalRequestRef: 'APP-42',
              submittedRevision: 'submit-1',
              submittedAt: '2026-08-21T00:00:00.000Z',
            },
          }
        },
        async observe(input) {
          approvalObserves += 1
          const approved = approvalObserves >= 2
          return {
            ok: true as const,
            receipt: {
              correlationRef: input.correlationRef,
              observedRevision: `observe-${approvalObserves}`,
              status: approved ? ('approved' as const) : ('pending' as const),
              evidenceRef: approved ? 'approval-evidence-42' : null,
              observedAt: `2026-08-21T00:00:0${approvalObserves}.000Z`,
            },
          }
        },
      },
      now: () => 40,
    })
    const approvalDraftContext = {
      id: 'approval-context',
      revision: 1,
      typeId: 'development.approval',
      stateJson: JSON.stringify({
        status: 'draft',
        approvalType: 'gate-change',
        adapterRef: { id: 'approval-adapter', revision: 1 },
        validatedDraftRef: 'approval-draft-42',
        subjectRef: null,
        deadlineAt: null,
        idempotencyKey: null,
        correlationRef: null,
        externalRequestRef: null,
        submittedRevision: null,
        observedRevision: null,
        evidenceRef: null,
      }),
    }
    const submitApprovalPlan = plan({
      roundRef: 'round-prepare',
      caseRef: 'case-1',
      workItemRef: 'submit-approval',
      contexts: [approvalDraftContext],
      allowedEffectKinds: ['external-approval.submit'],
    })
    const submittedApproval = JSON.parse(await platform.execute(submitApprovalPlan)) as {
      status: string
      contextPatches: Array<{ stateJson: string }>
    }
    expect(submittedApproval.status).toBe('ok')
    expect(approvalSubmits).toBe(1)
    const pendingApprovalContext = {
      ...approvalDraftContext,
      revision: 2,
      stateJson: submittedApproval.contextPatches[0]!.stateJson,
    }
    expect(JSON.parse(pendingApprovalContext.stateJson)).toMatchObject({
      status: 'pending',
      correlationRef: 'approval-correlation-1',
      externalRequestRef: 'APP-42',
    })
    const observeApprovalPlan = plan({
      roundRef: 'round-observe-approval',
      caseRef: 'case-1',
      workItemRef: 'observe-approval',
      contexts: [pendingApprovalContext],
      allowedEffectKinds: ['external-approval.observe'],
    })
    const pendingApproval = JSON.parse(await platform.execute(observeApprovalPlan)) as {
      status: string
      contextPatches: Array<{ stateJson: string }>
    }
    expect(pendingApproval.status).toBe('needs-input')
    const approvedApproval = JSON.parse(await platform.execute(observeApprovalPlan)) as {
      status: string
      contextPatches: Array<{ stateJson: string }>
    }
    expect(approvedApproval.status).toBe('ok')
    expect(JSON.parse(approvedApproval.contextPatches[0]!.stateJson)).toMatchObject({
      status: 'approved',
      evidenceRef: 'approval-evidence-42',
    })
    expect({ approvalSubmits, approvalObserves }).toEqual({
      approvalSubmits: 1,
      approvalObserves: 2,
    })
    const prepared = JSON.parse(await platform.execute(preparePlan)) as {
      status: string
      contextPatches: Array<{ stateJson: string }>
    }
    expect(prepared.status).toBe('ok')
    const candidateState = JSON.parse(prepared.contextPatches[0]!.stateJson) as {
      candidateRef: string
      changedPaths: string[]
    }
    expect(candidateState.changedPaths).toEqual(
      expect.arrayContaining([
        'config/existing.txt',
        'config/editable-same.txt',
        'docs/requirements/REQ-42.md',
        'src/feature.ts',
      ]),
    )
    expect(candidateState.changedPaths).not.toContain('config/already.txt')
    const candidateReceipt = JSON.parse(
      db
        .select({ receiptJson: employeeChangeCandidates.receiptJson })
        .from(employeeChangeCandidates)
        .get()!.receiptJson,
    ) as {
      uploadPlan: {
        entries: Array<{ targetPath: string; disposition: string; fileMode: string }>
      }
    }
    expect(candidateReceipt.uploadPlan.entries).toEqual([
      expect.objectContaining({
        targetPath: 'docs/requirements/REQ-42.md',
        disposition: 'create',
        fileMode: 'regular',
      }),
      expect.objectContaining({
        targetPath: 'config/existing.txt',
        disposition: 'replace',
        fileMode: 'regular',
      }),
      expect.objectContaining({
        targetPath: 'config/already.txt',
        disposition: 'already-present',
        fileMode: 'regular',
      }),
      expect.objectContaining({
        targetPath: 'config/editable-same.txt',
        disposition: 'replace',
        fileMode: 'regular',
      }),
    ])
    db.update(employeeReactionRounds).set({ state: 'completed', settledAt: 34 }).run()

    const candidateContext = {
      id: 'candidate-context',
      revision: 1,
      typeId: 'development.change-candidate',
      stateJson: prepared.contextPatches[0]!.stateJson,
    }
    const publishPlan = plan({
      roundRef: 'round-publish',
      caseRef: 'case-1',
      workItemRef: 'publish-mr',
      contexts: [deliveryIssueContext, candidateContext],
      allowedEffectKinds: [
        'source-control.commit',
        'source-control.push',
        'code-host.merge-request.ensure',
      ],
    })
    db.insert(employeeReactionRounds)
      .values({
        id: 'round-publish',
        caseId: 'case-1',
        caseRevision: 3,
        inboxId: null,
        employeeId: 'employee-1',
        employeeRevision: 1,
        ruleId: 'continue-publish',
        workItemRef: 'publish-mr',
        workContractId: 'development.publish-mr',
        workContractVersion: 1,
        toolId: null,
        toolRevision: null,
        executionPolicyRevision: 1,
        inputContextRefsJson: '[]',
        planJson: JSON.stringify(publishPlan),
        state: 'planned',
        executionRef: null,
        outputJson: null,
        attemptOrdinal: 0,
        createdAt: 35,
        updatedAt: 35,
        settledAt: null,
      })
      .run()
    const published = JSON.parse(await platform.execute(publishPlan)) as {
      status: string
      contextPatches: Array<{ contextTypeId: string; stateJson: string }>
    }
    expect(published.status).toBe('ok')
    db.update(employeeReactionRounds)
      .set({ state: 'completed', settledAt: 45 })
      .where(eq(employeeReactionRounds.id, 'round-publish'))
      .run()
    expect(ensureCalls).toBe(1)
    const mrPatch = published.contextPatches.find(
      (patch) => patch.contextTypeId === 'development.merge-request',
    )!
    expect(JSON.parse(mrPatch.stateJson)).toMatchObject({
      mergeRequestRef: 'repo-1!42',
      repositoryRef: 'repo-1',
      providerMrRef: '42',
      readyToMerge: false,
    })
    const branch = 'agent-workflow/employee/case-1'
    const publishedSha = git(remoteRepo, 'rev-parse', `refs/heads/${branch}`)
    expect(publishedSha).toMatch(/^[a-f0-9]{40}$/)
    expect(git(remoteRepo, 'show', `${publishedSha}:src/feature.ts`)).toBe(
      'export const feature = 2',
    )
    expect(git(remoteRepo, 'show', `${publishedSha}:docs/requirements/REQ-42.md`)).toBe(
      '# Required acceptance',
    )
    expect(git(remoteRepo, 'show', `${publishedSha}:config/existing.txt`)).toBe('replacement value')
    expect(git(remoteRepo, 'show', `${publishedSha}:config/already.txt`)).toBe('already supplied')
    expect(git(remoteRepo, 'show', `${publishedSha}:config/editable-same.txt`)).toBe(
      'same upload edited by agent',
    )

    // A later target-branch change conflicts with the employee's source head.
    // The OS must give the Agent a real marker scene, then platform code alone
    // creates and CAS-pushes the two-parent merge commit.
    mkdirSync(join(baselineRepo, 'src'), { recursive: true })
    writeFileSync(join(baselineRepo, 'src', 'feature.ts'), 'export const feature = 99\n')
    git(baselineRepo, 'add', '-A')
    git(
      baselineRepo,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=test',
      'commit',
      '-q',
      '-m',
      'target changes same file',
    )
    const targetSha = git(baselineRepo, 'rev-parse', 'HEAD')
    git(baselineRepo, 'push', '-q', remoteRepo, 'HEAD:refs/heads/main')
    const conflictMrState = {
      ...(JSON.parse(mrPatch.stateJson) as object),
      headSha: publishedSha,
      factsHeadSha: publishedSha,
      targetSha,
      mergeableState: 'conflict',
    }
    const conflictMrContext = {
      id: 'mr-context',
      revision: 2,
      typeId: 'development.merge-request',
      stateJson: JSON.stringify(conflictMrState),
    }
    const repairConflictPlan = plan({
      roundRef: 'round-repair-conflict',
      caseRef: 'case-1',
      workItemRef: 'repair-conflict',
      contexts: [deliveryIssueContext, conflictMrContext],
      workspacePolicy: writePolicy,
    })
    db.insert(employeeReactionRounds)
      .values({
        id: 'round-repair-conflict',
        caseId: 'case-1',
        caseRevision: 4,
        inboxId: null,
        employeeId: 'employee-1',
        employeeRevision: 1,
        ruleId: 'handle-conflict',
        workItemRef: 'repair-conflict',
        workContractId: 'development.repair-conflict',
        workContractVersion: 1,
        toolId: null,
        toolRevision: null,
        executionPolicyRevision: 1,
        inputContextRefsJson: '[]',
        planJson: JSON.stringify(repairConflictPlan),
        state: 'running',
        executionRef: 'task-conflict',
        outputJson: null,
        attemptOrdinal: 0,
        createdAt: 50,
        updatedAt: 50,
        settledAt: null,
      })
      .run()
    const conflictScene = await workspace.prepare({
      planJson: JSON.stringify(repairConflictPlan),
      attemptJson: JSON.stringify({ ordinal: 0, mode: 'initial', previousError: null }),
    })
    expect(conflictScene.kind).toBe('repository')
    if (conflictScene.kind !== 'repository') return
    expect(readFileSync(join(conflictScene.workspacePath, 'src/feature.ts'), 'utf8')).toContain(
      '<<<<<<<',
    )
    const freshConflictScene = await workspace.prepare({
      planJson: JSON.stringify(repairConflictPlan),
      attemptJson: JSON.stringify({ ordinal: 1, mode: 'fresh-scene', previousError: 'retry' }),
    })
    expect(freshConflictScene.kind).toBe('repository')
    if (freshConflictScene.kind !== 'repository') return
    expect(freshConflictScene.workspacePath).not.toBe(conflictScene.workspacePath)
    expect(
      readFileSync(join(freshConflictScene.workspacePath, 'src/feature.ts'), 'utf8'),
    ).toContain('<<<<<<<')
    const replayedFreshConflictScene = await workspace.prepare({
      planJson: JSON.stringify(repairConflictPlan),
      attemptJson: JSON.stringify({ ordinal: 1, mode: 'fresh-scene', previousError: 'retry' }),
    })
    expect(replayedFreshConflictScene).toMatchObject({
      kind: 'repository',
      workspacePath: freshConflictScene.workspacePath,
    })
    writeFileSync(
      join(freshConflictScene.workspacePath, 'src/feature.ts'),
      'export const feature = 3\n',
    )
    expect(
      await workspace.validate({
        roundRef: 'round-repair-conflict',
        taskStatus: 'done',
        outputJson: JSON.stringify({ status: 'ok' }),
      }),
    ).toEqual({ ok: true })
    db.update(employeeReactionRounds)
      .set({ state: 'completed', settledAt: 60 })
      .where(eq(employeeReactionRounds.id, 'round-repair-conflict'))
      .run()

    const publishConflictPlan = plan({
      roundRef: 'round-publish-conflict',
      caseRef: 'case-1',
      workItemRef: 'publish-conflict',
      contexts: [conflictMrContext],
      allowedEffectKinds: ['source-control.commit', 'source-control.push'],
    })
    const conflictPublished = JSON.parse(await platform.execute(publishConflictPlan)) as {
      status: string
      contextPatches: Array<{ contextTypeId: string; stateJson: string }>
    }
    expect(conflictPublished.status).toBe('ok')
    const mergeSha = git(remoteRepo, 'rev-parse', `refs/heads/${branch}`)
    const parents = git(baselineRepo, 'show', '-s', '--format=%P', mergeSha).split(' ')
    expect(parents).toEqual([publishedSha, targetSha])
    expect(git(remoteRepo, 'show', `${mergeSha}:src/feature.ts`)).toBe('export const feature = 3')
    expect(JSON.parse(conflictPublished.contextPatches[0]!.stateJson)).toMatchObject({
      headSha: mergeSha,
      factsHeadSha: null,
      mergeableState: 'unknown',
      readyToMerge: false,
    })
    const replayedConflictPublish = JSON.parse(await platform.execute(publishConflictPlan)) as {
      status: string
      contextPatches: Array<{ stateJson: string }>
    }
    expect(replayedConflictPublish.status).toBe('ok')
    expect(JSON.parse(replayedConflictPublish.contextPatches[0]!.stateJson)).toMatchObject({
      headSha: mergeSha,
    })

    // A committer or another automation can advance the same MR source branch.
    // Lifecycle observation must adopt that exact head, discard stale business
    // edits, and retain platform-only evidence needed by later reactions.
    git(baselineRepo, 'checkout', '-q', '--detach', mergeSha)
    writeFileSync(join(baselineRepo, 'src', 'external.ts'), 'export const external = true\n')
    git(baselineRepo, 'add', 'src/external.ts')
    git(
      baselineRepo,
      '-c',
      'user.email=committer@example.com',
      '-c',
      'user.name=committer',
      'commit',
      '-q',
      '-m',
      'committer advances employee branch',
    )
    const externalSha = git(baselineRepo, 'rev-parse', 'HEAD')
    git(baselineRepo, 'push', '-q', remoteRepo, `HEAD:refs/heads/${branch}`)
    observedHead = externalSha
    observedTargetSha = targetSha

    const caseWorkspace = join(
      appHome,
      'workspaces',
      'employee-cases',
      'case-1',
      'scene',
      'workspace',
    )
    writeFileSync(join(caseWorkspace, 'src', 'stale-local.ts'), 'stale local repair\n')
    const retainedEvidence = join(
      caseWorkspace,
      '.agent-workflow',
      'pipeline',
      'case-1',
      'retained.log',
    )
    mkdirSync(join(retainedEvidence, '..'), { recursive: true })
    writeFileSync(retainedEvidence, 'keep this platform evidence\n')
    const latestMrContext = {
      id: 'mr-context',
      revision: 3,
      typeId: 'development.merge-request',
      stateJson: conflictPublished.contextPatches[0]!.stateJson,
    }
    const observedOutput = JSON.parse(
      await platform.execute(
        plan({
          roundRef: 'round-observe-external-head',
          caseRef: 'case-1',
          workItemRef: 'observe-mr',
          contexts: [latestMrContext],
        }),
      ),
    ) as { status: string; contextPatches: Array<{ stateJson: string }> }
    expect(observedOutput.status).toBe('ok')
    expect(JSON.parse(observedOutput.contextPatches[0]!.stateJson)).toMatchObject({
      headSha: externalSha,
      factsHeadSha: externalSha,
      targetSha,
    })
    expect(readFileSync(join(caseWorkspace, 'src', 'external.ts'), 'utf8')).toBe(
      'export const external = true\n',
    )
    expect(existsSync(join(caseWorkspace, 'src', 'stale-local.ts'))).toBe(false)
    expect(readFileSync(retainedEvidence, 'utf8')).toBe('keep this platform evidence\n')
    expect(
      db
        .select({
          baselineSha: employeeCaseWorkspaces.baselineSha,
          remoteHeadSha: employeeCaseWorkspaces.remoteHeadSha,
        })
        .from(employeeCaseWorkspaces)
        .where(eq(employeeCaseWorkspaces.caseId, 'case-1'))
        .get(),
    ).toEqual({ baselineSha: externalSha, remoteHeadSha: externalSha })
    expect(baselineSha).not.toBe(publishedSha)
  })
})
