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
    readonly status: 'prepared'
    readonly candidateRef: string
    readonly baselineSha: string
    readonly treeOid: string
    readonly summarySource: string
    readonly changedPaths: readonly string[]
    readonly commitSha: string
  }
  readonly artifactRefs: readonly string[]
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
  return {
    ...care,
    async prepareHandoff(input: {
      readonly work: GraphEmployeeContext
      readonly roundRef: string
      readonly workspace: GraphVerificationWorkspace
      readonly verification: {
        readonly candidate: { readonly candidateRef: string; readonly treeOid: string }
        readonly basisId: string
        readonly basisDigest: string
        readonly implementationRoundRef: string
      }
      readonly commitSha: string
      readonly deliveryContent: {
        readonly commitMessage: string
        readonly title: string
        readonly description: string
      }
    }): Promise<GraphMrHandoffResult> {
      const { work, workspace, verification } = input
      const targetBranch = workspace.targetBranch ?? work.request.targetBranch ?? 'main'
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
      let record = await deps.commands.beginRecord(
        work.designId,
        `mr-handoff:${graphDigest({ basis: handoff.basisDigest, candidate: handoff.candidateRef })}`,
        'mr-handoff',
        { ...identity, baseline: workspace.baseline, sourceBranch, targetBranch },
      )
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
            record.id,
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
      const uploads = work.request.uploads.map((upload, index) => ({
        ...upload,
        targetPath:
          upload.placement === 'temporary'
            ? (upload.targetPath ??
              `.agent-workflow/inputs/requirements/${stableIdentityComponent(work.caseId)}/uploads/${index}-${stableIdentityComponent(upload.originalName)}`)
            : upload.targetPath!,
      }))
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
        issueState: {
          status: 'active',
          subjectRef: `case:${work.caseId}`,
          repositoryRef: work.repositoryId,
          request: {
            kind: work.request.kind,
            body: work.request.body,
            externalId: null,
            uploads,
            executionOptions: {},
            workingBranch: sourceBranch,
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
        },
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
