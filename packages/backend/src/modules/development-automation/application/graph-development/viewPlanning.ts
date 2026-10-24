import { z } from 'zod'
import { utf16MaxLength } from '@agent-workflow/shared'
import { toInputJsonSchema } from '@/util/zodJsonSchema'
import {
  canonicalJson,
  GraphDesignActionRequestSchema,
  GraphDesignDocumentSchema,
  GraphViewProposalSchema,
  type GraphDesignActionRequest,
  type GraphProposal,
} from '@agent-workflow/shared'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import {
  graphContentRefs,
  graphDigest,
  invalidateGraphViews,
} from '../../domain/graph-development/model'
import { GRAPH_VIEW_CAPABILITIES } from '../../domain/graph-development/viewCapabilities'
import {
  GRAPH_DEFAULT_PLANNING_BUDGET,
  selectGraphViews,
  materializeGraphViewPlan,
  type GraphPlanningBudget,
} from '../../domain/graph-development/selectViews'
import type { GraphDesignCommands } from './designCommands'
import type { GraphDesignAssistPort } from '../ports/graphDesignAssist'
import type { GraphDesignStore, GraphStoredRecord } from '../ports/graphDesignStore'
import { GRAPH_DESIGN_AUTHORING_RULES } from './toolContracts'
import type { GraphDesignArtifacts } from '../ports/graphDesignArtifacts'
import { readAcceptedGraphViewPlan } from './viewPlanningHistory'
import {
  graphPlanningScope,
  mergeGraphPlanningDocument,
} from '../../domain/graph-development/localPlanningScope'

export const GraphAssistOutputSchema = z
  .object({
    document: GraphDesignDocumentSchema,
    candidates: z.array(GraphViewProposalSchema).max(80),
    explanation: z.string().min(1).check(utf16MaxLength(20_000)),
  })
  .strict()

/** Generation sees the same limits and reference rules that selection will enforce. */
export function graphDesignAssistPrompt(request: Parameters<GraphDesignAssistPort['generate']>[0]) {
  return canonicalJson({
    request: request.request,
    document: request.document,
    readSet: request.readSet,
    catalog: JSON.parse(request.capabilityCatalogJson),
    planningBudget: request.planningBudget,
    authoringRules: GRAPH_DESIGN_AUTHORING_RULES,
    outputSchema: toInputJsonSchema(GraphAssistOutputSchema),
    instructions:
      'Generate alternatives according to the request; preserve pinned views and original human source records. Return a proposal only. An anchored local action receives only its dependency-closed scope. Do not invent unseen existing identities or change the global title/goals in a local action. For update-view, return a refreshed candidate with the exact target view ID; a valid candidate may refresh that stale pinned view while keeping it pinned. For other selected-element or selected-path actions, an anchor view ID is only a locator and does not expand the supplied scope.',
  })
}

