import { z } from 'zod'
import { graphContext } from './employeeCodec'
import { GRAPH_EMPLOYEE_TYPE } from './employeeType'
import type { GraphDesignCommands } from './designCommands'
import type { GraphDesignStore } from '../ports/graphDesignStore'
import type { GraphDesignArtifacts, GraphArtifactReference } from '../ports/graphDesignArtifacts'

export const GraphReactionPlanSchema = z
  .object({
    roundRef: z.string(),
    executionNonce: z.string(),
    caseRef: z.object({ id: z.string() }).passthrough(),
    employeeTypeRef: z.object({ typeId: z.string(), revision: z.number() }),
    workItemRef: z.enum([
      'understand-request',
      'design-and-clarify',
      'review-design',
      'implement-change',
      'verify-change',
      'deliver-result',
    ]),
    inputEnvelopeJson: z.string(),
    triggeringEventRef: z.string().optional(),
  })
  .passthrough()
export type GraphReactionPlan = z.infer<typeof GraphReactionPlanSchema>
export function isGraphPlan(json: string) {
  const parsed = GraphReactionPlanSchema.safeParse(JSON.parse(json))
  return parsed.success && parsed.data.employeeTypeRef.typeId === GRAPH_EMPLOYEE_TYPE.typeId
}
export function graphWork(plan: GraphReactionPlan) {
  const envelope = z
    .object({ contextsJson: z.string(), eventJson: z.string().optional() })
    .passthrough()
    .parse(JSON.parse(plan.inputEnvelopeJson))
  const { value } = graphContext(envelope.contextsJson)
  if (value.caseId !== plan.caseRef.id) throw new Error('graph-work-case-mismatch')
  return value
}

/** Resolve the accepted request through its exact Event Center payload reference. */
export async function graphReactionMaterial(
  plan: GraphReactionPlan,
  deps: { commands: GraphDesignCommands; store: GraphDesignStore; artifacts: GraphDesignArtifacts },
) {
  const work = graphWork(plan)
  const document = await deps.commands.document(work.designId)
  const envelope = JSON.parse(plan.inputEnvelopeJson) as { eventJson: string }
  const event = envelope.eventJson
    ? (JSON.parse(envelope.eventJson) as { eventId?: string; payloadArtifactRef?: string | null })
    : {}
  let request: Record<string, unknown> | null = null
  let basis: Awaited<ReturnType<GraphDesignCommands['basis']>> | null = null
  if (
    ['review-design', 'implement-change', 'design-and-clarify'].includes(plan.workItemRef) &&
    event.payloadArtifactRef
  ) {
    const requestRecord = (await deps.store.records(work.designId)).find((record) => {
      if (
        !['review', 'implementation', 'clarification'].includes(record.kind) ||
        !['prepared', 'accepted'].includes(record.status)
      )
        return false
      const value = JSON.parse(record.payloadJson) as {
        eventId?: string
        payload?: GraphArtifactReference
      }
      return (
        (!value.eventId || value.eventId === (event.eventId ?? plan.triggeringEventRef)) &&
        value.payload?.artifactRef === event.payloadArtifactRef
      )
    })
    if (!requestRecord) throw new Error('graph-request-receipt-missing')
    const receipt = JSON.parse(requestRecord.payloadJson) as { payload: GraphArtifactReference }
    const json = await deps.artifacts.read(receipt.payload, 'request.json')
    if (!json) throw new Error('graph-request-material-missing')
    request = z.record(z.unknown()).parse(JSON.parse(json))
    if (plan.workItemRef !== 'design-and-clarify') {
      const ref = z
        .object({ basisId: z.string(), basisDigest: z.string() })
        .passthrough()
        .parse(request)
      basis = await deps.commands.basis(work.designId, ref.basisId)
      if (basis.basis.digest !== ref.basisDigest) throw new Error('graph-request-basis-mismatch')
      if (plan.workItemRef === 'implement-change') {
        const review = z
          .object({ decision: z.literal('approved'), basisDigest: z.literal(ref.basisDigest) })
          .passthrough()
          .parse(request.review)
        if (!review) throw new Error('graph-request-approval-missing')
      }
    }
  } else if (plan.workItemRef === 'review-design' || plan.workItemRef === 'implement-change')
    throw new Error('graph-explicit-work-request-missing')
  return { work, document, request, basis }
}
