import {
  canonicalJson,
  GraphProposalSchema,
  type GraphSource,
  type GraphViewSpec,
} from '@agent-workflow/shared'
import type { EmployeeReactionRoundQueryPort } from '@/modules/digital-employee/public/types'
import type { GraphHumanInputFacts, GraphExecutionFacts } from '../ports/graphHostFacts'
import { sha256Hex } from '@/util/hash'
import { graphContentRefs, graphDigest } from '../../domain/graph-development/model'
import {
  GRAPH_DEFAULT_PLANNING_BUDGET,
  selectGraphViews,
} from '../../domain/graph-development/selectViews'
import { graphToolResultSchema, graphResultSchemas } from './toolContracts'
import type { GraphDesignStore } from '../ports/graphDesignStore'
import type { GraphDesignArtifacts } from '../ports/graphDesignArtifacts'
import type { GraphDesignCommands } from './designCommands'
import type { GraphDesignCasePort } from '../ports/graphDesignExecution'
import {
  GraphReactionPlanSchema,
  graphReactionMaterial,
  graphWork,
  isGraphPlan,
} from './reactionMaterial'

export function createGraphExecutionConsumption(deps: {
  readonly rounds: EmployeeReactionRoundQueryPort
  readonly executions: GraphExecutionFacts
  readonly humanInputs: GraphHumanInputFacts
  readonly commands: GraphDesignCommands
  readonly store: GraphDesignStore
  readonly artifacts: GraphDesignArtifacts
  readonly cases: GraphDesignCasePort
  readonly changed?: (caseId: string) => void
}) {
  async function humanSources(caseId: string, sources: readonly GraphSource[]) {
    const actual: GraphSource[] = []
    for (const taskId of new Set(
      sources.flatMap((source) =>
        source.kind === 'clarify' || source.kind === 'review' ? [source.taskId] : [],
      ),
    )) {
      if (!(await deps.executions.read({ caseId, executionRef: taskId }))) continue
      const rounds = await deps.humanInputs.clarificationRounds(taskId)
      for (const round of rounds)
        for (const answer of round.answers) {
          const requested = sources.filter(
            (source) =>
              source.kind === 'clarify' &&
              source.taskId === taskId &&
              source.roundId === round.id &&
              source.questionId === answer.questionId,
          )
          for (const source of requested)
            actual.push({
              id: source.id,
              kind: 'clarify',
              taskId,
              roundId: round.id,
              questionId: answer.questionId,
              confirmedBasis: answer.confirmedBasis ?? null,
              originalAnswer: [...answer.selectedOptionLabels, answer.customText]
                .filter(Boolean)
                .join('\n'),
              answer: {
                selectedOptionIndices: answer.selectedOptionIndices,
                selectedOptionLabels: answer.selectedOptionLabels,
                customText: answer.customText,
              },
              ...(answer.decision ? { decision: answer.decision } : {}),
            })
        }
      for (const source of sources)
        if (source.kind === 'review' && source.taskId === taskId) {
          const receipt = await reviewReceipt({
            caseId,
            executionRef: taskId,
            basisDigest: source.basisDigest,
          })
          if (
            receipt?.id === source.receiptId &&
            receipt.nodeRunId === source.nodeRunId &&
            receipt.decision === source.decision
          )
            actual.push(source)
        }
    }
    return actual
  }
  async function reviewReceipt(input: {
    caseId: string
    executionRef: string
    basisDigest: string
  }) {
    const task = await deps.executions.read(input)
    if (!task) return null
    const frozen = await deps.rounds.frozenPlan(task.roundRef)
    if (!frozen || !isGraphPlan(frozen.planJson)) return null
    const plan = GraphReactionPlanSchema.parse(JSON.parse(frozen.planJson))
    if (plan.workItemRef !== 'review-design') return null
    const material = await graphReactionMaterial(plan, deps)
    if (material.basis?.basis.digest !== input.basisDigest) return null
    const reviewed = material.basis.basis.files.find((file) => file.path === 'implementation.md')
    if (!reviewed) return null
    for (const nodeRunId of task.reviewRunIds) {
      const actual = await deps.humanInputs.reviewDecision(task.taskId, nodeRunId)
      if (
        actual &&
        actual.documentDigests.length === 1 &&
        actual.documentDigests[0] === sha256Hex(reviewed.content)
      )
        return {
          id: actual.receiptId,
          caseId: input.caseId,
          taskId: task.taskId,
          nodeRunId,
          basisDigest: input.basisDigest,
          decision: actual.decision,
          reason: actual.reason,
          decidedAt: actual.decidedAt,
        }
    }
    return null
  }
  async function importDesign(input: {
    planJson: string
    content: string
    invocationRef: string
    taskId?: string
    nodeRunId?: string
  }) {
    const plan = GraphReactionPlanSchema.parse(JSON.parse(input.planJson)),
      work = graphWork(plan)
    const output = graphResultSchemas['design-and-clarify'].parse(
      graphToolResultSchema('design-and-clarify').parse(JSON.parse(input.content)).result,
    )
    const links = await deps.store.links(work.designId)
    const records = await deps.store.records(work.designId)
    const scenes = records
      .filter((row) => row.kind === 'scene' && row.id.startsWith(`scene:${plan.roundRef}:`))
      .sort((a, b) => b.createdAt - a.createdAt)
    if (!scenes[0]) throw new Error('graph-import-scene-missing')
    const previousImports = links
      .filter((link) => link.kind === 'import')
      .map(
        (link) =>
          JSON.parse(link.payloadJson) as {
            roundRef?: string
            status: string
            appliedRevision?: number
          },
      )
      .filter(
        (link) =>
          link.roundRef === plan.roundRef && link.status === 'accepted' && link.appliedRevision,
      )
      .sort((a, b) => b.appliedRevision! - a.appliedRevision!)
    const frozen = previousImports[0]?.appliedRevision
      ? await deps.commands.document(work.designId, previousImports[0].appliedRevision)
      : (
          JSON.parse(scenes[0].payloadJson) as {
            projection: { materials: { document: typeof output.document } }
          }
        ).projection.materials.document
    if (output.document.id !== work.designId || output.document.caseId !== work.caseId)
      throw new Error('graph-import-design-mismatch')
    // Human records come from the collaboration owner, including originals omitted by the model.
    const requested: GraphSource[] = [
      ...new Map(
        [...output.document.sources, ...frozen.sources]
          .filter((source) => source.kind === 'clarify' || source.kind === 'review')
          .map((source) => [source.id, source]),
      ).values(),
    ]
    // A rejected design must not strand its committed human answers when the
    // same Case recovers in a new Task. Import receipts identify prior tasks;
    // the execution owner still verifies Case membership before any answer read.
    const priorTasks = [
      ...records.filter((record) => record.kind === 'import'),
      ...links.filter((link) => link.kind === 'import'),
    ].flatMap((record) => {
      const value = JSON.parse(record.payloadJson) as { taskId?: unknown }
      return typeof value.taskId === 'string' ? [value.taskId] : []
    })
    const taskIds = new Set([...priorTasks, ...(input.taskId ? [input.taskId] : [])])
    for (const taskId of taskIds) {
      if (!(await deps.executions.read({ caseId: work.caseId, executionRef: taskId }))) continue
      for (const round of await deps.humanInputs.clarificationRounds(taskId))
        for (const answer of round.answers) {
          if (
            !requested.some(
              (source) =>
                source.kind === 'clarify' &&
                source.roundId === round.id &&
                source.questionId === answer.questionId,
            )
          )
            requested.push({
              kind: 'clarify',
              id: `answer:${round.id}:${answer.questionId}`,
              taskId,
              roundId: round.id,
              questionId: answer.questionId,
              confirmedBasis: answer.confirmedBasis ?? null,
              originalAnswer: '',
            })
        }
    }
    const authoritative = await humanSources(work.caseId, requested)
    const humanIds = new Set(requested.map((source) => source.id))
    const sources = [
      ...output.document.sources.filter((source) => !humanIds.has(source.id)),
      ...authoritative,
    ]
    // A completed human round is new evidence even if the model reuses its design output.
    const importId = `import:${graphDigest({ round: plan.roundRef, content: output, sources })}`
    if (links.some((link) => link.id === importId)) return
    const document = { ...output.document, sources, views: frozen.views }
    const viewPlan = selectGraphViews(document, output.candidates, GRAPH_DEFAULT_PLANNING_BUDGET)
    const views: GraphViewSpec[] = viewPlan.selectedIds.map((id) => {
      const candidate = output.candidates.find((value) => value.id === id)
      const old = frozen.views.find((value) => value.id === id)
      if (!candidate && old) return old
      if (!candidate) throw new Error('graph-import-view-missing')
      return {
        id,
        revision: old?.revision ?? 1,
        title: candidate.title,
        purpose: candidate.purpose,
        capabilityRef: candidate.capabilityRef,
        concernIds: candidate.coverage.map((c) => c.concernId),
        modelIds: candidate.modelIds,
        elementIds: candidate.elementIds,
        relationIds: candidate.relationIds,
        sourceIds: candidate.sourceIds,
        status: 'current',
        pinned: old?.pinned ?? false,
        explanation: candidate.rationale,
        limitations: candidate.limitations,
      }
    })
    for (const view of frozen.views)
      if (!viewPlan.selectedIds.includes(view.id)) views.push({ ...view, status: 'archived' })
    const previous = await deps.store.record(work.designId, `proposal:${importId}`)
    const proposal = previous
      ? GraphProposalSchema.parse(
          JSON.parse(
            (await deps.artifacts.read(JSON.parse(previous.payloadJson), 'proposal.json'))!,
          ),
        )
      : GraphProposalSchema.parse({
          schemaVersion: 1,
          id: importId,
          requestId: importId,
          designId: work.designId,
          kind: 'semantic-change',
          readSet: graphContentRefs(frozen),
          invocationRef: input.invocationRef,
          status: 'proposed',
          explanation: '来自已提交的设计工作流产物；按实际读取版本导入。',
          document: { ...document, views },
          plan: viewPlan,
          createdAt: Date.now(),
        })
    const stored = previous
      ? { ...proposal, status: previous.status }
      : await deps.commands.storeProposal(proposal)
    const applied = ['proposed', 'accepted'].includes(stored.status)
      ? await deps.commands.applyProposal(work.designId, stored.id, importId)
      : { status: 'stale' as const }
    await deps.store.insertLink({
      designId: work.designId,
      id: importId,
      kind: 'import',
      payloadJson: canonicalJson({
        status: applied.status,
        roundRef: plan.roundRef,
        appliedRevision: 'document' in applied ? applied.document.revision : null,
        proposalId: proposal.id,
        taskId: input.taskId ?? null,
        nodeRunId: input.nodeRunId ?? null,
        digest: graphDigest(output),
      }),
      createdAt: Date.now(),
    })
    deps.changed?.(work.caseId)
  }
  return {
    humanSources,
    reviewReceipt,
    async progress(input: { roundRef: string; executionRef: string }) {
      const frozen = await deps.rounds.frozenPlan(input.roundRef)
      if (!frozen || !isGraphPlan(frozen.planJson)) return
      const plan = GraphReactionPlanSchema.parse(JSON.parse(frozen.planJson))
      const task = await deps.executions.read({
        caseId: plan.caseRef.id,
        executionRef: input.executionRef,
      })
      if (!task) return
      const work = graphWork(plan)
      await deps.store.insertLink({
        designId: work.designId,
        id: `host:${plan.roundRef}:${task.taskId}`,
        kind: 'execution',
        payloadJson: canonicalJson({
          kind: 'host',
          roundRef: plan.roundRef,
          workItemRef: plan.workItemRef,
          taskId: task.taskId,
        }),
        createdAt: Date.now(),
      })
      if (plan.workItemRef === 'design-and-clarify')
        for (const artifact of task.artifacts.filter(
          (artifact) => artifact.portName === 'design-model',
        )) {
          try {
            await importDesign({
              planJson: frozen.planJson,
              content: artifact.content,
              invocationRef: `${task.taskId}:${artifact.nodeRunId}:${artifact.digest}`,
              taskId: task.taskId,
              nodeRunId: artifact.nodeRunId,
            })
          } catch (error) {
            const id = `import-error:${graphDigest({ task: task.taskId, node: artifact.nodeRunId, digest: artifact.digest })}`
            const record = await deps.commands.beginRecord(work.designId, id, 'import', {
              taskId: task.taskId,
              nodeRunId: artifact.nodeRunId,
              digest: artifact.digest,
            })
            if (record.status === 'requested')
              await deps.commands.finishRecord(record, 'failed', {
                error: String(error).slice(0, 4000),
                taskId: task.taskId,
                nodeRunId: artifact.nodeRunId,
              })
            deps.changed?.(work.caseId)
          }
        }
      if (plan.workItemRef === 'review-design') {
        const material = await graphReactionMaterial(plan, deps)
        if (material.basis) {
          const receipt = await reviewReceipt({
            caseId: task ? plan.caseRef.id : '',
            executionRef: task.taskId,
            basisDigest: material.basis.basis.digest,
          })
          if (receipt) await deps.commands.recordReview(material.work.designId, receipt)
        }
      }
    },
    async consume(input: { planJson: string; outputJson: string }) {
      const plan = GraphReactionPlanSchema.parse(JSON.parse(input.planJson)),
        work = graphWork(plan)
      const output = graphToolResultSchema(plan.workItemRef).parse(JSON.parse(input.outputJson))
      if (plan.workItemRef === 'design-and-clarify') {
        const host = await deps.cases.inspect(work.caseId)
        const task = host.executionRef
          ? await deps.executions.read({ caseId: work.caseId, executionRef: host.executionRef })
          : null
        await importDesign({
          planJson: input.planJson,
          content: input.outputJson,
          invocationRef: `round:${plan.roundRef}`,
          ...(task?.roundRef === plan.roundRef ? { taskId: task.taskId } : {}),
        })
      }
      if (plan.workItemRef === 'review-design') {
        const result = graphResultSchemas['review-design'].parse(output.result)
        const actual = await reviewReceipt({
          caseId: work.caseId,
          executionRef: result.receipt.taskId,
          basisDigest: result.basisDigest,
        })
        if (
          !actual ||
          actual.id !== result.receipt.receiptId ||
          actual.decision !== result.receipt.decision ||
          actual.nodeRunId !== result.receipt.nodeRunId
        )
          throw new Error('graph-review-output-not-authoritative')
        await deps.commands.recordReview(work.designId, actual)
      }
      if (plan.workItemRef === 'implement-change') {
        const material = await graphReactionMaterial(plan, deps)
        if (!material.basis) throw new Error('graph-implementation-basis-missing')
        await deps.store.insertLink({
          designId: work.designId,
          id: `implementation:${plan.roundRef}`,
          kind: 'execution',
          payloadJson: canonicalJson({
            kind: 'implementation',
            roundRef: plan.roundRef,
            basisId: material.basis.basis.id,
            basisDigest: material.basis.basis.digest,
            result: graphResultSchemas['implement-change'].parse(output.result),
          }),
          createdAt: Date.now(),
        })
        const result = graphResultSchemas['implement-change'].parse(output.result)
        if (result.limitations.length) {
          const proposalId = `code-feedback:${plan.roundRef}`
          if (!(await deps.store.record(work.designId, `proposal:${proposalId}`))) {
            const document = material.basis.basis.document
            const sourceId = `implementation-source:${plan.roundRef}`
            await deps.commands.storeProposal(
              GraphProposalSchema.parse({
                schemaVersion: 1,
                id: proposalId,
                requestId: proposalId,
                designId: work.designId,
                kind: 'code-feedback',
                readSet: graphContentRefs(document),
                invocationRef: plan.roundRef,
                status: 'proposed',
                explanation: '实现报告存在未完成限制，需重新澄清和形成实现依据。',
                document: {
                  ...document,
                  sources: [
                    ...document.sources,
                    {
                      id: sourceId,
                      kind: 'model',
                      invocationRef: plan.roundRef,
                      materialDigest: graphDigest(result),
                    },
                  ],
                  concerns: [
                    ...document.concerns,
                    ...result.limitations.map((statement, index) => ({
                      id: `implementation-gap:${plan.roundRef}:${index}`,
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
                plan: null,
                createdAt: Date.now(),
              }),
            )
          }
        }
        deps.changed?.(work.caseId)
      }
    },
  }
}