export function createGraphViewPlanning(deps: {
  readonly commands: GraphDesignCommands
  readonly store: GraphDesignStore
  readonly artifacts?: GraphDesignArtifacts
  readonly assist: GraphDesignAssistPort
  readonly budget?: GraphPlanningBudget
  readonly now?: () => number
  readonly changed?: (caseId: string) => void
}) {
  const now = deps.now ?? Date.now
  const budget = deps.budget ?? GRAPH_DEFAULT_PLANNING_BUDGET
  const active = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  const keyOf = (id: string, requestId: string) => `${id}\0${requestId}`
  async function update(record: GraphStoredRecord, status: string, payload: unknown) {
    const current = await deps.store.record(record.designId, record.id)
    if (current?.status !== 'running' || current.version !== record.version) return
    await deps.commands.finishRecord(current, status, payload)
  }
  return {
    /** Called once in the existing startup program, never a recurring retry queue. */
    async recoverInterrupted() {
      await deps.store.interruptRunningActions(now())
    },
    async start(id: string, raw: GraphDesignActionRequest) {
      const request = GraphDesignActionRequestSchema.parse(raw)
      const record = await deps.commands.beginRecord(
        id,
        `action:${request.requestId}`,
        'action',
        request,
      )
      if (record.status !== 'requested') return record
      const document = await deps.commands.document(id)
      if (document.revision !== request.expectedRevision)
        throw new ConflictError('graph-design-revision-conflict', `当前版本为 ${document.revision}`)
      const ids = new Set(graphContentRefs(document).map((ref) => ref.id))
      if (
        request.anchor &&
        [
          ...request.anchor.elementIds,
          ...request.anchor.relationIds,
          ...(request.anchor.viewId ? [request.anchor.viewId] : []),
        ].some((ref) => !ids.has(ref))
      )
        throw new ValidationError('graph-action-anchor-missing', '所选元素已变化，请重新定位')
      const existingProposal = await deps.store.record(id, `proposal:action:${request.requestId}`)
      if (existingProposal)
        return await deps.commands.finishRecord(record, 'completed', {
          request,
          proposalId: `action:${request.requestId}`,
          proposalStatus: existingProposal.status,
        })
      const controller = new AbortController()
      const scope = graphPlanningScope(document, request)
      const previousPlan = await readAcceptedGraphViewPlan({ ...deps, document: scope.document })
      const running = await deps.commands.finishRecord(record, 'running', {
        request,
        readSet: scope.readSet,
      })
      const key = keyOf(id, request.requestId)
      const promise = (async () => {
        try {
          const readSet = scope.readSet
          const result = await deps.assist.generate({
            caseId: document.caseId,
            request,
            document: scope.document,
            readSet,
            capabilityCatalogJson: canonicalJson(GRAPH_VIEW_CAPABILITIES),
            planningBudget: budget,
            signal: controller.signal,
          })
          if (controller.signal.aborted) return
          const current = await deps.store.record(id, running.id)
          if (current?.status !== 'running' || current.version !== running.version) return
          const output = GraphAssistOutputSchema.parse(JSON.parse(result.outputJson))
          if (output.document.id !== id || output.document.caseId !== document.caseId)
            throw new Error('graph-assist-identity-mismatch')
          if (
            graphDigest(output.document.repositoryBaseline) !==
              graphDigest(document.repositoryBaseline) ||
            output.document.repositoryId !== document.repositoryId
          )
            throw new Error('graph-assist-repository-change')
          const planningDocument = { ...output.document, views: scope.document.views }
          invalidateGraphViews(scope.document, planningDocument)
          const plan = selectGraphViews(planningDocument, output.candidates, budget, previousPlan, {
            ...(request.action === 'update-view' && request.anchor?.viewId
              ? { refreshViewId: request.anchor.viewId }
              : {}),
          })
          const views = materializeGraphViewPlan(planningDocument, plan)
          const proposedDocument = mergeGraphPlanningDocument(document, scope, {
            ...output.document,
            views,
          })
          const proposal: GraphProposal = {
            schemaVersion: 1,
            id: `action:${request.requestId}`,
            requestId: request.requestId,
            designId: id,
            kind: request.action === 'replan' ? 'view-plan' : 'semantic-change',
            readSet,
            invocationRef: result.invocationRef,
            status: 'proposed',
            explanation: output.explanation,
            document: proposedDocument,
            plan,
            createdAt: now(),
          }
          const saved = await deps.commands.storeProposal(proposal)
          await update(running, 'completed', {
            request,
            invocationRef: result.invocationRef,
            proposalId: saved.id,
            proposalStatus: saved.status,
          })
        } catch (error) {
          await update(running, controller.signal.aborted ? 'canceled' : 'failed', {
            request,
            error: error instanceof Error ? error.message : String(error),
          })
        } finally {
          if (active.get(key)?.controller === controller) active.delete(key)
          deps.changed?.(document.caseId)
        }
      })()
      // Keep an interrupted persistence update observable through settled(), without an unhandled rejection.
      void promise.catch(() => undefined)
      active.set(key, { controller, promise })
      deps.changed?.(document.caseId)
      return running
    },
    async cancel(id: string, requestId: string) {
      const record = await deps.store.record(id, `action:${requestId}`)
      if (!record) throw new NotFoundError('graph-action-not-found', '调用不存在')
      if (record.status !== 'running') return record
      const canceled = await deps.commands.finishRecord(
        record,
        'canceled',
        JSON.parse(record.payloadJson),
      )
      active.get(keyOf(id, requestId))?.controller.abort()
      return canceled
    },
    async retry(id: string, requestId: string) {
      const record = await deps.store.record(id, `action:${requestId}`)
      if (!record || !['failed', 'interrupted', 'canceled'].includes(record.status))
        throw new ConflictError('graph-action-not-retryable', '仅失败、中断或取消的调用可重试')
      const payload = JSON.parse(record.payloadJson) as { request: GraphDesignActionRequest }
      await deps.commands.finishRecord(record, 'requested', { input: payload.request })
      return await this.start(id, payload.request)
    },
    async settled(id: string, requestId: string) {
      await active.get(keyOf(id, requestId))?.promise
    },
  }
}

export type GraphViewPlanning = ReturnType<typeof createGraphViewPlanning>
