import { z } from 'zod'
import { ClarifyDecisionSchema } from './clarifyDecision'
import { RepositoryContentBaselineSchema } from './repositoryContentBaseline'
import { ArtifactElementAnchorSchema } from './artifactElementAnchor'

const id = z.string().min(1).max(200)
const revision = z.number().int().positive()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const text = z.string().max(20_000)
const ids = z.array(id)
const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()])

export const GraphContentRefSchema = z.object({ id, revision, digest }).strict()
export type GraphContentRef = z.infer<typeof GraphContentRefSchema>

export const GraphSourceSchema = z.discriminatedUnion('kind', [
  z.object({ id, kind: z.literal('material'), artifactRef: id, digest, label: text }).strict(),
  z
    .object({
      id,
      kind: z.literal('code'),
      repositoryId: id,
      commitSha: id,
      path: id,
      blobOid: id,
      symbol: text.optional(),
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal('clarify'),
      taskId: id,
      roundId: id,
      questionId: id,
      confirmedBasis: z.string().max(128).nullable(),
      originalAnswer: text,
      answer: z
        .object({
          selectedOptionIndices: z.array(z.number().int().nonnegative()),
          selectedOptionLabels: z.array(z.string()),
          customText: z.string(),
        })
        .strict()
        .optional(),
      decision: ClarifyDecisionSchema.optional(),
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal('review'),
      taskId: id,
      nodeRunId: id,
      receiptId: id,
      basisDigest: digest,
      decision: z.enum(['approved', 'rejected', 'iterated']),
    })
    .strict(),
  z.object({ id, kind: z.literal('model'), invocationRef: id, materialDigest: digest }).strict(),
  z.object({ id, kind: z.literal('evidence'), artifactRef: id, digest }).strict(),
])
export type GraphSource = z.infer<typeof GraphSourceSchema>

export const GraphConcernSchema = z
  .object({
    id,
    revision,
    statement: text.min(1),
    purpose: z.enum(['understand', 'decide', 'implement', 'verify']),
    priority: z.enum(['required', 'important', 'optional']),
    disposition: z.enum(['open', 'addressed', 'deferred', 'out-of-scope']),
    sourceIds: ids,
    resolutionIds: ids,
    dispositionReason: text.optional(),
  })
  .strict()
export type GraphConcern = z.infer<typeof GraphConcernSchema>

