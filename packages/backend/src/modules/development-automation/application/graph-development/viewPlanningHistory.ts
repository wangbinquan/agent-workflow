import {
  GraphProposalSchema,
  type GraphDesignDocument,
  type GraphViewPlan,
} from '@agent-workflow/shared'
import { graphContentRefs } from '../../domain/graph-development/model'
import {
  graphViewAssessmentFingerprint,
  graphViewMatchesAssessment,
} from '../../domain/graph-development/selectViews'
import type { GraphDesignArtifacts, GraphArtifactReference } from '../ports/graphDesignArtifacts'
import type { GraphDesignStore } from '../ports/graphDesignStore'

/** Reuse assessments only from accepted artifacts whose actual semantic content still matches. */
export async function readAcceptedGraphViewPlan(input: {
  readonly document: GraphDesignDocument
  readonly store: Pick<GraphDesignStore, 'records'>
  readonly artifacts?: GraphDesignArtifacts
}): Promise<GraphViewPlan | null> {
  if (!input.artifacts) return null
  const records = (await input.store.records(input.document.id))
    .filter((record) => record.kind === 'proposal' && record.status === 'accepted')
    .sort(
      (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id),
    )
  let latest: GraphViewPlan | null = null
  const candidates = new Map<string, GraphViewPlan['candidates'][number]>()
  for (const record of records) {
    let proposal
    try {
      const content = await input.artifacts.read(
        JSON.parse(record.payloadJson) as GraphArtifactReference,
        'proposal.json',
      )
      if (!content) continue
      proposal = GraphProposalSchema.parse(JSON.parse(content))
    } catch {
      // Unavailable historical assessment is unknown coverage, never full coverage.
      continue
    }
    if (!proposal.plan || proposal.document.id !== input.document.id) continue
    latest ??= proposal.plan
    for (const candidate of proposal.plan.candidates) {
      if (candidates.has(candidate.id) || !proposal.plan.selectedIds.includes(candidate.id))
        continue
      const view = input.document.views.find((view) => view.id === candidate.id)
      const assessed = proposal.document.views.find((view) => view.id === candidate.id)
      if (!view || !assessed || !graphViewMatchesAssessment(view, candidate)) continue
      if (
        graphViewAssessmentFingerprint(input.document, view) !==
        graphViewAssessmentFingerprint(proposal.document, assessed)
      )
        continue
      candidates.set(candidate.id, candidate)
    }
  }
  return latest
    ? {
        ...latest,
        readSet: graphContentRefs(input.document),
        candidates: [...candidates.values()],
        selectedIds: [...candidates.keys()],
      }
    : null
}
