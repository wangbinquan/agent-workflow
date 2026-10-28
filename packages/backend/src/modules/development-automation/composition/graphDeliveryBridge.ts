import { canonicalJson, repositoryMaterializationCommit } from '@agent-workflow/shared'
import type {
  CandidateDeliveryParticipant,
  ChangeCandidateParticipant,
  EmployeeCaseWorkspaceParticipant,
} from '@/modules/source-control/public/types'
import { stableGitRefComponent, stableIdentityComponent } from '@/util/gitRef'
import type { AutomationWorkspaceEffectsFactory } from '../application/ports/automationWorkspaceEffects'
import type { EmployeeWorkspacePersistence } from '../application/ports/employeeWorkspacePersistence'
import type { EmployeePlatformWorkItemPersistence } from '../application/ports/employeePlatformWorkItemPersistence'
import type { GraphDesignStore } from '../application/ports/graphDesignStore'
import type { GraphDesignExecutionPort } from '../application/ports/graphDesignExecution'
import type { GraphDesignCommands } from '../application/graph-development/designCommands'
import type { GraphEmployeeContext } from '../application/graph-development/employeeCodec'
import type {
  createGraphVerification,
  GraphVerificationWorkspace,
} from '../application/graph-development/verification'
import { graphResultSchemas } from '../application/graph-development/toolContracts'
import {
  createGraphMrCare,
  validateGraphMrBasis,
  type GraphMrHandoff,
} from '../application/graph-development/mrCare'
import { graphDigest } from '../domain/graph-development/model'
import { withAutomationWorkspaceEffects } from '../infrastructure/automationWorkspaceEffects'
import { issueHandlingContextSchema } from './employeeTypePackage'

type Candidate = Extract<
  Awaited<ReturnType<ChangeCandidateParticipant['derive']>>,
  { ok: true }
>['receipt']

export interface GraphMrHandoffResult {
  readonly issueState: {
    readonly status: 'active'
    readonly subjectRef: string
    readonly repositoryRef: string
    readonly request: {
      readonly kind: 'body' | 'files' | 'body-and-files'
      readonly body: string | null
      readonly externalId: null
      readonly uploads: readonly {
        readonly artifactRef: string
        readonly sha256: string
        readonly placement: 'temporary' | 'repository'
        readonly targetPath: string
        readonly originalName: string
      }[]
      readonly executionOptions: Record<string, boolean>
      readonly workingBranch: string
    }
    readonly materialArtifactRefs: readonly string[]
    readonly deliveryContent: {
      readonly commitMessage: string
      readonly mergeRequestTitle: string
      readonly mergeRequestDescription: string
    }
  }
  readonly candidateState: {
    readonly status: 'prepared' | 'published'
    readonly candidateRef: string
    readonly baselineSha: string
    readonly treeOid: string
    readonly summarySource: string
    readonly changedPaths: readonly string[]
    readonly commitSha: string
  }
  readonly artifactRefs: readonly string[]
}

interface GraphMrDeliveryInput {
  readonly work: GraphEmployeeContext
  readonly roundRef: string
  readonly workspace: GraphVerificationWorkspace
  readonly verification: {
    readonly candidate: { readonly candidateRef: string; readonly treeOid: string }
    readonly basisId: string
    readonly basisDigest: string
    readonly implementationRoundRef: string
  }
  readonly deliveryContent: {
    readonly commitMessage: string
    readonly title: string
    readonly description: string
  }
}

interface PublishedGraphCandidate {
  readonly candidateRef: string
  readonly commitSha: string
  readonly repositoryRef: string
  readonly sourceBranch: string
  readonly targetBranch: string
  readonly issueStateJson: string
}
type GraphPublishedInput = Pick<GraphMrDeliveryInput, 'work' | 'workspace'> & {
  readonly published: PublishedGraphCandidate | null
}