const element = { id, revision, label: text.min(1), description: text, sourceIds: ids }
export const GraphElementSchema = z.discriminatedUnion('kind', [
  z.object({ ...element, kind: z.literal('requirement'), obligationIds: ids }).strict(),
  z
    .object({ ...element, kind: z.literal('decision'), decision: ClarifyDecisionSchema.optional() })
    .strict(),
  z.object({ ...element, kind: z.literal('assumption'), condition: text, unknowns: text }).strict(),
  z
    .object({
      ...element,
      kind: z.literal('entity'),
      fields: z.array(
        z
          .object({
            name: id,
            type: id,
            key: z.enum(['primary', 'foreign', 'none']),
            required: z.boolean(),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      ...element,
      kind: z.literal('behavior'),
      role: z.enum(['actor', 'step', 'state', 'action']),
    })
    .strict(),
  z
    .object({
      ...element,
      kind: z.literal('interface'),
      inputs: text,
      outputs: text,
      failures: text,
    })
    .strict(),
  z
    .object({ ...element, kind: z.literal('scenario'), given: text, when: text, then: text })
    .strict(),
  z.object({ ...element, kind: z.literal('constraint'), expression: text }).strict(),
])
export type GraphElement = z.infer<typeof GraphElementSchema>

export const GraphRelationSchema = z
  .object({
    id,
    revision,
    from: id,
    to: id,
    kind: z.enum([
      'containment',
      'depends-on',
      'implements',
      'verifies',
      'related-to',
      'flow',
      'message',
      'transition',
      'data-reference',
    ]),
    label: text,
    condition: text.optional(),
    sourceIds: ids,
  })
  .strict()
export type GraphRelation = z.infer<typeof GraphRelationSchema>

export const GraphPredicateSchema = z
  .object({
    field: id,
    operator: z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'exists']),
    value: z.union([scalar, z.array(scalar)]).optional(),
  })
  .strict()
export type GraphPredicate = z.infer<typeof GraphPredicateSchema>
const model = { id, revision, label: text, sourceIds: ids }
export const GraphSubmodelSchema = z.discriminatedUnion('kind', [
  z.object({ ...model, kind: z.literal('flow'), elementIds: ids, relationIds: ids }).strict(),
  z
    .object({
      ...model,
      kind: z.literal('sequence'),
      participantIds: ids,
      messageIds: ids,
      fragments: z.array(
        z
          .object({
            id,
            kind: z.enum(['sequence', 'parallel', 'alternative', 'loop']),
            messageIds: ids,
            condition: text,
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      ...model,
      kind: z.literal('state'),
      stateIds: ids,
      initialStateId: id,
      terminalStateIds: ids,
      transitions: z.array(
        z
          .object({
            relationId: id,
            event: id,
            guards: z.array(GraphPredicateSchema),
            actionRef: id.nullable(),
            assertionRefs: ids,
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      ...model,
      kind: z.literal('data'),
      entityIds: ids,
      relationships: z.array(
        z
          .object({
            relationId: id,
            cardinality: z.enum(['one-one', 'one-many', 'many-many']),
            required: z.boolean(),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      ...model,
      kind: z.literal('decision-table'),
      inputFields: ids,
      rows: z.array(
        z
          .object({
            id,
            ruleId: id,
            priority: z.number().int(),
            conditions: z.array(GraphPredicateSchema),
            output: z.record(scalar),
            assertionRefs: ids,
          })
          .strict(),
      ),
      resolution: z.enum(['unique', 'first-priority', 'collect']),
    })
    .strict(),
])
export type GraphSubmodel = z.infer<typeof GraphSubmodelSchema>
export type GraphCapabilityKind = GraphSubmodel['kind']

export const GraphViewSpecSchema = z
  .object({
    id,
    revision,
    title: text.min(1),
    purpose: text.min(1),
    concernIds: ids,
    capabilityRef: z.object({ id, version: revision }).strict(),
    modelIds: ids,
    elementIds: ids,
    relationIds: ids,
    sourceIds: ids,
    status: z.enum(['current', 'needs-update', 'archived']),
    pinned: z.boolean(),
    explanation: text,
    limitations: z.array(text),
  })
  .strict()
export type GraphViewSpec = z.infer<typeof GraphViewSpecSchema>

export const GraphBehaviorCheckSchema = z
  .object({
    modelId: id,
    programRef: z.string().startsWith('repo:').max(1000),
    inputs: z.array(z.record(scalar)).min(1).max(100),
    depth: z.number().int().min(1).max(100),
    paths: z.number().int().min(1).max(200),
    timeoutMs: z.number().int().min(100).max(300_000),
  })
  .strict()
export type GraphBehaviorCheck = z.infer<typeof GraphBehaviorCheckSchema>

export const GraphObligationSchema = z
  .object({
    id,
    revision,
    statement: text.min(1),
    elementIds: ids,
    concernIds: ids,
    verification: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('execution'),
          profileRef: z.object({ id, revision, digest }).strict(),
          testRefs: ids,
          modelCheck: GraphBehaviorCheckSchema.optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('manual'),
          instructions: text.min(1),
          owner: text.nullable(),
          when: text.nullable(),
        })
        .strict(),
      z.object({ kind: z.literal('unassigned'), reason: text }).strict(),
    ]),
  })
  .strict()
export type GraphObligation = z.infer<typeof GraphObligationSchema>

export const GraphDesignDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    caseId: id,
    revision,
    title: text.min(1),
    goals: z.array(text),
    repositoryId: id,
    repositoryBaseline: RepositoryContentBaselineSchema.nullable(),
    concerns: z.array(GraphConcernSchema),
    elements: z.array(GraphElementSchema),
    relations: z.array(GraphRelationSchema),
    models: z.array(GraphSubmodelSchema),
    views: z.array(GraphViewSpecSchema),
    sources: z.array(GraphSourceSchema),
    obligations: z.array(GraphObligationSchema),
  })
  .strict()
export type GraphDesignDocument = z.infer<typeof GraphDesignDocumentSchema>

export const GraphViewProposalSchema = z
  .object({
    id,
    title: text.min(1),
    purpose: text.min(1),
    capabilityRef: z.object({ id, version: revision }).strict(),
    coverage: z.array(
      z
        .object({ concernId: id, contribution: z.number().min(0).max(1), explanation: text })
        .strict(),
    ),
    modelIds: ids,
    elementIds: ids,
    relationIds: ids,
    sourceIds: ids,
    readingCost: z.number().positive().max(10_000),
    generationCost: z.number().nonnegative().max(10_000),
    rationale: text,
    limitations: z.array(text),
    replaces: ids,
  })
  .strict()
export type GraphViewProposal = z.infer<typeof GraphViewProposalSchema>

export const GraphViewPlanSchema = z
  .object({
    policyVersion: z.union([z.literal(1), z.literal(2)]),
    catalogVersion: z.literal(1),
    readSet: z.array(GraphContentRefSchema),
    selectedIds: ids,
    uncoveredConcernIds: ids,
    overBudget: z.boolean(),
    candidates: z.array(GraphViewProposalSchema),
    decisions: z.array(
      z
        .object({
          candidateId: id,
          selected: z.boolean(),
          reason: text,
          marginalValue: z.number().finite(),
        })
        .strict(),
    ),
  })
  .strict()
export type GraphViewPlan = z.infer<typeof GraphViewPlanSchema>

export const GraphProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    designId: id,
    requestId: id,
    kind: z.enum(['intake', 'clarification', 'semantic-change', 'view-plan', 'code-feedback']),
    readSet: z.array(GraphContentRefSchema),
    invocationRef: id.nullable(),
    status: z.enum(['proposed', 'accepted', 'stale', 'rejected']),
    explanation: text,
    document: GraphDesignDocumentSchema,
    plan: GraphViewPlanSchema.nullable(),
    createdAt: z.number().int(),
  })
  .strict()
export type GraphProposal = z.infer<typeof GraphProposalSchema>

export const GraphImplementationBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    designRef: GraphContentRefSchema,
    document: GraphDesignDocumentSchema,
    includedElementIds: ids,
    excludedElementIds: ids,
    obligationIds: ids,
    readSet: z.array(GraphContentRefSchema),
    toolContractVersion: z.literal(1),
    files: z.array(z.object({ path: id, mediaType: id, content: z.string(), digest }).strict()),
    digest,
    createdAt: z.number().int(),
  })
  .strict()
