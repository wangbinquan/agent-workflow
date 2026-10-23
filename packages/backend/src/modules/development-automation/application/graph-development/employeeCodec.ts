import { z } from 'zod'
import type {
  EmployeeTypeContextCodec,
  EmployeeTypeReactionCodec,
  EmployeeTypeCollaborationCodec,
} from '@/modules/digital-employee/public/types'
import { GRAPH_CONTEXT_TYPE, GRAPH_EMPLOYEE_TYPE, GraphEmployeeScopeSchema } from './employeeType'
import { graphResultSchemas, graphToolResultSchema, type GraphWorkItem } from './toolContracts'

const id = z.string().min(1).max(200)
export const GraphEmployeeContextSchema = z
  .object({
    caseId: id,
    designId: id,
    repositoryId: id,
    request: z
      .object({
        body: z.string().nullable(),
        kind: z.enum(['body', 'files', 'body-and-files']),
        targetBranch: z.string().nullable(),
        publicationBranch: z.string().nullable().optional(),
        deliveryMode: z.enum(['internal-candidate', 'merge-request']).optional(),
        uploads: z.array(
          z
            .object({
              artifactRef: id,
              sha256: z.string(),
              originalName: z.string(),
              placement: z.enum(['temporary', 'repository']),
              targetPath: z.string().nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
    consumedRevision: z.number().int().nonnegative(),
    basisId: id.nullable(),
    basisDigest: z.string().nullable(),
    reviewReceiptId: id.nullable(),
    reviewDecision: z.enum(['approved', 'rejected', 'iterated']).nullable(),
    candidateRef: id.nullable(),
    candidateTreeOid: id.nullable(),
    evidenceIds: z.array(id),
    result: z.enum([
      'designing',
      'awaiting-request',
      'implemented',
      'verification-failed',
      'verified',
      'delivered',
      'monitoring',
    ]),
  })
  .strict()
export type GraphEmployeeContext = z.infer<typeof GraphEmployeeContextSchema>
const contextsSchema = z.array(
  z
    .object({
      id,
      typeId: id,
      revision: z.number().int().positive(),
      stateJson: z.string(),
      artifactRefs: z.array(z.string()).default([]),
    })
    .passthrough(),
)
export function graphContext(json: string) {
  const record = contextsSchema
    .parse(JSON.parse(json))
    .find((value) => value.typeId === GRAPH_CONTEXT_TYPE)
  if (!record) throw new Error('graph-context-missing')
  return { record, value: GraphEmployeeContextSchema.parse(JSON.parse(record.stateJson)) }
}
function workItem(value: unknown): GraphWorkItem {
  if (typeof value !== 'string' || !(value in graphResultSchemas))
    throw new Error('graph-work-item-unknown')
  return value as GraphWorkItem
}
const normalizedOutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    roundRef: id,
    executionNonce: z.string(),
    status: z.enum(['ok', 'needs-input', 'blocked']),
    summary: z.string(),
    contextPatches: z.array(
      z
        .object({
          contextId: id.nullable(),
          contextTypeId: id,
          schemaVersion: z.literal(1),
          expectedRevision: z.number().int().positive().nullable(),
          lifecycleState: z.enum(['active', 'waiting', 'terminal']),
          stateJson: z.string(),
          artifactRefs: z.array(z.string()),
        })
        .strict(),
    ),
    effectSuggestions: z.array(z.string()),
    artifactRefs: z.array(z.string()),
  })
  .strict()

export const graphEmployeeRuntimeCodec: EmployeeTypeContextCodec &
  EmployeeTypeReactionCodec &
  EmployeeTypeCollaborationCodec = {
  typeId: GRAPH_EMPLOYEE_TYPE.typeId,
  buildInitialCaseJson(json) {
    const request = z
      .object({
        caseRef: id,
        employeeRef: z.object({ id, revision: z.number() }),
        workScopeJson: z.string(),
        intake: z
          .object({
            target: z.record(z.string()),
            kind: z.enum(['body', 'files', 'body-and-files']),
            body: z.string().nullable(),
            typeOptions: z.record(z.string()).default({}),
            uploads: z.array(
              z
                .object({
                  blobRef: z.string(),
                  sha256: z.string(),
                  originalName: z.string(),
                  placement: z.enum(['temporary', 'repository']),
                  targetPath: z.string().nullable(),
                })
                .passthrough(),
            ),
          })
          .passthrough(),
      })
      .passthrough()
      .parse(JSON.parse(json))
    const scope = GraphEmployeeScopeSchema.parse(JSON.parse(request.workScopeJson))
    const repositoryId =
      scope.kind === 'repository' ? scope.repositoryId : request.intake.target.repositoryId
    if (
      !repositoryId ||
      (scope.kind === 'repository' &&
        request.intake.target.repositoryId &&
        request.intake.target.repositoryId !== repositoryId)
    )
      throw new Error('graph-intake-repository-outside-scope')
    const uploads = request.intake.uploads.map((upload) => ({
      artifactRef: `employee-input:${upload.blobRef}`,
      sha256: upload.sha256,
      originalName: upload.originalName,
      placement: upload.placement,
      targetPath: upload.targetPath,
    }))
    const value: GraphEmployeeContext = {
      caseId: request.caseRef,
      designId: `design:${request.caseRef}`,
      repositoryId,
      request: {
        body: request.intake.body,
        kind: request.intake.kind,
        targetBranch: request.intake.typeOptions['working-branch'] || null,
        publicationBranch: request.intake.typeOptions['publication-branch'] || null,
        uploads,
      },
      consumedRevision: 0,
      basisId: null,
      basisDigest: null,
      reviewReceiptId: null,
      reviewDecision: null,
      candidateRef: null,
      candidateTreeOid: null,
      evidenceIds: [],
      result: 'designing',
    }
    return JSON.stringify({
      employeeRef: request.employeeRef,
      primaryContextTypeId: GRAPH_CONTEXT_TYPE,
      primaryContextSchemaVersion: 1,
      primaryContextState: 'active',
      primaryContextJson: JSON.stringify(GraphEmployeeContextSchema.parse(value)),
      artifactRefs: uploads.map((upload) => upload.artifactRef),
      workSubject: { typeId: 'graph-development.case', subjectRef: request.caseRef },
    })
  },
  validateContextJson(typeId, json) {
    if (typeId !== GRAPH_CONTEXT_TYPE) throw new Error('graph-context-type-unknown')
    return JSON.stringify(GraphEmployeeContextSchema.parse(JSON.parse(json)))
  },
  resolveExternalSubjectBindingsJson() {
    return '[]'
  },
  resolveAttentionSubjectsJson(typeId, json) {
    if (typeId !== GRAPH_CONTEXT_TYPE) return '[]'
    const value = GraphEmployeeContextSchema.parse(JSON.parse(json))
    if (value.result === 'delivered') return '[]'
    return JSON.stringify(
      ['review', 'implementation', 'clarification', 'verification'].map((kind) => ({
        eventTypeRef: { id: `graph-development.${kind}-requested`, revision: 1 },
        subject: { typeId: 'graph-development.case', subjectRef: value.caseId },
      })),
    )
  },
  selectReactionToolSlotJson(json) {
    const request = z.object({ defaultSlotRef: z.string() }).passthrough().parse(JSON.parse(json))
    return JSON.stringify({ slotRef: request.defaultSlotRef })
  },
  assembleReactionInputJson(json) {
    const request = z
      .object({
        schemaVersion: z.literal(1),
        roundRef: id,
        executionNonce: z.string(),
        workItemRef: id,
        toolSlotRef: id,
        connectionRef: z.unknown().nullable().default(null),
        inputSchemaId: id,
        outputSchemaId: id,
        eventJson: z.string(),
        contextsJson: z.string(),
      })
      .passthrough()
      .parse(JSON.parse(json))
    const { value } = graphContext(request.contextsJson)
    workItem(request.workItemRef)
    return JSON.stringify({
      schemaVersion: 1,
      roundRef: request.roundRef,
      executionNonce: request.executionNonce,
      workItemRef: request.workItemRef,
      toolSlotRef: request.toolSlotRef,
      connectionRef: request.connectionRef,
      inputSchemaId: request.inputSchemaId,
      outputSchemaId: request.outputSchemaId,
      eventJson: request.eventJson,
      contextsJson: request.contextsJson,
      contractInput: { work: value, materials: {} },
      artifactRefs: value.request.uploads.map((upload) => upload.artifactRef),
      executionEnvironmentJson: JSON.stringify({ kind: 'scratch' }),
      humanReview: null,
    })
  },
  validateReactionOutputJson(json) {
    const request = z
      .object({ workItemRef: id, inputEnvelopeJson: z.string(), outputJson: z.string() })
      .passthrough()
      .parse(JSON.parse(json))
    const envelope = z
      .object({ roundRef: id, executionNonce: z.string(), contextsJson: z.string() })
      .passthrough()
      .parse(JSON.parse(request.inputEnvelopeJson))
    const item = workItem(request.workItemRef)
    const raw = z
      .object({
        schemaVersion: z.literal(1),
        roundRef: id,
        executionNonce: z.string(),
        directResult: z.unknown(),
      })
      .strict()
      .parse(JSON.parse(request.outputJson))
    if (raw.roundRef !== envelope.roundRef || raw.executionNonce !== envelope.executionNonce)
      throw new Error('graph-output-invocation-mismatch')
    const result = graphToolResultSchema(item).parse(raw.directResult)
    const { record, value } = graphContext(envelope.contextsJson)
    let state: GraphEmployeeContext = value
    let status: 'ok' | 'needs-input' | 'blocked' = 'ok'
    let artifactRefs = record.artifactRefs
    const deliveryPatches: z.infer<typeof normalizedOutputSchema>['contextPatches'] = []
    switch (item) {
      case 'understand-request': {
        const data = graphResultSchemas[item].parse(result.result)
        if (data.designId !== value.designId) throw new Error('graph-output-design-mismatch')
        state = { ...value, consumedRevision: data.revision }
        break
      }
      case 'design-and-clarify': {
        const data = graphResultSchemas[item].parse(result.result)
        if (data.document.id !== value.designId || data.document.caseId !== value.caseId)
          throw new Error('graph-output-design-mismatch')
        state = { ...value, consumedRevision: data.document.revision, result: 'awaiting-request' }
        status = 'needs-input'
        break
      }
      case 'review-design': {
        const data = graphResultSchemas[item].parse(result.result)
        state = {
          ...value,
          basisId: data.basisId,
          basisDigest: data.basisDigest,
          reviewReceiptId: data.receipt.receiptId,
          reviewDecision: data.receipt.decision,
          result: 'awaiting-request',
        }
        status = 'needs-input'
        break
      }
      case 'implement-change':
        state = { ...value, result: 'implemented' }
        break
      case 'verify-change': {
        const data = graphResultSchemas[item].parse(result.result)
        state = {
          ...value,
          candidateRef: data.candidateRef,
          candidateTreeOid: data.candidateTreeOid,
          evidenceIds: data.evidenceIds,
          result: data.passed ? 'verified' : 'verification-failed',
        }
        status = data.passed ? 'ok' : 'blocked'
        break
      }
      case 'deliver-result': {
        const data = graphResultSchemas[item].parse(result.result)
        const mrDelivery = value.request.deliveryMode === 'merge-request'
        if (mrDelivery && !data.mergeRequestDelivery)
          throw new Error('graph-mr-delivery-handoff-missing')
        state = { ...value, result: mrDelivery ? 'monitoring' : 'delivered' }
        if (mrDelivery) {
          const contexts = contextsSchema.parse(JSON.parse(envelope.contextsJson))
          for (const [typeId, stateJson] of [
            ['development.issue-handling', data.mergeRequestDelivery!.issueStateJson],
            ['development.change-candidate', data.mergeRequestDelivery!.candidateStateJson],
          ] as const) {
            const current = contexts.find((context) => context.typeId === typeId)
            deliveryPatches.push({
              contextId: current?.id ?? null,
              contextTypeId: typeId,
              schemaVersion: 1,
              expectedRevision: current?.revision ?? null,
              lifecycleState: 'active',
              stateJson,
              artifactRefs: data.artifactRefs,
            })
          }
        }
        artifactRefs = [...new Set([...artifactRefs, ...data.artifactRefs])]
        break
      }
    }
    return JSON.stringify(
      normalizedOutputSchema.parse({
        schemaVersion: 1,
        roundRef: envelope.roundRef,
        executionNonce: envelope.executionNonce,
        status,
        summary: result.summary,
        contextPatches: [
          {
            contextId: record.id,
            contextTypeId: GRAPH_CONTEXT_TYPE,
            schemaVersion: 1,
            expectedRevision: record.revision,
            lifecycleState:
              state.result === 'delivered'
                ? 'terminal'
                : status === 'needs-input'
                  ? 'waiting'
                  : 'active',
            stateJson: JSON.stringify(state),
            artifactRefs,
          },
          ...deliveryPatches,
        ],
        effectSuggestions: [],
        artifactRefs,
      }),
    )
  },
  resolveReactionSettlementJson(json) {
    const request = z
      .object({ workItemRef: id, outputJson: z.string(), allowedNextWorkItemRefs: z.array(id) })
      .passthrough()
      .parse(JSON.parse(json))
    const output = normalizedOutputSchema.parse(JSON.parse(request.outputJson))
    const graphPatch = output.contextPatches.find(
      (patch) => patch.contextTypeId === GRAPH_CONTEXT_TYPE,
    )
    const terminal =
      request.workItemRef === 'deliver-result' &&
      output.status === 'ok' &&
      graphPatch !== undefined &&
      GraphEmployeeContextSchema.parse(JSON.parse(graphPatch.stateJson)).result === 'delivered'
    const next =
      output.status === 'ok' && !terminal ? (request.allowedNextWorkItemRefs[0] ?? null) : null
    return JSON.stringify({
      schemaVersion: 1,
      caseState: terminal
        ? 'terminal'
        : output.status === 'blocked'
          ? 'blocked'
          : output.status === 'needs-input' || next === null
            ? 'waiting'
            : 'active',
      terminalKind: terminal ? 'graph-development.delivered' : null,
      blockReason: output.status === 'blocked' ? output.summary.slice(0, 2000) : null,
      nextWorkItemRef: next,
      summary: output.summary,
      contextPatches: output.contextPatches,
      effectSuggestions: [],
      artifactRefs: output.artifactRefs,
    })
  },
  buildInvokedCaseJson() {
    throw new Error('graph-development-does-not-declare-invocation-contracts')
  },
  buildInvocationStartedOutputJson() {
    throw new Error('graph-development-does-not-declare-invocation-contracts')
  },
  buildInvocationResultOutputJson() {
    throw new Error('graph-development-does-not-declare-invocation-contracts')
  },
}