function deliveryIssue(input: GraphMrDeliveryInput, artifactRefs: readonly string[]) {
  const { work } = input
  const uploads = work.request.uploads.map((upload, index) => ({
    ...upload,
    targetPath:
      upload.placement === 'temporary'
        ? (upload.targetPath ??
          `.agent-workflow/inputs/requirements/${stableIdentityComponent(work.caseId)}/uploads/${index}-${stableIdentityComponent(upload.originalName)}`)
        : upload.targetPath!,
  }))
  return {
    status: 'active' as const,
    subjectRef: `case:${work.caseId}`,
    repositoryRef: work.repositoryId,
    request: {
      kind: work.request.kind,
      body: work.request.body,
      externalId: null,
      uploads,
      executionOptions: {},
      workingBranch:
        work.request.publicationBranch ??
        `agent-workflow/employee/${stableGitRefComponent(work.caseId)}`,
    },
    materialArtifactRefs: [
      ...work.request.uploads.map((upload) => upload.artifactRef),
      ...artifactRefs,
    ],
    deliveryContent: {
      commitMessage: input.deliveryContent.commitMessage,
      mergeRequestTitle: input.deliveryContent.title,
      mergeRequestDescription:
        input.deliveryContent.description || '按已批准的图设计完成实现与验证。',
    },
  } satisfies GraphMrHandoffResult['issueState']
}

function publicationIdentity(
  handoff: GraphMrHandoff,
  result: Pick<GraphMrHandoffResult, 'issueState'>,
) {
  // Review and verification receipts may advance without changing a publication.
  // Physical workspace paths and the source commit's new baseline are not inputs.
  return graphDigest({
    caseId: handoff.caseId,
    designId: handoff.designId,
    repositoryId: handoff.repositoryId,
    targetBranch: handoff.workspace.targetBranch ?? 'main',
    uploadPlan: handoff.workspace.uploadPlan ?? null,
    request: result.issueState.request,
    deliveryContent: result.issueState.deliveryContent,
  })
}

