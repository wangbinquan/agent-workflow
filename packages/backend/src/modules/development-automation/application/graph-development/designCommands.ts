import {
  canonicalJson,
  GraphDesignDocumentSchema,
  GraphImplementationBasisSchema,
  GraphProposalSchema,
  GraphEvidenceBindingSchema,
  type GraphDesignDocument,
  type GraphImplementationBasis,
  type GraphProposal,
} from '@agent-workflow/shared'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import {
  applyGraphProposal,
  graphContentRefs,
  graphDigest,
  invalidateGraphViews,
  staleGraphReads,
  validateGraphDocument,
} from '../../domain/graph-development/model'
import { createGraphImplementationBasis } from '../../domain/graph-development/implementationBasis'
import type {
  GraphDesignStore,
  GraphStoredRecord,
  GraphStoredRevision,
} from '../ports/graphDesignStore'
import type { GraphDesignArtifacts, GraphArtifactReference } from '../ports/graphDesignArtifacts'
import type {
  GraphClarificationRequest,
  GraphDesignCasePort,
  GraphDesignExecutionPort,
  GraphReviewReceipt,
} from '../ports/graphDesignExecution'

export interface GraphDesignDependencies {
  readonly store: GraphDesignStore
  readonly artifacts: GraphDesignArtifacts
  readonly cases: GraphDesignCasePort
  readonly execution: GraphDesignExecutionPort
  readonly now?: () => number
  readonly changed?: (caseId: string) => void
}

