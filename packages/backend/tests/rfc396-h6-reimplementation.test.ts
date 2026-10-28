// RFC-396 H6, hosted acceptance 2026-10-28, Case 01M5ZZCVCM0S9Y9JNQRQRPVW1V:
// explicit re-implementation may retain the completed tree, including after MR handoff.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson } from '@agent-workflow/shared'
import { createGraphEmployeeWorkspace } from '@/modules/development-automation/infrastructure/graph-development/employeeWorkspace'
import { createFileAutomationWorkspaceEffectsFactory } from '@/modules/development-automation/infrastructure/local/fileAutomationWorkspaceEffects'
import { graphEmployeeRuntimeCodec } from '@/modules/development-automation/application/graph-development/employeeCodec'
import { createGraphExecutionConsumption } from '@/modules/development-automation/application/graph-development/executionConsumption'
import { describeEachProvider } from './helpers/eachProvider'
import { graphFixture } from './helpers/graphDesign'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describeEachProvider('RFC-396 H6 unchanged implementation rounds', (harness) => {
  async function fixture(continuation: boolean) {
    const home = mkdtempSync(join(tmpdir(), 'rfc396-h6-'))
    homes.push(home)
    const f = await graphFixture(harness.db)
    const document = await f.commands.document('design-a')
    const basis = (
      await f.commands.preview(document.id, {
        requestId: 'basis',
        expectedRevision: document.revision,
        includedElementIds: ['booking'],
      })
    ).basis
    const initial = JSON.parse(
      graphEmployeeRuntimeCodec.buildInitialCaseJson(
        JSON.stringify({
          caseRef: 'case-a',
          employeeRef: { id: 'employee', revision: 1 },
          workScopeJson: '{"kind":"task"}',
          intake: {
            kind: 'body',
            body: 'booking',
            target: { repositoryId: 'repo-a' },
            uploads: [],
          },
        }),
      ),
    )
    const work = { ...JSON.parse(initial.primaryContextJson), designId: document.id }
    const payload = await f.artifacts.put([
      {
        path: 'request.json',
        content: canonicalJson({
          basisId: basis.id,
          basisDigest: basis.digest,
          review: { decision: 'approved', basisDigest: basis.digest },
        }),
      },
    ])
    const requested = await f.commands.beginRecord(
      document.id,
      'implementation:request',
      'implementation',
      {},
    )
    await f.commands.finishRecord(requested, 'accepted', { payload, eventId: 'implement' })
    let roundRef = 'first'
    const plan = () => ({
      roundRef,
      executionNonce: roundRef,
      caseRef: { id: 'case-a' },
      employeeTypeRef: { typeId: 'graph-development', revision: 2 },
      workItemRef: 'implement-change',
      inputEnvelopeJson: canonicalJson({
        contextsJson: canonicalJson([
          {
            id: 'context',
            revision: 1,
            typeId: 'graph-development.design-context',
            stateJson: canonicalJson(work),
          },
        ]),
        eventJson: canonicalJson({ eventId: 'implement', payloadArtifactRef: payload.artifactRef }),
      }),
    })
    const original = join(home, 'original'),
      continued = join(home, 'continued')
    for (const path of [original, continued]) {
      mkdirSync(join(path, '.git'), { recursive: true })
      writeFileSync(join(path, '.git', 'HEAD'), 'original metadata')
      writeFileSync(join(path, 'booking.ts'), 'previous implementation')
    }
    const state = (workspacePath: string) => ({
      workspacePath,
      baselineRepoPath: home,
      baseline: basis.document.repositoryBaseline!,
      targetBranch: 'main',
      remoteHeadSha: 'a'.repeat(40),
    })
    const workspaceRecord = await f.commands.beginRecord(document.id, 'workspace', 'workspace', {})
    await f.commands.finishRecord(workspaceRecord, 'ready', state(original))
    const rounds = {
      frozenPlan: async () => ({ caseId: 'case-a', planJson: canonicalJson(plan()) }),
      lastSettledRound: async () => null,
    }
    const consumption = createGraphExecutionConsumption({
      ...f,
      rounds,
      executions: { read: async () => null },
      humanInputs: { clarificationRounds: async () => [], reviewDecision: async () => null },
    })
    const unexpectedWorkspaceOperation = async () => {
      throw new Error('unexpected-workspace-operation')
    }
    const workspace = createGraphEmployeeWorkspace({
      ...f,
      rounds,
      appHome: home,
      factory: createFileAutomationWorkspaceEffectsFactory(),
      sourceControl: {
        checkpoint: async () => ({ checkpointDigest: '1'.repeat(64) }),
        materialize: unexpectedWorkspaceOperation,
        rematerialize: unexpectedWorkspaceOperation,
        fetchRemoteHead: unexpectedWorkspaceOperation,
        restore: unexpectedWorkspaceOperation,
        discard: unexpectedWorkspaceOperation,
        resolveBaseline: unexpectedWorkspaceOperation,
        importCommit: unexpectedWorkspaceOperation,
      },
      repositoryPreparation: {
        prepare: async () => ({ id: 'repo-a', localPath: home, defaultBranch: 'main' }),
      },
      inputArtifacts: {
        copyBlobTo() {
          throw new Error('unexpected-upload')
        },
      },
      consumeResult: consumption.consume,
      verificationProfiles: async () => [],
      continuationWorkspace: async () => (continuation ? state(continued) : null),
    })
    const result = {
      traceProposals: [],
      testRefs: [],
      limitations: ['Platform verification is pending'],
      deliveryContent: { commitMessage: 'booking', title: 'booking', description: '' },
    }
    const outputJson = canonicalJson({ summary: 'Implementation report', result })
    return {
      ...f,
      workspace,
      path: continuation ? continued : original,
      result,
      async prepare(ref = 'first', ordinal = 1) {
        roundRef = ref
        return workspace.prepare({
          planJson: canonicalJson(plan()),
          attemptJson: canonicalJson({ ordinal, mode: 'resume' }),
        })
      },
      validate: () => workspace.validate({ roundRef, taskStatus: 'done', outputJson }),
      async earlier(ref = 'earlier') {
        await f.store.insertLink({
          designId: document.id,
          id: `implementation:${ref}`,
          kind: 'execution',
          payloadJson: canonicalJson({
            kind: 'implementation',
            basisId: basis.id,
            basisDigest: basis.digest,
            roundRef: ref,
            result,
          }),
          createdAt: 1,
        })
      },
    }
  }
  for (const continuation of [false, true]) {
    const label = continuation ? 'MR continuation' : 'original workspace'
    test(`${label}: the first implementation and a same-round replay still require a change`, async () => {
      const f = await fixture(continuation)
      await f.prepare()
      expect(await f.validate()).toMatchObject({
        ok: false,
        errorCode: 'graph-workspace-outcome-workspace-mismatch',
      })
      await f.earlier('first')
      expect(await f.validate()).toMatchObject({
        ok: false,
        errorCode: 'graph-workspace-outcome-workspace-mismatch',
      })
    })
    test(`${label}: unchanged re-implementation consumes a new report and code-feedback proposal`, async () => {
      const f = await fixture(continuation)
      await f.earlier()
      await f.prepare('again')
      expect(await f.validate()).toEqual({ ok: true })
      expect(await f.validate()).toEqual({ ok: true })
      const link = (await f.store.links('design-a')).find(
        (link) => link.id === 'implementation:again',
      )!
      expect(JSON.parse(link.payloadJson)).toMatchObject({ roundRef: 'again', result: f.result })
      const proposal = await f.queries.proposal('design-a', 'code-feedback:again')
      expect(proposal.invocationRef).toBe('again')
      expect(proposal.document.concerns.at(-1)?.statement).toBe(f.result.limitations[0])
    })
    test(`${label}: changed paths and retries retain the round's first snapshot`, async () => {
      const f = await fixture(continuation)
      await f.earlier()
      await f.prepare('again')
      writeFileSync(join(f.path, 'booking.ts'), 'corrected implementation')
      writeFileSync(join(f.path, 'test.ts'), 'new test')
      await f.prepare('again', 2)
      const first = JSON.parse((await f.store.record('design-a', 'scene:again:1'))!.payloadJson)
      const retry = JSON.parse((await f.store.record('design-a', 'scene:again:2'))!.payloadJson)
      expect(retry.business).toEqual(first.business)
      expect(await f.validate()).toEqual({ ok: true })
    })
    for (const root of ['.git/HEAD', '.agent-workflow/inputs/graph/again/design.json'])
      test(`${label}: unchanged business files do not bypass ${root} validation`, async () => {
        const f = await fixture(continuation)
        await f.earlier()
        await f.prepare('again')
        writeFileSync(join(f.path, root), 'changed protected material')
        expect(await f.validate()).toMatchObject({
          ok: false,
          errorCode: 'graph-workspace-protected-root-write',
        })
        expect(
          (await f.store.links('design-a')).some((link) => link.id === 'implementation:again'),
        ).toBe(false)
      })
  }
})
