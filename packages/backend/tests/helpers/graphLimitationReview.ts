import {
  canonicalJson,
  GraphProposalSchema,
  type GraphImplementationBasis,
} from '@agent-workflow/shared'
import {
  graphContentRefs,
  graphDigest,
} from '@/modules/development-automation/domain/graph-development/model'
import { createGraphLimitationReview } from '@/modules/development-automation/application/graph-development/limitationReview'
import type { graphFixture } from './graphDesign'

export async function codeFeedbackProposal(
  f: Awaited<ReturnType<typeof graphFixture>>,
  basis: GraphImplementationBasis,
  roundRef: string,
  limitations: string[],
  kind = 'code-feedback',
) {
  const sourceId = `implementation-source:${roundRef}`
  const document = basis.document
  const proposal = GraphProposalSchema.parse({
    schemaVersion: 1,
    id: `code-feedback:${roundRef}`,
    requestId: `feedback:${roundRef}`,
    designId: document.id,
    kind,
    readSet: graphContentRefs(document),
    invocationRef: roundRef,
    status: 'proposed',
    explanation: 'Implementation report limitations',
    plan: null,
    createdAt: Date.now(),
    document: {
      ...document,
      sources: [
        ...document.sources,
        {
          id: sourceId,
          kind: 'model',
          invocationRef: roundRef,
          materialDigest: graphDigest(limitations),
        },
      ],
      concerns: [
        ...document.concerns,
        ...limitations.map((statement, index) => ({
          id: `implementation-gap:${roundRef}:${index}`,
          revision: 1,
          statement,
          purpose: 'implement',
          priority: 'required',
          disposition: 'open',
          sourceIds: [sourceId],
          resolutionIds: [],
        })),
      ],
    },
  })
  await f.commands.storeProposal(proposal)
  return proposal
}

export function limitationReviewCommand(
  f: Awaited<ReturnType<typeof graphFixture>>,
  options: {
    currentTree?: () => string | null
    changed?: (caseId: string) => void
  } = {},
) {
  async function latestVerification(id: string) {
    const record = (await f.store.records(id))
      .filter((row) => row.kind === 'verification' && row.status === 'completed')
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    return record
      ? (JSON.parse(record.payloadJson) as {
          basisDigest: string
          implementationRoundRef: string
          candidate: { treeOid: string }
        })
      : null
  }
  return createGraphLimitationReview({
    ...f,
    latestVerification,
    currentEvidenceTarget: async (id) => ({
      candidateTreeOid: options.currentTree
        ? options.currentTree()
        : ((await latestVerification(id))?.candidate.treeOid ?? null),
    }),
    changed: options.changed,
  })
}

export async function implementationReport(
  f: Awaited<ReturnType<typeof graphFixture>>,
  basis: GraphImplementationBasis,
  roundRef: string,
  limitations: string[],
  createdAt: number,
) {
  await f.store.insertLink({
    designId: basis.document.id,
    id: `implementation:${roundRef}`,
    kind: 'execution',
    createdAt,
    payloadJson: canonicalJson({
      kind: 'implementation',
      basisId: basis.id,
      basisDigest: basis.digest,
      roundRef,
      result: {
        traceProposals: [],
        testRefs: [],
        limitations,
        deliveryContent: { commitMessage: 'booking', title: 'booking', description: '' },
      },
    }),
  })
}
