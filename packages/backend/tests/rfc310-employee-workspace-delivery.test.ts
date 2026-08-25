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
  employeeRoundWorkspaceStates,
} from '@/db/schema'
import { composeDevelopmentEmployeePlatformWorkItems } from '@/modules/development-automation/composition/digitalEmployeePlatformWorkItems'
import { developmentEmployeeRuntimeCodec } from '@/modules/development-automation/composition/employeeTypePackage'
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
import { staticCachedRepositoryPreparation } from './helpers/staticCachedRepositoryPreparation'

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
  employeeTypeRef?: EmployeeReactionExecutionPlan['employeeTypeRef']
  workspacePolicy?: EmployeeReactionExecutionPlan['workspacePolicy']
  allowedEffectKinds?: readonly string[]
}): EmployeeReactionExecutionPlan {
  return {
    schemaVersion: 1,
    roundRef: input.roundRef,
    executionNonce: 'a'.repeat(64),
    caseRef: { id: input.caseRef, revision: 1 },
    employeeTypeRef: input.employeeTypeRef ?? null,
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
      repositoryPreparation: staticCachedRepositoryPreparation(db),
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

    // Real-environment regression 2026-08-24: a delegated Case can retain the
    // parent's frozen requirement and pipeline refs while its already-created
    // scene/checkpoint only contains the child namespace. A fresh retry must
    // hydrate those explicit grants without any manual DB or workspace repair.
    const inheritedMaterialRef =
      '.agent-workflow/inputs/requirements/source-case/external/issue-8.md'
    const inheritedPipelineRef = '.agent-workflow/pipeline/source-case/'
    const sourceCaseWorkspace = join(
      appHome,
      'workspaces',
      'employee-cases',
      'source-case',
      'scene',
      'workspace',
    )
    mkdirSync(
      join(sourceCaseWorkspace, '.agent-workflow/inputs/requirements/source-case/external'),
      { recursive: true },
    )
    writeFileSync(
      join(sourceCaseWorkspace, inheritedMaterialRef),
      '# Inherited issue 8 acceptance\n',
    )
    mkdirSync(join(sourceCaseWorkspace, inheritedPipelineRef), { recursive: true })
    writeFileSync(
      join(sourceCaseWorkspace, inheritedPipelineRef, 'typecheck.log'),
      'source dependency failed typecheck\n',
    )
    const inheritedIssueState = {
      ...issueState,
      materialArtifactRefs: [...issueState.materialArtifactRefs, inheritedMaterialRef],
    }
    const inheritedIssueContext = {
      ...issueContext,
      revision: 2,
      stateJson: JSON.stringify(inheritedIssueState),
      artifactRefs: [inheritedMaterialRef, inheritedPipelineRef],
    }
    const inheritedAnalyzePlan = plan({
      roundRef: 'round-analyze',
      caseRef: 'case-1',
      workItemRef: 'analyze-implement',
      contexts: [inheritedIssueContext],
      workspacePolicy: writePolicy,
    })
    db.update(employeeReactionRounds)
      .set({ planJson: JSON.stringify(inheritedAnalyzePlan), updatedAt: 11 })
      .where(eq(employeeReactionRounds.id, 'round-analyze'))
      .run()

    const fresh = await workspace.prepare({
      planJson: JSON.stringify(inheritedAnalyzePlan),
      attemptJson: JSON.stringify({
        ordinal: 1,
        mode: 'fresh-scene',
        previousError: 'bad envelope',
      }),
    })
    expect(fresh.kind).toBe('repository')
    if (fresh.kind !== 'repository') return
    expect(() => readFileSync(join(fresh.workspacePath, 'src', 'feature.ts'))).toThrow()
    expect(readFileSync(join(fresh.workspacePath, inheritedMaterialRef), 'utf8')).toBe(
      '# Inherited issue 8 acceptance\n',
    )
    expect(
      readFileSync(join(fresh.workspacePath, inheritedPipelineRef, 'typecheck.log'), 'utf8'),
    ).toBe('source dependency failed typecheck\n')
    expect(fresh.platformInputPaths).toEqual(
      expect.arrayContaining([inheritedMaterialRef, inheritedPipelineRef.slice(0, -1)]),
    )
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
    writeFileSync(join(fresh.workspacePath, inheritedMaterialRef), 'tampered child material\n')
    await expect(
      workspace.prepare({
        planJson: JSON.stringify(inheritedAnalyzePlan),
        attemptJson: JSON.stringify({
          ordinal: 2,
          mode: 'same-scene',
          previousError: 'retry after material tamper',
        }),
      }),
    ).rejects.toThrow('frozen artifact target disagrees with its source')
    writeFileSync(
      join(fresh.workspacePath, inheritedMaterialRef),
      '# Inherited issue 8 acceptance\n',
    )
    db.update(employeeReactionRounds)
      .set({
        state: 'completed',
        outputJson: JSON.stringify({ status: 'ok', summary: 'Implement feature' }),
        settledAt: 20,
      })
      .run()

    writeFileSync(join(fresh.workspacePath, 'src', 'feature.ts'), 'export const feature = 999\n')

    // A provider fact may preempt prepare-change after a completed Agent round.
    // Replaying the same action sees the already validated Case delta in its
    // initial snapshot and must be able to carry that exact unpublished delta
    // forward without forcing the Agent to manufacture an unrelated edit.
    const recoveryPlan = plan({
      roundRef: 'round-analyze-recovery',
      caseRef: 'case-1',
      workItemRef: 'analyze-implement',
      contexts: [inheritedIssueContext],
      workspacePolicy: writePolicy,
    })
    db.insert(employeeReactionRounds)
      .values({
        id: 'round-analyze-recovery',
        caseId: 'case-1',
        caseRevision: 2,
        inboxId: null,
        employeeId: 'employee-1',
        employeeRevision: 1,
        ruleId: 'continue-analyze-recovery',
        workItemRef: 'analyze-implement',
        workContractId: 'development.analyze-implement',
        workContractVersion: 1,
        toolId: null,
        toolRevision: null,
        executionPolicyRevision: 1,
        inputContextRefsJson: '[]',
        planJson: JSON.stringify(recoveryPlan),
        state: 'running',
        executionRef: 'task-recovery',
        outputJson: null,
        attemptOrdinal: 0,
        createdAt: 21,
        updatedAt: 21,
        settledAt: null,
      })
      .run()
    expect(
      await workspace.prepare({
        planJson: JSON.stringify(recoveryPlan),
        attemptJson: JSON.stringify({ ordinal: 0, mode: 'initial', previousError: null }),
      }),
    ).toMatchObject({ kind: 'repository' })
    expect(
      await workspace.validate({
        roundRef: 'round-analyze-recovery',
        taskStatus: 'done',
        outputJson: JSON.stringify({ status: 'ok' }),
      }),
    ).toMatchObject({
      ok: false,
      errorClass: 'semantic',
      errorCode: 'workspace-semantic-outcome-workspace-mismatch',
    })
    db.update(employeeReactionRounds)
      .set({ state: 'failed', settledAt: 22, updatedAt: 22 })
      .where(eq(employeeReactionRounds.id, 'round-analyze-recovery'))
      .run()
    writeFileSync(join(fresh.workspacePath, 'src', 'feature.ts'), 'export const feature = 2\n')
    const exactRecoveryPlan = {
      ...recoveryPlan,
      roundRef: 'round-analyze-recovery-exact',
    }
    const failedRecoveryRound = db
      .select()
      .from(employeeReactionRounds)
      .where(eq(employeeReactionRounds.id, 'round-analyze-recovery'))
      .get()!
    db.insert(employeeReactionRounds)
      .values({
        ...failedRecoveryRound,
        id: exactRecoveryPlan.roundRef,
        planJson: JSON.stringify(exactRecoveryPlan),
        state: 'running',
        executionRef: 'task-recovery-exact',
        outputJson: null,
        createdAt: 23,
        updatedAt: 23,
        settledAt: null,
      })
      .run()
    expect(
      await workspace.prepare({
        planJson: JSON.stringify(exactRecoveryPlan),
        attemptJson: JSON.stringify({ ordinal: 0, mode: 'initial', previousError: null }),
      }),
    ).toMatchObject({ kind: 'repository' })
    expect(
      await workspace.validate({
        roundRef: exactRecoveryPlan.roundRef,
        taskStatus: 'done',
        outputJson: JSON.stringify({ status: 'ok' }),
      }),
    ).toEqual({ ok: true })
    expect(
      JSON.parse(
        db
          .select({ validationJson: employeeRoundWorkspaceStates.validationJson })
          .from(employeeRoundWorkspaceStates)
          .where(eq(employeeRoundWorkspaceStates.roundId, exactRecoveryPlan.roundRef))
          .get()!.validationJson!,
      ),
    ).toEqual({
      ok: true,
      kind: 'changed',
      changedPaths: ['config/editable-same.txt', 'src/feature.ts'],
      postBusinessDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    db.update(employeeReactionRounds)
      .set({
        state: 'completed',
        outputJson: JSON.stringify({ status: 'ok', summary: 'Carry validated feature change' }),
        settledAt: 24,
      })
      .where(eq(employeeReactionRounds.id, exactRecoveryPlan.roundRef))
      .run()
    const deliveryIssueContext = {
      ...inheritedIssueContext,
      revision: 3,
      stateJson: JSON.stringify({
        ...inheritedIssueState,
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
    let replyCalls = 0
    let approvalSubmits = 0
    let approvalObserves = 0
    let observedHead: string | null = null
    let observedTargetSha: string | null = null
    let observedMergeableState: 'mergeable' | 'conflict' = 'mergeable'
    let observedState: 'opened' | 'merged' | 'closed' = 'opened'
    let observedMergedCommitSha: string | null = null
    const platform = composeDevelopmentEmployeePlatformWorkItems({
      reactionRounds: createEmployeeReactionRoundQueries(db),
      db,
      appHome,
      directPublicationSubject: { kind: 'system' },
      conflictMerge: bindConflictMergeParticipant(),
      sourceControl: {
        ...bindChangeCandidateParticipant(),
        ...bindCandidateDeliveryParticipant(),
        ...bindEmployeeCaseWorkspaceParticipant(),
      },
      repoRemote: { resolve: () => ({ remoteUrl: remoteRepo, defaultBranch: 'main' }) },
      mrEffects: {
        async reply() {
          replyCalls += 1
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
              // An existing provider MR may still return its pre-push head.
              sourceSha: baselineSha,
              created: false,
            },
          }
        },
        async observe() {
          return {
            ok: true,
            observation: {
              state: observedState,
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
              state: observedState,
              headSha: observedHead,
              targetSha: observedTargetSha,
              targetBranch: 'main',
              draft: false,
              mergeableState: observedMergeableState,
              approvalHold: false,
              mergedCommitSha: observedMergedCommitSha,
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
    const legacyMaterialRef = '.agent-workflow/inputs/requirements/legacy-child/external/issue-8.md'
    const legacyDelegatedIssueContext = {
      id: 'legacy-delegated-issue-context',
      revision: 1,
      typeId: 'development.issue-handling',
      lifecycleState: 'active',
      stateJson: JSON.stringify({
        status: 'active',
        subjectRef: 'invocation:legacy-child',
        repositoryRef: 'repo-1',
        request: {
          kind: 'external-id',
          body: null,
          externalId: 'ISSUE-8',
          uploads: [],
          executionOptions: {},
        },
        materialArtifactRefs: [legacyMaterialRef],
        deliveryContent: null,
      }),
      artifactRefs: [legacyMaterialRef],
    }
    const legacyPreparedMaterialsPlan = plan({
      roundRef: 'round-legacy-prepared-materials',
      caseRef: 'employee-child:legacy',
      workItemRef: 'prepare-materials',
      contexts: [legacyDelegatedIssueContext],
      employeeTypeRef: { typeId: 'development', revision: 8 },
    })
    const legacyPreparedMaterials = JSON.parse(
      await platform.execute(legacyPreparedMaterialsPlan),
    ) as { status: string; contextPatches: Array<{ stateJson: string }> }
    expect(legacyPreparedMaterials.status).toBe('ok')
    expect(JSON.parse(legacyPreparedMaterials.contextPatches[0]!.stateJson)).toMatchObject({
      request: { kind: 'external-id', externalId: 'ISSUE-8' },
      materialArtifactRefs: [legacyMaterialRef],
    })
    const validatedLegacyPreparedMaterials =
      developmentEmployeeRuntimeCodec.validateReactionOutputJson(
        JSON.stringify({
          schemaVersion: 1,
          employeeTypeRef: { typeId: 'development', revision: 8 },
          workItemRef: 'prepare-materials',
          toolSlotRef: 'platform',
          connectionRef: null,
          inputEnvelopeJson: legacyPreparedMaterialsPlan.inputEnvelopeJson,
          outputJson: JSON.stringify(legacyPreparedMaterials),
        }),
      )
    expect(
      JSON.parse(
        developmentEmployeeRuntimeCodec.resolveReactionSettlementJson(
          JSON.stringify({
            schemaVersion: 1,
            employeeTypeRef: { typeId: 'development', revision: 8 },
            workItemRef: 'prepare-materials',
            toolSlotRef: 'platform',
            outputJson: validatedLegacyPreparedMaterials,
            contextsJson: JSON.stringify([legacyDelegatedIssueContext]),
            inputEnvelopeJson: legacyPreparedMaterialsPlan.inputEnvelopeJson,
            enabledWorkItemRefsJson: '[]',
            allowedNextWorkItemRefs: ['analyze-implement'],
          }),
        ),
      ),
    ).toMatchObject({ caseState: 'active', nextWorkItemRef: 'analyze-implement' })
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
    const mrState = JSON.parse(mrPatch.stateJson) as { headSha: string }
    expect(mrState).toMatchObject({
      mergeRequestRef: 'repo-1!42',
      repositoryRef: 'repo-1',
      providerMrRef: '42',
      readyToMerge: false,
    })
    const initialPipelinePatch = published.contextPatches.find(
      (patch) => patch.contextTypeId === 'development.pipeline',
    )!
    expect(JSON.parse(initialPipelinePatch.stateJson)).toEqual({
      status: 'pending',
      mergeRequestRef: 'repo-1!42',
      headSha: mrState.headSha,
      targetSha: null,
      evidenceArtifactRef: '.agent-workflow/pipeline/case-1/',
      checks: [],
      failureTypes: [],
    })
    const branch = 'agent-workflow/employee/case-1'
    const publishedSha = git(remoteRepo, 'rev-parse', `refs/heads/${branch}`)
    expect(publishedSha).toMatch(/^[a-f0-9]{40}$/)
    expect(mrState.headSha).toBe(publishedSha)
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

    const staleReviewThread = {
      threadRef: 'system-discussion',
      revision: '1:14',
      authorClass: 'human',
      resolved: false,
      body: 'added 1 commit',
      path: null,
      messages: [],
    }
    const staleProblemContext = {
      id: 'problem-stale-system-note',
      revision: 1,
      typeId: 'development.problem-set',
      stateJson: JSON.stringify({
        status: 'active',
        source: 'review',
        headSha: publishedSha,
        remainingTypes: ['review'],
        problems: [
          {
            problemId: staleReviewThread.threadRef,
            type: 'review',
            summary: staleReviewThread.body,
            evidenceArtifactRefs: [],
            reviewThread: staleReviewThread,
          },
        ],
      }),
    }
    const staleResolutionContext = {
      id: 'resolution-stale-system-note',
      revision: 1,
      typeId: 'development.review-resolution',
      stateJson: JSON.stringify({
        status: 'collected',
        mergeRequestRef: 'repo-1!42',
        sourceHeadSha: publishedSha,
        publishedHeadSha: null,
        commitSha: null,
        threads: [
          {
            threadRef: staleReviewThread.threadRef,
            revision: staleReviewThread.revision,
            acknowledgement: null,
            disposition: null,
            replyBody: null,
            finalReply: null,
          },
        ],
      }),
    }
    const staleAcknowledgePlan = plan({
      roundRef: 'round-acknowledge-stale-system-note',
      caseRef: 'case-1',
      workItemRef: 'acknowledge-feedback',
      contexts: [
        { ...mrPatch, id: 'mr-context', revision: 1, typeId: mrPatch.contextTypeId },
        staleProblemContext,
        staleResolutionContext,
      ],
      allowedEffectKinds: ['code-host.merge-request.reply'],
    })
    observedHead = 'f'.repeat(40)
    expect(JSON.parse(await platform.execute(staleAcknowledgePlan))).toMatchObject({
      status: 'needs-input',
      summary: expect.stringContaining('MR head'),
    })
    expect(replyCalls).toBe(0)
    observedHead = publishedSha
    const reconciledReview = JSON.parse(await platform.execute(staleAcknowledgePlan)) as {
      status: string
      contextPatches: Array<{ contextTypeId: string; lifecycleState: string; stateJson: string }>
      effectSuggestions: string[]
    }
    expect(reconciledReview.status).toBe('ok')
    expect(replyCalls).toBe(0)
    expect(reconciledReview.effectSuggestions).toEqual([])
    expect(
      JSON.parse(
        reconciledReview.contextPatches.find(
          (patch) => patch.contextTypeId === 'development.review-resolution',
        )!.stateJson,
      ),
    ).toMatchObject({ status: 'collected', threads: [] })
    const retiredProblemPatch = reconciledReview.contextPatches.find(
      (patch) => patch.contextTypeId === 'development.problem-set',
    )!
    expect(retiredProblemPatch.lifecycleState).toBe('terminal')
    expect(JSON.parse(retiredProblemPatch.stateJson)).toMatchObject({
      status: 'resolved',
      remainingTypes: [],
      problems: [],
    })

    // An upgraded blocked Case may resume at observe-mr instead of replaying
    // acknowledge-feedback. The observation boundary must reconcile the same
    // stale provider fact so old persisted Contexts heal without manual edits.
    observedHead = publishedSha
    const observedReviewReconciliation = JSON.parse(
      await platform.execute(
        plan({
          roundRef: 'round-observe-stale-system-note',
          caseRef: 'case-1',
          workItemRef: 'observe-mr',
          contexts: [
            { ...mrPatch, id: 'mr-context', revision: 1, typeId: mrPatch.contextTypeId },
            {
              ...initialPipelinePatch,
              id: 'pipeline-context',
              revision: 1,
              typeId: initialPipelinePatch.contextTypeId,
            },
            staleProblemContext,
            staleResolutionContext,
          ],
        }),
      ),
    ) as {
      summary: string
      contextPatches: Array<{ contextTypeId: string; lifecycleState: string; stateJson: string }>
    }
    expect(observedReviewReconciliation.summary).toContain('自动淘汰失效检视事实')
    expect(
      JSON.parse(
        observedReviewReconciliation.contextPatches.find(
          (patch) => patch.contextTypeId === 'development.review-resolution',
        )!.stateJson,
      ),
    ).toMatchObject({ status: 'collected', threads: [] })
    expect(
      JSON.parse(
        observedReviewReconciliation.contextPatches.find(
          (patch) => patch.contextTypeId === 'development.problem-set',
        )!.stateJson,
      ),
    ).toMatchObject({ status: 'resolved', remainingTypes: [], problems: [] })

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
    observedHead = publishedSha
    observedTargetSha = baselineSha
    observedMergeableState = 'conflict'
    const staleTargetObservation = JSON.parse(
      await platform.execute(
        plan({
          roundRef: 'round-observe-target-race',
          caseRef: 'case-1',
          workItemRef: 'observe-mr',
          contexts: [
            { ...mrPatch, id: 'mr-context', revision: 1, typeId: mrPatch.contextTypeId },
            {
              ...initialPipelinePatch,
              id: 'pipeline-context',
              revision: 1,
              typeId: initialPipelinePatch.contextTypeId,
            },
          ],
        }),
      ),
    ) as { status: string; summary: string; contextPatches: unknown[] }
    expect(staleTargetObservation).toMatchObject({
      status: 'needs-input',
      summary: expect.stringContaining('MR target 在事实读取与 Git 获取之间已前进'),
      contextPatches: [],
    })
    observedTargetSha = targetSha
    const readyMrContext = {
      id: 'mr-ready-context',
      revision: 1,
      typeId: 'development.merge-request',
      stateJson: JSON.stringify({
        ...JSON.parse(mrPatch.stateJson),
        headSha: publishedSha,
        factsHeadSha: publishedSha,
        targetSha,
        mergeableState: 'mergeable',
      }),
    }
    const legacyPassedPipelineContext = {
      id: 'pipeline-ready-context',
      revision: 1,
      typeId: 'development.pipeline',
      stateJson: JSON.stringify({
        ...JSON.parse(initialPipelinePatch.stateJson),
        status: 'passed',
        headSha: publishedSha,
      }),
    }
    const evaluateReady = async (
      revision: 7 | 8,
      pipelineContext: typeof legacyPassedPipelineContext,
      additionalContexts: readonly object[] = [],
    ) => {
      const evaluated = JSON.parse(
        await platform.execute(
          plan({
            roundRef: `round-evaluate-ready-v${revision}`,
            caseRef: 'case-1',
            workItemRef: 'evaluate-ready',
            contexts: [readyMrContext, pipelineContext, ...additionalContexts],
            employeeTypeRef: { typeId: 'development', revision },
          }),
        ),
      ) as { contextPatches: Array<{ contextTypeId: string; stateJson: string }> }
      return JSON.parse(
        evaluated.contextPatches.find(
          (patch) => patch.contextTypeId === 'development.merge-request',
        )!.stateJson,
      ) as { readyToMerge: boolean }
    }
    // Runtime codecs are keyed by type id. The exact Case pin therefore has
    // to preserve v7's head-only pipeline contract while v8 requires target.
    expect((await evaluateReady(7, legacyPassedPipelineContext)).readyToMerge).toBe(true)
    expect((await evaluateReady(8, legacyPassedPipelineContext)).readyToMerge).toBe(false)
    expect(
      (
        await evaluateReady(8, {
          ...legacyPassedPipelineContext,
          stateJson: JSON.stringify({
            ...JSON.parse(legacyPassedPipelineContext.stateJson),
            targetSha,
          }),
        })
      ).readyToMerge,
    ).toBe(true)
    const targetBoundPassedPipelineContext = {
      ...legacyPassedPipelineContext,
      stateJson: JSON.stringify({
        ...JSON.parse(legacyPassedPipelineContext.stateJson),
        targetSha,
      }),
    }
    const delegationContext = {
      id: 'delegation-context',
      revision: 1,
      typeId: 'development.delegation',
      stateJson: JSON.stringify({
        status: 'waiting',
        groupRef: 'delegation-group',
        joinMode: 'all',
        quorum: null,
        members: [
          {
            memberRef: 'primary',
            invocationRef: 'invocation-1',
            targetEmployeeRef: 'employee-child@1',
            state: 'waiting',
            resultArtifactRefs: [],
          },
        ],
        resultArtifactRefs: [],
      }),
    }
    expect(
      (await evaluateReady(8, targetBoundPassedPipelineContext, [delegationContext])).readyToMerge,
    ).toBe(false)
    expect(
      (
        await evaluateReady(8, targetBoundPassedPipelineContext, [
          {
            ...delegationContext,
            stateJson: JSON.stringify({
              ...JSON.parse(delegationContext.stateJson),
              status: 'satisfied',
              members: [
                {
                  ...JSON.parse(delegationContext.stateJson).members[0],
                  state: 'satisfied',
                },
              ],
            }),
          },
        ])
      ).readyToMerge,
    ).toBe(true)
    const unknownTargetMrContext = {
      ...readyMrContext,
      stateJson: JSON.stringify({
        ...JSON.parse(readyMrContext.stateJson),
        targetSha: null,
      }),
    }
    const unknownTargetEvaluation = JSON.parse(
      await platform.execute(
        plan({
          roundRef: 'round-evaluate-ready-v8-unknown-target',
          caseRef: 'case-1',
          workItemRef: 'evaluate-ready',
          contexts: [
            unknownTargetMrContext,
            {
              ...legacyPassedPipelineContext,
              stateJson: JSON.stringify({
                ...JSON.parse(legacyPassedPipelineContext.stateJson),
                targetSha: null,
              }),
            },
          ],
          employeeTypeRef: { typeId: 'development', revision: 8 },
        }),
      ),
    ) as { contextPatches: Array<{ contextTypeId: string; stateJson: string }> }
    expect(
      JSON.parse(
        unknownTargetEvaluation.contextPatches.find(
          (patch) => patch.contextTypeId === 'development.merge-request',
        )!.stateJson,
      ).readyToMerge,
    ).toBe(false)
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
    expect(readFileSync(join(conflictScene.workspacePath, inheritedMaterialRef), 'utf8')).toBe(
      '# Inherited issue 8 acceptance\n',
    )
    expect(
      JSON.parse(
        readFileSync(
          join(
            conflictScene.workspacePath,
            '.agent-workflow/inputs/requirements/case-1/request.json',
          ),
          'utf8',
        ),
      ),
    ).toMatchObject({ body: 'Implement deterministic delivery' })
    expect(existsSync(join(conflictScene.workspacePath, '.agent-workflow/pipeline/case-1'))).toBe(
      true,
    )
    expect(
      readFileSync(
        join(conflictScene.workspacePath, inheritedPipelineRef, 'typecheck.log'),
        'utf8',
      ),
    ).toBe('source dependency failed typecheck\n')
    expect(conflictScene.platformInputPaths).toEqual(
      expect.arrayContaining([inheritedMaterialRef, inheritedPipelineRef.slice(0, -1)]),
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
    expect(readFileSync(join(freshConflictScene.workspacePath, inheritedMaterialRef), 'utf8')).toBe(
      '# Inherited issue 8 acceptance\n',
    )
    expect(
      JSON.parse(
        readFileSync(
          join(
            freshConflictScene.workspacePath,
            '.agent-workflow/inputs/requirements/case-1/request.json',
          ),
          'utf8',
        ),
      ),
    ).toMatchObject({ body: 'Implement deterministic delivery' })
    expect(
      readFileSync(
        join(freshConflictScene.workspacePath, inheritedPipelineRef, 'typecheck.log'),
        'utf8',
      ),
    ).toBe('source dependency failed typecheck\n')
    const replayedFreshConflictScene = await workspace.prepare({
      planJson: JSON.stringify(repairConflictPlan),
      attemptJson: JSON.stringify({ ordinal: 1, mode: 'fresh-scene', previousError: 'retry' }),
    })
    expect(replayedFreshConflictScene).toMatchObject({
      kind: 'repository',
      workspacePath: freshConflictScene.workspacePath,
    })
    // A semantic retry after a fresh scene must keep the newest scene. Falling
    // back to attempt 0 resurrects an already rejected workspace and can carry
    // its out-of-contract edits into every later retry.
    const sameSceneAfterFresh = await workspace.prepare({
      planJson: JSON.stringify(repairConflictPlan),
      attemptJson: JSON.stringify({
        ordinal: 2,
        mode: 'same-scene',
        previousError: 'semantic inspection retry',
      }),
    })
    expect(sameSceneAfterFresh).toMatchObject({
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
      contexts: [
        conflictMrContext,
        {
          id: 'pipeline-context',
          revision: 2,
          typeId: 'development.pipeline',
          stateJson: JSON.stringify({
            ...JSON.parse(initialPipelinePatch.stateJson),
            status: 'passed',
            headSha: publishedSha,
          }),
        },
      ],
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
    const conflictMrPatch = conflictPublished.contextPatches.find(
      (patch) => patch.contextTypeId === 'development.merge-request',
    )!
    expect(JSON.parse(conflictMrPatch.stateJson)).toMatchObject({
      headSha: mergeSha,
      factsHeadSha: null,
      mergeableState: 'unknown',
      readyToMerge: false,
    })
    const conflictPipelinePatch = conflictPublished.contextPatches.find(
      (patch) => patch.contextTypeId === 'development.pipeline',
    )!
    expect(conflictPipelinePatch).toMatchObject({
      contextId: 'pipeline-context',
      expectedRevision: 2,
      lifecycleState: 'active',
    })
    expect(JSON.parse(conflictPipelinePatch.stateJson)).toMatchObject({
      status: 'pending',
      mergeRequestRef: 'repo-1!42',
      headSha: mergeSha,
      failureTypes: [],
    })
    const replayedConflictPublish = JSON.parse(await platform.execute(publishConflictPlan)) as {
      status: string
      contextPatches: Array<{ contextTypeId: string; stateJson: string }>
    }
    expect(replayedConflictPublish.status).toBe('ok')
    expect(
      JSON.parse(
        replayedConflictPublish.contextPatches.find(
          (patch) => patch.contextTypeId === 'development.merge-request',
        )!.stateJson,
      ),
    ).toMatchObject({
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
      stateJson: conflictMrPatch.stateJson,
    }
    const latestPipelineContext = {
      id: 'pipeline-context',
      revision: 3,
      typeId: 'development.pipeline',
      stateJson: JSON.stringify({
        ...JSON.parse(conflictPipelinePatch.stateJson),
        status: 'passed',
      }),
    }
    // A pre-v8 Case freezes reaction inputs from its historical descriptor.
    // Those observe-mr plans omit the already-existing pipeline Context; the
    // platform must not mistake that omission for permission to create a
    // duplicate Context identity.
    const frozenLegacyReactionOutput = JSON.parse(
      await platform.execute(
        plan({
          roundRef: 'round-observe-frozen-v7-reaction',
          caseRef: 'case-1',
          workItemRef: 'observe-mr',
          contexts: [latestMrContext],
        }),
      ),
    ) as { contextPatches: Array<{ contextTypeId: string }> }
    expect(
      frozenLegacyReactionOutput.contextPatches.some(
        (patch) => patch.contextTypeId === 'development.pipeline',
      ),
    ).toBe(false)

    const observedOutput = JSON.parse(
      await platform.execute(
        plan({
          roundRef: 'round-observe-external-head',
          caseRef: 'case-1',
          workItemRef: 'observe-mr',
          contexts: [latestMrContext, latestPipelineContext],
        }),
      ),
    ) as {
      status: string
      contextPatches: Array<{ contextTypeId: string; stateJson: string }>
    }
    expect(observedOutput.status).toBe('ok')
    expect(
      JSON.parse(
        observedOutput.contextPatches.find(
          (patch) => patch.contextTypeId === 'development.merge-request',
        )!.stateJson,
      ),
    ).toMatchObject({
      headSha: externalSha,
      factsHeadSha: externalSha,
      targetSha,
    })
    expect(
      JSON.parse(
        observedOutput.contextPatches.find(
          (patch) => patch.contextTypeId === 'development.pipeline',
        )!.stateJson,
      ),
    ).toMatchObject({ status: 'pending', headSha: externalSha, failureTypes: [] })
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

    const observedMrPatch = observedOutput.contextPatches.find(
      (patch) => patch.contextTypeId === 'development.merge-request',
    )!
    const providerMergeCommitSha = 'd'.repeat(40)
    observedState = 'merged'
    observedTargetSha = providerMergeCommitSha
    observedMergedCommitSha = providerMergeCommitSha
    const terminalObservation = JSON.parse(
      await platform.execute(
        plan({
          roundRef: 'round-observe-terminal-merge',
          caseRef: 'case-1',
          workItemRef: 'wait-merge',
          contexts: [
            {
              ...observedMrPatch,
              id: 'mr-context',
              revision: 4,
              typeId: observedMrPatch.contextTypeId,
            },
          ],
        }),
      ),
    ) as {
      contextPatches: Array<{ contextTypeId: string; lifecycleState: string; stateJson: string }>
    }
    const terminalMrPatch = terminalObservation.contextPatches.find(
      (patch) => patch.contextTypeId === 'development.merge-request',
    )!
    expect(terminalMrPatch.lifecycleState).toBe('terminal')
    expect(JSON.parse(terminalMrPatch.stateJson)).toMatchObject({
      status: 'merged',
      headSha: externalSha,
      targetSha: providerMergeCommitSha,
      mergedCommitSha: providerMergeCommitSha,
      readyToMerge: false,
    })
    expect(baselineSha).not.toBe(publishedSha)
  })
})
