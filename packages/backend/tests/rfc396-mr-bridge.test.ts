// RFC-396 MR parity: the verified tree enters the existing care workspace, and every repair
// (including a separate conflict scene) must execute the approved graph checks again.
// Run the real repository check through Bun explicitly so every assertion also
// runs on native Windows; this suite does not require POSIX shebang/chmod semantics.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { canonicalJson, repositoryMaterializationCommit } from '@agent-workflow/shared'
import { stableIdentityComponent } from '@/util/gitRef'
import { sha256Hex } from '@/util/hash'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import {
  bindConflictMergeParticipant,
  bindEmployeeCaseWorkspaceParticipant,
} from '@/modules/source-control/composition'
import {
  bindCandidateDeliveryParticipant,
  bindChangeCandidateParticipant,
} from '@/modules/source-control/composition/repositoryCandidate'
import { composeLocalRepositoryRevisionContent } from '@/modules/source-control/composition/repositoryRevisionContent'
import {
  createGraphDeliveryBridge,
  type GraphMrHandoffResult,
} from '@/modules/development-automation/composition/graphDeliveryBridge'
import { createGraphPlatformWorkItems } from '@/modules/development-automation/application/graph-development/platformWorkItems'
import { graphDigest } from '@/modules/development-automation/domain/graph-development/model'
import { issueHandlingContextSchema } from '@/modules/development-automation/composition/employeeTypePackage'
import { createGraphVerification } from '@/modules/development-automation/application/graph-development/verification'
import type { GraphEmployeeContext } from '@/modules/development-automation/application/graph-development/employeeCodec'
import type { GraphMrBeforePublishInput } from '@/modules/development-automation/application/graph-development/mrCare'
import type { EmployeeCaseWorkspaceRow } from '@/modules/development-automation/application/ports/employeeWorkspacePersistence'
import type { EmployeeChangeCandidateRecord } from '@/modules/development-automation/application/ports/employeePlatformWorkItemPersistence'
import { createFileAutomationWorkspaceEffectsFactory } from '@/modules/development-automation/infrastructure/local/fileAutomationWorkspaceEffects'
import {
  createLocalVerificationCommandEffects,
  createLocalVerificationCommandEffectsFactory,
  createRepoScriptResolver,
} from '@/modules/development-automation/infrastructure/local/verificationCommandEffects'
import { createVerificationProfilePersistence } from '@/modules/development-automation/infrastructure/configResourceStore'
import { createEmployeeWorkspacePersistence } from '@/modules/development-automation/infrastructure/employeeWorkspacePersistence'
import { createEmployeePlatformWorkItemPersistence } from '@/modules/development-automation/infrastructure/employeePlatformWorkItemPersistence'
import { createRuntimePersistence } from '@/modules/digital-employee/infrastructure/runtimeStore'
import {
  verificationProfileContentDigest,
  type VerificationProfileContent,
} from '@/modules/development-automation/domain/verificationProfile'
import { EvidenceStore } from '@/modules/development-automation/infrastructure/evidenceStore'
import { graphFixture } from './helpers/graphDesign'
import { describeEachProvider } from './helpers/eachProvider'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function git(cwd: string, ...args: string[]) {
  const child = Bun.spawnSync(['git', ...args], { cwd })
  if (child.exitCode !== 0) throw new Error(child.stderr.toString())
  return child.stdout.toString().trim()
}

