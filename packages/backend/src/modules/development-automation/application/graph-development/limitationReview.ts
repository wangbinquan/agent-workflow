import {
  canonicalJson,
  GraphEvidenceBindingSchema,
  GraphLimitationReviewRequestSchema,
  type GraphLimitationReviewRequest,
} from '@agent-workflow/shared'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { graphDigest, staleGraphReads } from '../../domain/graph-development/model'
import type { GraphDesignArtifacts } from '../ports/graphDesignArtifacts'
import type { GraphDesignStore } from '../ports/graphDesignStore'
import type { GraphDesignCommands } from './designCommands'
import type { GraphDesignQueries } from './designQueries'
import { graphResultSchemas } from './toolContracts'

export function createGraphLimitationReview(deps: {
  store: GraphDesignStore
  artifacts: GraphDesignArtifacts
  commands: GraphDesignCommands
  queries: GraphDesignQueries
  latestVerification(id: string): Promise<{
    basisDigest: string
    implementationRoundRef: string
    candidate: { treeOid: string }
  } | null>
  currentEvidenceTarget(id: string): Promise<{ candidateTreeOid: string | null }>
  changed?: (caseId: string) => void
}) {
  return async (
    id: string,
    proposalId: string,
    input: GraphLimitationReviewRequest,
    actorUserId: string,
  ) => {
    const parsed = GraphLimitationReviewRequestSchema.safeParse(input)
    if (!parsed.success) throw new ValidationError('graph-request-invalid', parsed.error.message)
    const request = parsed.data
    const recordId = `limitation-review:${request.requestId}`
    const identity = { ...request, proposalId, actorUserId }
    let record = await deps.store.record(id, recordId)
    if (record && record.requestDigest !== graphDigest(identity))
      throw new ConflictError('graph-request-reused-with-different-input', request.requestId)
    if (record?.status === 'completed')
      return GraphEvidenceBindingSchema.parse(JSON.parse(record.payloadJson))
    const stored = await deps.store.record(id, `proposal:${proposalId}`)
    if (!stored) throw new NotFoundError('graph-proposal-not-found', '提案不存在')
    if (record?.status !== 'prepared') {
      const proposal = await deps.queries.proposal(id, proposalId)
      if (proposal.kind !== 'code-feedback')
        throw new ValidationError(
          'graph-limitation-review-proposal-invalid',
          '仅可判定代码反馈提案',
        )
      if (stored.status !== 'proposed')
        throw new ConflictError('graph-proposal-already-decided', proposalId)
      const implementations = (await deps.store.links(id))
        .filter((link) => link.kind === 'execution' && link.id.startsWith('implementation:'))
        .sort((a, b) => b.createdAt - a.createdAt)
      const link = implementations.find(
        (link) => link.id === `implementation:${proposal.invocationRef}`,
      )
      if (!link)
        throw new ValidationError(
          'graph-limitation-review-implementation-missing',
          '实现报告不存在',
        )
      if (implementations[0]?.id !== link.id)
        throw new ConflictError(
          'graph-limitation-review-implementation-not-latest',
          '仅可判定最新实现报告',
        )
      const implementation = JSON.parse(link.payloadJson) as {
        basisId: string
        basisDigest: string
        roundRef: string
        result: unknown
      }
      const { limitations } = graphResultSchemas['implement-change'].parse(implementation.result)
      if (!limitations.length)
        throw new ValidationError('graph-limitation-review-limitations-empty', '实现报告没有限制项')
      const basis = (await deps.commands.basis(id, implementation.basisId)).basis
      const current = await deps.latestVerification(id)
      const document = await deps.commands.document(id)
      if (
        implementation.roundRef !== proposal.invocationRef ||
        implementation.basisDigest !== basis.digest ||
        !current ||
        current.basisDigest !== basis.digest ||
        current.implementationRoundRef !== implementation.roundRef ||
        staleGraphReads(document, basis.readSet).length > 0 ||
        staleGraphReads(document, proposal.readSet).length > 0 ||
        (await deps.currentEvidenceTarget(id)).candidateTreeOid !== current.candidate.treeOid
      )
        throw new ConflictError(
          'graph-limitation-review-candidate-mismatch',
          '实现依据或候选已变化，请重新校验',
        )
      record = await deps.commands.beginRecord(id, recordId, 'limitation-review', identity)
      const artifact = await deps.artifacts.put([
        {
          path: 'limitation-review.json',
          content: canonicalJson({
            ...identity,
            designId: id,
            limitations,
            roundRef: implementation.roundRef,
            basisDigest: basis.digest,
            candidateTreeOid: current.candidate.treeOid,
            recordedAt: record.createdAt,
          }),
        },
      ])
      // The judgment is about this implementation report's texts, not one tree:
      // a care repair of the same round keeps it (the proposal is already
      // rejected, so a tree-bound judgment could never be renewed). The judged
      // tree stays in the artifact.
      const evidence = GraphEvidenceBindingSchema.parse({
        id: recordId,
        kind: 'limitation-review',
        basisDigest: basis.digest,
        obligationIds: [],
        readSet: basis.readSet,
        candidateTreeOid: null,
        commitSha: null,
        profileRef: null,
        environmentDigest: null,
        executionRef: implementation.roundRef,
        artifactRef: artifact.artifactRef,
        artifactDigest: artifact.digest,
        ci: null,
        result: 'passed',
        summary: request.comment,
        limitations,
        recordedAt: record.createdAt,
      })
      record = await deps.commands.finishRecord(record, 'prepared', {
        evidence,
        proposalVersion: stored.version,
      })
    }
    const prepared = JSON.parse(record.payloadJson) as {
      evidence: unknown
      proposalVersion: number
    }
    const evidence = GraphEvidenceBindingSchema.parse(prepared.evidence)
    const payload = JSON.parse(stored.payloadJson) as {
      artifactRef: string
      digest: string
      limitationReviewId?: string
    }
    if (stored.status === 'proposed' && stored.version === prepared.proposalVersion)
      await deps.store.updateRecord(
        {
          ...stored,
          status: 'rejected',
          version: stored.version + 1,
          payloadJson: canonicalJson({ ...payload, limitationReviewId: recordId }),
          updatedAt: record.createdAt,
        },
        stored.version,
      )
    else if (stored.status !== 'rejected' || payload.limitationReviewId !== recordId)
      throw new ConflictError('graph-proposal-already-decided', proposalId)
    await deps.store.insertLink({
      designId: id,
      id: evidence.id,
      kind: 'evidence',
      payloadJson: canonicalJson(evidence),
      createdAt: record.createdAt,
    })
    await deps.commands.finishRecord(record, 'completed', evidence)
    deps.changed?.((await deps.commands.document(id)).caseId)
    return evidence
  }
}
