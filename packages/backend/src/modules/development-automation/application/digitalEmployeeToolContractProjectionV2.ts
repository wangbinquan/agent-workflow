import { z } from 'zod'

import { sha256Hex } from '@/util/hash'
import { isLexicallyInsideForHost } from '@/util/platformExec'
import {
  developmentToolInputSchemasV2,
  type DevelopmentToolContractIdV2,
} from '../domain/digitalEmployeeToolContractsV2'

const refSchema = z
  .object({ id: z.string().min(1), revision: z.number().int().positive() })
  .strict()

const contextRecordSchema = z
  .object({
    id: z.string().min(1),
    revision: z.number().int().positive(),
    typeId: z.string().min(1),
    schemaVersion: z.number().int().positive().default(1),
    lifecycleState: z.enum(['active', 'waiting', 'terminal']).default('active'),
    stateJson: z.string().min(2),
    artifactRefs: z.array(z.string()).default([]),
  })
  .passthrough()

const hostEnvelopeSchema = z
  .object({
    connectionRef: refSchema.nullable().default(null),
    contractInput: z.unknown(),
    contextsJson: z.string().min(2),
    platformPaths: z
      .object({
        requirementDirectory: z.string().min(1),
        externalMaterialDirectory: z.string().min(1),
        pipelineDirectory: z.string().min(1),
        implementationPlanPath: z.string().min(1),
      })
      .passthrough(),
    humanReview: z.unknown().nullable().default(null),
  })
  .passthrough()