describeEachProvider('RFC-396 MR candidate bridge', (harness) => {
  function platformPlan(
    work: GraphEmployeeContext,
    workItemRef: 'verify-change' | 'deliver-result',
    roundRef: string,
    published?: GraphMrHandoffResult,
  ) {
    return {
      roundRef,
      executionNonce: 'nonce',
      caseRef: { id: work.caseId },
      employeeTypeRef: { typeId: 'graph-development', revision: 2 },
      workItemRef,
      inputEnvelopeJson: canonicalJson({
        contextsJson: canonicalJson([
          {
            id: 'graph-context',
            typeId: 'graph-development.design-context',
            revision: 1,
            stateJson: canonicalJson(work),
            artifactRefs: [],
          },
          ...(published
            ? [
                {
                  id: 'issue',
                  typeId: 'development.issue-handling',
                  revision: 1,
                  stateJson: canonicalJson(published.issueState),
                },
                {
                  id: 'candidate',
                  typeId: 'development.change-candidate',
                  revision: 1,
                  stateJson: canonicalJson(published.candidateState),
                },
                {
                  id: 'mr',
                  typeId: 'development.merge-request',
                  revision: 1,
                  stateJson: canonicalJson({
                    status: 'active',
                    headSha: published.candidateState.commitSha,
                    repositoryRef: work.repositoryId,
                    sourceBranch: published.issueState.request.workingBranch,
                    targetBranch: work.request.targetBranch ?? 'main',
                  }),
                },
              ]
            : []),
        ]),
      }),
    }
  }
  async function fixture(
    unborn = false,
    options: {
      manualAcceptance?: boolean
      multipleProfileRevisions?: boolean
      enforcePortableCheckpointPaths?: boolean
    } = {},
  ) {
    const root = mkdtempSync(join(tmpdir(), 'rfc396-mr-bridge-'))
    roots.push(root)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    if (!unborn) {
      writeFileSync(join(repo, 'README.md'), 'booking\n')
      git(repo, 'add', 'README.md')
      git(
        repo,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=f@example.test',
        'commit',
        '-qm',
        'base',
      )
    }
    const sourceControl = bindEmployeeCaseWorkspaceParticipant()
    const resolved = await sourceControl.resolveBaseline({
      baselineRepoPath: repo,
      preferredBranch: 'main',
      sourceBranch: null,
      allowUnborn: true,
    })
    const baseline = resolved.contentBaseline!
    const graphScene = await sourceControl.materialize({
      caseRoot: join(root, 'graph-scene'),
      baselineRepoPath: repo,
      baselineSha: resolved.baselineSha,
    })
    writeFileSync(
      join(graphScene.workspacePath, 'booking.js'),
      'export const reserve = () => "预约";\n',
    )
    writeFileSync(
      join(graphScene.workspacePath, 'verify.js'),
      '// booking-test\nif ((await import("./booking.js")).reserve() !== "预约") process.exit(3); console.log("booking-test passed");\n',
    )
    const f = await graphFixture(harness.db, baseline)
    const profiles = createVerificationProfilePersistence(harness.db)
    const profile: VerificationProfileContent = {
      schemaVersion: 1,
      stopPolicy: 'first-failure',
      maxParallel: 1,
      steps: [
        {
          stepId: 'booking',
          programRef: 'repo:verify.js',
          argsRef: null,
          timeoutMs: 5000,
          networkProfileRef: 'default',
          successExitCodes: [0],
          evidenceSelectors: [{ kind: 'stdout-tail', value: 4000 }],
        },
      ],
    }
    const digest = verificationProfileContentDigest(profile)
    await profiles.create({
      id: 'checks',
      name: 'checks',
      draftJson: canonicalJson(profile),
      ownerUserId: null,
      extra: {},
      now: 1,
    })
    await profiles.publishRevision({
      resourceId: 'checks',
      revision: 1,
      contentJson: canonicalJson(profile),
      contentDigest: digest,
      publishedBy: null,
      publishedAt: 2,
    })
    const document = await f.commands.document('design-a')
    const booking = document.elements[0]!
    if (booking.kind !== 'requirement') throw new Error('fixture-booking-requirement-missing')
    document.obligations[0]!.verification = {
      kind: 'execution',
      profileRef: { id: 'checks', revision: 1, digest },
      testRefs: ['verify.js#booking-test'],
    }
    if (options.multipleProfileRevisions) {
      const next = {
        ...profile,
        steps: profile.steps.map((step) => ({ ...step, timeoutMs: 6000 })),
      }
      const nextDigest = verificationProfileContentDigest(next)
      await profiles.publishRevision({
        resourceId: 'checks',
        revision: 2,
        contentJson: canonicalJson(next),
        contentDigest: nextDigest,
        publishedBy: null,
        publishedAt: 3,
      })
      booking.obligationIds.push('next-check')
      document.obligations.push({
        id: 'next-check',
        revision: 1,
        statement: 'Second approved check',
        elementIds: ['booking'],
        concernIds: [],
        verification: {
          kind: 'execution',
          profileRef: { id: 'checks', revision: 2, digest: nextDigest },
          testRefs: ['verify.js#booking-test'],
        },
      })
    }
    if (options.manualAcceptance) {
      booking.obligationIds.push('human')
      document.obligations.push({
        id: 'human',
        revision: 1,
        statement: 'Confirm booking experience',
        elementIds: ['booking'],
        concernIds: [],
        verification: {
          kind: 'manual',
          instructions: 'Confirm booking experience',
          owner: null,
          when: null,
        },
      })
    }
    const changed = await f.commands.change(document.id, {
      requestId: 'profile',
      expectedRevision: document.revision,
      document,
    })
    const frozen = await f.commands.preview(document.id, {
      requestId: 'basis',
      expectedRevision: changed.revision,
      includedElementIds: ['booking'],
    })
    const review = {
      id: 'native-approval',
      caseId: 'case-a',
      taskId: 'review-task',
      nodeRunId: 'review-run',
      basisDigest: frozen.basis.digest,
      decision: 'approved' as const,
      reason: 'approved fixture',
      decidedAt: 20,
    }
    f.setReview(review)
    await f.commands.recordReview(document.id, review)
    const implementation = {
      traceProposals: [
        {
          elementId: 'booking',
          obligationId: 'unique',
          path: 'booking.js',
          symbol: 'reserve',
          testRef: 'verify.js#booking-test',
          reason: 'Booking implementation',
        },
      ],
      testRefs: ['verify.js#booking-test'],
      limitations: [],
      deliveryContent: {
        commitMessage: 'Implement booking',
        title: 'Booking',
        description: 'Approved booking design',
      },
    }
    await f.store.insertLink({
      designId: document.id,
      id: 'implementation:build',
      kind: 'execution',
      payloadJson: canonicalJson({
        basisId: frozen.basis.id,
        basisDigest: frozen.basis.digest,
        roundRef: 'build',
        result: implementation,
      }),
      createdAt: 30,
    })
    const candidates = {
      ...bindChangeCandidateParticipant(),
      ...bindCandidateDeliveryParticipant(),
    }
    const verificationEffects = createLocalVerificationCommandEffectsFactory()
    let environmentGeneration = 1
    const verification = createGraphVerification({
      ...f,
      candidates,
      content: composeLocalRepositoryRevisionContent(),
      profiles,
      verification: {
        ...verificationEffects,
        create(input) {
          const resolver = createRepoScriptResolver()
          return createLocalVerificationCommandEffects({
            evidence: input.evidence,
            resolver: {
              resolve(request) {
                const resolved = resolver.resolve(request)
                return resolved ? { argv: [process.execPath, ...resolved.argv] } : null
              },
            },
          })
        },
        async environment(path) {
          const actual = await verificationEffects.environment!(path)
          return { ...actual, digest: sha256Hex(`${actual.digest}:${environmentGeneration}`) }
        },
      },
      evidence: new EvidenceStore(root),
    })
    const workspace = {
      baselineRepoPath: repo,
      baseline,
      targetBranch: 'main',
      workspacePath: graphScene.workspacePath,
    }
    if (options.manualAcceptance) {
      const candidate = await candidates.derive({
        baselineRepoPath: repo,
        baselineSha: resolved.baselineSha,
        repositoryBaseline: baseline,
        overlayRoot: workspace.workspacePath,
        excludePolicyDigest: 'a'.repeat(64),
        agentOutcomeRef: 'build',
      })
      if (!candidate.ok) throw new Error(candidate.detail)
      const artifact = await f.artifacts.put([
        { path: 'acceptance.json', content: '{"decision":"accepted"}' },
      ])
      await f.store.insertLink({
        designId: document.id,
        id: 'acceptance:initial',
        kind: 'evidence',
        payloadJson: canonicalJson({
          id: 'acceptance:initial',
          kind: 'acceptance',
          obligationIds: ['human'],
          basisDigest: frozen.basis.digest,
          readSet: frozen.basis.readSet,
          candidateTreeOid: candidate.receipt.treeOid,
          commitSha: null,
          profileRef: null,
          environmentDigest: null,
          executionRef: null,
          artifactRef: artifact.artifactRef,
          artifactDigest: artifact.digest,
          ci: null,
          result: 'passed',
          summary: 'Human accepted',
          limitations: [],
          recordedAt: 40,
        }),
        createdAt: 40,
      })
    }
    const verified = await verification.run({
      designId: document.id,
      roundRef: 'initial-checks',
      workspace,
    })
    expect(verified.passed).toBe(true)
    const committed = await candidates.commit({
      baselineRepoPath: repo,
      baselineSha: resolved.baselineSha,
      repositoryBaseline: baseline,
      overlayRoot: workspace.workspacePath,
      expectedTreeOid: verified.candidateTreeOid!,
      missionId: 'graph-case-a',
      summarySource: implementation.deliveryContent.commitMessage,
    })
    if (!committed.ok) throw new Error(committed.detail)
    const work: GraphEmployeeContext = {
      caseId: 'case-a',
      designId: 'design-a',
      repositoryId: 'repo-a',
      request: {
        body: 'Implement booking',
        kind: 'body',
        targetBranch: 'main',
        publicationBranch: 'graph/booking',
        uploads: [],
      },
      consumedRevision: changed.revision,
      basisId: frozen.basis.id,
      basisDigest: frozen.basis.digest,
      reviewReceiptId: review.id,
      reviewDecision: 'approved',
      candidateRef: verified.candidateRef,
      candidateTreeOid: verified.candidateTreeOid,
      evidenceIds: verified.evidenceIds,
      result: 'verified',
    }
    let workspaceRow: EmployeeCaseWorkspaceRow | null = null
    const candidateRows = new Map<string, EmployeeChangeCandidateRecord>()
    let failCommitRegistration = false
    let restores = 0
    const checkpointPaths: string[] = []
    const bridge = createGraphDeliveryBridge({
      appHome: root,
      factory: createFileAutomationWorkspaceEffectsFactory(),
      sourceControl: {
        ...sourceControl,
        async checkpoint(input) {
          if (
            options.enforcePortableCheckpointPaths &&
            /[<>:"\\|?*]/.test(basename(input.checkpointRoot))
          )
            throw new Error('invalid-windows-checkpoint-directory')
          checkpointPaths.push(input.checkpointRoot)
          return await sourceControl.checkpoint(input)
        },
        async restore(input) {
          restores++
          return await sourceControl.restore(input)
        },
      },
      candidates,
      ...f,
      verification,
      workspacePersistence: {
        async workspace() {
          return workspaceRow
        },
        async insertWorkspace(row) {
          if (workspaceRow) throw new Error('duplicate workspace')
          workspaceRow = row
        },
      },
      platformPersistence: {
        async currentWorkspace() {
          return workspaceRow ? { row: workspaceRow, repositoryLocalPath: repo } : null
        },
        async insertCandidate(row) {
          if (!candidateRows.has(row.candidateRef))
            candidateRows.set(row.candidateRef, { ...row, state: 'prepared', commitSha: null })
        },
        async candidate(id) {
          return candidateRows.get(id) ?? null
        },
        async recordCandidateCommit(row) {
          if (failCommitRegistration) {
            failCommitRegistration = false
            throw new Error('interrupted-registration')
          }
          const before = candidateRows.get(row.candidateRef)!
          candidateRows.set(row.candidateRef, {
            ...before,
            state: 'committed',
            commitSha: row.commitSha,
          })
        },
      },
    })
    const handoff = {
      work,
      roundRef: 'handoff',
      workspace,
      verification: {
        candidate: { candidateRef: verified.candidateRef!, treeOid: verified.candidateTreeOid! },
        basisId: frozen.basis.id,
        basisDigest: frozen.basis.digest,
        implementationRoundRef: 'build',
      },
      commitSha: committed.commitSha,
      deliveryContent: implementation.deliveryContent,
    }
    const publish = async (patch: Partial<GraphMrBeforePublishInput> = {}) => {
      const current = await bridge.continuationWorkspace('design-a')
      if (!current) throw new Error('missing continuation')
      return await bridge.beforePublish({
        caseId: 'case-a',
        roundRef: 'publish',
        workItemRef: 'publish-mr',
        workspacePath: current.workspacePath,
        baselineRepoPath: repo,
        baselineSha: repositoryMaterializationCommit(current.baseline),
        expectedTreeOid: verified.candidateTreeOid!,
        expectedCandidateRef: verified.candidateRef!,
        ...patch,
      })
    }
    return {
      ...f,
      root,
      repo,
      sourceControl,
      candidates,
      verification,
      work,
      handoff,
      bridge,
      publish,
      frozen,
      verified,
      committed,
      candidateRows,
      checkpointPaths,
      review,
      implementation,
      profiles,
      changeEnvironment: () => {
        environmentGeneration++
      },
      getWorkspace: () => workspaceRow,
      setWorkspace: (row: EmployeeCaseWorkspaceRow) => {
        workspaceRow = row
      },
      restores: () => restores,
      interruptRegistration: () => {
        failCommitRegistration = true
      },
    }
  }

  const caseTest = test

  async function publishedFixture() {
    const f = await fixture()
    const initial = await f.bridge.prepareHandoff(f.handoff)
    f.setWorkspace({
      ...f.getWorkspace()!,
      baselineSha: f.committed.commitSha,
      remoteHeadSha: f.committed.commitSha,
      state: 'published',
    })
    f.candidateRows.set(initial.candidateState.candidateRef, {
      ...f.candidateRows.get(initial.candidateState.candidateRef)!,
      state: 'published',
    })
    const publication: GraphMrHandoffResult = {
      ...initial,
      candidateState: { ...initial.candidateState, status: 'published' },
    }
    const work = {
      ...f.work,
      request: { ...f.work.request, deliveryMode: 'merge-request' as const },
    }
    const workspace = (await f.bridge.continuationWorkspace('design-a'))!
    const published = {
      candidateRef: publication.candidateState.candidateRef,
      commitSha: f.committed.commitSha,
      repositoryRef: 'repo-a',
      sourceBranch: 'graph/booking',
      targetBranch: 'main',
      issueStateJson: canonicalJson(publication.issueState),
    }
    const verificationWorkspace = await f.bridge.verificationWorkspace({
      work,
      workspace,
      published,
    })
    const checked = await f.verification.run({
      designId: 'design-a',
      roundRef: 'published-checks',
      workspace: verificationWorkspace,
    })
    expect(checked.passed).toBe(true)
    return {
      ...f,
      work,
      publication,
      published,
      workspace,
      verificationWorkspace,
      reuse: {
        ...f.handoff,
        work,
        workspace,
        published,
        roundRef: 'published-redelivery',
        verification: {
          ...f.handoff.verification,
          candidate: { candidateRef: checked.candidateRef!, treeOid: checked.candidateTreeOid! },
        },
      },
    }
  }

  caseTest(
    'publication reuse rejects changed inputs, a different published head, stale approval and workspace drift',
    async () => {
      const f = await publishedFixture()
      const count = git(f.repo, 'rev-list', '--all', '--count')
      expect((await f.bridge.reusePublished(f.reuse))?.commitSha).toBe(f.committed.commitSha)
      for (const patch of [
        { publicationBranch: 'another-source' },
        { targetBranch: 'release' },
        { body: 'A different publication request' },
        {
          uploads: [
            {
              artifactRef: 'other-upload',
              sha256: 'b'.repeat(64),
              originalName: 'spec.md',
              placement: 'temporary' as const,
              targetPath: null,
            },
          ],
        },
      ])
        await expect(
          f.bridge.reusePublished({
            ...f.reuse,
            work: { ...f.work, request: { ...f.work.request, ...patch } },
          }),
        ).rejects.toThrow('graph-mr-publication-inputs-changed')
      await expect(
        f.bridge.reusePublished({
          ...f.reuse,
          deliveryContent: {
            ...f.handoff.deliveryContent,
            commitMessage: 'Different commit intent',
          },
        }),
      ).rejects.toThrow('graph-mr-publication-inputs-changed')
      await expect(
        f.bridge.reusePublished({
          ...f.reuse,
          workspace: {
            ...f.workspace,
            uploadPlan: { planDigest: 'new-plan', entries: [] },
          },
        }),
      ).rejects.toThrow('graph-mr-publication-inputs-changed')
      expect(
        await f.bridge.reusePublished({
          ...f.reuse,
          published: { ...f.published, commitSha: 'e'.repeat(40) },
        }),
      ).toBeNull()
      expect(await f.bridge.reusePublished({ ...f.reuse, published: null })).toBeNull()
      const wrongTarget = { ...f.work, request: { ...f.work.request, targetBranch: 'release' } }
      expect(
        (
          await f.bridge.verificationWorkspace({
            work: wrongTarget,
            workspace: f.workspace,
            published: f.published,
          })
        ).baseline,
      ).toEqual(f.workspace.baseline)
      await expect(
        f.bridge.prepareHandoff({ ...f.handoff, work: wrongTarget, workspace: f.workspace }),
      ).rejects.toThrow('graph-mr-target-baseline-mismatch')
      f.setWorkspace({ ...f.getWorkspace()!, remoteHeadSha: 'f'.repeat(40) })
      expect(await f.bridge.reusePublished(f.reuse)).toBeNull()
      f.setWorkspace({ ...f.getWorkspace()!, remoteHeadSha: f.committed.commitSha })
      f.setReview({ ...f.review, decision: 'rejected' })
      await expect(f.bridge.reusePublished(f.reuse)).rejects.toThrow(
        'graph-mr-approval-no-longer-valid',
      )
      f.setReview(f.review)
      f.changeEnvironment()
      await expect(f.bridge.reusePublished(f.reuse)).rejects.toThrow(
        'graph-mr-reverification-required',
      )
      expect(
        (
          await f.verification.run({
            designId: 'design-a',
            roundRef: 'fresh-published-checks',
            workspace: f.verificationWorkspace,
          })
        ).passed,
      ).toBe(true)
      expect(
        (await f.bridge.reusePublished({ ...f.reuse, roundRef: 'fresh-redelivery' }))?.commitSha,
      ).toBe(f.committed.commitSha)
      writeFileSync(
        join(f.workspace.workspacePath, 'booking.js'),
        'export const reserve = () => "预约";\n// actual new code\n',
      )
      expect((await f.bridge.verificationWorkspace(f.reuse)).baseline).toEqual(f.workspace.baseline)
      await expect(f.bridge.reusePublished(f.reuse)).rejects.toThrow(
        'graph-mr-handoff-candidate-drifted',
      )
      expect(git(f.repo, 'rev-list', '--all', '--count')).toBe(count)
    },
    30_000,
  )

  caseTest(
    'incompatible publication inputs stop the platform before commit or push',
    async () => {
      const f = await publishedFixture()
      let workspace = f.workspace
      let commits = 0,
        pushes = 0
      const platform = createGraphPlatformWorkItems({
        ...f,
        workspace: { initialize: async () => workspace, state: async () => workspace },
        candidates: {
          ...f.candidates,
          async commit(input) {
            commits++
            return await f.candidates.commit(input)
          },
          async push(input) {
            pushes++
            return await f.candidates.push(input)
          },
        },
        mergeRequestDelivery: f.bridge,
      })
      const count = git(f.repo, 'rev-list', '--all', '--count')
      const publishedSubject = git(f.repo, 'log', '-1', '--format=%s', f.committed.commitSha)
      expect(publishedSubject).toBe(`aw: ${f.implementation.deliveryContent.commitMessage}`)
      for (const patch of [
        { publicationBranch: 'another-source' },
        { targetBranch: 'release' },
        { body: 'Different requirement' },
      ])
        await expect(
          platform.execute(
            platformPlan(
              { ...f.work, request: { ...f.work.request, ...patch } },
              'deliver-result',
              'changed-identity',
              f.publication,
            ),
          ),
        ).rejects.toThrow('graph-mr-publication-inputs-changed')
      workspace = { ...workspace, uploadPlan: { planDigest: 'changed-plan', entries: [] } }
      await expect(
        platform.execute(
          platformPlan(f.work, 'deliver-result', 'changed-upload-plan', f.publication),
        ),
      ).rejects.toThrow('graph-mr-publication-inputs-changed')
      workspace = f.workspace
      for (const [index, patch] of [
        { title: 'A different MR title' },
        { description: 'Different MR release notes' },
        { commitMessage: 'A different immutable commit message' },
      ].entries()) {
        const roundRef = `changed-publication-content-${index}`
        const implementation = {
          ...f.implementation,
          deliveryContent: { ...f.implementation.deliveryContent, ...patch },
        }
        await f.store.insertLink({
          designId: 'design-a',
          id: `implementation:${roundRef}`,
          kind: 'execution',
          payloadJson: canonicalJson({
            basisId: f.frozen.basis.id,
            basisDigest: f.frozen.basis.digest,
            roundRef,
            result: implementation,
          }),
          createdAt: Date.now() + index,
        })
        expect(
          JSON.parse(
            await platform.execute(
              platformPlan(f.work, 'verify-change', `${roundRef}-checks`, f.publication),
            ),
          ).result.passed,
        ).toBe(true)
        await expect(
          platform.execute(platformPlan(f.work, 'deliver-result', roundRef, f.publication)),
        ).rejects.toThrow('graph-mr-publication-inputs-changed')
      }
      expect(git(f.repo, 'log', '-1', '--format=%s', f.committed.commitSha)).toBe(publishedSubject)
      expect(git(f.repo, 'rev-list', '--all', '--count')).toBe(count)
      expect(commits).toBe(0)
      expect(pushes).toBe(0)
      expect(f.candidateRows.get(f.publication.candidateState.candidateRef)).toMatchObject({
        state: 'published',
        baselineSha: f.publication.candidateState.baselineSha,
        commitSha: f.committed.commitSha,
      })
    },
    30_000,
  )

  caseTest(
    'changed care code is verified against the current head and becomes a real child candidate',
    async () => {
      const f = await publishedFixture()
      writeFileSync(
        join(f.workspace.workspacePath, 'booking.js'),
        'export const reserve = () => "预约";\n// requested code change\n',
      )
      let commits = 0
      const platform = createGraphPlatformWorkItems({
        ...f,
        workspace: { initialize: async () => f.workspace, state: async () => f.workspace },
        candidates: {
          ...f.candidates,
          async commit(input) {
            commits++
            return await f.candidates.commit(input)
          },
        },
        mergeRequestDelivery: f.bridge,
      })
      expect(
        JSON.parse(
          await platform.execute(
            platformPlan(f.work, 'verify-change', 'changed-code-checks', f.publication),
          ),
        ).result.passed,
      ).toBe(true)
      const delivered = JSON.parse(
        await platform.execute(
          platformPlan(f.work, 'deliver-result', 'changed-code-delivery', f.publication),
        ),
      ).result
      expect(commits).toBe(1)
      expect(delivered.commitSha).not.toBe(f.committed.commitSha)
      expect(git(f.repo, 'rev-parse', `${delivered.commitSha}^`)).toBe(f.committed.commitSha)
      expect(JSON.parse(delivered.mergeRequestDelivery.candidateStateJson)).toMatchObject({
        status: 'prepared',
        baselineSha: f.committed.commitSha,
      })
    },
    30_000,
  )

  caseTest(
    'an upgraded graph@2 delivery replays its legacy completed receipt without another commit',
    async () => {
      const f = await fixture()
      const handoff = await f.bridge.prepareHandoff(f.handoff)
      const legacyResult = {
        artifactRefs: handoff.artifactRefs,
        commitSha: f.committed.commitSha,
        publication: null,
        mergeRequestDelivery: {
          issueStateJson: canonicalJson(handoff.issueState),
          candidateStateJson: canonicalJson(handoff.candidateState),
        },
      }
      const verification = JSON.parse(
        (await f.store.record('design-a', 'verification:initial-checks'))!.payloadJson,
      )
      await f.store.insertLink({
        designId: 'design-a',
        kind: 'execution',
        id: `delivery:${graphDigest({ basis: f.frozen.basis.digest, candidate: verification.candidate })}`,
        payloadJson: canonicalJson({ kind: 'delivery', result: legacyResult }),
        createdAt: Date.now(),
      })
      const workspace = (await f.bridge.continuationWorkspace('design-a'))!
      const work = {
        ...f.work,
        request: { ...f.work.request, deliveryMode: 'merge-request' as const },
      }
      const platform = createGraphPlatformWorkItems({
        ...f,
        workspace: { initialize: async () => workspace, state: async () => workspace },
        candidates: {
          ...f.candidates,
          async commit() {
            throw new Error('legacy replay must not commit')
          },
          async push() {
            throw new Error('legacy replay must not push')
          },
        },
        mergeRequestDelivery: f.bridge,
      })
      expect(
        JSON.parse(await platform.execute(platformPlan(work, 'deliver-result', 'legacy-retry')))
          .result,
      ).toEqual(legacyResult)
      expect(
        await f.bridge.resumeHandoff({
          ...f.handoff,
          workspace,
          deliveryContent: { ...f.handoff.deliveryContent, title: 'Changed publication' },
        }),
      ).toBeNull()
      f.setReview({ ...f.review, decision: 'rejected' })
      await expect(
        platform.execute(platformPlan(work, 'deliver-result', 'legacy-withdrawn')),
      ).rejects.toThrow('graph-mr-approval-no-longer-valid')
    },
    30_000,
  )

  caseTest(
    'a current delivery receipt rechecks native approval and the care tree before publication replay',
    async () => {
      const f = await fixture()
      const work = {
        ...f.work,
        request: { ...f.work.request, deliveryMode: 'merge-request' as const },
      }
      const workspace = async () =>
        (await f.bridge.continuationWorkspace('design-a')) ?? f.handoff.workspace
      let commits = 0
      const platform = createGraphPlatformWorkItems({
        ...f,
        workspace: { initialize: workspace, state: workspace },
        candidates: {
          ...f.candidates,
          async commit(input) {
            commits++
            return await f.candidates.commit(input)
          },
          async push() {
            throw new Error('delivery replay must not push')
          },
        },
        mergeRequestDelivery: f.bridge,
      })
      const plan = platformPlan(work, 'deliver-result', 'current-receipt')
      const delivered = JSON.parse(await platform.execute(plan)).result
      expect(JSON.parse(delivered.mergeRequestDelivery.candidateStateJson).status).toBe('prepared')
      expect(JSON.parse(await platform.execute(plan)).result).toEqual(delivered)
      expect(commits).toBe(1)
      f.setReview({ ...f.review, decision: 'rejected' })
      await expect(platform.execute(plan)).rejects.toThrow('graph-mr-approval-no-longer-valid')
      f.setReview(f.review)
      writeFileSync(
        join((await workspace()).workspacePath, 'booking.js'),
        'export const reserve = () => "预约";\n// replay drift\n',
      )
      await expect(platform.execute(plan)).rejects.toThrow('graph-mr-handoff-candidate-drifted')
      expect(commits).toBe(1)
    },
    30_000,
  )

  caseTest(
    'a newly approved basis refreshes handoff and care materials without republishing identical code',
    async () => {
      const f = await publishedFixture()
      f.execution.resolveImplementationBaseline = async () => f.workspace.baseline
      const before = await f.commands.document('design-a')
      const next = await f.commands.preview('design-a', {
        requestId: 'same-tree-new-basis',
        expectedRevision: before.revision,
        includedElementIds: ['booking'],
      })
      const review = {
        ...f.review,
        id: 'new-basis-approval',
        taskId: 'new-basis-review',
        basisDigest: next.basis.digest,
        decidedAt: 90,
      }
      f.setReview(review)
      await f.commands.recordReview('design-a', review)
      await f.store.insertLink({
        designId: 'design-a',
        id: 'implementation:new-basis-build',
        kind: 'execution',
        payloadJson: canonicalJson({
          basisId: next.basis.id,
          basisDigest: next.basis.digest,
          roundRef: 'new-basis-build',
          result: f.implementation,
        }),
        createdAt: Date.now() + 10,
      })
      const work = {
        ...f.work,
        basisId: next.basis.id,
        basisDigest: next.basis.digest,
        reviewReceiptId: review.id,
      }
      const platform = createGraphPlatformWorkItems({
        ...f,
        workspace: { initialize: async () => f.workspace, state: async () => f.workspace },
        candidates: {
          ...f.candidates,
          async commit() {
            throw new Error('same tree must retain its commit')
          },
          async push() {
            throw new Error('same publication must not push')
          },
        },
        mergeRequestDelivery: f.bridge,
      })
      expect(
        JSON.parse(
          await platform.execute(
            platformPlan(work, 'verify-change', 'new-basis-checks', f.publication),
          ),
        ).result.passed,
      ).toBe(true)
      const delivered = JSON.parse(
        await platform.execute(
          platformPlan(work, 'deliver-result', 'new-basis-delivery', f.publication),
        ),
      ).result
      expect(delivered.commitSha).toBe(f.committed.commitSha)
      const artifact = (await f.commands.basis('design-a', next.basis.id)).artifact
      const issue = JSON.parse(delivered.mergeRequestDelivery.issueStateJson)
      expect(issue.materialArtifactRefs).toContain(artifact.artifactRef)
      expect(issue.materialArtifactRefs).toContain(f.frozen.artifact.artifactRef)
      const material = await f.bridge.repairMaterial({
        caseId: 'case-a',
        roundRef: 'after-new-basis',
      })
      expect(material).toMatchObject({ basisId: next.basis.id, basisDigest: next.basis.digest })
      expect(material!.files.find((file) => file.path === 'care.json')!.content).toContain(
        next.basis.digest,
      )
    },
    30_000,
  )

  caseTest(
    'MR handoff preserves its business identity through a portable checkpoint and replay',
    async () => {
      const f = await fixture(false, { enforcePortableCheckpointPaths: true })
      const result = await f.bridge.prepareHandoff(f.handoff)
      expect(result.candidateState).toMatchObject({
        commitSha: f.committed.commitSha,
        treeOid: f.verified.candidateTreeOid,
      })
      expect(f.checkpointPaths).toHaveLength(1)
      const record = (await f.store.records(f.work.designId)).find(
        (row) => row.kind === 'mr-handoff',
      )!
      expect(record.id).toStartWith('mr-handoff:')
      expect(record.status).toBe('completed')
      const workspace = await f.bridge.continuationWorkspace(f.work.designId)
      expect(workspace).not.toBeNull()
      expect(readFileSync(join(workspace!.workspacePath, 'booking.js'), 'utf8')).toContain('预约')
      expect(await f.bridge.prepareHandoff({ ...f.handoff, workspace: workspace! })).toEqual(result)
      expect(f.checkpointPaths).toHaveLength(1)
    },
  )

  caseTest(
    'owner persistence resumes an interrupted handoff and keeps the published candidate after reconstruction',
    async () => {
      const f = await fixture()
      const { cachedRepos, employeeCases, employeeReactionRounds, employeeChangeCandidates } =
        tablesOf(harness.db)
      await insertOne(harness.db, cachedRepos, {
        id: 'repo-a',
        urlHash: 'rfc396-bridge',
        localPath: f.repo,
        defaultBranch: 'main',
        lastFetchedAt: 1,
        createdAt: 1,
      })
      await insertOne(harness.db, employeeCases, {
        id: 'case-a',
        employeeId: 'employee-a',
        employeeRevision: 1,
        typeId: 'graph-driven-development',
        typeRevision: 2,
        primaryContextId: 'graph-case-a',
        activeRoundId: 'handoff',
        currentWorkItemRef: 'deliver-result',
        executionPolicyRevision: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      await insertOne(harness.db, employeeReactionRounds, {
        id: 'handoff',
        caseId: 'case-a',
        caseRevision: 1,
        employeeId: 'employee-a',
        employeeRevision: 1,
        ruleId: 'deliver',
        workItemRef: 'deliver-result',
        workContractId: 'graph.deliver-result',
        workContractVersion: 2,
        executionPolicyRevision: 1,
        inputContextRefsJson: '[]',
        planJson: '{}',
        state: 'running',
        createdAt: 2,
        updatedAt: 2,
      })
      const workspacePersistence = createEmployeeWorkspacePersistence(harness.db)
      const platformPersistence = createEmployeePlatformWorkItemPersistence(harness.db)
      let interrupt = true,
        restores = 0
      const compose = () =>
        createGraphDeliveryBridge({
          ...f,
          appHome: f.root,
          factory: createFileAutomationWorkspaceEffectsFactory(),
          workspacePersistence,
          sourceControl: {
            ...f.sourceControl,
            async restore(input) {
              restores++
              return await f.sourceControl.restore(input)
            },
          },
          platformPersistence: {
            ...platformPersistence,
            async recordCandidateCommit(input) {
              if (interrupt) {
                interrupt = false
                throw new Error('owner-write-interrupted')
              }
              await platformPersistence.recordCandidateCommit(input)
            },
          },
        })
      await expect(compose().prepareHandoff(f.handoff)).rejects.toThrow('owner-write-interrupted')
      expect((await platformPersistence.candidate(f.verified.candidateRef!))?.state).toBe(
        'prepared',
      )
      const resumed = compose()
      const result = await resumed.prepareHandoff(f.handoff)
      expect(restores).toBe(1)
      // A crash before core delivery writes its receipt restarts through workspace.state(),
      // which already resolves to care after the handoff was completed.
      const continuation = (await compose().continuationWorkspace('design-a'))!
      expect(continuation.workspacePath).not.toBe(f.handoff.workspace.workspacePath)
      expect(await compose().prepareHandoff({ ...f.handoff, workspace: continuation })).toEqual(
        result,
      )
      expect(await platformPersistence.candidate(result.candidateState.candidateRef)).toMatchObject(
        {
          state: 'committed',
          commitSha: f.committed.commitSha,
          treeOid: f.verified.candidateTreeOid,
        },
      )
      const candidates = await harness.db.select().from(employeeChangeCandidates)
      expect(candidates).toHaveLength(1)
      expect(candidates[0]).toMatchObject({ caseId: 'case-a', roundId: 'handoff' })
      await platformPersistence.publishCandidateAndWorkspace({
        caseId: 'case-a',
        candidateRef: result.candidateState.candidateRef,
        commitSha: f.committed.commitSha,
        pushReceiptJson: '{"published":true}',
        updatedAt: 3,
      })
      const restarted = compose()
      expect(await restarted.prepareHandoff(f.handoff)).toEqual(result)
      expect((await platformPersistence.candidate(result.candidateState.candidateRef))?.state).toBe(
        'published',
      )
      expect(await restarted.continuationWorkspace('design-a')).toMatchObject({
        baseline: { kind: 'commit', commitSha: f.committed.commitSha },
        uploadsAlreadyPublished: true,
        remoteHeadSha: f.committed.commitSha,
      })
      expect((await workspacePersistence.workspace('case-a'))?.sourceBranch).toBe('graph/booking')
      expect(restores).toBe(1)
      let commitCalls = 0,
        pushCalls = 0
      const work = {
        ...f.work,
        request: { ...f.work.request, deliveryMode: 'merge-request' as const },
      }
      let publication: GraphMrHandoffResult = {
        ...result,
        candidateState: { ...result.candidateState, status: 'published' },
      }
      const platform = () =>
        createGraphPlatformWorkItems({
          ...f,
          workspace: {
            initialize: async () => (await compose().continuationWorkspace('design-a'))!,
            state: async () => (await compose().continuationWorkspace('design-a'))!,
          },
          candidates: {
            ...f.candidates,
            async commit(input) {
              commitCalls++
              return await f.candidates.commit(input)
            },
            async push(input) {
              pushCalls++
              return await f.candidates.push(input)
            },
          },
          mergeRequestDelivery: compose(),
        })
      const countBefore = git(f.repo, 'rev-list', '--all', '--count')
      const checked = JSON.parse(
        await platform().execute(
          platformPlan(work, 'verify-change', 'unchanged-checks', publication),
        ),
      ).result
      expect(checked.passed).toBe(true)
      const put = f.artifacts.put.bind(f.artifacts)
      let interruptDelivery = true
      f.artifacts.put = async (files) => {
        if (interruptDelivery && files.some((file) => file.path === 'delivery.json')) {
          interruptDelivery = false
          throw new Error('delivery-response-lost')
        }
        return await put(files)
      }
      const deliveryPlan = platformPlan(work, 'deliver-result', 'unchanged-delivery', publication)
      await expect(platform().execute(deliveryPlan)).rejects.toThrow('delivery-response-lost')
      const delivered = JSON.parse(await platform().execute(deliveryPlan)).result
      expect(delivered.commitSha).toBe(f.committed.commitSha)
      expect(JSON.parse(delivered.mergeRequestDelivery.candidateStateJson)).toMatchObject({
        status: 'published',
        candidateRef: result.candidateState.candidateRef,
      })
      expect(JSON.parse(await platform().execute(deliveryPlan)).result).toEqual(delivered)
      expect(git(f.repo, 'rev-list', '--all', '--count')).toBe(countBefore)
      expect(commitCalls).toBe(0)
      expect(pushCalls).toBe(0)
      expect((await platformPersistence.candidate(result.candidateState.candidateRef))?.state).toBe(
        'published',
      )
      expect(
        (await f.store.records('design-a')).some(
          (row) => row.id === 'verification:unchanged-checks' && row.status === 'completed',
        ),
      ).toBe(true)

      const runtime = createRuntimePersistence(harness.db)
      await runtime.settleRound({
        roundId: 'handoff',
        state: 'completed',
        outputJson: canonicalJson(delivered),
        nextCaseState: 'active',
        nextWorkItemRef: 'observe-mr',
        now: 4,
      })
      expect(
        (await runtime.listRounds('case-a')).find((round) => round.id === 'handoff'),
      ).toMatchObject({ state: 'completed' })
      const afterHandoff = await runtime.getCase('case-a')
      expect(afterHandoff).toMatchObject({ state: 'active', activeRoundId: null })

      // A later care repair owns a different real commit and candidate. Recheck
      // that candidate, not merely the one from the first graph handoff.
      const current = (await compose().continuationWorkspace('design-a'))!
      writeFileSync(
        join(current.workspacePath, 'booking.js'),
        'export const reserve = () => "预约";\n// review repair\n',
      )
      const repair = await f.candidates.derive({
        baselineRepoPath: f.repo,
        baselineSha: f.committed.commitSha,
        repositoryBaseline: current.baseline,
        overlayRoot: current.workspacePath,
        excludePolicyDigest: 'a'.repeat(64),
        agentOutcomeRef: 'care-repair',
      })
      if (!repair.ok) throw new Error(repair.detail)
      const repairCommit = await f.candidates.commit({
        baselineRepoPath: f.repo,
        baselineSha: f.committed.commitSha,
        repositoryBaseline: current.baseline,
        overlayRoot: current.workspacePath,
        expectedTreeOid: repair.receipt.treeOid,
        missionId: 'care-repair',
        summarySource: 'Fix booking review',
      })
      if (!repairCommit.ok) throw new Error(repairCommit.detail)
      await insertOne(harness.db, employeeReactionRounds, {
        id: 'care-repair',
        caseId: 'case-a',
        caseRevision: afterHandoff!.revision,
        employeeId: 'employee-a',
        employeeRevision: 1,
        ruleId: 'prepare-repair',
        workItemRef: 'prepare-change',
        workContractId: 'development.prepare-change',
        workContractVersion: 1,
        executionPolicyRevision: 1,
        inputContextRefsJson: '[]',
        planJson: '{}',
        state: 'running',
        createdAt: 4,
        updatedAt: 4,
      })
      await platformPersistence.insertCandidate({
        candidateRef: repair.receipt.candidateRef,
        caseId: 'case-a',
        roundId: 'care-repair',
        baselineSha: f.committed.commitSha,
        treeOid: repair.receipt.treeOid,
        receiptJson: canonicalJson({ ...repair.receipt, uploadPlan: null }),
        summarySource: 'Fix booking review',
        createdAt: 4,
        updatedAt: 4,
      })
      expect(await platformPersistence.candidate(repair.receipt.candidateRef)).toMatchObject({
        caseId: 'case-a',
        roundId: 'care-repair',
        state: 'prepared',
        baselineSha: f.committed.commitSha,
        treeOid: repair.receipt.treeOid,
        commitSha: null,
      })
      await platformPersistence.recordCandidateCommit({
        candidateRef: repair.receipt.candidateRef,
        commitSha: repairCommit.commitSha,
        updatedAt: 5,
      })
      await platformPersistence.publishCandidateAndWorkspace({
        caseId: 'case-a',
        candidateRef: repair.receipt.candidateRef,
        commitSha: repairCommit.commitSha,
        pushReceiptJson: '{"published":true}',
        updatedAt: 6,
      })
      expect(await platformPersistence.candidate(repair.receipt.candidateRef)).toMatchObject({
        state: 'published',
        baselineSha: f.committed.commitSha,
        treeOid: repair.receipt.treeOid,
        commitSha: repairCommit.commitSha,
      })
      expect(await harness.db.select().from(employeeChangeCandidates)).toHaveLength(2)
      publication = {
        ...publication,
        issueState: {
          ...publication.issueState,
          deliveryContent: {
            ...publication.issueState.deliveryContent,
            commitMessage: 'Fix booking review',
          },
        },
        candidateState: {
          ...publication.candidateState,
          candidateRef: repair.receipt.candidateRef,
          baselineSha: f.committed.commitSha,
          treeOid: repair.receipt.treeOid,
          commitSha: repairCommit.commitSha,
          summarySource: 'Fix booking review',
        },
      }
      const repairCount = git(f.repo, 'rev-list', '--all', '--count')
      const repairChecked = JSON.parse(
        await platform().execute(
          platformPlan(work, 'verify-change', 'repair-recheck', publication),
        ),
      ).result
      expect(repairChecked.limitations).toEqual([])
      expect(repairChecked.passed).toBe(true)
      const repairDeliveryPlan = platformPlan(
        work,
        'deliver-result',
        'repair-redelivery',
        publication,
      )
      const repairDelivery = JSON.parse(await platform().execute(repairDeliveryPlan)).result
      expect(repairDelivery.commitSha).toBe(repairCommit.commitSha)
      expect(JSON.parse(repairDelivery.mergeRequestDelivery.candidateStateJson).candidateRef).toBe(
        repair.receipt.candidateRef,
      )
      expect(
        JSON.parse(repairDelivery.mergeRequestDelivery.issueStateJson).deliveryContent
          .commitMessage,
      ).toBe('Fix booking review')
      expect(JSON.parse(await platform().execute(repairDeliveryPlan)).result).toEqual(
        repairDelivery,
      )
      expect(
        JSON.parse(
          await platform().execute(platformPlan(work, 'deliver-result', 'repair-redelivery')),
        ).result,
      ).toEqual(repairDelivery)
      expect(git(f.repo, 'rev-list', '--all', '--count')).toBe(repairCount)
      expect(commitCalls).toBe(0)
      expect(pushCalls).toBe(0)
    },
    30_000,
  )

  caseTest(
    'a completed publication check requires its frozen profile revision and the latest human acceptance',
    async () => {
      const f = await fixture(false, { manualAcceptance: true })
      await f.bridge.prepareHandoff(f.handoff)
      expect(await f.publish()).toEqual({ ok: true })
      const getRevision = f.profiles.getRevision.bind(f.profiles)
      f.profiles.getRevision = async () => null
      expect(await f.publish()).toMatchObject({ ok: false, code: 'graph-mr-verification-required' })
      f.profiles.getRevision = getRevision
      const previous = (await f.store.links('design-a')).find(
        (link) => link.id === 'acceptance:initial',
      )!
      const artifact = await f.artifacts.put([
        { path: 'acceptance.json', content: '{"decision":"withdrawn"}' },
      ])
      const acceptance = {
        ...JSON.parse(previous.payloadJson),
        id: 'acceptance:withdrawn',
        result: 'failed',
        recordedAt: Date.now(),
        artifactRef: artifact.artifactRef,
        artifactDigest: artifact.digest,
      }
      await f.store.insertLink({
        ...previous,
        id: acceptance.id,
        payloadJson: canonicalJson(acceptance),
        createdAt: acceptance.recordedAt,
      })
      expect(await f.publish()).toMatchObject({ ok: false, code: 'graph-mr-verification-required' })
    },
    30_000,
  )

  caseTest(
    'publication replay distinguishes two approved revisions of the same verification profile',
    async () => {
      const f = await fixture(false, { multipleProfileRevisions: true })
      await f.bridge.prepareHandoff(f.handoff)
      expect(await f.publish()).toEqual({ ok: true })
      expect(await f.publish()).toEqual({ ok: true })
      const saved = JSON.parse(
        (await f.store.record('design-a', 'verification:initial-checks'))!.payloadJson,
      )
      expect(saved.profileDigests['checks@1']).toBe(
        (await f.profiles.getRevision('checks', 1))!.contentDigest,
      )
      expect(saved.profileDigests['checks@2']).toBe(
        (await f.profiles.getRevision('checks', 2))!.contentDigest,
      )
    },
    30_000,
  )

  caseTest(
    'handoff maps temporary graph material into the existing care requirement directory',
    async () => {
      const f = await fixture()
      const content = 'Existing requirement material\n'
      const originalName = 'spec.md'
      const graphUploads = join(
        f.handoff.workspace.workspacePath,
        '.agent-workflow/inputs/graph/uploads',
      )
      mkdirSync(graphUploads, { recursive: true })
      writeFileSync(join(graphUploads, `0-${stableIdentityComponent(originalName)}`), content)
      const result = await f.bridge.prepareHandoff({
        ...f.handoff,
        work: {
          ...f.work,
          request: {
            ...f.work.request,
            kind: 'body-and-files',
            uploads: [
              {
                artifactRef: 'employee-input:spec',
                sha256: sha256Hex(content),
                placement: 'temporary',
                targetPath: null,
                originalName,
              },
            ],
          },
        },
      })
      expect(issueHandlingContextSchema.safeParse(result.issueState).success).toBe(true)
      const target = result.issueState.request.uploads[0]!.targetPath
      expect(target).toContain('/inputs/requirements/')
      const current = (await f.bridge.continuationWorkspace('design-a'))!
      expect(readFileSync(join(current.workspacePath, target), 'utf8')).toBe(content)
    },
    30_000,
  )

  caseTest(
    'a completed publication check cannot reuse an old execution environment as current evidence',
    async () => {
      const f = await fixture()
      await f.bridge.prepareHandoff(f.handoff)
      expect(await f.publish()).toEqual({ ok: true })
      f.changeEnvironment()
      expect(await f.publish()).toMatchObject({ ok: false, code: 'graph-mr-verification-required' })
      expect(await f.publish({ roundRef: 'new-environment-check' })).toEqual({ ok: true })
    },
    30_000,
  )

  caseTest(
    'a completed publication check reports missing execution artifacts instead of reusing green text',
    async () => {
      const f = await fixture()
      await f.bridge.prepareHandoff(f.handoff)
      expect(await f.publish()).toEqual({ ok: true })
      const execution = (await f.store.links('design-a'))
        .filter((link) => link.kind === 'evidence')
        .map((link) => JSON.parse(link.payloadJson))
        .find((value) => value.kind === 'execution' && value.id.includes('mr:'))
      expect(execution).toBeDefined()
      const files = f.artifacts.files.bind(f.artifacts)
      f.artifacts.files = async (ref) => {
        if (ref.artifactRef === execution.artifactRef) throw new Error('missing-execution-artifact')
        return await files(ref)
      }
      expect(await f.publish()).toMatchObject({ ok: false, code: 'graph-mr-verification-required' })
    },
    30_000,
  )

  caseTest(
    'new approval rebases the design explicitly and hands the next candidate to the same MR workspace',
    async () => {
      const f = await fixture()
      await f.bridge.prepareHandoff(f.handoff)
      f.setWorkspace({
        ...f.getWorkspace()!,
        state: 'published',
        baselineSha: f.committed.commitSha,
        remoteHeadSha: f.committed.commitSha,
      })
      const currentWorkspace = (await f.bridge.continuationWorkspace('design-a'))!
      f.execution.resolveImplementationBaseline = async () =>
        (await f.bridge.continuationWorkspace('design-a'))?.baseline ?? null
      const before = await f.commands.document('design-a')
      const previewRequest = {
        requestId: 'second-basis',
        expectedRevision: before.revision,
        includedElementIds: ['booking'],
      }
      const put = f.artifacts.put.bind(f.artifacts)
      let interruptBasis = true
      f.artifacts.put = async (files) => {
        if (interruptBasis && files.some((file) => file.path === 'basis.json')) {
          interruptBasis = false
          throw new Error('interrupted-basis-after-rebase')
        }
        return await put(files)
      }
      await expect(f.commands.preview('design-a', previewRequest)).rejects.toThrow(
        'interrupted-basis-after-rebase',
      )
      const next = await f.commands.preview('design-a', previewRequest)
      expect(next.basis.document.repositoryBaseline).toEqual(currentWorkspace.baseline)
      expect(next.basis.document.revision).toBe(before.revision + 1)
      expect((await f.commands.document('design-a')).repositoryBaseline).toEqual(
        currentWorkspace.baseline,
      )
      expect((await f.commands.preview('design-a', previewRequest)).basis).toEqual(next.basis)
      expect(await f.publish()).toMatchObject({
        ok: false,
        code: 'graph-mr-design-review-required',
      })
      const review = {
        ...f.review,
        id: 'second-approval',
        taskId: 'review-task-2',
        basisDigest: next.basis.digest,
        decidedAt: 60,
      }
      f.setReview(review)
      await f.commands.recordReview('design-a', review)
      writeFileSync(
        join(currentWorkspace.workspacePath, 'booking.js'),
        '// next approved change\nexport const reserve = () => "预约";\n',
      )
      await f.store.insertLink({
        designId: 'design-a',
        id: 'implementation:build-2',
        kind: 'execution',
        payloadJson: canonicalJson({
          basisId: next.basis.id,
          basisDigest: next.basis.digest,
          roundRef: 'build-2',
          result: f.implementation,
        }),
        createdAt: Date.now() + 1,
      })
      const checked = await f.verification.run({
        designId: 'design-a',
        roundRef: 'second-checks',
        workspace: currentWorkspace,
        implementationRoundRef: 'build-2',
      })
      expect(checked.passed).toBe(true)
      const committed = await f.candidates.commit({
        baselineRepoPath: f.repo,
        baselineSha: f.committed.commitSha,
        repositoryBaseline: currentWorkspace.baseline,
        overlayRoot: currentWorkspace.workspacePath,
        expectedTreeOid: checked.candidateTreeOid!,
        missionId: 'graph-case-a-second',
        summarySource: 'Next approved change',
      })
      if (!committed.ok) throw new Error(committed.detail)
      const result = await f.bridge.prepareHandoff({
        ...f.handoff,
        roundRef: 'handoff-2',
        work: {
          ...f.work,
          reviewReceiptId: review.id,
          basisId: next.basis.id,
          basisDigest: next.basis.digest,
        },
        workspace: currentWorkspace,
        verification: {
          candidate: { candidateRef: checked.candidateRef!, treeOid: checked.candidateTreeOid! },
          basisId: next.basis.id,
          basisDigest: next.basis.digest,
          implementationRoundRef: 'build-2',
        },
        commitSha: committed.commitSha,
      })
      expect(result.issueState.request.workingBranch).toBe('graph/booking')
      expect(f.getWorkspace()?.remoteHeadSha).toBe(f.committed.commitSha)
      expect(result.candidateState.baselineSha).toBe(f.committed.commitSha)
      expect(f.restores()).toBe(1)
      expect(
        await f.publish({
          roundRef: 'publish-second',
          expectedTreeOid: checked.candidateTreeOid!,
          expectedCandidateRef: checked.candidateRef!,
        }),
      ).toEqual({ ok: true })
    },
    30_000,
  )

  caseTest(
    'handoff preserves the exact verified tree, same Case and committed candidate; replay does not reset care',
    async () => {
      const f = await fixture()
      const result = await f.bridge.prepareHandoff(f.handoff)
      const workspace = (await f.bridge.continuationWorkspace('design-a'))!
      expect(result.issueState.subjectRef).toBe('case:case-a')
      expect(issueHandlingContextSchema.safeParse(result.issueState).success).toBe(true)
      expect(result.issueState.deliveryContent.mergeRequestTitle).toBe('Booking')
      expect(result.candidateState.commitSha).toBe(f.committed.commitSha)
      expect(f.getWorkspace()).toMatchObject({
        caseId: 'case-a',
        sourceBranch: 'graph/booking',
        targetBranch: 'main',
        remoteHeadSha: null,
      })
      expect(workspace.workspacePath).not.toBe(f.handoff.workspace.workspacePath)
      expect(readFileSync(join(workspace.workspacePath, 'booking.js'), 'utf8')).toContain('预约')
      await f.bridge.prepareHandoff(f.handoff)
      expect(f.restores()).toBe(1)
      expect(await f.publish()).toEqual({ ok: true })
    },
    30_000,
  )

  caseTest(
    'a crash after workspace registration resumes without copying over care edits',
    async () => {
      const f = await fixture()
      f.interruptRegistration()
      await expect(f.bridge.prepareHandoff(f.handoff)).rejects.toThrow('interrupted-registration')
      expect(f.getWorkspace()).not.toBeNull()
      const replay = await f.bridge.prepareHandoff(f.handoff)
      expect(replay.candidateState.commitSha).toBe(f.committed.commitSha)
      expect(f.restores()).toBe(1)
    },
    30_000,
  )

  caseTest(
    'a different commit or equal source/target branches cannot enter MR care',
    async () => {
      const f = await fixture()
      await expect(
        f.bridge.prepareHandoff({
          ...f.handoff,
          commitSha: repositoryMaterializationCommit(f.handoff.workspace.baseline),
        }),
      ).rejects.toThrow('graph-mr-commit-content-mismatch')
      await expect(
        f.bridge.prepareHandoff({
          ...f.handoff,
          work: { ...f.work, request: { ...f.work.request, publicationBranch: 'main' } },
        }),
      ).rejects.toThrow('graph-mr-branches-must-differ')
      expect(f.getWorkspace()).toBeNull()
    },
    30_000,
  )

  caseTest(
    'repair reruns the actual profile; an initial green result never blesses changed failing code',
    async () => {
      const f = await fixture()
      await f.bridge.prepareHandoff(f.handoff)
      const workspace = (await f.bridge.continuationWorkspace('design-a'))!
      writeFileSync(
        join(workspace.workspacePath, 'booking.js'),
        'export const reserve = () => "broken";\n',
      )
      const changed = await f.candidates.derive({
        baselineRepoPath: f.repo,
        baselineSha: repositoryMaterializationCommit(workspace.baseline),
        overlayRoot: workspace.workspacePath,
        agentOutcomeRef: 'repair',
        excludePolicyDigest: 'a'.repeat(64),
      })
      if (!changed.ok) throw new Error(changed.detail)
      expect(
        await f.publish({
          roundRef: 'repair-failed',
          workItemRef: 'prepare-change',
          expectedTreeOid: changed.receipt.treeOid,
        }),
      ).toMatchObject({ ok: false, code: 'graph-mr-verification-required' })
      const failed = (await f.store.links('design-a'))
        .filter((link) => link.kind === 'evidence')
        .map((link) => JSON.parse(link.payloadJson))
        .find((e) => e.candidateTreeOid === changed.receipt.treeOid && e.kind === 'execution')
      expect(failed.result).toBe('failed')
      writeFileSync(
        join(workspace.workspacePath, 'booking.js'),
        '// repaired\nexport const reserve = () => "预约";\n',
      )
      const repaired = await f.candidates.derive({
        baselineRepoPath: f.repo,
        baselineSha: repositoryMaterializationCommit(workspace.baseline),
        overlayRoot: workspace.workspacePath,
        agentOutcomeRef: 'repair-success',
        excludePolicyDigest: 'a'.repeat(64),
      })
      if (!repaired.ok) throw new Error(repaired.detail)
      expect(
        await f.publish({ roundRef: 'repair-success', expectedTreeOid: repaired.receipt.treeOid }),
      ).toEqual({ ok: true })
    },
    30_000,
  )

  caseTest(
    'conflict publication verifies the merged target content and rejects a broken resolution',
    async () => {
      const f = await fixture()
      await f.bridge.prepareHandoff(f.handoff)
      writeFileSync(join(f.repo, 'booking.js'), 'export const reserve = () => "target revision";\n')
      writeFileSync(join(f.repo, 'target-only.txt'), 'New target content must survive the merge\n')
      git(f.repo, 'add', 'booking.js', 'target-only.txt')
      git(
        f.repo,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=f@example.test',
        'commit',
        '-qm',
        'target advanced',
      )
      const conflict = await bindConflictMergeParticipant().prepare({
        baselineRepoPath: f.repo,
        sourceSha: f.committed.commitSha,
        targetSha: git(f.repo, 'rev-parse', 'HEAD'),
        workspacesRoot: join(f.root, 'conflicts'),
      })
      if (!conflict.ok) throw new Error(`${conflict.code}: ${conflict.detail}`)
      try {
        expect(conflict.conflictPaths).toEqual(['booking.js'])
        expect(readFileSync(join(conflict.workspacePath, 'target-only.txt'), 'utf8')).toContain(
          'New target content',
        )
        writeFileSync(
          join(conflict.workspacePath, 'booking.js'),
          '// resolved target and source\nexport const reserve = () => "预约";\n',
        )
        const derive = () =>
          f.candidates.derive({
            baselineRepoPath: f.repo,
            baselineSha: f.committed.commitSha,
            overlayRoot: conflict.workspacePath,
            excludePolicyDigest: 'a'.repeat(64),
            agentOutcomeRef: 'conflict',
          })
        const candidate = await derive()
        if (!candidate.ok) throw new Error(candidate.detail)
        expect(candidate.receipt.changed.added).toContain('target-only.txt')
        expect(
          await f.publish({
            roundRef: 'conflict-resolved',
            workItemRef: 'publish-conflict',
            workspacePath: conflict.workspacePath,
            baselineSha: f.committed.commitSha,
            expectedTreeOid: candidate.receipt.treeOid,
          }),
        ).toEqual({ ok: true })
        expect(
          await f.publish({ roundRef: 'wrong-scene', expectedTreeOid: candidate.receipt.treeOid }),
        ).toMatchObject({ ok: false, code: 'graph-mr-verification-required' })
        writeFileSync(
          join(conflict.workspacePath, 'booking.js'),
          'export const reserve = () => "bad merge";\n',
        )
        const broken = await derive()
        if (!broken.ok) throw new Error(broken.detail)
        expect(
          await f.publish({
            roundRef: 'conflict-broken',
            workItemRef: 'publish-conflict',
            workspacePath: conflict.workspacePath,
            baselineSha: f.committed.commitSha,
            expectedTreeOid: broken.receipt.treeOid,
          }),
        ).toMatchObject({ ok: false, code: 'graph-mr-verification-required' })
      } finally {
        await conflict.cleanup()
      }
    },
    30_000,
  )

  caseTest(
    'a published workspace becomes the next graph baseline and preserves its current content',
    async () => {
      const f = await fixture()
      await f.bridge.prepareHandoff(f.handoff)
      f.setWorkspace({
        ...f.getWorkspace()!,
        state: 'published',
        baselineSha: f.committed.commitSha,
        remoteHeadSha: f.committed.commitSha,
      })
      const current = (await f.bridge.continuationWorkspace('design-a'))!
      const candidateTreeOid = f.verified.candidateTreeOid
      if (!candidateTreeOid) throw new Error('fixture-verified-candidate-missing')
      expect(current.baseline).toEqual({
        kind: 'commit',
        commitSha: f.committed.commitSha,
        treeOid: candidateTreeOid,
      })
      expect(current.uploadsAlreadyPublished).toBe(true)
      expect(current.remoteHeadSha).toBe(f.committed.commitSha)
    },
    30_000,
  )

  caseTest(
    'changed design and withdrawn approval require a new native design review',
    async () => {
      const f = await fixture()
      await f.bridge.prepareHandoff(f.handoff)
      f.setReview({ ...f.review, decision: 'rejected', reason: 'withdrawn', decidedAt: 50 })
      expect(await f.publish()).toMatchObject({
        ok: false,
        code: 'graph-mr-approval-no-longer-valid',
      })
      f.setReview(f.review)
      const document = await f.commands.document('design-a')
      document.elements[0]!.description = 'Changed business behavior'
      await f.commands.change('design-a', {
        requestId: 'design-change',
        expectedRevision: document.revision,
        document,
      })
      expect(await f.publish()).toMatchObject({
        ok: false,
        code: 'graph-mr-design-review-required',
      })
    },
    30_000,
  )

  caseTest(
    'care material includes approved traces and freezes one material set per reaction round',
    async () => {
      const f = await fixture()
      await f.bridge.prepareHandoff(f.handoff)
      const first = await f.bridge.repairMaterial({ caseId: 'case-a', roundRef: 'repair' })
      expect(first?.materialDirectory).toContain('/inputs/requirements/')
      const care = JSON.parse(first!.files.find((file) => file.path === 'care.json')!.content)
      expect(care.basis.digest).toBe(f.frozen.basis.digest)
      expect(care.traces.some((trace: { path: string }) => trace.path === 'booking.js')).toBe(true)
      expect(care.instructions.join(' ')).toContain('old green report')
      await f.publish()
      expect(await f.bridge.repairMaterial({ caseId: 'case-a', roundRef: 'repair' })).toEqual(first)
      expect(
        (await f.bridge.repairMaterial({ caseId: 'case-a', roundRef: 'next-repair' }))
          ?.materialDirectory,
      ).not.toBe(first?.materialDirectory)
    },
    30_000,
  )

  caseTest(
    'empty repositories retain a parentless candidate and report the missing MR target explicitly',
    async () => {
      const f = await fixture(true)
      await f.bridge.prepareHandoff(f.handoff)
      const workspace = (await f.bridge.continuationWorkspace('design-a'))!
      expect(workspace.baseline.kind).toBe('unborn')
      expect(git(f.repo, 'rev-list', '--parents', '-n', '1', f.committed.commitSha)).toBe(
        f.committed.commitSha,
      )
      expect(await f.publish()).toMatchObject({ ok: false, code: 'graph-mr-target-unborn' })
    },
    30_000,
  )

  caseTest(
    'MR verification uses the handoff implementation contract even if a newer unrelated link appears',
    async () => {
      const f = await fixture()
      await f.bridge.prepareHandoff(f.handoff)
      await f.store.insertLink({
        designId: 'design-a',
        id: 'implementation:unrelated',
        kind: 'execution',
        payloadJson: canonicalJson({
          basisId: f.frozen.basis.id,
          basisDigest: f.frozen.basis.digest,
          roundRef: 'unrelated',
          result: {
            traceProposals: [],
            testRefs: [],
            limitations: ['unrelated unfinished implementation'],
            deliveryContent: f.handoff.deliveryContent,
          },
        }),
        createdAt: Date.now() + 1000,
      })
      expect(await f.publish()).toEqual({ ok: true })
      const regular = await f.bridge.beforePublish({
        caseId: 'ordinary-case',
        roundRef: 'ordinary',
        workItemRef: 'publish-mr',
        workspacePath: 'unused',
        baselineRepoPath: 'unused',
        baselineSha: 'unused',
        expectedTreeOid: 'unused',
      })
      expect(regular).toEqual({ ok: true })
    },
    30_000,
  )
})
