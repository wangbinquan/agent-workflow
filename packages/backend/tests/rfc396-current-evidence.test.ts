import { expect, spyOn, test } from 'bun:test'
import { canonicalJson, type GraphEvidenceBinding } from '@agent-workflow/shared'
import { composeGraphDevelopment } from '@/modules/development-automation/composition/graphDevelopment'
import { bookingDesign, graphFixture } from './helpers/graphDesign'
import { describeEachProvider } from './helpers/eachProvider'
import { projectGraphEvidence } from '@/modules/development-automation/domain/graph-development/evidence'

test('evidence uses the approved exact profile revision instead of silently switching to the newest release', () => {
  const oldDigest = 'a'.repeat(64)
  const evidence: GraphEvidenceBinding = {
    id: 'execution',
    kind: 'execution',
    basisDigest: 'b'.repeat(64),
    obligationIds: ['unique'],
    readSet: [],
    candidateTreeOid: 'c'.repeat(40),
    commitSha: null,
    profileRef: { id: 'checks', revision: 1, digest: oldDigest },
    environmentDigest: 'e'.repeat(64),
    executionRef: 'run',
    artifactRef: 'report',
    artifactDigest: 'f'.repeat(64),
    ci: null,
    result: 'passed',
    summary: '执行通过',
    limitations: [],
    recordedAt: 1,
  }
  const target = {
    document: bookingDesign(),
    basisDigest: evidence.basisDigest,
    candidateTreeOid: evidence.candidateTreeOid,
    environmentDigest: evidence.environmentDigest,
    commitSha: null,
    profileDigests: { checks: '2'.repeat(64), 'checks@1': oldDigest },
  }
  expect(projectGraphEvidence(evidence, target).freshness).toBe('current')
  expect(
    projectGraphEvidence(evidence, {
      ...target,
      profileDigests: { checks: oldDigest, 'checks@1': '' },
    }),
  ).toMatchObject({ freshness: 'stale', reasons: ['different-verification-profile'] })
})

describeEachProvider('RFC-396 current workspace evidence projection', (harness) => {
  test('a repair invalidates the retained green result before a new verification, and cannot be accepted as the old tree', async () => {
    const f = await graphFixture(harness.db)
    const document = await f.commands.document('design-a')
    document.elements.push({
      id: 'notification',
      kind: 'requirement',
      revision: 1,
      label: '独立通知',
      description: '独立通知',
      sourceIds: ['request'],
      obligationIds: ['notify'],
    })
    document.obligations.push({
      ...document.obligations[0]!,
      id: 'notify',
      statement: '独立通知验收',
      elementIds: ['notification'],
      concernIds: [],
    })
    const changedDocument = await f.commands.change('design-a', {
      expectedRevision: document.revision,
      requestId: 'separate-scope',
      document,
    })
    const preview = await f.commands.preview('design-a', {
      requestId: 'evidence-basis',
      expectedRevision: changedDocument.revision,
      includedElementIds: ['booking'],
    })
    const { basis } = await f.commands.basis('design-a', preview.basis.id)
    const tree = 'c'.repeat(40)
    let currentTree = tree
    const calls: unknown[] = []
    // Unused external boundaries deliberately have no implementation: this
    // exercises the production composition/query path without running a Task.
    type Input = Parameters<typeof composeGraphDevelopment>[0]
    const graph = composeGraphDevelopment({
      db: harness.db,
      appHome: '/tmp/rfc396-current-evidence',
      cases: f.cases,
      artifacts: {} as Input['artifacts'],
      rounds: {} as Input['rounds'],
      humanInputs: {} as Input['humanInputs'],
      executions: {} as Input['executions'],
      workspace: {} as Input['workspace'],
      content: {} as Input['content'],
      candidates: {
        async derive(input: unknown) {
          calls.push(input)
          return { ok: true, receipt: { treeOid: currentTree } }
        },
      } as Input['candidates'],
      verification: {
        async environment() {
          return { digest: 'e'.repeat(64), description: 'evidence fixture' }
        },
        create() {
          throw new Error('unexpected-verification-execution')
        },
      },
      async readCase() {
        throw new Error('unexpected-case-read')
      },
      assist: {
        async generate() {
          throw new Error('unexpected-assist')
        },
      },
    })
    const spies = [
      spyOn(graph.commands, 'document').mockImplementation(f.commands.document),
      spyOn(graph.commands, 'basis').mockImplementation(f.commands.basis),
      spyOn(graph.workspace, 'state').mockResolvedValue({
        workspacePath: '/tmp/rfc396-current-evidence/workspace',
        baselineRepoPath: '/tmp/rfc396-current-evidence/repository',
        baseline: basis.document.repositoryBaseline!,
        targetBranch: 'main',
        remoteHeadSha: 'a'.repeat(40),
      }),
    ]
    try {
      const record = await f.commands.beginRecord(
        'design-a',
        'verification:old',
        'verification',
        {},
      )
      await f.commands.finishRecord(record, 'completed', {
        basisId: basis.id,
        basisDigest: basis.digest,
        candidate: { treeOid: tree },
        environmentDigest: 'e'.repeat(64),
        profileDigests: {},
      })
      const evidence: GraphEvidenceBinding = {
        id: 'acceptance:old',
        kind: 'acceptance',
        basisDigest: basis.digest,
        obligationIds: ['unique'],
        readSet: basis.readSet,
        candidateTreeOid: tree,
        commitSha: null,
        profileRef: null,
        environmentDigest: null,
        executionRef: null,
        artifactRef: null,
        artifactDigest: null,
        ci: null,
        result: 'passed',
        summary: '人工核对通过',
        limitations: [],
        recordedAt: 1,
      }
      await f.store.insertLink({
        designId: 'design-a',
        id: evidence.id,
        kind: 'evidence',
        payloadJson: canonicalJson(evidence),
        createdAt: 1,
      })
      const verified = await graph.evidence('design-a')
      expect(verified.obligations[0]?.state).toBe('passed')
      expect(verified.candidate?.obligationIds).toEqual(['unique'])
      await expect(
        graph.accept(
          'design-a',
          {
            requestId: 'outside-acceptance',
            basisId: basis.id,
            candidateTreeOid: tree,
            obligationIds: ['notify'],
            result: 'passed',
            comment: '不属于本次实现',
          },
          'reviewer',
        ),
      ).rejects.toThrow('graph-acceptance-obligation-invalid')
      currentTree = 'd'.repeat(40)
      const changed = await graph.evidence('design-a')
      expect(changed.evidence[0]).toMatchObject({
        freshness: 'stale',
        reasons: ['different-candidate-content'],
      })
      expect(changed.obligations[0]?.state).toBe('pending')
      expect(changed.candidate).toBeNull()
      expect(calls.at(-1)).toMatchObject({
        overlayRoot: '/tmp/rfc396-current-evidence/workspace',
        baselineSha: 'a'.repeat(40),
      })
      await expect(
        graph.accept(
          'design-a',
          {
            requestId: 'late-acceptance',
            basisId: basis.id,
            candidateTreeOid: tree,
            obligationIds: ['unique'],
            result: 'passed',
            comment: '旧页面提交',
          },
          'reviewer',
        ),
      ).rejects.toThrow('graph-acceptance-candidate-mismatch')
      expect(await f.store.record('design-a', 'acceptance:late-acceptance')).toBeNull()
      spies[2]!.mockRejectedValue(new Error('workspace temporarily unavailable'))
      expect((await graph.evidence('design-a')).obligations[0]?.state).toBe('pending')
    } finally {
      spies.forEach((spy) => spy.mockRestore())
    }
  })
})
