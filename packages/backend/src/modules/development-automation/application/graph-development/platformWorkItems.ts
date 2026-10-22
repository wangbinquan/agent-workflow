import { canonicalJson, repositoryMaterializationCommit } from '@agent-workflow/shared'
import type { CandidateDeliveryParticipant } from '@/modules/source-control/public/types'
import { graphDigest } from '../../domain/graph-development/model'
import {
  graphToolResultSchema,
  graphResultSchemas,
} from '../../domain/graph-development/toolContracts'
import type { GraphDesignCommands } from './designCommands'
import type { GraphDesignArtifacts } from '../ports/graphDesignArtifacts'
import type { GraphDesignStore } from '../ports/graphDesignStore'
import type { GraphVerificationWorkspace, createGraphVerification } from './verification'
import type { GraphEmployeeContext } from '../../domain/graph-development/employeeCodec'
import { GraphReactionPlanSchema, graphWork } from './reactionMaterial'

export function createGraphPlatformWorkItems(deps: {
  commands: GraphDesignCommands
  store: GraphDesignStore
  artifacts: GraphDesignArtifacts
  workspace: {
    initialize(work: GraphEmployeeContext): Promise<GraphVerificationWorkspace>
    state(designId: string): Promise<GraphVerificationWorkspace>
  }
  verification: ReturnType<typeof createGraphVerification>
  candidates: CandidateDeliveryParticipant
  publication?: { remoteUrl(repositoryId: string): Promise<string> }
}) {
  return {
    async execute(
      rawPlan: unknown,
      context?: {
        publicationSubject: NonNullable<
          Parameters<CandidateDeliveryParticipant['push']>[0]['publicationSubject']
        >
      },
    ) {
      const plan = GraphReactionPlanSchema.parse(rawPlan),
        work = graphWork(plan)
      let result: unknown
      let summary: string
      if (plan.workItemRef === 'understand-request') {
        const original = await deps.artifacts.put([
          { path: 'request.md', content: work.request.body ?? '' },
          { path: 'uploads.json', content: canonicalJson(work.request.uploads) },
          {
            path: 'delivery-policy.json',
            content: canonicalJson({ publicationBranch: work.request.publicationBranch ?? null }),
          },
        ])
        const document = await deps.commands.ensure({
          id: work.designId,
          caseId: work.caseId,
          repositoryId: work.repositoryId,
          title: (work.request.body?.split('\n')[0] || '研发设计').slice(0, 200),
          body: (work.request.body ?? '请读取参考材料').slice(0, 20_000),
          materialSources: [
            {
              id: 'request-material',
              kind: 'material',
              artifactRef: original.artifactRef,
              digest: original.digest,
              label: '完整原始需求与参考材料清单',
            },
          ],
        })
        await deps.workspace.initialize(work)
        result = { designId: document.id, revision: document.revision }
        summary = '已保存完整需求材料并确定仓库基线。'
      } else if (plan.workItemRef === 'verify-change') {
        result = await deps.verification.run({
          designId: work.designId,
          roundRef: plan.roundRef,
          workspace: await deps.workspace.state(work.designId),
        })
        summary = graphResultSchemas['verify-change'].parse(result).passed
          ? '候选校验已通过。'
          : '候选存在失败或未完成的验收项。'
      } else if (plan.workItemRef === 'deliver-result') {
        const verification = (await deps.store.records(work.designId))
          .filter((row) => row.kind === 'verification' && row.status === 'completed')
          .sort((a, b) => b.createdAt - a.createdAt)[0]
        if (!verification) throw new Error('graph-delivery-verification-missing')
        const value = JSON.parse(verification.payloadJson) as {
          candidate: { treeOid: string; candidateRef: string }
          basisId: string
          basisDigest: string
          implementationRoundRef: string
          result: unknown
        }
        if (!graphResultSchemas['verify-change'].parse(value.result).passed)
          throw new Error('graph-delivery-verification-not-passed')
        const deliveryId = `delivery:${graphDigest({ basis: value.basisDigest, candidate: value.candidate })}`
        const delivered = (await deps.store.links(work.designId)).find(
          (link) => link.id === deliveryId,
        )
        if (delivered) {
          const saved = JSON.parse(delivered.payloadJson) as { result: unknown }
          return JSON.stringify(
            graphToolResultSchema(plan.workItemRef).parse({
              summary: '设计、候选提交与验证证据已交付。',
              result: saved.result,
            }),
          )
        }
        const implementation = (await deps.store.links(work.designId)).find(
          (link) => link.id === `implementation:${value.implementationRoundRef}`,
        )
        if (!implementation) throw new Error('graph-delivery-implementation-missing')
        const output = graphResultSchemas['implement-change'].parse(
          (JSON.parse(implementation.payloadJson) as { result: unknown }).result,
        )
        const workspace = await deps.workspace.state(work.designId)
        const commit = await deps.candidates.commit({
          baselineRepoPath: workspace.baselineRepoPath,
          baselineSha: repositoryMaterializationCommit(workspace.baseline),
          repositoryBaseline: workspace.baseline,
          overlayRoot: workspace.workspacePath,
          uploadPlan: workspace.uploadPlan,
          expectedTreeOid: value.candidate.treeOid,
          missionId: `graph-${work.caseId}-${value.basisDigest.slice(0, 12)}`,
          summarySource: output.deliveryContent.commitMessage,
        })
        if (!commit.ok) throw new Error(`${commit.code}: ${commit.detail}`)
        let publication: {
          remoteRef: string
          oldSha: string | null
          newSha: string
          publication: unknown
        } | null = null
        if (work.request.publicationBranch) {
          if (!deps.publication || !context?.publicationSubject)
            throw new Error('graph-publication-binding-missing')
          const published = await deps.candidates.push({
            baselineRepoPath: workspace.baselineRepoPath,
            baselineSha: repositoryMaterializationCommit(workspace.baseline),
            repositoryBaseline: workspace.baseline,
            commitSha: commit.commitSha,
            expectedTreeOid: value.candidate.treeOid,
            remoteUrl: await deps.publication.remoteUrl(work.repositoryId),
            branch: work.request.publicationBranch,
            expectedRemoteSha:
              workspace.baseline.kind === 'commit' &&
              work.request.publicationBranch === workspace.targetBranch
                ? workspace.baseline.commitSha
                : null,
            publicationSubject: context.publicationSubject,
          })
          if (!published.ok) throw new Error(`${published.code}: ${published.detail}`)
          const { reused: _reused, ...receipt } = published.receipt
          publication = receipt
        }
        const basis = await deps.commands.basis(work.designId, value.basisId)
        const links = await deps.store.links(work.designId)
        const artifact = await deps.artifacts.put([
          {
            path: 'delivery.json',
            content: canonicalJson({
              caseId: work.caseId,
              designId: work.designId,
              basis: { id: value.basisId, digest: value.basisDigest, artifact: basis.artifact },
              candidate: value.candidate,
              verification: value.result,
              commit: { commitSha: commit.commitSha, localRef: commit.localRef },
              publication,
              evidence: links
                .filter((link) => ['trace', 'evidence'].includes(link.kind))
                .map((link) => JSON.parse(link.payloadJson)),
              limitations: [
                publication
                  ? '远端发布已完成；CI 与部署需另有实际回执。'
                  : '该回执记录内部候选提交；未配置远端发布和部署。',
              ],
            }),
          },
        ])
        result = {
          artifactRefs: [basis.artifact.artifactRef, artifact.artifactRef],
          commitSha: commit.commitSha,
          publication: publication?.remoteRef ?? null,
        }
        await deps.store.insertLink({
          designId: work.designId,
          id: deliveryId,
          kind: 'execution',
          payloadJson: canonicalJson({
            kind: 'delivery',
            commitSha: commit.commitSha,
            candidate: value.candidate,
            artifact,
            publication,
            result,
          }),
          createdAt: Date.now(),
        })
        summary = '设计、候选提交与验证证据已交付。'
      } else throw new Error('graph-platform-work-item-unknown')
      return JSON.stringify(graphToolResultSchema(plan.workItemRef).parse({ summary, result }))
    },
  }
}
