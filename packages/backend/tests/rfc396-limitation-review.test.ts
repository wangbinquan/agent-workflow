// RFC-396 H5, hosted acceptance 2026-10-28, Case 01M5ZZCVCM0S9Y9JNQRQRPVW1V:
// a person's exact-report judgment is evidence, not an implementation or obligation pass.
import { expect, spyOn, test } from 'bun:test'
import { canonicalJson } from '@agent-workflow/shared'
import {
  graphObligationCoverage,
  projectGraphEvidence,
} from '@/modules/development-automation/domain/graph-development/evidence'
import { describeEachProvider } from './helpers/eachProvider'
import { graphFixture } from './helpers/graphDesign'
import {
  codeFeedbackProposal,
  implementationReport,
  limitationReviewCommand,
} from './helpers/graphLimitationReview'

const limitations = ['平台独立执行尚未发生。', '明确排除的需求未实现。']
const request = {
  requestId: 'human-judgment',
  comment: '这两项分别是待执行验证和明确排除项，不属于实现缺口。',
}

describeEachProvider('RFC-396 H5 limitation review command', (harness) => {
  async function fixture(
    options: { kind?: string; missing?: boolean; limitations?: readonly string[] } = {},
  ) {
    const f = await graphFixture(harness.db)
    const document = await f.commands.document('design-a')
    const basis = (
      await f.commands.preview(document.id, {
        requestId: 'basis',
        expectedRevision: document.revision,
        includedElementIds: ['booking'],
      })
    ).basis
    const texts = [...(options.limitations ?? limitations)]
    const proposal = await codeFeedbackProposal(f, basis, 'build', texts, options.kind)
    if (!options.missing) await implementationReport(f, basis, 'build', texts, 10)
    const record = await f.commands.beginRecord(
      document.id,
      'verification:checks',
      'verification',
      {},
    )
    await f.commands.finishRecord(record, 'completed', {
      basisId: basis.id,
      basisDigest: basis.digest,
      implementationRoundRef: 'build',
      candidate: { treeOid: 'c'.repeat(40) },
      result: { passed: false, limitations: texts },
    })
    let tree = 'c'.repeat(40)
    const changes: string[] = []
    const review = limitationReviewCommand(f, {
      currentTree: () => tree,
      changed: (id) => changes.push(id),
    })
    return {
      ...f,
      basis,
      proposal,
      changes,
      review,
      judge: (input = request, actor = 'human') => review(document.id, proposal.id, input, actor),
      setTree(value: string) {
        tree = value
      },
    }
  }
  test('records exact texts, actor and time, rejects the proposal, and replays the same evidence', async () => {
    const f = await fixture()
    const evidence = await f.judge()
    expect(evidence).toMatchObject({
      kind: 'limitation-review',
      result: 'passed',
      summary: request.comment,
      executionRef: 'build',
      limitations,
      obligationIds: [],
      candidateTreeOid: null,
      basisDigest: f.basis.digest,
    })
    const artifact = await f.queries.evidenceArtifacts('design-a', evidence.id)
    expect(JSON.parse(artifact.files[0]!.content)).toEqual({
      ...request,
      proposalId: f.proposal.id,
      designId: 'design-a',
      actorUserId: 'human',
      recordedAt: evidence.recordedAt,
      roundRef: 'build',
      basisDigest: f.basis.digest,
      candidateTreeOid: 'c'.repeat(40),
      limitations,
    })
    expect(artifact.files[0]!.path).toBe('limitation-review.json')
    expect((await f.queries.proposal('design-a', f.proposal.id)).status).toBe('rejected')
    expect(await f.judge()).toEqual(evidence)
    expect(f.changes).toEqual(['case-a'])
    expect(
      (await f.store.links('design-a')).filter((link) => link.id === evidence.id),
    ).toHaveLength(1)
    expect(
      (await f.queries.workspace('design-a')).requests.some(
        (item) => item.kind === 'limitation-review',
      ),
    ).toBe(true)
    await expect(
      f.commands.applyProposal('design-a', f.proposal.id, 'apply'),
    ).rejects.toMatchObject({ code: 'graph-proposal-already-decided' })
    for (const input of [
      { ...request, comment: 'different' },
      { ...request, comment: request.comment + ' ' },
    ])
      await expect(f.judge(input)).rejects.toMatchObject({
        code: 'graph-request-reused-with-different-input',
      })
    await expect(f.judge(request, 'other-human')).rejects.toMatchObject({
      code: 'graph-request-reused-with-different-input',
    })
    await expect(
      f.review('design-a', 'different-proposal', request, 'human'),
    ).rejects.toMatchObject({ code: 'graph-request-reused-with-different-input' })
  })
  test('projection follows basis and read freshness but never covers an obligation', async () => {
    const f = await fixture()
    const evidence = await f.judge()
    const target = {
      document: await f.commands.document('design-a'),
      basisDigest: f.basis.digest,
      candidateTreeOid: 'c'.repeat(40),
      profileDigests: {},
      environmentDigest: null,
      commitSha: null,
    }
    const projected = await f.queries.evidence('design-a', target)
    expect(projected.evidence[0]?.freshness).toBe('current')
    expect(projected.obligations).toEqual([
      { obligationId: 'unique', state: 'pending', evidenceIds: [] },
    ])
    expect(
      graphObligationCoverage(target.document, [
        projectGraphEvidence({ ...evidence, obligationIds: ['unique'] }, target),
      ])[0]?.state,
    ).toBe('pending')
    expect(
      projectGraphEvidence(evidence, { ...target, basisDigest: 'f'.repeat(64) }).freshness,
    ).toBe('stale')
    // A care repair changes the candidate but not the judged report.
    expect(
      projectGraphEvidence(evidence, { ...target, candidateTreeOid: 'd'.repeat(40) }).freshness,
    ).toBe('current')
    target.document.elements[0]!.description = 'changed design'
    expect(projectGraphEvidence(evidence, target).freshness).toBe('stale')
  })
  for (const [name, options, code] of [
    ['non-code-feedback', { kind: 'semantic-change' }, 'graph-limitation-review-proposal-invalid'],
    ['missing implementation', { missing: true }, 'graph-limitation-review-implementation-missing'],
    ['empty limitations', { limitations: [] }, 'graph-limitation-review-limitations-empty'],
  ] as const)
    test(`rejects ${name}`, async () => {
      const f = await fixture(options)
      await expect(f.judge()).rejects.toMatchObject({ code })
      expect(await f.store.record('design-a', 'limitation-review:human-judgment')).toBeNull()
    })
  for (const status of ['accepted', 'rejected', 'stale'])
    test(`rejects proposal status ${status}`, async () => {
      const f = await fixture()
      const stored = (await f.store.record('design-a', `proposal:${f.proposal.id}`))!
      await f.store.updateRecord({ ...stored, status, version: stored.version + 1 }, stored.version)
      await expect(f.judge()).rejects.toMatchObject({ code: 'graph-proposal-already-decided' })
    })
  test('requires a nonblank reason and enforces 20,000 UTF-16 units without normalizing request identity', async () => {
    const f = await fixture()
    for (const comment of ['', ' \n\t ', '😀'.repeat(10_001)])
      await expect(f.judge({ ...request, comment })).rejects.toMatchObject({
        code: 'graph-request-invalid',
      })
    const comment = '😀'.repeat(10_000)
    expect((await f.judge({ ...request, comment })).summary).toBe(comment)
  })
  test('only the latest implementation report can be judged', async () => {
    const f = await fixture()
    await implementationReport(f, f.basis, 'new-build', limitations, 11)
    await expect(f.judge()).rejects.toMatchObject({
      code: 'graph-limitation-review-implementation-not-latest',
    })
  })
  for (const drift of ['basis', 'round', 'design', 'candidate', 'missing-verification'])
    test(`rejects stale ${drift}`, async () => {
      const f = await fixture()
      if (drift === 'candidate') f.setTree('d'.repeat(40))
      else if (drift === 'design') {
        const document = await f.commands.document('design-a')
        document.elements[0]!.description = 'new implementation contract'
        await f.commands.change(document.id, {
          requestId: 'edit',
          expectedRevision: document.revision,
          document,
        })
      } else {
        const record = (await f.store.record('design-a', 'verification:checks'))!
        const payload = JSON.parse(record.payloadJson)
        if (drift === 'basis') payload.basisDigest = 'd'.repeat(64)
        if (drift === 'round') payload.implementationRoundRef = 'older-round'
        await f.store.updateRecord(
          {
            ...record,
            status: drift === 'missing-verification' ? 'requested' : 'completed',
            version: record.version + 1,
            payloadJson: canonicalJson(payload),
          },
          record.version,
        )
      }
      await expect(f.judge()).rejects.toMatchObject({
        code: 'graph-limitation-review-candidate-mismatch',
      })
    })
  test('a retry completes the same prepared judgment after proposal rejection and an interrupted evidence write', async () => {
    const f = await fixture()
    const insert = f.store.insertLink.bind(f.store)
    const failure = spyOn(f.store, 'insertLink').mockImplementation(async (link) => {
      if (link.id.startsWith('limitation-review:')) throw new Error('interrupted-evidence-write')
      await insert(link)
    })
    try {
      await expect(f.judge()).rejects.toThrow('interrupted-evidence-write')
    } finally {
      failure.mockRestore()
    }
    expect((await f.queries.proposal('design-a', f.proposal.id)).status).toBe('rejected')
    const evidence = await f.judge()
    expect(await f.judge()).toEqual(evidence)
    expect((await f.store.record('design-a', evidence.id))?.status).toBe('completed')
  })
})
