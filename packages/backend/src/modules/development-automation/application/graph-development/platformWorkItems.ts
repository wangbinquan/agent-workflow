import {
  canonicalJson,
  repositoryMaterializationCommit,
  utf16MaxLength,
} from '@agent-workflow/shared'
import { z } from 'zod'
import type { CandidateDeliveryParticipant } from '@/modules/source-control/public/types'
import { graphDigest } from '../../domain/graph-development/model'
import { graphToolResultSchema, graphResultSchemas } from './toolContracts'
import type { GraphDesignCommands } from './designCommands'
import type { GraphDesignArtifacts } from '../ports/graphDesignArtifacts'
import type { GraphDesignStore } from '../ports/graphDesignStore'
import type { GraphVerificationWorkspace, createGraphVerification } from './verification'
import type { GraphEmployeeContext } from './employeeCodec'
import { GraphReactionPlanSchema, graphWork } from './reactionMaterial'

interface GraphDeliveryInput {
  work: GraphEmployeeContext
  roundRef: string
  workspace: GraphVerificationWorkspace
  verification: {
    candidate: { candidateRef: string; treeOid: string }
    basisId: string
    basisDigest: string
    implementationRoundRef: string
  }
  deliveryContent: { commitMessage: string; title: string; description: string }
}
interface GraphDeliveryResult {
  issueState: unknown
  candidateState: unknown
  artifactRefs: readonly string[]
}
function inputContexts(inputEnvelopeJson: string) {
  const envelope = z.object({ contextsJson: z.string() }).parse(JSON.parse(inputEnvelopeJson))
  return z
    .array(z.object({ typeId: z.string(), stateJson: z.string() }))
    .parse(JSON.parse(envelope.contextsJson))
}
function issueDeliveryContent(inputEnvelopeJson: string) {
  const issue = inputContexts(inputEnvelopeJson).find(
    (context) => context.typeId === 'development.issue-handling',
  )
  if (!issue) return null
  let state: unknown
  try {
    state = JSON.parse(issue.stateJson)
  } catch {
    return null
  }
  const parsed = z
    .object({
      deliveryContent: z
        .object({
          commitMessage: z.string().trim().min(1).check(utf16MaxLength(5_000)),
          mergeRequestTitle: z.string().trim().min(1).check(utf16MaxLength(240)),
          mergeRequestDescription: z.string().trim().min(1).check(utf16MaxLength(32_000)),
        })
        .strict(),
    })
    .safeParse(state)
  if (!parsed.success) return null
  const content = parsed.data.deliveryContent
  return {
    commitMessage: content.commitMessage,
    title: content.mergeRequestTitle,
    description: content.mergeRequestDescription,
  }
}
function publishedContext(inputEnvelopeJson: string) {
  const contexts = inputContexts(inputEnvelopeJson)
  const state = (typeId: string) => {
    const value = contexts.find((context) => context.typeId === typeId)
    return value ? (JSON.parse(value.stateJson) as unknown) : null
  }
  const candidate = z
    .object({
      status: z.literal('published'),
      candidateRef: z.string(),
      commitSha: z.string(),
    })
    .safeParse(state('development.change-candidate'))
  const mr = z
    .object({
      status: z.literal('active'),
      headSha: z.string(),
      repositoryRef: z.string(),
      sourceBranch: z.string(),
      targetBranch: z.string(),
    })
    .safeParse(state('development.merge-request'))
  const issue = contexts.find((context) => context.typeId === 'development.issue-handling')
  if (!candidate.success || !mr.success || !issue || candidate.data.commitSha !== mr.data.headSha)
    return null
  return {
    candidateRef: candidate.data.candidateRef,
    commitSha: candidate.data.commitSha,
    repositoryRef: mr.data.repositoryRef,
    sourceBranch: mr.data.sourceBranch,
    targetBranch: mr.data.targetBranch,
    issueStateJson: issue.stateJson,
  }
}

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
  mergeRequestDelivery?: {
    prepareHandoff(input: GraphDeliveryInput & { commitSha: string }): Promise<GraphDeliveryResult>
    resumeHandoff?(
      input: GraphDeliveryInput & { commitSha: string },
    ): Promise<GraphDeliveryResult | null>
    verificationWorkspace?(
      input: Pick<GraphDeliveryInput, 'work' | 'workspace'> & {
        published: ReturnType<typeof publishedContext>
      },
    ): Promise<GraphVerificationWorkspace>
    reusePublished?(
      input: GraphDeliveryInput & {
        published: ReturnType<typeof publishedContext>
      },
    ): Promise<{ commitSha: string; delivery: GraphDeliveryResult } | null>
  }
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
        const workspace = await deps.workspace.state(work.designId)
        const verificationWorkspace =
          work.request.deliveryMode === 'merge-request'
            ? ((await deps.mergeRequestDelivery?.verificationWorkspace?.({
                work,
                workspace,
                published: publishedContext(plan.inputEnvelopeJson),
              })) ?? workspace)
            : workspace
        result = await deps.verification.run({
          designId: work.designId,
          roundRef: plan.roundRef,
          workspace: verificationWorkspace,
        })
        summary = graphResultSchemas['verify-change'].parse(result).passed
          ? '候选校验已通过。'
          : '候选存在失败或未完成的验收项。'
      } else if (plan.workItemRef === 'deliver-result') {
        const records = await deps.store.records(work.designId)
        const verification = records
          .filter((row) => row.kind === 'verification' && row.status === 'completed')
          .sort((a, b) => b.createdAt - a.createdAt)[0]
        if (!verification) throw new Error('graph-delivery-verification-missing')
        const value = JSON.parse(verification.payloadJson) as {
          candidate: { treeOid: string; candidateRef: string; baselineSnapshotRef?: string }
          basisId: string
          basisDigest: string
          implementationRoundRef: string
          result: unknown
        }
        if (!graphResultSchemas['verify-change'].parse(value.result).passed)
          throw new Error('graph-delivery-verification-not-passed')
        let deliveryId = `delivery:${graphDigest({ basis: value.basisDigest, candidate: value.candidate })}`
        const delivered = (await deps.store.links(work.designId)).find(
          (link) => link.id === deliveryId,
        )
        if (delivered && work.request.deliveryMode !== 'merge-request') {
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
        let deliveryContent = output.deliveryContent
        if (work.request.deliveryMode === 'merge-request') {
          const redelivery = records.some((row) => {
            if (row.kind !== 'mr-handoff' || row.status !== 'completed') return false
            const { handoff } = JSON.parse(row.payloadJson) as {
              handoff: { implementationRoundRef: string; candidateRef: string }
            }
            return (
              handoff.implementationRoundRef === value.implementationRoundRef &&
              handoff.candidateRef !== value.candidate.candidateRef
            )
          })
          if (redelivery)
            deliveryContent = issueDeliveryContent(plan.inputEnvelopeJson) ?? deliveryContent
          // A retry keeps the content selected for this exact verification, even
          // if care has since advanced its issue context or omitted it on replay.
          const saved = (await deps.store.links(work.designId))
            .filter((link) => link.kind === 'execution' && link.id.startsWith('delivery:'))
            .map(
              (link) =>
                JSON.parse(link.payloadJson) as {
                  verificationRef?: string
                  implementationRoundRef?: string
                  candidate?: { candidateRef: string }
                  deliveryContent?: GraphDeliveryInput['deliveryContent']
                },
            )
            .find(
              (link) =>
                link.verificationRef === verification.id &&
                link.implementationRoundRef === value.implementationRoundRef &&
                link.candidate?.candidateRef === value.candidate.candidateRef,
            )
          deliveryContent = saved?.deliveryContent ?? deliveryContent
        }
        const workspace = await deps.workspace.state(work.designId)
        const deliveryInput: GraphDeliveryInput = {
          work,
          roundRef: plan.roundRef,
          workspace,
          verification: value,
          deliveryContent,
        }
        const reused =
          work.request.deliveryMode === 'merge-request'
            ? ((await deps.mergeRequestDelivery?.reusePublished?.({
                ...deliveryInput,
                published: publishedContext(plan.inputEnvelopeJson),
              })) ?? null)
            : null
        if (delivered && !reused && work.request.deliveryMode === 'merge-request') {
          const saved = JSON.parse(delivered.payloadJson) as {
            result: { commitSha: string | null }
          }
          if (
            saved.result.commitSha &&
            (await deps.mergeRequestDelivery?.resumeHandoff?.({
              ...deliveryInput,
              commitSha: saved.result.commitSha,
            }))
          )
            return JSON.stringify(
              graphToolResultSchema(plan.workItemRef).parse({
                summary: '设计、候选提交与验证证据已交付。',
                result: saved.result,
              }),
            )
        }
        if (work.request.deliveryMode === 'merge-request') {
          // Reverification produces a fresh evidence receipt even when its published
          // business tree is unchanged. Include publication inputs in replay identity.
          deliveryId = `delivery:${graphDigest({
            basis: value.basisDigest,
            candidate: value.candidate,
            verification: verification.id,
            request: work.request,
            deliveryContent,
            targetBranch: workspace.targetBranch ?? null,
            uploadPlan: workspace.uploadPlan ?? null,
          })}`
          const previous = (await deps.store.links(work.designId)).find(
            (link) => link.id === deliveryId,
          )
          if (previous) {
            const saved = JSON.parse(previous.payloadJson) as {
              result: { commitSha: string | null }
            }
            const resumed =
              reused?.delivery ??
              (saved.result.commitSha
                ? await deps.mergeRequestDelivery?.resumeHandoff?.({
                    ...deliveryInput,
                    commitSha: saved.result.commitSha,
                  })
                : null)
            if (!resumed) throw new Error('graph-mr-delivery-replay-mismatch')
            return JSON.stringify(
              graphToolResultSchema(plan.workItemRef).parse({
                summary: '设计、候选提交与验证证据已交付。',
                result: saved.result,
              }),
            )
          }
        }
        if (
          work.request.deliveryMode === 'merge-request' &&
          !reused &&
          value.candidate.baselineSnapshotRef &&
          value.candidate.baselineSnapshotRef !==
            `git:${repositoryMaterializationCommit(workspace.baseline)}` &&
          workspace.baseline.kind === 'commit'
        )
          throw new Error(
            'graph-mr-candidate-baseline-changed: 当前发布 head 与验证候选的父基线不一致；请重新准备并验证候选后交付。',
          )
        const commit = reused
          ? { ok: true as const, commitSha: reused.commitSha, localRef: '' }
          : await deps.candidates.commit({
              baselineRepoPath: workspace.baselineRepoPath,
              baselineSha: repositoryMaterializationCommit(workspace.baseline),
              repositoryBaseline: workspace.baseline,
              overlayRoot: workspace.workspacePath,
              uploadPlan: workspace.uploadPlan,
              expectedTreeOid: value.candidate.treeOid,
              missionId: `graph-${work.caseId}-${value.basisDigest.slice(0, 12)}`,
              summarySource: deliveryContent.commitMessage,
            })
        if (!commit.ok) throw new Error(`${commit.code}: ${commit.detail}`)
        let publication: {
          remoteRef: string
          oldSha: string | null
          newSha: string
          publication: unknown
        } | null = null
        if (work.request.publicationBranch && work.request.deliveryMode !== 'merge-request') {
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
        const mergeRequestDelivery =
          reused?.delivery ??
          (work.request.deliveryMode === 'merge-request'
            ? await (() => {
                if (!deps.mergeRequestDelivery) throw new Error('graph-mr-delivery-binding-missing')
                return deps.mergeRequestDelivery.prepareHandoff({
                  ...deliveryInput,
                  commitSha: commit.commitSha,
                })
              })()
            : null)
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
                mergeRequestDelivery
                  ? '候选已交给 MR 提交与持续看护流程；MR 创建、CI 与外部合入仍待各自回执。'
                  : publication
                    ? '远端发布已完成；CI 与部署需另有实际回执。'
                    : '该回执记录内部候选提交；未配置远端发布和部署。',
              ],
            }),
          },
        ])
        result = {
          artifactRefs: [
            ...new Set([
              basis.artifact.artifactRef,
              artifact.artifactRef,
              ...(mergeRequestDelivery?.artifactRefs ?? []),
            ]),
          ],
          commitSha: commit.commitSha,
          publication: publication?.remoteRef ?? null,
          ...(mergeRequestDelivery
            ? {
                mergeRequestDelivery: {
                  issueStateJson: canonicalJson(mergeRequestDelivery.issueState),
                  candidateStateJson: canonicalJson(mergeRequestDelivery.candidateState),
                },
              }
            : {}),
        }
        await deps.store.insertLink({
          designId: work.designId,
          id: deliveryId,
          kind: 'execution',
          payloadJson: canonicalJson({
            kind: 'delivery',
            commitSha: commit.commitSha,
            candidate: value.candidate,
            implementationRoundRef: value.implementationRoundRef,
            verificationRef: verification.id,
            deliveryContent,
            artifact,
            publication,
            result,
          }),
          createdAt: Date.now(),
        })
        summary = reused
          ? '新的图验证已记录，代码与发布输入未变化，继续观察现有 MR。'
          : mergeRequestDelivery
            ? '候选与图验证已就绪，继续提交 MR 并持续看护。'
            : '设计、候选提交与验证证据已交付。'
      } else throw new Error('graph-platform-work-item-unknown')
      return JSON.stringify(graphToolResultSchema(plan.workItemRef).parse({ summary, result }))
    },
  }
}
