import { z } from 'zod'
import type { GraphHumanInputFacts, GraphRequestObservation } from '../ports/graphHostFacts'
import { GRAPH_EVENT_SOURCE, GRAPH_CONTEXT_TYPE } from '../../domain/graph-development/employeeType'
import { GraphEmployeeContextSchema } from '../../domain/graph-development/employeeCodec'
import type { GraphDesignCasePort } from '../ports/graphDesignExecution'
import type { GraphDesignArtifacts } from '../ports/graphDesignArtifacts'

const projectionSchema = z
  .object({
    case: z
      .object({
        id: z.string(),
        employeeRef: z.object({ id: z.string() }).passthrough(),
        state: z.enum(['active', 'waiting', 'blocked', 'terminal']),
        currentWorkItemRef: z.string().nullable(),
      })
      .passthrough(),
    contexts: z.array(z.object({ typeId: z.string(), stateJson: z.string() }).passthrough()),
    activeRound: z
      .object({ executionRef: z.string().nullable(), workItemRef: z.string() })
      .passthrough()
      .nullish(),
  })
  .passthrough()
export function createGraphCaseIntake(input: {
  readCase(caseId: string): Promise<{ projectionJson: string }>
  owner(caseId: string): Promise<{ ownerUserId: string | null } | null>
  launchWork(request: {
    employeeId: string
    intake: unknown
    actorUserId: string | null
  }): Promise<{ caseRef: { id: string } }>
  cancelTask(taskId: string): Promise<unknown>
  events: GraphRequestObservation
  humanInputs: GraphHumanInputFacts
  artifacts: GraphDesignArtifacts
}): GraphDesignCasePort {
  async function projection(caseId: string) {
    return projectionSchema.parse(JSON.parse((await input.readCase(caseId)).projectionJson))
  }
  return {
    async inspect(caseId) {
      const value = await projection(caseId)
      const taskId = value.activeRound?.executionRef ?? null
      const rounds = taskId ? await input.humanInputs.clarificationRounds(taskId) : []
      const open = rounds.find((round) => round.status === 'awaiting_human')
      return {
        caseId,
        employeeId: value.case.employeeRef.id,
        state: value.case.state,
        workItemRef: value.activeRound?.workItemRef ?? value.case.currentWorkItemRef,
        executionRef: taskId,
        editableClarify: open ? { taskId: open.taskId, roundId: open.id } : null,
      }
    },
    async requestWork(request) {
      const value = await projection(request.caseId)
      if (value.case.state === 'terminal') throw new Error('graph-case-terminal')
      if (
        request.withdrawReview &&
        value.activeRound?.workItemRef === 'review-design' &&
        value.activeRound.executionRef
      )
        await input.cancelTask(value.activeRound.executionRef)
      const receipt = await input.events.observe({
        sourceRef: GRAPH_EVENT_SOURCE,
        eventTypeRef: { id: `graph-development.${request.kind}-requested`, revision: 1 },
        subject: { typeId: 'graph-development.case', subjectRef: request.caseId },
        occurredAt: Date.now(),
        dedupeKey: `${request.caseId}:${request.kind}:${request.requestId}`,
        summary: `设计工作请求：${request.kind}`,
        payloadArtifactRef: request.payloadRef.artifactRef,
      })
      return {
        eventId: receipt.eventId,
        caseId: request.caseId,
        queued: Boolean(value.activeRound),
      }
    },
    async followOn(request) {
      const value = await projection(request.caseId)
      const context = value.contexts.find((context) => context.typeId === GRAPH_CONTEXT_TYPE)
      if (!context) throw new Error('graph-context-missing')
      const work = GraphEmployeeContextSchema.parse(JSON.parse(context.stateJson))
      const material = await input.artifacts.read(request.artifactRef, 'request.json')
      const owner = await input.owner(request.caseId)
      const launched = await input.launchWork({
        employeeId: value.case.employeeRef.id,
        actorUserId: owner?.ownerUserId ?? null,
        intake: {
          name: `补充澄清：${request.body.trim().slice(0, 80)}`,
          kind: 'body',
          body: `${request.body}\n\n前序设计：${work.designId}\n前序请求材料：${material ?? ''}`,
          target: { repositoryId: work.repositoryId },
          uploads: [],
          advanced: {
            typeOptions: {
              ...(work.request.targetBranch ? { 'working-branch': work.request.targetBranch } : {}),
              ...(work.request.publicationBranch
                ? { 'publication-branch': work.request.publicationBranch }
                : {}),
            },
          },
          executionOptions: {},
          externalId: null,
          idempotencyKey: `graph-follow-on:${request.caseId}:${request.requestId}`,
        },
      })
      return { caseId: launched.caseRef.id }
    },
  }
}
