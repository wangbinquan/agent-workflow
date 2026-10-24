// RFC-396: publication advances the baseline, not the content identity of a
// verified tree. Exercise the real Git candidate adapter and evidence projection;
// the retained execution bindings below are fixtures, not profile executions.
import { expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalJson,
  type GraphEvidenceBinding,
  type RepositoryContentBaseline,
} from '@agent-workflow/shared'
import { composeGraphDevelopment } from '@/modules/development-automation/composition/graphDevelopment'
import { graphDigest } from '@/modules/development-automation/domain/graph-development/model'
import {
  verificationProfileContentDigest,
  type VerificationProfileContent,
} from '@/modules/development-automation/domain/verificationProfile'
import { createVerificationProfilePersistence } from '@/modules/development-automation/infrastructure/configResourceStore'
import { EvidenceStore } from '@/modules/development-automation/infrastructure/evidenceStore'
import { createGraphDesignArtifacts } from '@/modules/development-automation/infrastructure/graph-development/designArtifacts'
import {
  bindCandidateDeliveryParticipant,
  bindChangeCandidateParticipant,
} from '@/modules/source-control/composition/repositoryCandidate'
import { describeEachProvider } from './helpers/eachProvider'
import { graphFixture } from './helpers/graphDesign'

type Input = Parameters<typeof composeGraphDevelopment>[0]
type Stage = Extract<Awaited<ReturnType<Input['candidates']['stage']>>, { ok: true }>

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd })
  if (result.exitCode) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function commit(repository: string, content: string, message: string) {
  writeFileSync(join(repository, 'booking.json'), content)
  git(repository, 'add', 'booking.json')
  git(
    repository,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-qm',
    message,
  )
  return {
    kind: 'commit' as const,
    commitSha: git(repository, 'rev-parse', 'HEAD'),
    treeOid: git(repository, 'rev-parse', 'HEAD^{tree}'),
  }
}

