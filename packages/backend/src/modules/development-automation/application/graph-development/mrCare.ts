import {
  canonicalJson,
  repositoryMaterializationCommit,
  type RepositoryContentBaseline,
} from '@agent-workflow/shared'
import type { EmployeeCaseWorkspaceParticipant } from '@/modules/source-control/public/types'
import { stableIdentityComponent } from '@/util/gitRef'
import { graphDigest, staleGraphReads } from '../../domain/graph-development/model'
import type { EmployeePlatformWorkItemPersistence } from '../ports/employeePlatformWorkItemPersistence'
import type { GraphDesignStore } from '../ports/graphDesignStore'
import type { GraphDesignExecutionPort, GraphReviewReceipt } from '../ports/graphDesignExecution'
import type { GraphDesignCommands } from './designCommands'
import type { createGraphVerification, GraphVerificationWorkspace } from './verification'

export interface GraphMrHandoff {
  readonly designId: string
  readonly caseId: string
  readonly repositoryId: string
  readonly basisId: string
  readonly basisDigest: string
  readonly reviewReceiptId: string
  readonly implementationRoundRef: string
  readonly candidateRef: string
  readonly candidateTreeOid: string
  readonly commitSha: string
  readonly workspace: GraphVerificationWorkspace
}

export type GraphMrPublicationVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly detail: string }

export interface GraphMrBeforePublishInput {
  readonly caseId: string
  readonly roundRef: string
  readonly workItemRef: 'prepare-change' | 'publish-mr' | 'publish-conflict'
  readonly workspacePath: string
  readonly baselineRepoPath: string
  readonly baselineSha: string
  readonly expectedTreeOid: string
  readonly expectedCandidateRef?: string
}

export interface GraphMrRepairMaterial {
  readonly basisId: string
  readonly basisDigest: string
  readonly materialDirectory: string
  readonly files: readonly { readonly path: string; readonly content: string }[]
  readonly summary: string
}

export async function latestGraphMrHandoff(store: GraphDesignStore, designId: string) {
  const record = (await store.records(designId))
    .filter((row) => row.kind === 'mr-handoff' && row.status === 'completed')
    .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))[0]
  return record ? (JSON.parse(record.payloadJson) as { handoff: GraphMrHandoff }).handoff : null
}

/** Native review approval and the still-current read set remain authoritative throughout MR care. */
export async function validateGraphMrBasis(
  input: Pick<
    GraphMrHandoff,
    'designId' | 'caseId' | 'basisId' | 'basisDigest' | 'reviewReceiptId'
  >,
  deps: {
    store: GraphDesignStore
    commands: Pick<GraphDesignCommands, 'basis' | 'document'>
    execution: Pick<GraphDesignExecutionPort, 'reviewReceipt' | 'assertMaterialsReadable'>
  },
): Promise<GraphMrPublicationVerdict> {
  const frozen = await deps.commands.basis(input.designId, input.basisId)
  if (frozen.basis.digest !== input.basisDigest)
    return { ok: false, code: 'graph-mr-basis-mismatch', detail: 'MR 候选与批准的实现依据不一致。' }
  const changed = staleGraphReads(
    await deps.commands.document(input.designId),
    frozen.basis.readSet,
  )
  if (changed.length)
    return {
      ok: false,
      code: 'graph-mr-design-review-required',
      detail: `相关设计已变化（${changed.join(', ')}），请重新预览实现依据、审核并生成候选。`,
    }
  const review = (await deps.store.links(input.designId)).find(
    (link) => link.id === `review:${input.reviewReceiptId}`,
  )
  const saved = review
    ? (JSON.parse(review.payloadJson) as { receipt: GraphReviewReceipt }).receipt
    : null
  if (!saved || saved.decision !== 'approved' || saved.basisDigest !== input.basisDigest)
    return { ok: false, code: 'graph-mr-approval-missing', detail: '缺少该实现依据的批准回执。' }
  const current = await deps.execution.reviewReceipt({
    caseId: input.caseId,
    executionRef: saved.taskId,
    basisDigest: input.basisDigest,
  })
  if (!current || graphDigest(current) !== graphDigest(saved))
    return {
      ok: false,
      code: 'graph-mr-approval-no-longer-valid',
      detail: '原生审核批准已变化或暂不可读取，请重新确认设计审核。',
    }
  await deps.execution.assertMaterialsReadable({
    caseId: input.caseId,
    basis: frozen.basis,
    artifact: frozen.artifact,
  })
  return { ok: true }
}