export type GraphImplementationBasis = z.infer<typeof GraphImplementationBasisSchema>

export const GraphTraceLinkSchema = z
  .object({
    id,
    elementId: id,
    obligationId: id.nullable(),
    candidateTreeOid: id,
    path: z.string().min(1).max(1000),
    blobOid: id,
    symbol: text.nullable(),
    testRef: text.nullable(),
    status: z.enum(['proposed', 'reference-checked', 'coverage-reviewed']),
    reason: text,
  })
  .strict()
export type GraphTraceLink = z.infer<typeof GraphTraceLinkSchema>

export const GraphEvidenceBindingSchema = z
  .object({
    id,
    kind: z.enum(['structure', 'design-review', 'execution', 'acceptance']),
    basisDigest: digest,
    obligationIds: ids,
    readSet: z.array(GraphContentRefSchema),
    candidateTreeOid: id.nullable(),
    commitSha: id.nullable(),
    profileRef: z.object({ id, revision, digest }).strict().nullable(),
    environmentDigest: digest.nullable(),
    executionRef: id.nullable(),
    artifactRef: id.nullable(),
    artifactDigest: digest.nullable(),
    ci: z
      .object({ workflow: id, sha: id, runId: id, jobId: id.nullable(), step: text.nullable() })
      .strict()
      .nullable(),
    result: z.enum(['passed', 'failed', 'not-run', 'inconclusive']),
    summary: text,
    limitations: z.array(text),
    recordedAt: z.number().int(),
  })
  .strict()
export type GraphEvidenceBinding = z.infer<typeof GraphEvidenceBindingSchema>

export const GraphAnchorSchema = ArtifactElementAnchorSchema
export type GraphAnchor = z.infer<typeof GraphAnchorSchema>

export const GraphDesignActionRequestSchema = z
  .object({
    requestId: id,
    expectedRevision: revision,
    action: z.enum(['explain', 'replan', 'update-view', 'inspect-exceptions', 'compare-options']),
    instruction: text,
    anchor: GraphAnchorSchema.nullable(),
  })
  .strict()
export type GraphDesignActionRequest = z.infer<typeof GraphDesignActionRequestSchema>

export const GraphPresentationSchema = z
  .object({
    viewId: id,
    revision,
    collapsedIds: ids,
    positions: z.record(z.object({ x: z.number().finite(), y: z.number().finite() }).strict()),
    viewport: z
      .object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().positive() })
      .strict(),
  })
  .strict()
export type GraphPresentation = z.infer<typeof GraphPresentationSchema>
