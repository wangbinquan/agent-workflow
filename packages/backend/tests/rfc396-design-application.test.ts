// Real provider transactions, immutable artifacts, request replay and human-gate boundaries.
import { expect, test } from 'bun:test'
import { graphContentRefs } from '@/modules/development-automation/domain/graph-development/model'
import { createGraphDesignCommands } from '@/modules/development-automation/application/graph-development/designCommands'
import { describeEachProvider } from './helpers/eachProvider'
import { graphFixture } from './helpers/graphDesign'

describeEachProvider('RFC-396 design owner transactions', (harness) => {
  test('semantic writes replay, concurrent writes conflict, and layouts leave semantic revisions intact', async () => {
    const f = await graphFixture(harness.db),
      current = await f.commands.document('design-a')
    const next = structuredClone(current)
    next.elements[0]!.description = '返回已有预约，不创建第二笔'
    const input = { requestId: 'edit', expectedRevision: current.revision, document: next }
    const saved = await f.commands.change(current.id, input)
    expect(await f.commands.change(current.id, input)).toEqual(saved)
    expect(saved.revision).toBe(current.revision + 1)
    await expect(
      f.commands.change(current.id, { ...input, requestId: 'concurrent' }),
    ).rejects.toThrow('当前版本')
    await f.queries.savePresentation(current.id, {
      expectedRevision: 1,
      views: {
        overview: {
          viewId: 'overview',
          revision: 1,
          collapsedIds: ['booking'],
          positions: {},
          viewport: { x: 20, y: 30, zoom: 2 },
        },
      },
    })
    expect(await f.commands.document(current.id)).toEqual(saved)
    expect((await f.queries.workspace(current.id)).presentationRevision).toBe(2)
    expect((await f.commands.document(current.id, current.revision)).elements[0]!.description).toBe(
      '同一时段最多一笔',
    )
  })
  test('a committed proposal survives a lost status update and does not apply twice with a new request key', async () => {
    const f = await graphFixture(harness.db),
      current = await f.commands.document('design-a')
    const next = structuredClone(current)
    next.elements[0]!.label = '并发预约'
    await f.commands.storeProposal({
      schemaVersion: 1,
      id: 'p',
      designId: current.id,
      requestId: 'p',
      kind: 'semantic-change',
      readSet: graphContentRefs(current),
      invocationRef: 'invoke',
      status: 'proposed',
      explanation: '明确并发',
      document: next,
      plan: null,
      createdAt: 10,
    })
    let failed = false
    const crashing = createGraphDesignCommands({
      ...f,
      store: {
        ...f.store,
        async updateRecord(record, version) {
          if (record.id === 'proposal:p' && !failed) {
            failed = true
            throw new Error('lost status write')
          }
          await f.store.updateRecord(record, version)
        },
      },
    })
    await expect(crashing.applyProposal(current.id, 'p', 'first')).rejects.toThrow('lost status')
    const replay = await f.commands.applyProposal(current.id, 'p', 'second')
    expect(replay.status).toBe('accepted')
    expect((await f.commands.document(current.id)).revision).toBe(current.revision + 1)
    expect((await f.queries.proposal(current.id, 'p')).status).toBe('accepted')
  })
  test('the event sees prepared material, and review approval is tied to the same basis', async () => {
    const f = await graphFixture(harness.db),
      current = await f.commands.document('design-a')
    const preview = await f.commands.preview(current.id, {
      requestId: 'b1',
      expectedRevision: current.revision,
      includedElementIds: ['booking'],
    })
    expect(f.requests).toHaveLength(0)
    const commands = createGraphDesignCommands({
      ...f,
      cases: {
        ...f.cases,
        async requestWork(input) {
          expect((await f.store.record(current.id, `review:${input.requestId}`))?.status).toBe(
            'prepared',
          )
          return await f.cases.requestWork(input)
        },
      },
    })
    await commands.requestReview(current.id, { requestId: 'review1', basisId: preview.basis.id })
    await commands.requestReview(current.id, { requestId: 'review1', basisId: preview.basis.id })
    expect(f.requests).toHaveLength(1)
    await expect(
      f.commands.requestImplementation(current.id, {
        requestId: 'build',
        basisId: preview.basis.id,
        reviewReceiptId: 'fabricated',
      }),
    ).rejects.toThrow('批准')
    const receipt = {
      id: 'approved',
      caseId: current.caseId,
      taskId: 'task-review',
      nodeRunId: 'review-node',
      basisDigest: preview.basis.digest,
      decision: 'approved' as const,
      reason: '按此实现',
      decidedAt: 100,
    }
    f.setReview(receipt)
    let artifactWrites = 0
    const refs = new Map<string, { artifactRef: string; digest: string }>()
    const commandsWithFreshArtifacts = createGraphDesignCommands({
      ...f,
      artifacts: {
        ...f.artifacts,
        async put(files) {
          const actual = await f.artifacts.put(files)
          const artifactRef = `fresh-artifact:${++artifactWrites}`
          refs.set(artifactRef, actual)
          return { ...actual, artifactRef }
        },
        read: (ref, path) => f.artifacts.read(refs.get(ref.artifactRef) ?? ref, path),
      },
    })
    await Promise.all([
      commandsWithFreshArtifacts.recordReview(current.id, receipt),
      commandsWithFreshArtifacts.recordReview(current.id, receipt),
    ])
    const evidenceBefore = (await f.store.links(current.id)).find(
      (link) => link.id === 'review-evidence:approved',
    )!
    const writesBeforeReplay = artifactWrites
    await commandsWithFreshArtifacts.recordReview(current.id, receipt)
    expect(artifactWrites).toBe(writesBeforeReplay)
    expect((await f.store.links(current.id)).find((link) => link.id === evidenceBefore.id)).toEqual(
      evidenceBefore,
    )
    await f.commands.requestImplementation(current.id, {
      requestId: 'build-approved',
      basisId: preview.basis.id,
      reviewReceiptId: receipt.id,
    })
    expect(f.requests.at(-1)?.kind).toBe('implementation')
    const payload = JSON.parse(
      (await f.artifacts.read(f.requests.at(-1)!.payloadRef, 'request.json'))!,
    )
    expect(payload.basisDigest).toBe(preview.basis.digest)
    expect(
      (await f.store.links(current.id)).some((link) => link.id === 'review-evidence:approved'),
    ).toBe(true)
  })
  test('related semantic edits stale a basis; layout and unrelated entities do not', async () => {
    const f = await graphFixture(harness.db),
      current = await f.commands.document('design-a')
    const basis = (
      await f.commands.preview(current.id, {
        requestId: 'basis',
        expectedRevision: current.revision,
        includedElementIds: ['booking'],
      })
    ).basis
    const extra = structuredClone(current)
    extra.elements.push({
      id: 'unrelated',
      revision: 1,
      kind: 'assumption',
      label: '无关假设',
      description: '',
      condition: '',
      unknowns: '',
      sourceIds: [],
    })
    const saved = await f.commands.change(current.id, {
      requestId: 'unrelated',
      expectedRevision: current.revision,
      document: extra,
    })
    await f.commands.requestReview(current.id, { requestId: 'unrelated-review', basisId: basis.id })
    saved.elements[0]!.description = '允许两笔'
    await f.commands.change(current.id, {
      requestId: 'related',
      expectedRevision: saved.revision,
      document: saved,
    })
    await expect(
      f.commands.requestReview(current.id, { requestId: 'stale-review', basisId: basis.id }),
    ).rejects.toThrow('已变化')
  })
  test('open rounds remain at the original questions, review withdrawal is explicit, and terminal work creates a follow-on', async () => {
    const f = await graphFixture(harness.db),
      current = await f.commands.document('design-a')
    const input = {
      requestId: 'ask',
      expectedRevision: current.revision,
      instruction: '如果时间冲突怎么办',
      anchor: null,
      previousSourceIds: [],
      withdrawReview: false,
    }
    Object.assign(f.host, { editableClarify: { taskId: 'task', roundId: 'round' } })
    await expect(f.commands.requestClarification(current.id, input)).rejects.toThrow('round')
    Object.assign(f.host, {
      editableClarify: null,
      workItemRef: 'review-design',
      executionRef: 'task',
    })
    await expect(
      f.commands.requestClarification(current.id, { ...input, requestId: 'ask-review' }),
    ).rejects.toThrow('撤回')
    await f.commands.requestClarification(current.id, {
      ...input,
      requestId: 'withdraw',
      withdrawReview: true,
    })
    expect(f.requests.at(-1)?.withdrawReview).toBe(true)
    Object.assign(f.host, { state: 'terminal', workItemRef: null, executionRef: null })
    expect(
      (await f.commands.requestClarification(current.id, { ...input, requestId: 'follow' })).caseId,
    ).toBe('follow-on')
  })
  test('human sources cannot be edited through semantic changes and unknown owners stay empty', async () => {
    const f = await graphFixture(harness.db),
      current = await f.commands.document('design-a')
    const modified = structuredClone(current)
    modified.sources.push({
      id: 'fake-human',
      kind: 'clarify',
      taskId: 'task',
      roundId: 'r',
      questionId: 'q',
      confirmedBasis: null,
      originalAnswer: 'already decided',
    })
    await expect(
      f.commands.change(current.id, {
        requestId: 'fake',
        expectedRevision: current.revision,
        document: modified,
      }),
    ).rejects.toThrow('原澄清')
    const basis = (
      await f.commands.preview(current.id, {
        requestId: 'unknown',
        expectedRevision: current.revision,
        includedElementIds: ['booking'],
      })
    ).basis
    expect(basis.document.obligations[0]!.verification).toEqual({
      kind: 'manual',
      instructions: '发起两笔预约并检查',
      owner: null,
      when: null,
    })
  })
  test('large views expose bounded semantic pages and a complete total instead of rendering an unbounded graph', async () => {
    const f = await graphFixture(harness.db),
      current = await f.commands.document('design-a')
    current.elements = Array.from({ length: 1000 }, (_, index) => ({
      id: `e${index}`,
      revision: 1,
      kind: 'behavior' as const,
      role: 'step' as const,
      label: `步骤${index}`,
      description: '',
      sourceIds: [],
    }))
    current.concerns = []
    current.obligations = []
    current.models = [
      {
        id: 'flow',
        kind: 'flow',
        revision: 1,
        label: 'large',
        sourceIds: [],
        elementIds: current.elements.map((e) => e.id),
        relationIds: [],
      },
    ]
    current.views[0]!.elementIds = current.elements.map((e) => e.id)
    current.views[0]!.concernIds = []
    await f.commands.change(current.id, {
      requestId: 'large',
      expectedRevision: current.revision,
      document: current,
    })
    const page = await f.queries.view(current.id, 'overview', { offset: 500, limit: 50 })
    expect(page.elements.map((e) => e.id)).toEqual(
      Array.from({ length: 50 }, (_, index) => `e${500 + index}`),
    )
    expect(page.scope.total).toBe(1000)
    expect(page.scope.truncated).toBe(true)
    expect(page.renderings).toEqual([])
  })
  test('an unavailable evidence artifact cannot retain a current passing status', async () => {
    const f = await graphFixture(harness.db),
      document = await f.commands.document('design-a')
    await f.store.insertLink({
      designId: document.id,
      id: 'lost-evidence',
      kind: 'evidence',
      createdAt: 10,
      payloadJson: JSON.stringify({
        id: 'lost-evidence',
        kind: 'acceptance',
        obligationIds: ['unique'],
        basisDigest: 'a'.repeat(64),
        readSet: [],
        candidateTreeOid: 'b'.repeat(40),
        commitSha: null,
        profileRef: null,
        environmentDigest: null,
        executionRef: null,
        artifactRef: 'deleted',
        artifactDigest: 'c'.repeat(64),
        ci: null,
        result: 'passed',
        summary: 'historical pass',
        limitations: [],
        recordedAt: 10,
      }),
    })
    const value = await f.queries.evidence(document.id, {
      basisDigest: 'a'.repeat(64),
      candidateTreeOid: 'b'.repeat(40),
      profileDigests: {},
      environmentDigest: null,
      commitSha: null,
    })
    expect(value.evidence[0]!.freshness).toBe('unknown')
    expect(value.evidence[0]!.evidence.result).toBe('passed')
    expect(value.obligations[0]!.state).toBe('pending')
  })
})