const issueStateSchema = z
  .object({
    repositoryRef: z.string().min(1),
    request: z.object({ externalId: z.string().min(1).nullable() }).passthrough(),
    deliveryContent: z
      .object({
        commitMessage: z.string().min(1),
        mergeRequestTitle: z.string().min(1),
        mergeRequestDescription: z.string().min(1),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .passthrough()

const mergeRequestStateSchema = z
  .object({
    mergeRequestRef: z.string().min(1),
    headSha: z.string().min(1),
    targetSha: z.string().min(1).nullable().default(null),
  })
  .passthrough()

const pipelineCheckStateSchema = z
  .object({
    checkRef: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(['queued', 'running', 'passed', 'failed', 'canceled', 'skipped']),
    summary: z.string().min(1).optional(),
    evidenceFiles: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()

const pipelineStateSchema = z
  .object({
    status: z.enum(['pending', 'passed', 'failed']),
    mergeRequestRef: z.string().min(1),
    headSha: z.string().min(1),
    targetSha: z.string().min(1).nullable().default(null),
    checks: z.array(pipelineCheckStateSchema).default([]),
  })
  .passthrough()

const reviewThreadStateSchema = z
  .object({
    threadRef: z.string().min(1),
    revision: z.string().min(1),
    authorClass: z.enum(['human', 'bot', 'self']),
    body: z.string(),
    path: z.string().min(1).nullable(),
    messages: z
      .array(
        z
          .object({
            authorClass: z.enum(['human', 'bot', 'self']),
            body: z.string(),
            path: z.string().min(1).nullable(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough()

const problemSetStateSchema = z
  .object({
    source: z.enum(['review', 'pipeline']),
    headSha: z.string().min(1).nullable(),
    problems: z.array(
      z
        .object({
          problemId: z.string().min(1),
          type: z.string().min(1),
          summary: z.string().min(1),
          evidenceArtifactRefs: z.array(z.string().min(1)).default([]),
          reviewThread: reviewThreadStateSchema.nullable().default(null),
        })
        .passthrough(),
    ),
  })
  .passthrough()

const failureTypeDefinitionsSchema = z
  .array(
    z
      .object({
        typeId: z.string().min(1),
        name: z.string().min(1),
        description: z.string(),
        fallback: z.boolean(),
      })
      .passthrough(),
  )
  .min(1)

const directResultEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    roundRef: z.string().min(1),
    executionNonce: z.string().regex(/^[a-f0-9]{64}$/),
    directResult: z.record(z.string(), z.unknown()),
  })
  .strict()

function parseHost(inputEnvelopeJson: string) {
  const envelope = hostEnvelopeSchema.parse(JSON.parse(inputEnvelopeJson) as unknown)
  const contexts = z.array(contextRecordSchema).parse(JSON.parse(envelope.contextsJson) as unknown)
  const context = (typeId: string) => contexts.find((candidate) => candidate.typeId === typeId)
  const state = <T>(typeId: string, schema: z.ZodType<T>): T | null => {
    const current = context(typeId)
    return current === undefined ? null : schema.parse(JSON.parse(current.stateJson) as unknown)
  }
  return { envelope, contexts, context, state }
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message)
  return value
}

export function projectDevelopmentToolInputV2(input: {
  readonly contractId: DevelopmentToolContractIdV2
  readonly inputEnvelopeJson: string
  readonly projectionJson?: string | null
}): string {
  const host = parseHost(input.inputEnvelopeJson)
  const contractInput = z.record(z.string(), z.unknown()).parse(host.envelope.contractInput)
  let candidate: unknown
  switch (input.contractId) {
    case 'development.prepare-materials': {
      const workRequest = z
        .object({ externalId: z.string().min(1).nullable() })
        .passthrough()
        .parse(contractInput.workRequest)
      candidate = {
        connection: requireValue(
          host.envelope.connectionRef,
          'prepare-materials requires a requirement-source connection',
        ),
        externalItemId: requireValue(
          workRequest.externalId,
          'prepare-materials requires an external item id',
        ),
        outputDirectory: host.envelope.platformPaths.externalMaterialDirectory,
      }
      break
    }
    case 'development.plan-implementation':
      candidate = {
        requirementsDirectory: host.envelope.platformPaths.requirementDirectory,
        outputFile: host.envelope.platformPaths.implementationPlanPath,
      }
      break
    case 'development.implement-change':
      candidate = {
        requirementsDirectory: host.envelope.platformPaths.requirementDirectory,
        ...(host.envelope.humanReview === null
          ? {}
          : { approvedPlanFile: host.envelope.platformPaths.implementationPlanPath }),
      }
      break
    case 'development.resolve-review-feedback': {
      const problemSet = requireValue(
        host.state('development.problem-set', problemSetStateSchema),
        'review repair requires a problem set',
      )
      if (problemSet.source !== 'review') throw new Error('review repair requires review problems')
      candidate = {
        requirementsDirectory: host.envelope.platformPaths.requirementDirectory,
        threads: problemSet.problems.map((problem) => {
          const thread = requireValue(problem.reviewThread, 'review problem has no thread')
          const threadMessages = thread.messages ?? []
          const messages =
            threadMessages.length === 0
              ? [{ author: thread.authorClass, body: thread.body }]
              : threadMessages.map((message) => ({
                  author: message.authorClass,
                  body: message.body,
                }))
          const file = thread.path ?? threadMessages.find((message) => message.path !== null)?.path
          return {
            threadRef: thread.threadRef,
            ...(file === null || file === undefined ? {} : { file }),
            messages,
          }
        }),
      }
      break
    }
    case 'development.collect-pipeline-status': {
      const mergeRequest = requireValue(
        host.state('development.merge-request', mergeRequestStateSchema),
        'pipeline collection requires a merge request',
      )
      candidate = {
        connection: requireValue(
          host.envelope.connectionRef,
          'pipeline collection requires a pipeline-gate connection',
        ),
        mergeRequest: mergeRequest.mergeRequestRef,
        evidenceDirectory: host.envelope.platformPaths.pipelineDirectory,
      }
      break
    }
    case 'development.classify-pipeline-failures': {
      const pipeline = requireValue(
        host.state('development.pipeline', pipelineStateSchema),
        'pipeline classification requires collected status',
      )
      const definitions = failureTypeDefinitionsSchema.parse(contractInput.failureTypeDefinitions)
      candidate = {
        failedChecks: (pipeline.checks ?? [])
          .filter((check) => check.status === 'failed' || check.status === 'canceled')
          .map((check) => ({
            checkRef: check.checkRef,
            name: check.name,
            ...(check.summary === undefined ? {} : { summary: check.summary }),
            ...(check.evidenceFiles === undefined ? {} : { evidenceFiles: check.evidenceFiles }),
          })),
        categories: definitions.map((definition) => ({
          type: definition.typeId,
          name: definition.name,
          description: definition.description,
        })),
        fallbackType: requireValue(
          definitions.find((definition) => definition.fallback)?.typeId,
          'pipeline classification requires one fallback category',
        ),
      }
      break
    }
    case 'development.repair-pipeline-failures': {
      const problemSet = requireValue(
        host.state('development.problem-set', problemSetStateSchema),
        'pipeline repair requires a problem set',
      )
      const failureType = z.string().min(1).parse(contractInput.assignedFailureType)
      candidate = {
        failureType,
        problems: problemSet.problems
          .filter((problem) => problem.type === failureType)
          .map((problem) => ({
            summary: problem.summary,
            ...((problem.evidenceArtifactRefs ?? []).length === 0
              ? {}
              : { evidenceFiles: problem.evidenceArtifactRefs ?? [] }),
          })),
      }
      break
    }
    case 'development.resolve-merge-conflicts': {
      const mergeRequest = requireValue(
        host.state('development.merge-request', mergeRequestStateSchema),
        'conflict repair requires a merge request',
      )
      const projection = z
        .object({ conflictFiles: z.array(z.string().min(1)).min(1) })
        .passthrough()
        .parse(JSON.parse(input.projectionJson ?? '{}') as unknown)
      candidate = {
        sourceVersion: mergeRequest.headSha,
        targetVersion: requireValue(
          mergeRequest.targetSha,
          'conflict repair requires a target version',
        ),
        conflictFiles: projection.conflictFiles,
        requirementsDirectory: host.envelope.platformPaths.requirementDirectory,
      }
      break
    }
    case 'development.draft-approval': {
      const mergeRequest = requireValue(
        host.state('development.merge-request', mergeRequestStateSchema),
        'approval drafting requires a merge request',
      )
      const pipeline = requireValue(
        host.state('development.pipeline', pipelineStateSchema),
        'approval drafting requires gate conclusions',
      )
      if (pipeline.status === 'pending') {
        throw new Error('approval drafting requires a terminal pipeline conclusion')
      }
      candidate = {
        mergeRequest: mergeRequest.mergeRequestRef,
        currentVersion: mergeRequest.headSha,
        approvalType: 'gate-change',
        gateConclusions: [
          {
            name: 'pipeline',
            conclusion: pipeline.status === 'passed' ? ('passed' as const) : ('failed' as const),
          },
        ],
        formatGuide: '使用 Markdown 简洁说明变更范围、门禁结论、风险和请求审批的事项。',
      }
      break
    }
  }
  const schema = developmentToolInputSchemasV2[input.contractId] as z.ZodType<unknown>
  return JSON.stringify(schema.parse(candidate))
}

function legacyContextPatch(
  current: z.infer<typeof contextRecordSchema> | undefined,
  state: unknown,
) {
  return {
    contextId: current?.id ?? null,
    contextTypeId: current?.typeId ?? '',
    schemaVersion: current?.schemaVersion ?? 1,
    expectedRevision: current?.revision ?? null,
    lifecycleState: current?.lifecycleState ?? 'active',
    stateJson: JSON.stringify(state),
    artifactRefs: current?.artifactRefs ?? [],
  }
}

function legacyBase(
  identity: z.infer<typeof directResultEnvelopeSchema>,
  status: 'ok' | 'blocked',
  summary: string,
) {
  return {
    schemaVersion: 1,
    roundRef: identity.roundRef,
    executionNonce: identity.executionNonce,
    status,
    summary,
    contextPatches: [] as ReturnType<typeof legacyContextPatch>[],
    effectSuggestions: [] as string[],
    artifactRefs: [] as string[],
  }
}

function existingDelivery(host: ReturnType<typeof parseHost>) {
  return requireValue(
    host.state('development.issue-handling', issueStateSchema)?.deliveryContent,
    'repair result requires the existing merge request title and description',
  )
}

export function projectDevelopmentToolResultV2(input: {
  readonly workItemRef: string
  readonly inputEnvelopeJson: string
  readonly connectionRef: { readonly id: string; readonly revision: number } | null
  readonly outputEnvelopeJson: string
}): string {
  const identity = directResultEnvelopeSchema.parse(JSON.parse(input.outputEnvelopeJson) as unknown)
  const host = parseHost(input.inputEnvelopeJson)
  const result = identity.directResult
  if (result.outcome === 'blocked') {
    return JSON.stringify(
      legacyBase(identity, 'blocked', z.string().min(1).parse(result.explanation)),
    )
  }
  if (result.outcome !== 'completed') throw new Error('direct tool result has no outcome')
  const output = legacyBase(identity, 'ok', `completed ${input.workItemRef}`)

  if (input.workItemRef === 'prepare-materials') {
    const issueContext = host.context('development.issue-handling')
    const issue = requireValue(
      host.state('development.issue-handling', issueStateSchema),
      'material preparation requires the issue context',
    )
    output.contextPatches.push(legacyContextPatch(issueContext, issue))
  } else if (input.workItemRef === 'analyze-implement') {
    Object.assign(output, {
      deliveryContent: {
        commitMessage: z.string().min(1).parse(result.commitMessage),
        mergeRequestTitle: z.string().min(1).parse(result.mergeRequestTitle),
        mergeRequestDescription: z.string().min(1).parse(result.mergeRequestDescription),
      },
    })
  } else if (input.workItemRef === 'repair-feedback') {
    const problemSet = requireValue(
      host.state('development.problem-set', problemSetStateSchema),
      'review repair requires a problem set',
    )
    const replies = z
      .array(z.object({ threadRef: z.string().min(1), reply: z.string().min(1) }).strict())
      .parse(result.replies)
    const repliesByRef = new Map(replies.map((reply) => [reply.threadRef, reply.reply] as const))
    const orderedReplies = problemSet.problems.map((problem) => {
      const thread = requireValue(problem.reviewThread, 'review problem has no thread')
      const reply = repliesByRef.get(thread.threadRef)
      if (reply === undefined) throw new Error(`missing reply for ${thread.threadRef}`)
      repliesByRef.delete(thread.threadRef)
      return {
        threadRef: thread.threadRef,
        revision: thread.revision,
        disposition: 'addressed' as const,
        replyBody: reply,
      }
    })
    if (repliesByRef.size !== 0) throw new Error('review result contains an unknown threadRef')
    Object.assign(output, { reviewReplies: orderedReplies })
    if (typeof result.commitMessage === 'string') {
      const delivery = existingDelivery(host)
      Object.assign(output, {
        deliveryContent: { ...delivery, commitMessage: result.commitMessage },
      })
    }
  } else if (input.workItemRef === 'collect-pipeline') {
    const mergeRequest = requireValue(
      host.state('development.merge-request', mergeRequestStateSchema),
      'pipeline collection requires a merge request',
    )
    const collected = z
      .object({
        observedSourceVersion: z.string().min(1),
        observedTargetVersion: z.string().min(1).optional(),
        status: z.enum(['pending', 'passed', 'failed']),
        checks: z.array(pipelineCheckStateSchema),
      })
      .passthrough()
      .parse(result)
    if (collected.observedSourceVersion !== mergeRequest.headSha) {
      throw new Error('pipeline result does not belong to the current source version')
    }
    if (
      collected.observedTargetVersion !== undefined &&
      collected.observedTargetVersion !== mergeRequest.targetSha
    ) {
      throw new Error('pipeline result does not belong to the current target version')
    }
    if (mergeRequest.targetSha === null && collected.status !== 'pending') {
      throw new Error('pipeline result must remain pending while target version is unknown')
    }
    const evidenceDirectory = host.envelope.platformPaths.pipelineDirectory
    for (const file of collected.checks.flatMap((check) => check.evidenceFiles ?? [])) {
      if (!isLexicallyInsideForHost(evidenceDirectory, file)) {
        throw new Error(`pipeline evidence file is outside evidenceDirectory: ${file}`)
      }
    }
    const current = host.context('development.pipeline')
    output.contextPatches.push(
      legacyContextPatch(
        current ?? ({ typeId: 'development.pipeline' } as z.infer<typeof contextRecordSchema>),
        {
          status: collected.status,
          mergeRequestRef: mergeRequest.mergeRequestRef,
          headSha: mergeRequest.headSha,
          targetSha: mergeRequest.targetSha,
          evidenceArtifactRef: evidenceDirectory.concat('/'),
          failureTypes: [],
          checks: collected.checks,
        },
      ),
    )
  } else if (input.workItemRef === 'classify-pipeline') {
    const pipeline = requireValue(
      host.state('development.pipeline', pipelineStateSchema),
      'pipeline classification requires collected checks',
    )
    const configuration = z
      .object({ failureTypeDefinitions: failureTypeDefinitionsSchema })
      .passthrough()
      .parse(host.envelope.contractInput)
    const allowed = new Set(configuration.failureTypeDefinitions.map((item) => item.typeId))
    const failedChecks = (pipeline.checks ?? []).filter(
      (check) => check.status === 'failed' || check.status === 'canceled',
    )
    const failedByRef = new Map(failedChecks.map((check) => [check.checkRef, check] as const))
    const groups = z
      .array(
        z
          .object({ type: z.string().min(1), checkRefs: z.array(z.string().min(1)).min(1) })
          .strict(),
      )
      .parse(result.groups)
    const problems = groups.flatMap((group) => {
      if (!allowed.has(group.type)) throw new Error(`unknown pipeline category: ${group.type}`)
      return group.checkRefs.map((checkRef) => {
        const check = failedByRef.get(checkRef)
        if (check === undefined) throw new Error(`unknown or duplicate failed check: ${checkRef}`)
        failedByRef.delete(checkRef)
        return {
          problemId: check.checkRef,
          type: group.type,
          summary: check.summary ?? check.name,
          evidenceArtifactRefs: check.evidenceFiles ?? [],
          reviewThread: null,
        }
      })
    })
    if (failedByRef.size !== 0)
      throw new Error('every failed check must be classified exactly once')
    const current = host.context('development.problem-set')
    output.contextPatches.push(
      legacyContextPatch(
        current ?? ({ typeId: 'development.problem-set' } as z.infer<typeof contextRecordSchema>),
        {
          status: 'active',
          source: 'pipeline',
          headSha: pipeline.headSha,
          remainingTypes: groups.map((group) => group.type),
          problems,
        },
      ),
    )
  } else if (input.workItemRef === 'repair-pipeline' || input.workItemRef === 'repair-conflict') {
    const delivery = existingDelivery(host)
    Object.assign(output, {
      deliveryContent: {
        ...delivery,
        commitMessage: z.string().min(1).parse(result.commitMessage),
      },
    })
  } else if (input.workItemRef === 'prepare-approval') {
    const mergeRequest = requireValue(
      host.state('development.merge-request', mergeRequestStateSchema),
      'approval drafting requires a merge request',
    )
    const connectionRef = requireValue(
      input.connectionRef,
      'approval drafting requires the platform approval connection',
    )
    const draft = z.string().min(1).parse(result.draft)
    const current = host.context('development.approval')
    output.contextPatches.push(
      legacyContextPatch(
        current ?? ({ typeId: 'development.approval' } as z.infer<typeof contextRecordSchema>),
        {
          status: 'draft',
          mergeRequestRef: mergeRequest.mergeRequestRef,
          headSha: mergeRequest.headSha,
          approvalType: 'gate-change',
          adapterRef: connectionRef,
          validatedDraftRef: `approval-draft:${sha256Hex(draft)}`,
          draft,
          subjectRef: null,
          deadlineAt: null,
          idempotencyKey: null,
          correlationRef: null,
          externalRequestRef: null,
          submittedRevision: null,
          observedRevision: null,
          evidenceRef: null,
        },
      ),
    )
  } else {
    throw new Error(`unsupported v2 development result: ${input.workItemRef}`)
  }
  return JSON.stringify(output)
}