/** One existing Case changes workspace owner; MR creation/observation stays in the development engine. */
export function createGraphDeliveryBridge(deps: {
  readonly appHome: string
  readonly factory: AutomationWorkspaceEffectsFactory
  readonly sourceControl: EmployeeCaseWorkspaceParticipant
  readonly candidates: Pick<CandidateDeliveryParticipant, 'stage'>
  readonly workspacePersistence: Pick<EmployeeWorkspacePersistence, 'workspace' | 'insertWorkspace'>
  readonly platformPersistence: Pick<
    EmployeePlatformWorkItemPersistence,
    'currentWorkspace' | 'insertCandidate' | 'candidate' | 'recordCandidateCommit'
  >
  readonly store: GraphDesignStore
  readonly commands: GraphDesignCommands
  readonly execution: Pick<GraphDesignExecutionPort, 'reviewReceipt' | 'assertMaterialsReadable'>
  readonly verification: Pick<ReturnType<typeof createGraphVerification>, 'run'>
  readonly now?: () => number
}) {
  const now = deps.now ?? Date.now
  const caseRoot = (caseId: string) =>
    deps.factory.resolve(
      deps.factory.applicationRootReference ?? deps.appHome,
      'workspaces',
      'employee-cases',
      stableIdentityComponent(caseId),
    )
  const sceneRoot = (caseId: string) => deps.factory.resolve(caseRoot(caseId), 'scene')
  const workspacePath = (caseId: string) => deps.factory.resolve(sceneRoot(caseId), 'workspace')
  const care = createGraphMrCare({
    ...deps,
    persistence: deps.platformPersistence,
    workspacePath,
  })
  async function publishedCandidate(input: GraphPublishedInput) {
    if (!input.published) return null
    const current = await deps.platformPersistence.currentWorkspace(input.work.caseId)
    const candidate = await deps.platformPersistence.candidate(input.published.candidateRef)
    const commitSha = candidate?.commitSha
    if (
      !current ||
      current.row.state !== 'published' ||
      !candidate ||
      candidate.state !== 'published' ||
      !commitSha ||
      current.row.repositoryId !== input.work.repositoryId ||
      current.row.baselineSha !== commitSha ||
      current.row.remoteHeadSha !== commitSha ||
      repositoryMaterializationCommit(input.workspace.baseline) !== commitSha ||
      input.published.commitSha !== commitSha ||
      input.published.repositoryRef !== input.work.repositoryId ||
      input.published.sourceBranch !== current.row.sourceBranch ||
      input.published.targetBranch !== current.row.targetBranch ||
      (input.workspace.targetBranch ?? 'main') !== current.row.targetBranch ||
      (input.work.request.targetBranch !== null &&
        input.work.request.targetBranch !== current.row.targetBranch)
    )
      return null
    return { current, candidate, commitSha }
  }
  async function verificationWorkspace(
    input: GraphPublishedInput,
  ): Promise<GraphVerificationWorkspace> {
    const published = await publishedCandidate(input)
    if (!published) return input.workspace
    const staged = await deps.candidates.stage({
      baselineRepoPath: input.workspace.baselineRepoPath,
      baselineSha: published.commitSha,
      overlayRoot: input.workspace.workspacePath,
      uploadPlan: input.workspace.uploadPlan,
    })
    if (!staged.ok) throw new Error(`${staged.code}: ${staged.detail}`)
    try {
      if (staged.treeOid !== published.candidate.treeOid) return input.workspace
    } finally {
      await staged.cleanup()
    }
    // An unchanged published tree has no delta against its own commit. Recheck
    // the actual published candidate against its original parent, after proving
    // that the current care scene still equals that exact publication.
    const parent = await deps.sourceControl.resolveBaseline({
      baselineRepoPath: input.workspace.baselineRepoPath,
      preferredBranch: published.candidate.baselineSha,
      sourceBranch: null,
      allowUnborn: true,
    })
    if (!parent.contentBaseline || parent.baselineSha !== published.candidate.baselineSha)
      throw new Error('graph-mr-published-parent-unavailable')
    return { ...input.workspace, baseline: parent.contentBaseline }
  }
  return {
    ...care,
    verificationWorkspace,
    async resumeHandoff(
      input: GraphMrDeliveryInput & { commitSha: string },
    ): Promise<GraphMrHandoffResult | null> {
      if (
        input.work.request.targetBranch !== null &&
        input.work.request.targetBranch !== (input.workspace.targetBranch ?? 'main')
      )
        return null
      const previous = (await deps.store.records(input.work.designId))
        .filter((row) => row.kind === 'mr-handoff' && row.status === 'completed')
        .map(
          (row) =>
            JSON.parse(row.payloadJson) as {
              handoff: GraphMrHandoff
              result: GraphMrHandoffResult
              publicationIdentity?: string
            },
        )
        .find(
          ({ handoff }) =>
            handoff.basisDigest === input.verification.basisDigest &&
            handoff.candidateRef === input.verification.candidate.candidateRef &&
            handoff.commitSha === input.commitSha,
        )
      if (!previous || !input.work.reviewReceiptId) return null
      const handoff = { ...previous.handoff, reviewReceiptId: input.work.reviewReceiptId }
      const desired = {
        ...previous.result,
        issueState: deliveryIssue(input, previous.result.artifactRefs),
      }
      if (
        publicationIdentity({ ...handoff, workspace: input.workspace }, desired) !==
        (previous.publicationIdentity ?? publicationIdentity(previous.handoff, previous.result))
      )
        return null
      const approved = await validateGraphMrBasis(handoff, deps)
      if (!approved.ok) throw new Error(`${approved.code}: ${approved.detail}`)
      const staged = await deps.candidates.stage({
        baselineRepoPath: input.workspace.baselineRepoPath,
        baselineSha: repositoryMaterializationCommit(input.workspace.baseline),
        overlayRoot: input.workspace.workspacePath,
        uploadPlan: input.workspace.uploadPlan,
      })
      if (!staged.ok) throw new Error(`${staged.code}: ${staged.detail}`)
      try {
        if (staged.treeOid !== handoff.candidateTreeOid)
          throw new Error('graph-mr-handoff-candidate-drifted')
      } finally {
        await staged.cleanup()
      }
      return previous.result
    },
    async reusePublished(
      input: GraphMrDeliveryInput & GraphPublishedInput,
    ): Promise<{ commitSha: string; delivery: GraphMrHandoffResult } | null> {
      if (!input.published || !input.work.reviewReceiptId) return null
      const records = await deps.store.records(input.work.designId)
      const previous = records
        .filter((row) => row.kind === 'mr-handoff' && row.status === 'completed')
        .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))[0]
      if (!previous) return null
      const saved = JSON.parse(previous.payloadJson) as {
        handoff: GraphMrHandoff
        result: GraphMrHandoffResult
        publicationIdentity?: string
      }
      let issueState: unknown
      try {
        issueState = JSON.parse(input.published.issueStateJson)
      } catch {
        return null
      }
      const parsedIssue = issueHandlingContextSchema.safeParse(issueState)
      if (!parsedIssue.success || !parsedIssue.data.deliveryContent) return null
      const currentIssue = parsedIssue.data
      // Care may have published a repaired candidate since the last graph
      // handoff. Its delivery content belongs to that publication of this round.
      const publishedIdentity =
        saved.handoff.implementationRoundRef === input.verification.implementationRoundRef &&
        saved.result.candidateState.candidateRef !== input.published.candidateRef
          ? publicationIdentity(saved.handoff, {
              issueState: {
                ...saved.result.issueState,
                deliveryContent: parsedIssue.data.deliveryContent,
              },
            })
          : (saved.publicationIdentity ?? publicationIdentity(saved.handoff, saved.result))
      const intendedPublicationIdentity = publicationIdentity(
        {
          ...saved.handoff,
          caseId: input.work.caseId,
          designId: input.work.designId,
          repositoryId: input.work.repositoryId,
          workspace: input.workspace,
        },
        { issueState: deliveryIssue(input, []) },
      )
      const currentCandidate = await deps.platformPersistence.candidate(
        input.published.candidateRef,
      )
      if (
        currentCandidate?.treeOid === input.verification.candidate.treeOid &&
        (intendedPublicationIdentity !== publishedIdentity ||
          (input.work.request.targetBranch !== null &&
            input.work.request.targetBranch !== (input.workspace.targetBranch ?? 'main')))
      )
        throw new Error(
          'graph-mr-publication-inputs-changed: 代码树与已发布提交相同，但 MR 标题、描述、提交消息、源/目标分支、需求或上传计划已变化；现有 MR 和 Git 提交保持不变，请通过新工作重新准备并审核发布输入。',
        )
      const published = await publishedCandidate(input)
      if (!published || published.candidate.treeOid !== input.verification.candidate.treeOid)
        return null
      const { current, candidate, commitSha } = published
      const handoff: GraphMrHandoff = {
        designId: input.work.designId,
        caseId: input.work.caseId,
        repositoryId: input.work.repositoryId,
        basisId: input.verification.basisId,
        basisDigest: input.verification.basisDigest,
        reviewReceiptId: input.work.reviewReceiptId,
        implementationRoundRef: input.verification.implementationRoundRef,
        candidateRef: input.verification.candidate.candidateRef,
        candidateTreeOid: input.verification.candidate.treeOid,
        commitSha,
        workspace: input.workspace,
      }
      const frozen = await deps.commands.basis(input.work.designId, input.verification.basisId)
      const receipt = JSON.parse(candidate.receiptJson) as Candidate
      let delivery: GraphMrHandoffResult = {
        issueState: deliveryIssue(input, [frozen.artifact.artifactRef]),
        candidateState: {
          status: 'published',
          candidateRef: candidate.candidateRef,
          baselineSha: candidate.baselineSha,
          treeOid: candidate.treeOid,
          summarySource: candidate.summarySource,
          changedPaths: [
            ...receipt.changed.added,
            ...receipt.changed.modified,
            ...receipt.changed.deleted,
          ],
          commitSha,
        },
        artifactRefs: [frozen.artifact.artifactRef],
      }
      const identityDigest = publicationIdentity(handoff, delivery)
      if (
        delivery.issueState.request.workingBranch !== current.row.sourceBranch ||
        (input.workspace.targetBranch ?? 'main') !== current.row.targetBranch
      )
        return null
      if (
        currentIssue.status !== 'active' ||
        currentIssue.repositoryRef !== input.work.repositoryId ||
        currentIssue.subjectRef !== delivery.issueState.subjectRef ||
        !currentIssue.deliveryContent ||
        graphDigest(currentIssue.request) !== graphDigest(delivery.issueState.request)
      )
        return null
      delivery = {
        ...delivery,
        issueState: {
          ...delivery.issueState,
          materialArtifactRefs: [
            ...new Set([
              ...currentIssue.materialArtifactRefs,
              ...delivery.issueState.materialArtifactRefs,
            ]),
          ],
        },
      }
      const approved = await validateGraphMrBasis(handoff, deps)
      if (!approved.ok) throw new Error(`${approved.code}: ${approved.detail}`)
      const verified = records
        .filter((row) => {
          if (row.kind !== 'verification' || row.status !== 'completed') return false
          const value = JSON.parse(row.payloadJson) as typeof input.verification & {
            candidate: Candidate
            result: unknown
          }
          return (
            value.candidate.candidateRef === input.verification.candidate.candidateRef &&
            value.candidate.treeOid === candidate.treeOid &&
            value.candidate.baselineSnapshotRef === `git:${candidate.baselineSha}` &&
            value.basisDigest === input.verification.basisDigest &&
            value.implementationRoundRef === input.verification.implementationRoundRef &&
            graphResultSchemas['verify-change'].parse(value.result).passed
          )
        })
        .sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt)[0]
      if (!verified) return null
      const checkedWorkspace = await verificationWorkspace(input)
      if (repositoryMaterializationCommit(checkedWorkspace.baseline) !== candidate.baselineSha)
        throw new Error('graph-mr-handoff-candidate-drifted')
      const checked = await deps.verification.run({
        designId: input.work.designId,
        roundRef: verified.id.slice('verification:'.length),
        workspace: checkedWorkspace,
        implementationRoundRef: input.verification.implementationRoundRef,
        expectedBasisDigest: input.verification.basisDigest,
        expectedCandidateTreeOid: candidate.treeOid,
      })
      if (!checked.passed) throw new Error('graph-mr-reverification-required')
      const resolved = await deps.sourceControl.resolveBaseline({
        baselineRepoPath: input.workspace.baselineRepoPath,
        preferredBranch: commitSha,
        sourceBranch: null,
        allowUnborn: true,
      })
      if (
        resolved.contentBaseline?.kind !== 'commit' ||
        resolved.contentBaseline.commitSha !== commitSha ||
        resolved.contentBaseline.treeOid !== candidate.treeOid
      )
        throw new Error('graph-mr-commit-content-mismatch')
      const { workspace: _workspace, ...identity } = handoff
      const record = await deps.commands.beginRecord(
        input.work.designId,
        `mr-handoff:${graphDigest({ roundRef: input.roundRef, identity, publication: identityDigest, reused: true })}`,
        'mr-handoff',
        { ...identity, baseline: input.workspace.baseline, published: input.published },
      )
      if (record.status !== 'completed')
        await deps.commands.finishRecord(record, 'completed', {
          handoff,
          result: delivery,
          publicationIdentity: identityDigest,
        })
      return { commitSha, delivery }
    },
    async prepareHandoff(
      input: GraphMrDeliveryInput & { readonly commitSha: string },
    ): Promise<GraphMrHandoffResult> {
      const { work, workspace, verification } = input
      const targetBranch = workspace.targetBranch ?? work.request.targetBranch ?? 'main'
      if (work.request.targetBranch && work.request.targetBranch !== targetBranch)
        throw new Error('graph-mr-target-baseline-mismatch')
      const sourceBranch =
        work.request.publicationBranch ??
        `agent-workflow/employee/${stableGitRefComponent(work.caseId)}`
      if (sourceBranch === targetBranch)
        throw new Error(
          'graph-mr-branches-must-differ: MR 源分支和目标分支必须不同，请修改发布分支。',
        )
      if (!work.reviewReceiptId)
        throw new Error('graph-mr-approval-missing: 图实现依据尚未取得批准。')
      const handoff: GraphMrHandoff = {
        designId: work.designId,
        caseId: work.caseId,
        repositoryId: work.repositoryId,
        basisId: verification.basisId,
        basisDigest: verification.basisDigest,
        reviewReceiptId: work.reviewReceiptId,
        implementationRoundRef: verification.implementationRoundRef,
        candidateRef: verification.candidate.candidateRef,
        candidateTreeOid: verification.candidate.treeOid,
        commitSha: input.commitSha,
        workspace,
      }
      const approved = await validateGraphMrBasis(handoff, deps)
      if (!approved.ok) throw new Error(`${approved.code}: ${approved.detail}`)
      const completed = (await deps.store.records(work.designId))
        .filter((row) => row.kind === 'verification' && row.status === 'completed')
        .map(
          (row) =>
            JSON.parse(row.payloadJson) as {
              candidate: Candidate
              basisDigest: string
              implementationRoundRef: string
              result: unknown
            },
        )
        .find(
          (value) =>
            value.candidate.candidateRef === verification.candidate.candidateRef &&
            value.candidate.treeOid === verification.candidate.treeOid &&
            value.basisDigest === verification.basisDigest &&
            value.implementationRoundRef === verification.implementationRoundRef &&
            graphResultSchemas['verify-change'].parse(value.result).passed,
        )
      if (!completed) throw new Error('graph-mr-verified-candidate-missing')
      const frozen = await deps.commands.basis(work.designId, verification.basisId)
      const baselineSha = repositoryMaterializationCommit(workspace.baseline)
      // Once handoff completes, workspace.state() resolves to care. A delivery
      // receipt retry must retain its identity across that physical path change.
      const { workspace: _workspace, ...identity } = handoff
      const legacyRecordId = `mr-handoff:${graphDigest({ basis: handoff.basisDigest, candidate: handoff.candidateRef })}`
      const legacyRecord = await deps.store.record(work.designId, legacyRecordId)
      const publicationDigest = publicationIdentity(handoff, {
        issueState: deliveryIssue(input, []),
      })
      const legacyPublication =
        legacyRecord?.status === 'completed'
          ? (JSON.parse(legacyRecord.payloadJson) as {
              handoff: GraphMrHandoff
              result: GraphMrHandoffResult
            })
          : null
      const recordId =
        legacyRecord &&
        (!legacyPublication ||
          publicationIdentity(legacyPublication.handoff, legacyPublication.result) ===
            publicationDigest)
          ? legacyRecordId
          : `mr-handoff:${graphDigest({ basis: handoff.basisDigest, candidate: handoff.candidateRef, publication: publicationDigest })}`
      let record = await deps.commands.beginRecord(work.designId, recordId, 'mr-handoff', {
        ...identity,
        baseline: workspace.baseline,
        sourceBranch,
        targetBranch,
      })
      if (record.status === 'completed')
        return (JSON.parse(record.payloadJson) as { result: GraphMrHandoffResult }).result
      const committed = await deps.sourceControl.resolveBaseline({
        baselineRepoPath: workspace.baselineRepoPath,
        preferredBranch: input.commitSha,
        sourceBranch: null,
        allowUnborn: true,
      })
      if (
        committed.contentBaseline?.kind !== 'commit' ||
        committed.contentBaseline.commitSha !== input.commitSha ||
        committed.contentBaseline.treeOid !== verification.candidate.treeOid
      )
        throw new Error('graph-mr-commit-content-mismatch')
      const current = await deps.workspacePersistence.workspace(work.caseId)
      if (
        current &&
        (current.repositoryId !== work.repositoryId ||
          current.baselineSha !== baselineSha ||
          current.sourceBranch !== sourceBranch ||
          current.targetBranch !== targetBranch)
      )
        throw new Error('graph-mr-workspace-handoff-conflict')
      if (workspace.workspacePath !== workspacePath(work.caseId)) {
        if (current && record.status !== 'prepared')
          throw new Error('graph-mr-workspace-already-owned')
        if (!current) {
          const checkpointRoot = deps.factory.resolve(
            caseRoot(work.caseId),
            'graph-handoff',
            stableIdentityComponent(record.id),
          )
          const checkpoint = await deps.sourceControl.checkpoint({
            workspacePath: workspace.workspacePath,
            checkpointRoot,
          })
          await deps.sourceControl.restore({
            caseRoot: sceneRoot(work.caseId),
            baselineRepoPath: workspace.baselineRepoPath,
            baselineSha,
            checkpointRoot,
            expectedCheckpointDigest: checkpoint.checkpointDigest,
          })
        }
      }
      const staged = await deps.candidates.stage({
        baselineRepoPath: workspace.baselineRepoPath,
        baselineSha,
        overlayRoot: workspacePath(work.caseId),
        uploadPlan: workspace.uploadPlan,
      })
      if (!staged.ok) throw new Error(`${staged.code}: ${staged.detail}`)
      try {
        if (staged.treeOid !== verification.candidate.treeOid)
          throw new Error('graph-mr-handoff-candidate-drifted')
      } finally {
        await staged.cleanup()
      }
      if (record.status !== 'prepared')
        record = await deps.commands.finishRecord(record, 'prepared', { handoff })
      if (!current) {
        const timestamp = now()
        await deps.workspacePersistence.insertWorkspace({
          caseId: work.caseId,
          repositoryId: work.repositoryId,
          cachedRepoId: work.repositoryId,
          baselineSha,
          targetBranch,
          sourceBranch,
          // Graph intake pins the target head; it never observes this new MR source branch.
          remoteHeadSha: null,
          state: 'active',
          createdAt: timestamp,
          updatedAt: timestamp,
        })
      }
      const issue = deliveryIssue(input, [frozen.artifact.artifactRef])
      const uploads = issue.request.uploads
      // Graph intake stores temporary files in its own material directory. The
      // shared care tools consume the existing requirements-directory contract.
      await withAutomationWorkspaceEffects(deps.factory, async (effects) => {
        for (const [index, upload] of uploads.entries()) {
          if (upload.placement !== 'temporary') continue
          const from = deps.factory.resolve(
            workspacePath(work.caseId),
            '.agent-workflow',
            'inputs',
            'graph',
            'uploads',
            `${index}-${stableIdentityComponent(upload.originalName)}`,
          )
          const target = deps.factory.resolve(workspacePath(work.caseId), upload.targetPath)
          await effects.createDirectory(deps.factory.parent(target), true)
          if (!(await effects.exists(target))) await effects.copyFile(from, target, true)
        }
      })
      await deps.platformPersistence.insertCandidate({
        candidateRef: completed.candidate.candidateRef,
        caseId: work.caseId,
        roundId: input.roundRef,
        baselineSha,
        treeOid: completed.candidate.treeOid,
        receiptJson: canonicalJson({
          ...completed.candidate,
          uploadPlan: workspace.uploadPlan ?? null,
        }),
        summarySource: input.deliveryContent.commitMessage,
        createdAt: now(),
        updatedAt: now(),
      })
      const stored = await deps.platformPersistence.candidate(completed.candidate.candidateRef)
      if (
        !stored ||
        stored.treeOid !== completed.candidate.treeOid ||
        stored.baselineSha !== baselineSha ||
        (stored.commitSha && stored.commitSha !== input.commitSha)
      )
        throw new Error('graph-mr-candidate-registration-conflict')
      await deps.platformPersistence.recordCandidateCommit({
        candidateRef: completed.candidate.candidateRef,
        commitSha: input.commitSha,
        updatedAt: now(),
      })
      const artifactRefs = [frozen.artifact.artifactRef]
      const result: GraphMrHandoffResult = {
        issueState: issue,
        candidateState: {
          status: 'prepared',
          candidateRef: completed.candidate.candidateRef,
          baselineSha,
          treeOid: completed.candidate.treeOid,
          summarySource: input.deliveryContent.commitMessage,
          changedPaths: [
            ...completed.candidate.changed.added,
            ...completed.candidate.changed.modified,
            ...completed.candidate.changed.deleted,
          ],
          commitSha: input.commitSha,
        },
        artifactRefs,
      }
      await deps.commands.finishRecord(record, 'completed', { handoff, result })
      return result
    },
  }
}

export type GraphDeliveryBridge = ReturnType<typeof createGraphDeliveryBridge>