export function createGraphDesignCommands(deps: GraphDesignDependencies) {
  const now = deps.now ?? Date.now
  async function readRevision(reference: GraphStoredRevision): Promise<GraphDesignDocument> {
    const text = await deps.artifacts.read(reference, 'design.json')
    if (text === null) throw new NotFoundError('graph-design-content-missing', '设计内容暂不可读取')
    const value = GraphDesignDocumentSchema.parse(JSON.parse(text))
    if (value.id !== reference.designId || value.revision !== reference.revision)
      throw new Error('graph-design-content-identity-mismatch')
    return value
  }
  async function document(id: string, revision?: number) {
    const identity = await deps.store.find(id)
    if (!identity) throw new NotFoundError('graph-design-not-found', '设计不存在')
    const stored = await deps.store.revision(id, revision ?? identity.revision)
    if (!stored) throw new NotFoundError('graph-design-revision-not-found', '设计版本不存在')
    return await readRevision(stored)
  }
  function check(value: GraphDesignDocument) {
    const issues = validateGraphDocument(value)
    if (issues.length) throw new ValidationError('graph-design-invalid', canonicalJson(issues))
  }
  async function checkHumanSources(value: GraphDesignDocument) {
    const requested = value.sources.filter((s) => s.kind === 'clarify' || s.kind === 'review')
    const authoritative = await deps.execution.humanSources({
      caseId: value.caseId,
      sources: requested,
    })
    for (const source of requested) {
      if (
        !authoritative.some(
          (actual) => actual.id === source.id && graphDigest(actual) === graphDigest(source),
        )
      )
        throw new ValidationError('graph-source-not-authoritative', source.id)
    }
  }
  async function save(
    value: GraphDesignDocument,
    expectedRevision: number,
    requestId: string,
    requestDigest: string,
  ) {
    check(value)
    const artifact = await deps.artifacts.put([
      { path: 'design.json', content: canonicalJson(value) },
    ])
    const stored = await deps.store.commit({
      expectedRevision,
      requestDigest,
      revision: {
        ...artifact,
        designId: value.id,
        revision: value.revision,
        requestId,
        createdAt: now(),
      },
    })
    deps.changed?.(value.caseId)
    return await readRevision(stored)
  }
  async function basis(
    id: string,
    basisId: string,
  ): Promise<{ basis: GraphImplementationBasis; artifact: GraphArtifactReference }> {
    const stored = await deps.store.basis(id, basisId)
    if (!stored) throw new NotFoundError('graph-basis-not-found', '实现依据不存在')
    const content = await deps.artifacts.read(stored, 'basis.json')
    if (!content) throw new NotFoundError('graph-basis-content-missing', '实现依据材料暂不可读取')
    return { basis: GraphImplementationBasisSchema.parse(JSON.parse(content)), artifact: stored }
  }
  async function beginRecord(
    designId: string,
    id: string,
    kind: string,
    input: unknown,
  ): Promise<GraphStoredRecord> {
    return await deps.store.insertRecord({
      designId,
      id,
      kind,
      requestDigest: graphDigest(input),
      status: 'requested',
      version: 1,
      payloadJson: canonicalJson({ input }),
      createdAt: now(),
      updatedAt: now(),
    })
  }
  async function finishRecord(record: GraphStoredRecord, status: string, value: unknown) {
    const next = {
      ...record,
      status,
      version: record.version + 1,
      payloadJson: canonicalJson(value),
      updatedAt: now(),
    }
    await deps.store.updateRecord(next, record.version)
    return next
  }
  async function dispatch(
    record: GraphStoredRecord,
    request: Omit<Parameters<GraphDesignCasePort['requestWork']>[0], 'payloadRef'>,
    payload: GraphArtifactReference,
  ) {
    // Store readable input before observing the event; recovery reuses its dedupe key.
    const prepared =
      record.status === 'prepared' ? record : await finishRecord(record, 'prepared', { payload })
    const savedPayload = (JSON.parse(prepared.payloadJson) as { payload: GraphArtifactReference })
      .payload
    const receipt = await deps.cases.requestWork({ ...request, payloadRef: savedPayload })
    await finishRecord(prepared, 'accepted', { ...receipt, payload: savedPayload })
    deps.changed?.(request.caseId)
    return receipt
  }
  return {
    document,
    basis,
    beginRecord,
    finishRecord,
    async ensure(input: {
      readonly id: string
      readonly caseId: string
      readonly repositoryId: string
      readonly title: string
      readonly body: string
      readonly materialSources: GraphDesignDocument['sources']
    }) {
      const existing = await deps.store.findByCase(input.caseId)
      if (existing) return await document(existing.id)
      const value: GraphDesignDocument = {
        schemaVersion: 1,
        id: input.id,
        caseId: input.caseId,
        revision: 1,
        title: input.title,
        goals: [input.body],
        repositoryId: input.repositoryId,
        repositoryBaseline: await deps.execution.resolveRepositoryBaseline(input),
        concerns: [],
        elements: [],
        relations: [],
        models: [],
        views: [],
        sources: input.materialSources,
        obligations: [],
      }
      check(value)
      const artifact = await deps.artifacts.put([
        { path: 'design.json', content: canonicalJson(value) },
      ])
      const identity = await deps.store.create(
        {
          id: value.id,
          caseId: value.caseId,
          revision: 1,
          presentationJson: '{}',
          presentationRevision: 1,
          createdAt: now(),
          updatedAt: now(),
        },
        { ...artifact, designId: value.id, revision: 1, requestId: 'initial', createdAt: now() },
      )
      return await document(identity.id)
    },
    async change(
      id: string,
      input: {
        readonly expectedRevision: number
        readonly requestId: string
        readonly document: GraphDesignDocument
      },
    ) {
      const digest = graphDigest(input)
      const replay = await deps.store.record(id, `change:${input.requestId}`)
      if (replay) {
        if (replay.requestDigest !== digest)
          throw new ConflictError(
            'graph-request-reused-with-different-input',
            '请求标识已用于不同内容',
          )
        return await readRevision(JSON.parse(replay.payloadJson) as GraphStoredRevision)
      }
      const current = await document(id)
      if (current.revision !== input.expectedRevision)
        throw new ConflictError(
          'graph-design-revision-conflict',
          `当前版本为 ${current.revision}；已保留你的输入，请比较后再提交`,
        )
      const proposed = GraphDesignDocumentSchema.parse(input.document)
      if (
        proposed.id !== id ||
        proposed.caseId !== current.caseId ||
        graphDigest(proposed.repositoryBaseline) !== graphDigest(current.repositoryBaseline) ||
        proposed.repositoryId !== current.repositoryId
      )
        throw new ValidationError('graph-change-identity-invalid', '仓库基线由平台管理')
      // Human answers are edited through their original collaboration commands only.
      if (graphDigest(proposed.sources) !== graphDigest(current.sources))
        throw new ValidationError('graph-change-sources-immutable', '请通过原澄清问题补充回答')
      for (const source of current.sources)
        if (!proposed.sources.some((s) => graphDigest(s) === graphDigest(source)))
          throw new ValidationError('graph-change-source-removed', source.id)
      const refs = new Map(graphContentRefs(current).map((ref) => [ref.id, ref]))
      const next = { ...proposed, revision: current.revision + 1 }
      for (const field of [
        'concerns',
        'elements',
        'relations',
        'models',
        'views',
        'obligations',
      ] as const) {
        for (const item of next[field]) {
          const before = refs.get(item.id)
          item.revision = before
            ? before.revision + (before.digest === graphDigest(item) ? 0 : 1)
            : 1
        }
      }
      invalidateGraphViews(current, next)
      return await save(next, current.revision, input.requestId, digest)
    },
    async storeProposal(input: GraphProposal) {
      const proposal = GraphProposalSchema.parse(input)
      const current = await document(proposal.designId)
      check(proposal.document)
      await checkHumanSources(proposal.document)
      const stale = staleGraphReads(current, proposal.readSet)
      const value: GraphProposal = { ...proposal, status: stale.length ? 'stale' : 'proposed' }
      const artifact = await deps.artifacts.put([
        { path: 'proposal.json', content: canonicalJson(value) },
      ])
      await deps.store.insertRecord({
        designId: value.designId,
        id: `proposal:${value.id}`,
        kind: 'proposal',
        requestDigest: graphDigest(proposal),
        status: value.status,
        version: 1,
        payloadJson: canonicalJson(artifact),
        createdAt: value.createdAt,
        updatedAt: now(),
      })
      deps.changed?.(current.caseId)
      return value
    },
    async applyProposal(id: string, proposalId: string, requestId: string) {
      const stored = await deps.store.record(id, `proposal:${proposalId}`)
      if (!stored) throw new NotFoundError('graph-proposal-not-found', '提案不存在')
      const artifact = JSON.parse(stored.payloadJson) as GraphArtifactReference
      const text = await deps.artifacts.read(artifact, 'proposal.json')
      if (!text) throw new NotFoundError('graph-proposal-content-missing', '提案材料暂不可读')
      const proposal = GraphProposalSchema.parse(JSON.parse(text))
      const requestDigest = graphDigest({ proposalId, proposalDigest: stored.requestDigest })
      const applyId = `proposal-apply:${graphDigest(proposalId)}`
      const replay = await deps.store.record(id, `change:${applyId}`)
      if (replay) {
        if (replay.requestDigest !== requestDigest)
          throw new ConflictError('graph-request-reused-with-different-input', requestId)
        if (stored.status !== 'accepted')
          await deps.store.updateRecord(
            { ...stored, status: 'accepted', version: stored.version + 1, updatedAt: now() },
            stored.version,
          )
        return {
          status: 'accepted' as const,
          document: await readRevision(JSON.parse(replay.payloadJson)),
        }
      }
      if (stored.status === 'accepted' || stored.status === 'rejected')
        throw new ConflictError('graph-proposal-already-decided', proposalId)
      const current = await document(id)
      const result = applyGraphProposal(current, proposal)
      if (result.status === 'stale') {
        if (stored.status !== 'stale')
          await deps.store.updateRecord(
            { ...stored, status: 'stale', version: stored.version + 1, updatedAt: now() },
            stored.version,
          )
        return result
      }
      const saved = await save(result.document, current.revision, applyId, requestDigest)
      // The accepted change receipt is authoritative if a crash separates these two writes.
      await deps.store.updateRecord(
        { ...stored, status: 'accepted', version: stored.version + 1, updatedAt: now() },
        stored.version,
      )
      return { status: 'accepted' as const, document: saved }
    },
    async preview(
      id: string,
      input: {
        readonly requestId: string
        readonly expectedRevision: number
        readonly includedElementIds: readonly string[]
      },
    ) {
      const record = await beginRecord(id, `preview:${input.requestId}`, 'preview', input)
      if (record.status === 'completed')
        return await basis(id, (JSON.parse(record.payloadJson) as { basisId: string }).basisId)
      const rebaseRequestId = `preview-baseline:${input.requestId}`
      const rebased = await deps.store.record(id, `change:${rebaseRequestId}`)
      let current = rebased
        ? await readRevision(JSON.parse(rebased.payloadJson) as GraphStoredRevision)
        : await document(id)
      if (!rebased && current.revision !== input.expectedRevision)
        throw new ConflictError('graph-design-revision-conflict', `当前版本为 ${current.revision}`)
      if (!rebased) {
        const baseline = await deps.execution.resolveImplementationBaseline?.({
          caseId: current.caseId,
          designId: id,
          repositoryId: current.repositoryId,
        })
        if (baseline && graphDigest(baseline) !== graphDigest(current.repositoryBaseline)) {
          const next = { ...current, revision: current.revision + 1, repositoryBaseline: baseline }
          invalidateGraphViews(current, next)
          current = await save(
            next,
            current.revision,
            rebaseRequestId,
            graphDigest({ input, baseline }),
          )
        }
      }
      let value: GraphImplementationBasis
      try {
        value = createGraphImplementationBasis({
          id: `basis:${input.requestId}`,
          document: current,
          includedElementIds: input.includedElementIds,
          createdAt: record.createdAt,
        })
      } catch (error) {
        throw new ValidationError(
          'graph-basis-invalid',
          error instanceof Error ? error.message : String(error),
        )
      }
      const artifact = await deps.artifacts.put([
        ...value.files,
        { path: 'basis.json', content: canonicalJson(value) },
      ])
      await deps.execution.assertMaterialsReadable({
        caseId: current.caseId,
        basis: value,
        artifact,
      })
      const stored = await deps.store.insertBasis({
        ...artifact,
        designId: id,
        id: value.id,
        createdAt: value.createdAt,
      })
      await finishRecord(record, 'completed', { basisId: value.id })
      return { basis: value, artifact: stored }
    },
    async requestReview(
      id: string,
      input: { readonly requestId: string; readonly basisId: string },
    ) {
      const frozen = await basis(id, input.basisId)
      const record = await beginRecord(id, `review:${input.requestId}`, 'review', input)
      if (record.status === 'accepted')
        return JSON.parse(record.payloadJson) as {
          eventId: string
          caseId: string
          queued: boolean
        }
      if (record.status === 'prepared')
        return await dispatch(
          record,
          {
            caseId: frozen.basis.document.caseId,
            requestId: input.requestId,
            kind: 'review',
            withdrawReview: false,
          },
          JSON.parse(record.payloadJson).payload,
        )
      const current = await document(id)
      if (staleGraphReads(current, frozen.basis.readSet).length)
        throw new ConflictError('graph-basis-stale', '实现依据所引用内容已变化，请重新预览')
      const state = await deps.cases.inspect(current.caseId)
      if (
        state.state === 'terminal' ||
        (state.executionRef && state.workItemRef !== 'design-and-clarify')
      )
        throw new ConflictError('graph-review-host-busy', '请先结束当前工作项')
      const payload = await deps.artifacts.put([
        {
          path: 'request.json',
          content: canonicalJson({
            ...input,
            basisDigest: frozen.basis.digest,
            basis: frozen.artifact,
          }),
        },
      ])
      return await dispatch(
        record,
        {
          caseId: current.caseId,
          requestId: input.requestId,
          kind: 'review',
          withdrawReview: false,
        },
        payload,
      )
    },
    async recordReview(id: string, receipt: GraphReviewReceipt) {
      const current = await document(id)
      if (receipt.caseId !== current.caseId)
        throw new ValidationError('graph-review-case-mismatch', receipt.id)
      const actual = await deps.execution.reviewReceipt({
        caseId: current.caseId,
        executionRef: receipt.taskId,
        basisDigest: receipt.basisDigest,
      })
      if (!actual || graphDigest(actual) !== graphDigest(receipt))
        throw new ValidationError('graph-review-receipt-mismatch', receipt.id)
      await deps.store.insertLink({
        designId: id,
        id: `review:${receipt.id}`,
        kind: 'execution',
        payloadJson: canonicalJson({ kind: 'review', receipt }),
        createdAt: receipt.decidedAt,
      })
      const frozen = await Promise.all((await deps.store.bases(id)).map((row) => basis(id, row.id)))
      const reviewed = frozen.find((value) => value.basis.digest === receipt.basisDigest)?.basis
      if (!reviewed) throw new NotFoundError('graph-reviewed-basis-missing', receipt.id)
      const evidenceId = `review-evidence:${receipt.id}`
      const previousEvidence = (await deps.store.links(id)).find((link) => link.id === evidenceId)
      if (previousEvidence) {
        const previous = GraphEvidenceBindingSchema.parse(JSON.parse(previousEvidence.payloadJson))
        const original = await deps.artifacts.read(
          { artifactRef: previous.artifactRef!, digest: previous.artifactDigest! },
          'review.json',
        )
        if (
          previousEvidence.kind !== 'evidence' ||
          previous.basisDigest !== reviewed.digest ||
          original !== canonicalJson(receipt)
        )
          throw new ConflictError('graph-review-evidence-conflict', receipt.id)
        return
      }
      const artifact = await deps.artifacts.put([
        { path: 'review.json', content: canonicalJson(receipt) },
      ])
      const evidence = GraphEvidenceBindingSchema.parse({
        id: evidenceId,
        kind: 'design-review',
        basisDigest: reviewed.digest,
        obligationIds: reviewed.obligationIds,
        readSet: reviewed.readSet,
        candidateTreeOid: null,
        commitSha: null,
        profileRef: null,
        environmentDigest: null,
        executionRef: receipt.taskId,
        artifactRef: artifact.artifactRef,
        artifactDigest: artifact.digest,
        ci: null,
        result: receipt.decision === 'approved' ? 'passed' : 'failed',
        summary: `${receipt.decision}: ${receipt.reason}`,
        limitations: ['人工批准设计并不证明候选代码已通过执行验证。'],
        recordedAt: receipt.decidedAt,
      })
      try {
        await deps.store.insertLink({
          designId: id,
          id: evidence.id,
          kind: 'evidence',
          payloadJson: canonicalJson(evidence),
          createdAt: receipt.decidedAt,
        })
      } catch (error) {
        // Concurrent progress and terminal consumption can import equal content
        // under different artifact references. Keep the first persisted binding.
        const winner = (await deps.store.links(id)).find((link) => link.id === evidence.id)
        if (
          winner?.kind !== 'evidence' ||
          canonicalJson({
            ...JSON.parse(winner.payloadJson),
            artifactRef: evidence.artifactRef,
          }) !== canonicalJson(evidence)
        )
          throw error
      }
      deps.changed?.(current.caseId)
    },
    async requestImplementation(
      id: string,
      input: {
        readonly requestId: string
        readonly basisId: string
        readonly reviewReceiptId: string
      },
    ) {
      const frozen = await basis(id, input.basisId)
      const record = await beginRecord(
        id,
        `implementation:${input.requestId}`,
        'implementation',
        input,
      )
      if (record.status === 'accepted')
        return JSON.parse(record.payloadJson) as {
          eventId: string
          caseId: string
          queued: boolean
        }
      if (record.status === 'prepared')
        return await dispatch(
          record,
          {
            caseId: frozen.basis.document.caseId,
            requestId: input.requestId,
            kind: 'implementation',
            withdrawReview: false,
          },
          JSON.parse(record.payloadJson).payload,
        )
      if (staleGraphReads(await document(id), frozen.basis.readSet).length)
        throw new ConflictError('graph-basis-stale', '相关设计已变化，请重新预览并审核')
      const reviewLink = (await deps.store.links(id)).find(
        (link) => link.id === `review:${input.reviewReceiptId}`,
      )
      const review = reviewLink
        ? (JSON.parse(reviewLink.payloadJson) as { receipt: GraphReviewReceipt }).receipt
        : null
      if (!review || review.decision !== 'approved' || review.basisDigest !== frozen.basis.digest)
        throw new ValidationError('graph-implementation-not-approved', '需取得该实现依据的批准回执')
      const actual = await deps.execution.reviewReceipt({
        caseId: frozen.basis.document.caseId,
        executionRef: review.taskId,
        basisDigest: frozen.basis.digest,
      })
      if (!actual || actual.id !== review.id || actual.decision !== 'approved')
        throw new ConflictError('graph-review-no-longer-valid', '批准回执不可读取或已撤回')
      await deps.execution.assertMaterialsReadable({
        caseId: review.caseId,
        basis: frozen.basis,
        artifact: frozen.artifact,
      })
      const payload = await deps.artifacts.put([
        {
          path: 'request.json',
          content: canonicalJson({
            ...input,
            basisDigest: frozen.basis.digest,
            basis: frozen.artifact,
            review,
          }),
        },
      ])
      return await dispatch(
        record,
        {
          caseId: review.caseId,
          requestId: input.requestId,
          kind: 'implementation',
          withdrawReview: false,
        },
        payload,
      )
    },
    async requestClarification(id: string, input: GraphClarificationRequest) {
      const current = await document(id)
      const record = await beginRecord(
        id,
        `clarification:${input.requestId}`,
        'clarification',
        input,
      )
      if (record.status === 'accepted')
        return JSON.parse(record.payloadJson) as {
          caseId: string
          queued?: boolean
          eventId?: string
        }
      if (record.status === 'prepared')
        return await dispatch(
          record,
          {
            caseId: current.caseId,
            requestId: input.requestId,
            kind: 'clarification',
            withdrawReview: input.withdrawReview,
          },
          JSON.parse(record.payloadJson).payload,
        )
      if (current.revision !== input.expectedRevision)
        throw new ConflictError('graph-design-revision-conflict', `当前版本为 ${current.revision}`)
      for (const sourceId of input.previousSourceIds)
        if (!current.sources.some((s) => s.id === sourceId && s.kind === 'clarify'))
          throw new ValidationError('graph-clarification-source-missing', sourceId)
      const state = await deps.cases.inspect(current.caseId)
      if (state.editableClarify)
        throw new ConflictError(
          'graph-clarification-round-open',
          canonicalJson(state.editableClarify),
        )
      if (state.workItemRef === 'review-design' && state.executionRef && !input.withdrawReview)
        throw new ConflictError(
          'graph-review-withdrawal-required',
          '当前正在审核，请明确撤回后补充澄清',
        )
      const payload = await deps.artifacts.put([
        {
          path: 'request.json',
          content: canonicalJson({
            ...input,
            designId: id,
            document: current,
            readSet: graphContentRefs(current),
          }),
        },
      ])
      if (state.state !== 'terminal')
        return await dispatch(
          record,
          {
            caseId: current.caseId,
            requestId: input.requestId,
            kind: 'clarification',
            withdrawReview: input.withdrawReview,
          },
          payload,
        )
      const receipt = await deps.cases.followOn({
        caseId: current.caseId,
        requestId: input.requestId,
        body: input.instruction,
        artifactRef: payload,
      })
      await finishRecord(record, 'accepted', { ...receipt, payload })
      deps.changed?.(current.caseId)
      return receipt
    },
  }
}

export type GraphDesignCommands = ReturnType<typeof createGraphDesignCommands>