export function createGraphMrCare(deps: {
  readonly store: GraphDesignStore
  readonly commands: GraphDesignCommands
  readonly execution: Pick<GraphDesignExecutionPort, 'reviewReceipt' | 'assertMaterialsReadable'>
  readonly sourceControl: Pick<EmployeeCaseWorkspaceParticipant, 'resolveBaseline'>
  readonly persistence: Pick<EmployeePlatformWorkItemPersistence, 'currentWorkspace'>
  readonly verification: Pick<ReturnType<typeof createGraphVerification>, 'run'>
  readonly workspacePath: (caseId: string) => string
}) {
  async function baseline(
    handoff: GraphMrHandoff,
    baselineRepoPath: string,
    baselineSha: string,
  ): Promise<RepositoryContentBaseline> {
    // The empty anchor is only a checkout mechanism; never turn it into a business parent.
    if (repositoryMaterializationCommit(handoff.workspace.baseline) === baselineSha)
      return handoff.workspace.baseline
    const resolved = await deps.sourceControl.resolveBaseline({
      baselineRepoPath,
      preferredBranch: baselineSha,
      sourceBranch: null,
      allowUnborn: true,
    })
    if (
      resolved.baselineSha !== baselineSha ||
      resolved.contentBaseline?.kind !== 'commit' ||
      resolved.contentBaseline.commitSha !== baselineSha
    )
      throw new Error('graph-mr-baseline-unavailable')
    return resolved.contentBaseline
  }
  return {
    async continuationWorkspace(designId: string) {
      const handoff = await latestGraphMrHandoff(deps.store, designId)
      if (!handoff) return null
      const current = await deps.persistence.currentWorkspace(handoff.caseId)
      if (!current || current.row.state === 'released')
        throw new Error('graph-mr-workspace-missing')
      return {
        baselineRepoPath: current.repositoryLocalPath,
        baseline: await baseline(handoff, current.repositoryLocalPath, current.row.baselineSha),
        targetBranch: current.row.targetBranch,
        remoteHeadSha: current.row.remoteHeadSha,
        workspacePath: deps.workspacePath(handoff.caseId),
        uploadPlan: handoff.workspace.uploadPlan,
        uploadsAlreadyPublished: current.row.state === 'published',
      }
    },
    async repairMaterial(input: {
      caseId: string
      roundRef?: string
    }): Promise<GraphMrRepairMaterial | null> {
      const design = await deps.store.findByCase(input.caseId)
      if (!design) return null
      const materialId = input.roundRef ? `mr-material:${input.roundRef}` : null
      const previous = materialId ? await deps.store.record(design.id, materialId) : null
      if (previous?.status === 'completed')
        return JSON.parse(previous.payloadJson) as GraphMrRepairMaterial
      const handoff = await latestGraphMrHandoff(deps.store, design.id)
      if (!handoff) return null
      const frozen = await deps.commands.basis(design.id, handoff.basisId)
      const current = await deps.commands.document(design.id)
      const links = (await deps.store.links(design.id))
        .filter((link) => link.kind === 'trace' || link.kind === 'evidence')
        .map((link) => JSON.parse(link.payloadJson) as Record<string, unknown>)
      const staleIds = staleGraphReads(current, frozen.basis.readSet)
      const payload = {
        basis: frozen.basis,
        reviewReceiptId: handoff.reviewReceiptId,
        staleIds,
        traces: links.filter((link) => link.candidateTreeOid !== undefined && link.blobOid),
        evidence: links.filter((link) => link.basisDigest === frozen.basis.digest),
        instructions: [
          'Repair the code against this approved basis and its exact tests. Existing evidence is historical until the platform re-verifies the new candidate tree.',
          'Preserve the approved scope, original decisions, trace paths and test names. If the request changes behavior or invalidates the basis, request graph clarification and a new native design review before implementation.',
          'The platform reruns graph verification before every MR publication, including conflict repair. A prompt claim or an old green report cannot satisfy this gate.',
        ],
      }
      // Evidence can grow between rounds; the content digest makes each frozen material immutable.
      const materialDirectory = `.agent-workflow/inputs/requirements/${stableIdentityComponent(input.caseId)}/graph-design/${graphDigest(payload)}`
      const material: GraphMrRepairMaterial = {
        basisId: frozen.basis.id,
        basisDigest: frozen.basis.digest,
        materialDirectory,
        summary: staleIds.length
          ? '设计已变化，修复需先回到图设计澄清和审核。'
          : '按已批准的图设计修复；候选内容变化后必须重新验证。',
        files: [
          { path: 'care.json', content: canonicalJson(payload) },
          ...frozen.basis.files.map((file) => ({ path: file.path, content: file.content })),
        ],
      }
      if (materialId) {
        const record = await deps.commands.beginRecord(design.id, materialId, 'mr-material', {
          caseId: input.caseId,
          roundRef: input.roundRef,
          basisDigest: handoff.basisDigest,
        })
        await deps.commands.finishRecord(record, 'completed', material)
      }
      return material
    },
    async beforePublish(input: GraphMrBeforePublishInput): Promise<GraphMrPublicationVerdict> {
      const design = await deps.store.findByCase(input.caseId)
      if (!design) return { ok: true }
      const handoff = await latestGraphMrHandoff(deps.store, design.id)
      if (!handoff)
        return {
          ok: false,
          code: 'graph-mr-handoff-missing',
          detail: '图候选尚未交接到 MR 交付流程。',
        }
      const approved = await validateGraphMrBasis(handoff, deps)
      if (!approved.ok) return approved
      const current = await deps.persistence.currentWorkspace(input.caseId)
      if (!current)
        return { ok: false, code: 'graph-mr-workspace-missing', detail: 'MR 修复工作区不可用。' }
      const contentBaseline = await baseline(handoff, input.baselineRepoPath, input.baselineSha)
      if (contentBaseline.kind === 'unborn')
        return {
          ok: false,
          code: 'graph-mr-target-unborn',
          detail:
            '空仓候选已保留；创建 MR 需要有真实提交的目标分支。请先初始化目标分支，再从该分支新建图研发任务。',
        }
      const checked = await deps.verification.run({
        designId: design.id,
        // A publication round replays only its own exact tree. New repair rounds create fresh evidence.
        roundRef: `mr:${graphDigest({ roundRef: input.roundRef, tree: input.expectedTreeOid, baseline: input.baselineSha, basis: handoff.basisDigest })}`,
        implementationRoundRef: handoff.implementationRoundRef,
        expectedBasisDigest: handoff.basisDigest,
        expectedCandidateTreeOid: input.expectedTreeOid,
        workspace: {
          workspacePath: input.workspacePath,
          baselineRepoPath: input.baselineRepoPath,
          baseline: contentBaseline,
          uploadPlan: handoff.workspace.uploadPlan,
          uploadsAlreadyPublished: current.row.state === 'published',
          targetBranch: current.row.targetBranch,
        },
      })
      if (!checked.passed || checked.candidateTreeOid !== input.expectedTreeOid)
        return {
          ok: false,
          code: 'graph-mr-verification-required',
          detail: `当前 MR 候选尚未通过图设计验证：${checked.limitations.join('；') || '候选内容不一致'}`,
        }
      return { ok: true }
    },
  }
}

export type GraphMrCare = ReturnType<typeof createGraphMrCare>
