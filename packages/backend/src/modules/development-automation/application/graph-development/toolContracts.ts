import { z } from 'zod'
import { GraphDesignDocumentSchema, GraphViewProposalSchema } from '@agent-workflow/shared'
import type { ExecutionContractRegistration } from '@/modules/execution-contract/public/types'
import { GRAPH_WORK_CONTRACTS, GRAPH_WORK_ITEMS, graphText as text } from './employeeType'

const id = z.string().min(1).max(200)
/** Semantic requirements supplement the JSON shape in every frozen work material. */
export const GRAPH_DESIGN_AUTHORING_RULES = [
  'Use only the provided schema kinds and capability versions. Keep every referenced ID declared in its owning collection.',
  'A decision element may omit its optional decision property. Omit it for model assumptions and whenever no matching committed clarify source is available; even status=unmarked requires a matching source. The platform imports actual human answers, maturity, notes and confirmedBasis.',
  'Each decision-table rows[].ruleId must identify a declared element, for example a behavior element with role=action. A row ID alone does not declare an element; the schema has no rule element kind.',
  'Candidate costs use the supplied planningBudget units. Offer a useful affordable combination and expose uncovered concerns; do not assume the model-recommended combination will be selected. Keep candidate material concise and avoid unnecessary semantic objects.',
  'Candidate coverage may reference only declared concerns whose disposition is not out-of-scope. Describe excluded behavior as a limitation instead of claiming coverage for it; one excluded concern invalidates that candidate.',
  'Coverage of the same concern is not additive across views. Describe independently answerable questions as distinct concerns; repeating partial coverage in another renderer does not complete a concern.',
  'Execution obligation testRefs and implementation testRefs must be exact repository-relative test paths, optionally followed by #test-name, such as src/normalize.test.ts#invalid-data. Do not use repo: or planned: prefixes or :: separators for testRefs; repo: is for the verification profile programRef. A runner script alone is not a test.',
  'Implementation limitations block automatic delivery. Report every unmet requirement in the approved scope; never omit a real gap to pass. Put approved scope boundaries, provisional decisions and unknown responsibility in summary. Existing manual obligations and platform profile execution remain pending in their own verification flow; do not claim they passed or misreport them as missing implementation.',
  'Code traces must reference actual business candidate files. Platform material under .agent-workflow is excluded from the candidate. An ownership assumption with no code implementation belongs to manual acceptance; do not invent a code trace for it.',
  'A provisional decision or unknown owner does not prove implementation or verification impossible. Bind concrete behavior obligations to an actual execution profile or an explicit manual check; retain responsibility gaps separately and use unassigned only when the verification itself is unresolved.',
] as const
export const GraphReviewDecisionOutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    receiptId: id,
    taskId: id,
    nodeRunId: id,
    decision: z.enum(['approved', 'rejected', 'iterated']),
    decidedAt: z.number().int(),
    reviewIteration: z.number().int(),
    reason: z.string(),
    documents: z
      .array(
        z
          .object({
            docVersionId: id,
            sourceNodeId: id,
            sourcePortName: id,
            contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
export const GraphTraceProposalSchema = z
  .object({
    elementId: id,
    obligationId: id.nullable(),
    path: z.string().min(1).max(1000),
    symbol: z.string().max(2000).nullable(),
    testRef: z.string().max(2000).nullable(),
    reason: z.string().max(5000),
  })
  .strict()
export const graphResultSchemas = {
  'understand-request': z.object({ designId: id, revision: z.number().int().positive() }).strict(),
  'design-and-clarify': z
    .object({
      document: GraphDesignDocumentSchema,
      candidates: z.array(GraphViewProposalSchema).max(80),
    })
    .strict(),
  'review-design': z
    .object({
      basisId: id,
      basisDigest: z.string().regex(/^[a-f0-9]{64}$/),
      receipt: GraphReviewDecisionOutputSchema,
    })
    .strict(),
  'implement-change': z
    .object({
      traceProposals: z.array(GraphTraceProposalSchema),
      testRefs: z.array(z.string().min(1)),
      limitations: z.array(z.string()),
      deliveryContent: z
        .object({
          commitMessage: z.string().min(1),
          title: z.string().min(1),
          description: z.string(),
        })
        .strict(),
    })
    .strict(),
  'verify-change': z
    .object({
      candidateRef: id.nullable(),
      candidateTreeOid: id.nullable(),
      evidenceIds: z.array(id),
      passed: z.boolean(),
      limitations: z.array(z.string()),
    })
    .strict(),
  'deliver-result': z
    .object({
      artifactRefs: z.array(id),
      commitSha: id.nullable(),
      publication: z.string().nullable(),
      mergeRequestDelivery: z
        .object({ issueStateJson: z.string(), candidateStateJson: z.string() })
        .strict()
        .optional(),
    })
    .strict(),
} as const
export type GraphWorkItem = keyof typeof graphResultSchemas
export function graphToolResultSchema(workItem: GraphWorkItem) {
  return z
    .object({ summary: z.string().min(1).max(5000), result: graphResultSchemas[workItem] })
    .strict()
}

const field = (path: string, valueType: 'object' | 'string') => ({
  path,
  label: text(path, path),
  description: text(
    path === 'materials' ? '平台冻结并准备的设计材料、依据与来源' : '合同业务字段',
    path === 'materials'
      ? 'Platform-frozen design material, basis and sources'
      : 'Contract business field',
  ),
  valueType,
  required: true,
  source: 'work-input' as const,
  condition: null,
  example: null,
})

export const graphExecutionContractRegistrations: readonly ExecutionContractRegistration[] =
  GRAPH_WORK_CONTRACTS.map((contract) => {
    const item = GRAPH_WORK_ITEMS.find(
      (work) => contract.contractId === `graph-development.${work.id}`,
    )!
    const instruction = text(
      '读取完整材料及来源，按声明的业务合同返回 JSON。人的决定与原回答必须逐字保留。',
      'Read all material and sources; return JSON matching the business contract. Preserve human decisions and original answers exactly.',
    )
    const transport = {
      inputLocation: 'Workflow / Agent input · prompt',
      outputLocation: 'agent-result',
      outputPort: 'agent-result',
      inputInstruction: instruction,
      outputInstruction: instruction,
    }
    const guide = {
      schemaVersion: 1,
      inputMode: 'direct-json',
      outputMode: 'direct-json',
      contractRef: { contractId: contract.contractId, version: 1 },
      displayName: item.label,
      description: item.description,
      input: {
        schemaId: contract.inputSchemaId,
        displayName: item.label,
        description: item.description,
        topLevelFields: ['work', 'materials'],
        primaryFieldPaths: ['materials'],
        fields: [field('work', 'object'), field('materials', 'object')],
        exampleJson: JSON.stringify({ work: {}, materials: {} }),
      },
      output: {
        schemaId: contract.outputSchemaId,
        displayName: item.label,
        description: item.description,
        topLevelFields: ['summary', 'result'],
        primaryFieldPaths: ['summary'],
        fields: [field('summary', 'string'), field('result', 'object')],
        exampleJson: JSON.stringify({
          summary: 'Completed work with explicit limitations',
          result: {},
        }),
      },
      allowedExecutorKinds: item.executors,
      transports: {
        agent: item.executors.includes('agent') ? transport : null,
        workflow: item.executors.includes('workflow') ? transport : null,
        program: item.executors.includes('program')
          ? { ...transport, inputLocation: 'DIGITAL_EMPLOYEE_INPUT_JSON', outputLocation: 'stdout' }
          : null,
      },
    }
    return {
      contractRef: guide.contractRef,
      guideJson: JSON.stringify(guide),
      workflowHumanGates:
        item.id === 'design-and-clarify'
          ? ['clarify', 'clarify-cross-agent']
          : item.id === 'review-design'
            ? ['review']
            : [],
      projectInputJson(input) {
        const envelope = z
          .object({ contractInput: z.object({ work: z.record(z.unknown()) }).passthrough() })
          .passthrough()
          .parse(JSON.parse(input.inputEnvelopeJson))
        const projection = z
          .object({ materials: z.record(z.unknown()) })
          .parse(JSON.parse(input.projectionJson ?? '{"materials":{}}'))
        return JSON.stringify({
          work: envelope.contractInput.work,
          materials: projection.materials,
        })
      },
      validateOutputJson: (json) =>
        JSON.stringify(graphToolResultSchema(item.id).parse(JSON.parse(json))),
    }
  })