describeEachProvider('RFC-396 published evidence uses the actual Git tree', (harness) => {
  test('baseline advancement preserves only matching evidence and later file, environment and design drift invalidate it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc396-current-evidence-'))
    const stages: Stage[] = []
    const restore: (() => void)[] = []
    try {
      const repository = join(root, 'repository')
      const graphWorkspace = join(root, 'graph-workspace')
      const careWorkspace = join(root, 'care-workspace')
      for (const path of [repository, graphWorkspace, careWorkspace]) mkdirSync(path)
      git(repository, 'init', '-q', '-b', 'main')
      const baseline = commit(repository, '{"implemented":false}', 'baseline')
      const initialContent = '{"implemented":true,"pipelineRevision":"initial"}'
      const repairedContent = '{"implemented":true,"pipelineRevision":"repaired"}'
      const initial = commit(repository, initialContent, 'initial delivery')
      for (const path of [graphWorkspace, careWorkspace])
        writeFileSync(join(path, 'booking.json'), initialContent)

      const f = await graphFixture(harness.db, baseline)
      const profiles = createVerificationProfilePersistence(harness.db)
      const profile: VerificationProfileContent = {
        schemaVersion: 1,
        stopPolicy: 'first-failure',
        maxParallel: 1,
        steps: [
          {
            stepId: 'booking-check',
            programRef: 'repo:verify.js',
            argsRef: null,
            timeoutMs: 5000,
            networkProfileRef: 'default',
            successExitCodes: [0],
            evidenceSelectors: [{ kind: 'stdout-tail', value: 1000 }],
          },
        ],
      }
      const profileRef = {
        id: 'checks',
        revision: 1,
        digest: verificationProfileContentDigest(profile),
      }
      await profiles.create({
        id: profileRef.id,
        name: 'checks',
        draftJson: canonicalJson(profile),
        ownerUserId: null,
        extra: {},
        now: 1,
      })
      await profiles.publishRevision({
        resourceId: profileRef.id,
        revision: profileRef.revision,
        contentJson: canonicalJson(profile),
        contentDigest: profileRef.digest,
        publishedBy: null,
        publishedAt: 2,
      })
      const document = await f.commands.document('design-a')
      document.obligations[0]!.verification = {
        kind: 'execution',
        profileRef,
        testRefs: ['verify.js#booking-check'],
      }
      const changed = await f.commands.change(document.id, {
        requestId: 'execution-obligation',
        expectedRevision: document.revision,
        document,
      })
      const { basis } = await f.commands.preview(document.id, {
        requestId: 'approved-scope',
        expectedRevision: changed.revision,
        includedElementIds: ['booking'],
      })
      const evidence = new EvidenceStore(join(root, 'evidence'))
      const artifacts = createGraphDesignArtifacts(evidence)
      const expectedEnvironmentDigest = 'e'.repeat(64)
      let environmentDigest = expectedEnvironmentDigest
      let unreadableEnvironment = false
      const environment: NonNullable<Input['verification']['environment']> = async () => {
        if (unreadableEnvironment) throw new Error('environment temporarily unavailable')
        return { digest: environmentDigest, description: 'current-tree projection fixture' }
      }
      const verification: Input['verification'] = {
        environment,
        create() {
          throw new Error('this projection test does not execute profiles')
        },
      }
      const realCandidates = {
        ...bindChangeCandidateParticipant(),
        ...bindCandidateDeliveryParticipant(),
      }
      const candidates: Input['candidates'] = {
        ...realCandidates,
        async stage(request) {
          const staged = await realCandidates.stage(request)
          if (staged.ok) stages.push(staged)
          return staged
        },
      }
      const graph = composeGraphDevelopment({
        db: harness.db,
        appHome: root,
        cases: f.cases,
        artifacts: evidence,
        rounds: {} as Input['rounds'],
        humanInputs: {} as Input['humanInputs'],
        executions: {} as Input['executions'],
        workspace: {} as Input['workspace'],
        content: {} as Input['content'],
        candidates,
        verification,
        async readCase() {
          throw new Error('unexpected-case-read')
        },
        assist: {
          async generate() {
            throw new Error('unexpected-assist')
          },
        },
      })
      type Continuation = Awaited<ReturnType<typeof graph.care.continuationWorkspace>>
      let continuation: Continuation = null
      const spies = [
        spyOn(graph.commands, 'document').mockImplementation(f.commands.document),
        spyOn(graph.commands, 'basis').mockImplementation(f.commands.basis),
        spyOn(graph.workspace, 'state').mockResolvedValue({
          workspacePath: graphWorkspace,
          baselineRepoPath: repository,
          baseline,
          targetBranch: 'main',
          remoteHeadSha: baseline.commitSha,
        }),
        spyOn(graph.care, 'continuationWorkspace').mockImplementation(async () => continuation),
      ]
      restore.push(...spies.map((spy) => () => spy.mockRestore()))
      function published(current: typeof initial): NonNullable<Continuation> {
        return {
          workspacePath: careWorkspace,
          baselineRepoPath: repository,
          baseline: current,
          targetBranch: 'main',
          remoteHeadSha: current.commitSha,
          uploadPlan: undefined,
          uploadsAlreadyPublished: true,
        }
      }
      async function retainedExecution(id: string, treeOid: string, recordedAt: number) {
        const record = await f.commands.beginRecord(
          document.id,
          `verification:${id}`,
          'verification',
          {},
        )
        await f.commands.finishRecord(record, 'completed', {
          basisId: basis.id,
          basisDigest: basis.digest,
          candidate: { treeOid },
          environmentDigest: expectedEnvironmentDigest,
          profileDigests: { 'checks@1': profileRef.digest },
        })
        const artifact = await artifacts.put([
          {
            path: 'execution.json',
            content: canonicalJson({ fixture: 'projection-only', treeOid }),
          },
        ])
        const binding: GraphEvidenceBinding = {
          id: `execution:${id}`,
          kind: 'execution',
          basisDigest: basis.digest,
          obligationIds: ['unique'],
          readSet: basis.readSet,
          candidateTreeOid: treeOid,
          commitSha: null,
          profileRef,
          environmentDigest: expectedEnvironmentDigest,
          executionRef: `fixture:${id}`,
          artifactRef: artifact.artifactRef,
          artifactDigest: artifact.digest,
          ci: null,
          result: 'passed',
          summary: 'Retained execution binding fixture',
          limitations: [],
          recordedAt,
        }
        await f.store.insertLink({
          designId: document.id,
          id: binding.id,
          kind: 'evidence',
          payloadJson: canonicalJson(binding),
          createdAt: recordedAt,
        })
      }
      function derive(current: RepositoryContentBaseline, overlayRoot: string) {
        if (current.kind !== 'commit') throw new Error('expected a real published commit')
        return realCandidates.derive({
          repositoryBaseline: current,
          baselineRepoPath: repository,
          baselineSha: current.commitSha,
          overlayRoot,
          excludePolicyDigest: graphDigest(['.git', '.agent-workflow']),
          agentOutcomeRef: 'current-evidence-fixture',
        })
      }
      const execution = (result: Awaited<ReturnType<typeof graph.evidence>>, id: string) =>
        result.evidence.find((item) => item.evidence.id === `execution:${id}`)
      const assertStagesCleaned = () => {
        expect(stages.length).toBeGreaterThan(0)
        expect(stages.every((stage) => !existsSync(stage.ws))).toBe(true)
      }

      await retainedExecution('initial', initial.treeOid, 1)
      expect(await derive(baseline, graphWorkspace)).toMatchObject({
        ok: true,
        receipt: { treeOid: initial.treeOid },
      })
      expect(execution(await graph.evidence(document.id), 'initial')).toMatchObject({
        freshness: 'current',
        reasons: [],
      })
      continuation = published(initial)
      // Publishing the verified content leaves no new delivery candidate. It
      // must not erase the tree identity used by the evidence query.
      expect(await derive(initial, careWorkspace)).toMatchObject({
        ok: false,
        code: 'candidate-empty',
      })
      const firstPublished = await graph.evidence(document.id)
      expect(execution(firstPublished, 'initial')?.freshness).toBe('current')
      expect(firstPublished.obligations[0]?.state).toBe('passed')
      assertStagesCleaned()

      writeFileSync(join(careWorkspace, 'booking.json'), repairedContent)
      const unverifiedRepair = await graph.evidence(document.id)
      expect(execution(unverifiedRepair, 'initial')).toMatchObject({
        freshness: 'stale',
        reasons: ['different-candidate-content'],
      })
      expect(unverifiedRepair.obligations[0]?.state).toBe('pending')
      expect(unverifiedRepair.candidate).toBeNull()
      const repaired = commit(repository, repairedContent, 'publish repaired delivery')
      expect(repaired.treeOid).not.toBe(initial.treeOid)
      await retainedExecution('repair', repaired.treeOid, 2)
      continuation = published(repaired)
      expect(await derive(repaired, careWorkspace)).toMatchObject({
        ok: false,
        code: 'candidate-empty',
      })
      const repairedEvidence = await graph.evidence(document.id)
      expect(execution(repairedEvidence, 'repair')).toMatchObject({
        freshness: 'current',
        reasons: [],
      })
      expect(execution(repairedEvidence, 'initial')).toMatchObject({
        freshness: 'stale',
        reasons: ['different-candidate-content'],
      })
      expect(repairedEvidence.candidate?.candidateTreeOid).toBe(repaired.treeOid)
      expect(repairedEvidence.obligations[0]).toMatchObject({
        state: 'passed',
        evidenceIds: ['execution:repair'],
      })

      // A retained execution tree is not a substitute for reading the files.
      writeFileSync(join(careWorkspace, 'booking.json'), '{"implemented":false,"drift":true}')
      const drifted = await graph.evidence(document.id)
      expect(execution(drifted, 'repair')?.reasons).toEqual(['different-candidate-content'])
      expect(drifted.obligations[0]?.state).toBe('pending')
      expect(drifted.candidate).toBeNull()
      expect(
        JSON.parse((await f.store.record(document.id, 'verification:repair'))!.payloadJson)
          .candidate.treeOid,
      ).toBe(repaired.treeOid)
      writeFileSync(join(careWorkspace, 'booking.json'), repairedContent)
      expect(execution(await graph.evidence(document.id), 'repair')?.freshness).toBe('current')

      environmentDigest = 'f'.repeat(64)
      const changedEnvironment = await graph.evidence(document.id)
      expect(execution(changedEnvironment, 'repair')?.reasons).toEqual(['different-environment'])
      expect(changedEnvironment.obligations[0]?.state).toBe('pending')
      environmentDigest = expectedEnvironmentDigest
      delete verification.environment
      expect(execution(await graph.evidence(document.id), 'repair')?.reasons).toEqual([
        'different-environment',
      ])
      verification.environment = environment
      unreadableEnvironment = true
      const unavailable = await graph.evidence(document.id)
      expect(execution(unavailable, 'repair')?.freshness).toBe('stale')
      expect(unavailable.obligations[0]?.state).toBe('pending')
      expect(unavailable.candidate).toBeNull()
      assertStagesCleaned()
      unreadableEnvironment = false

      const changedDesign = await f.commands.document(document.id)
      changedDesign.elements[0]!.description = '预约策略已更改，需要重新审核'
      await f.commands.change(document.id, {
        requestId: 'design-drift',
        expectedRevision: changedDesign.revision,
        document: changedDesign,
      })
      const staleDesign = await graph.evidence(document.id)
      expect(execution(staleDesign, 'repair')?.reasons).toContain('changed:booking')
      expect(staleDesign.obligations[0]?.state).toBe('pending')
      expect(staleDesign.candidate).toBeNull()
      assertStagesCleaned()
    } finally {
      restore.forEach((undo) => undo())
      for (const stage of stages) await stage.cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
