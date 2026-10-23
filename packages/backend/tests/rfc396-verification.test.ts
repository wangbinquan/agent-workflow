// RFC-396: actual Git candidate + executable profile, and evidence never trusts agent claims.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphEvidenceBindingSchema, canonicalJson } from '@agent-workflow/shared'
import {
  bindChangeCandidateParticipant,
  bindCandidateDeliveryParticipant,
} from '@/modules/source-control/composition/repositoryCandidate'
import { composeLocalRepositoryRevisionContent } from '@/modules/source-control/composition/repositoryRevisionContent'
import { createGraphVerification } from '@/modules/development-automation/application/graph-development/verification'
import { createVerificationProfilePersistence } from '@/modules/development-automation/infrastructure/configResourceStore'
import { createLocalVerificationCommandEffectsFactory } from '@/modules/development-automation/infrastructure/local/verificationCommandEffects'
import {
  verificationProfileContentDigest,
  type VerificationProfileContent,
} from '@/modules/development-automation/domain/verificationProfile'
import { EvidenceStore } from '@/modules/development-automation/infrastructure/evidenceStore'
import { describeEachProvider } from './helpers/eachProvider'
import { graphFixture } from './helpers/graphDesign'
import { createGraphPlatformWorkItems } from '@/modules/development-automation/application/graph-development/platformWorkItems'
import { graphEmployeeRuntimeCodec } from '@/modules/development-automation/application/graph-development/employeeCodec'
import { createGraphDesignArtifacts } from '@/modules/development-automation/infrastructure/graph-development/designArtifacts'

const homes: string[] = []
afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true })
})
function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(['git', ...args], { cwd })
  if (r.exitCode) throw new Error(r.stderr.toString())
  return r.stdout.toString().trim()
}

describeEachProvider('RFC-396 candidate verification', (harness) => {
  async function fixture(
    mode: 'passed' | 'failed' | 'timeout' | 'missing-trace' | 'manual' | 'limited' | 'report-only',
    references: { obligation?: string; trace?: string | null; declared?: readonly string[] } = {},
  ) {
    const root = mkdtempSync(join(tmpdir(), 'rfc396-verify-'))
    homes.push(root)
    const repo = join(root, 'repo'),
      ws = join(root, 'ws')
    mkdirSync(repo)
    mkdirSync(ws)
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'README.md'), 'baseline')
    git(repo, 'add', 'README.md')
    git(
      repo,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=f@example.test',
      'commit',
      '-qm',
      'baseline',
    )
    const baseline = {
      kind: 'commit' as const,
      commitSha: git(repo, 'rev-parse', 'HEAD'),
      treeOid: git(repo, 'rev-parse', 'HEAD^{tree}'),
    }
    const program =
      '#!/usr/bin/env bun\n' +
      (mode === 'report-only'
        ? 'await Bun.write("report.xml", "<failure>actual assertion failed</failure>"); await Bun.write("binary.dat", new Uint8Array([0,255,128])); process.exit(3);'
        : mode === 'timeout'
          ? 'await Bun.sleep(10000);'
          : mode === 'failed'
            ? 'console.log("all passed"); process.exit(3);'
            : 'if ((await import("./booking.js")).reserve() !== "预约") process.exit(2); console.log("booking-test");')
    writeFileSync(join(ws, 'booking.js'), 'export const reserve = () => "预约";\n')
    writeFileSync(join(ws, 'verify.js'), program + '\n// booking-test\n')
    chmodSync(join(ws, 'verify.js'), 0o755)
    const f = await graphFixture(harness.db)
    // Establish the real baseline at creation; the production edit command never changes it.
    const initial = await f.commands.document('design-a')
    const seeded = { ...initial, repositoryBaseline: baseline, revision: initial.revision + 1 }
    const artifact = await f.artifacts.put([
      { path: 'design.json', content: canonicalJson(seeded) },
    ])
    await f.store.commit({
      expectedRevision: initial.revision,
      requestDigest: 'a'.repeat(64),
      revision: {
        ...artifact,
        designId: seeded.id,
        revision: seeded.revision,
        requestId: 'fixture-baseline',
        createdAt: 10,
      },
    })
    const profiles = createVerificationProfilePersistence(harness.db)
    const profile: VerificationProfileContent = {
      schemaVersion: 1,
      stopPolicy: 'first-failure',
      maxParallel: 1,
      steps: [
        {
          stepId: 'tests',
          programRef: 'repo:verify.js',
          argsRef: null,
          timeoutMs: mode === 'timeout' ? 100 : 5000,
          networkProfileRef: 'default',
          successExitCodes: [0],
          evidenceSelectors:
            mode === 'report-only'
              ? [
                  { kind: 'file-glob', value: 'report.xml' },
                  { kind: 'file-glob', value: 'binary.dat' },
                ]
              : [{ kind: 'stdout-tail', value: 4000 }],
        },
      ],
    }
    const digest = verificationProfileContentDigest(profile)
    await profiles.create({
      id: 'checks',
      name: 'checks',
      draftJson: JSON.stringify(profile),
      ownerUserId: null,
      extra: {},
      now: 1,
    })
    await profiles.publishRevision({
      resourceId: 'checks',
      revision: 1,
      contentJson: JSON.stringify(profile),
      contentDigest: digest,
      publishedBy: null,
      publishedAt: 2,
    })
    const document = await f.commands.document('design-a')
    if (mode !== 'manual')
      document.obligations[0]!.verification = {
        kind: 'execution',
        profileRef: { id: 'checks', revision: 1, digest },
        testRefs: [references.obligation ?? 'verify.js#booking-test'],
      }
    const changed = await f.commands.change(document.id, {
      expectedRevision: document.revision,
      requestId: 'profile',
      document,
    })
    const basis = (
      await f.commands.preview(document.id, {
        requestId: 'basis',
        expectedRevision: changed.revision,
        includedElementIds: ['booking'],
      })
    ).basis
    const result = {
      traceProposals: [
        {
          elementId: 'booking',
          obligationId: 'unique',
          path: mode === 'missing-trace' ? 'imaginary.js' : 'booking.js',
          symbol: 'reserve',
          testRef: 'trace' in references ? (references.trace ?? null) : 'verify.js#booking-test',
          reason: 'real implementation',
        },
      ],
      testRefs: references.declared ?? ['verify.js#booking-test'],
      limitations: mode === 'limited' ? ['Concurrency behavior remains unimplemented'] : [],
      deliveryContent: {
        commitMessage: 'Implement reservation',
        title: 'Reservation',
        description: '',
      },
    }
    await f.store.insertLink({
      designId: document.id,
      id: 'implementation:build',
      kind: 'execution',
      payloadJson: canonicalJson({
        basisId: basis.id,
        basisDigest: basis.digest,
        roundRef: 'build',
        result,
      }),
      createdAt: 20,
    })
    const verificationDependencies = {
      ...f,
      candidates: { ...bindChangeCandidateParticipant(), ...bindCandidateDeliveryParticipant() },
      content: composeLocalRepositoryRevisionContent(),
      profiles,
      verification: createLocalVerificationCommandEffectsFactory(),
      evidence: new EvidenceStore(root),
    }
    const verification = createGraphVerification(verificationDependencies)
    return {
      ...f,
      basis,
      profiles,
      verification,
      verificationDependencies,
      workspace: { workspacePath: ws, baselineRepoPath: repo, baseline },
    }
  }
  test.skipIf(process.platform === 'win32')(
    'a checked named test satisfies a file obligation and executes the real profile',
    async () => {
      const f = await fixture('passed', { obligation: 'verify.js' })
      const result = await f.verification.run({
        designId: 'design-a',
        roundRef: 'file-ref',
        workspace: f.workspace,
      })
      expect(result.passed).toBe(true)
      const execution = (await f.store.links('design-a')).find((link) =>
        link.id.startsWith('execution:'),
      )!
      const raw = await f.queries.evidenceArtifacts('design-a', execution.id)
      const receipt = JSON.parse(raw.files.find((file) => file.path === 'execution.json')!.content)
      expect(receipt.testReferencesChecked).toBe(true)
      expect(receipt.receipt.steps[0].exitCode).toBe(0)
      expect(raw.files.find((file) => file.path === 'logs/0-output-tail.txt')?.content).toContain(
        'booking-test',
      )
    },
    30_000,
  )
  for (const [name, references] of [
    ['file-only trace cannot prove a named test', { trace: 'verify.js' }],
    [
      'a missing named test cannot prove its file',
      { obligation: 'verify.js', trace: 'verify.js#missing-test' },
    ],
    [
      'a declared file without a checked trace cannot run verification',
      { obligation: 'verify.js', trace: null, declared: ['verify.js'] },
    ],
  ] as const)
    test.skipIf(process.platform === 'win32')(
      name,
      async () => {
        const f = await fixture('passed', {
          ...references,
          ...('declared' in references ? { declared: [...references.declared] } : {}),
        })
        const result = await f.verification.run({
          designId: 'design-a',
          roundRef: 'invalid-ref',
          workspace: f.workspace,
        })
        expect(result.passed).toBe(false)
        const execution = (await f.store.links('design-a')).find((link) =>
          link.id.startsWith('execution:'),
        )!
        const raw = await f.queries.evidenceArtifacts('design-a', execution.id)
        expect(raw.evidence.result).toBe('not-run')
        const receipt = JSON.parse(
          raw.files.find((file) => file.path === 'execution.json')!.content,
        )
        expect(receipt.testReferencesChecked).toBe(false)
        expect(receipt.receipt).toBe(null)
      },
      30_000,
    )
  test.skipIf(process.platform === 'win32')(
    'a crash after structural evidence preserves the real artifact binding on verification recovery',
    async () => {
      const f = await fixture('passed')
      let crash = true
      const verification = createGraphVerification({
        ...f.verificationDependencies,
        artifacts: createGraphDesignArtifacts(f.verificationDependencies.evidence),
        store: {
          ...f.store,
          async insertLink(link) {
            await f.store.insertLink(link)
            if (link.id.startsWith('structure:') && crash) {
              crash = false
              throw new Error('crash-after-structure')
            }
          },
        },
      })
      const input = { designId: 'design-a', roundRef: 'verify-crash', workspace: f.workspace }
      await expect(verification.run(input)).rejects.toThrow('crash-after-structure')
      const original = (await f.store.links(input.designId)).find(
        (link) => link.id === 'structure:verify-crash',
      )!
      const result = await verification.run(input)
      expect(result.passed).toBe(true)
      expect((await f.store.links(input.designId)).find((link) => link.id === original.id)).toEqual(
        original,
      )
      expect(await verification.run(input)).toEqual(result)
    },
    30_000,
  )
  for (const mode of ['passed', 'failed', 'timeout', 'missing-trace', 'limited'] as const)
    test.skipIf(process.platform === 'win32')(
      `actual ${mode} candidate is classified from execution and references`,
      async () => {
        const f = await fixture(mode)
        const input = { designId: 'design-a', roundRef: 'verify', workspace: f.workspace }
        const result = await f.verification.run(input)
        expect(result.passed).toBe(mode === 'passed')
        expect(result.candidateTreeOid).toMatch(/^[a-f0-9]{40,64}$/)
        expect(await f.verification.run(input)).toEqual(result)
        const execution = (await f.store.links('design-a'))
          .filter((link) => link.kind === 'evidence')
          .map((link) => GraphEvidenceBindingSchema.parse(JSON.parse(link.payloadJson)))
          .find((e) => e.kind === 'execution')!
        expect(execution.result).toBe(
          mode === 'passed' || mode === 'limited'
            ? 'passed'
            : mode === 'missing-trace'
              ? 'not-run'
              : 'failed',
        )
        const details = JSON.parse(
          (await f.artifacts.read(
            { artifactRef: execution.artifactRef!, digest: execution.artifactDigest! },
            'execution.json',
          ))!,
        )
        if (mode === 'failed') expect(details.receipt.steps[0].exitCode).toBe(3)
        if (mode === 'failed' || mode === 'passed') {
          const readable = await f.queries.evidenceArtifacts('design-a', execution.id)
          expect(
            readable.files.find((file) => file.path === 'logs/0-output-tail.txt')?.content,
          ).toContain(mode === 'failed' ? 'all passed' : 'booking-test')
          expect(readable.files.find((file) => file.path === 'execution.json')?.content).toContain(
            'exitCode',
          )
        }
        if (mode === 'timeout') expect(details.receipt.steps[0].timedOut).toBe(true)
      },
      30_000,
    )
  test.skipIf(process.platform === 'win32')(
    'a silent failed command retains readable file-glob reports and original binary bytes after candidate cleanup',
    async () => {
      const f = await fixture('report-only')
      const result = await f.verification.run({
        designId: 'design-a',
        roundRef: 'reports',
        workspace: f.workspace,
      })
      expect(result.passed).toBe(false)
      const execution = (await f.store.links('design-a'))
        .filter((link) => link.kind === 'evidence')
        .map((link) => GraphEvidenceBindingSchema.parse(JSON.parse(link.payloadJson)))
        .find((value) => value.kind === 'execution')!
      const raw = await f.queries.evidenceArtifacts('design-a', execution.id)
      const receipt = JSON.parse(raw.files.find((file) => file.path === 'execution.json')!.content)
      expect(receipt.receipt.steps[0]).toMatchObject({ exitCode: 3, outputTailRef: null })
      const reports = raw.files
        .filter((file) => file.path.startsWith('reports/'))
        .map((file) => JSON.parse(file.content))
      expect(reports.find((file) => file.sourcePath === 'report.xml').text).toBe(
        '<failure>actual assertion failed</failure>',
      )
      const binary = reports.find((file) => file.sourcePath === 'binary.dat')
      expect(binary.text).toBe(null)
      expect([...Buffer.from(binary.base64, 'base64')]).toEqual([0, 255, 128])
    },
    30_000,
  )
  test.skipIf(process.platform === 'win32')(
    'configured publication and crash replay retain one exact delivery, while an advanced remote blocks publication',
    async () => {
      const f = await fixture('passed')
      const verified = await f.verification.run({
        designId: 'design-a',
        roundRef: 'verify',
        workspace: f.workspace,
      })
      expect(verified.passed).toBe(true)
      const remote = join(f.workspace.baselineRepoPath, '..', 'remote.git')
      git(f.workspace.baselineRepoPath, 'clone', '--bare', f.workspace.baselineRepoPath, remote)
      const initial = JSON.parse(
        graphEmployeeRuntimeCodec.buildInitialCaseJson(
          JSON.stringify({
            caseRef: 'case-a',
            employeeRef: { id: 'employee', revision: 1 },
            workScopeJson: '{"kind":"task"}',
            intake: {
              target: { repositoryId: 'repo-a' },
              kind: 'body',
              body: '预约',
              uploads: [],
              typeOptions: { 'working-branch': 'main', 'publication-branch': 'main' },
            },
          }),
        ),
      )
      const work = { ...JSON.parse(initial.primaryContextJson), designId: 'design-a' }
      const plan = {
        roundRef: 'deliver',
        executionNonce: 'nonce',
        caseRef: { id: 'case-a' },
        employeeTypeRef: { typeId: 'graph-development', revision: 1 },
        workItemRef: 'deliver-result',
        inputEnvelopeJson: JSON.stringify({
          contextsJson: JSON.stringify([
            {
              id: 'context',
              typeId: 'graph-development.design-context',
              revision: 1,
              stateJson: JSON.stringify(work),
            },
          ]),
        }),
      }
      const candidates = bindCandidateDeliveryParticipant()
      let crash = true,
        pushCount = 0
      const platform = createGraphPlatformWorkItems({
        ...f,
        workspace: {
          initialize: async () => f.workspace,
          state: async () => ({ ...f.workspace, targetBranch: 'main' }),
        },
        publication: { remoteUrl: async () => remote },
        candidates: {
          ...candidates,
          async push(input) {
            pushCount++
            return candidates.push(input)
          },
        },
        store: {
          ...f.store,
          async insertLink(link) {
            await f.store.insertLink(link)
            if (link.id.startsWith('delivery:') && crash) {
              crash = false
              throw new Error('crash-after-delivery-persisted')
            }
          },
        },
      })
      // Advance the configured branch before delivering: the owner must refuse it.
      writeFileSync(join(f.workspace.baselineRepoPath, 'remote.txt'), 'another change')
      git(f.workspace.baselineRepoPath, 'add', 'remote.txt')
      git(
        f.workspace.baselineRepoPath,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=f@example.test',
        'commit',
        '-qm',
        'advance',
      )
      git(f.workspace.baselineRepoPath, 'push', remote, 'HEAD:main')
      await expect(
        platform.execute(plan, { publicationSubject: { kind: 'system' } }),
      ).rejects.toThrow('remote-head-changed')
      expect(
        (await f.store.links('design-a')).some((link) => link.id.startsWith('delivery:')),
      ).toBe(false)
      // A separately configured new branch can publish the frozen candidate normally.
      work.request.publicationBranch = 'reviewed-candidate'
      plan.inputEnvelopeJson = JSON.stringify({
        contextsJson: JSON.stringify([
          {
            id: 'context',
            typeId: 'graph-development.design-context',
            revision: 1,
            stateJson: JSON.stringify(work),
          },
        ]),
      })
      await expect(
        platform.execute(plan, { publicationSubject: { kind: 'system' } }),
      ).rejects.toThrow('crash-after-delivery-persisted')
      const replay = await platform.execute(plan, { publicationSubject: { kind: 'system' } })
      expect(await platform.execute(plan, { publicationSubject: { kind: 'system' } })).toBe(replay)
      expect(pushCount).toBe(2)
      const result = JSON.parse(replay).result
      expect(result.publication).toBe('refs/heads/reviewed-candidate')
      expect(git(remote, 'rev-parse', 'refs/heads/reviewed-candidate')).toBe(result.commitSha)
      expect(git(remote, 'rev-parse', `${result.commitSha}^{tree}`)).toBe(
        verified.candidateTreeOid!,
      )
      expect(
        (await f.store.links('design-a')).filter((link) => link.id.startsWith('delivery:')),
      ).toHaveLength(1)
    },
    30_000,
  )
  test.skipIf(process.platform === 'win32')(
    'latest manual rejection overrides previous acceptance and candidate edits invalidate the judgment',
    async () => {
      const f = await fixture('manual')
      const result = await f.verification.run({
        designId: 'design-a',
        roundRef: 'v1',
        workspace: f.workspace,
      })
      expect(result.passed).toBe(false)
      const accept = async (id: string, state: 'passed' | 'failed', at: number) => {
        const artifact = await f.artifacts.put([
          {
            path: 'acceptance.json',
            content: canonicalJson({
              id,
              result: state,
              comment: 'Observed the exact candidate',
              recordedAt: at,
            }),
          },
        ])
        return await f.store.insertLink({
          designId: 'design-a',
          id,
          kind: 'evidence',
          createdAt: at,
          payloadJson: canonicalJson({
            id,
            kind: 'acceptance',
            obligationIds: ['unique'],
            basisDigest: f.basis.digest,
            candidateTreeOid: result.candidateTreeOid,
            readSet: f.basis.readSet,
            commitSha: null,
            ci: null,
            profileRef: null,
            environmentDigest: null,
            executionRef: null,
            artifactRef: artifact.artifactRef,
            artifactDigest: artifact.digest,
            result: state,
            summary: state,
            limitations: [],
            recordedAt: at,
          }),
        })
      }
      await accept('accept', 'passed', 100)
      expect(
        (await f.verification.run({ designId: 'design-a', roundRef: 'v2', workspace: f.workspace }))
          .passed,
      ).toBe(true)
      await accept('reject', 'failed', 101)
      expect(
        (await f.verification.run({ designId: 'design-a', roundRef: 'v3', workspace: f.workspace }))
          .passed,
      ).toBe(false)
      await accept('accept-again', 'passed', 102)
      writeFileSync(
        join(f.workspace.workspacePath, 'booking.js'),
        'export const reserve = () => "changed";',
      )
      expect(
        (await f.verification.run({ designId: 'design-a', roundRef: 'v4', workspace: f.workspace }))
          .passed,
      ).toBe(false)
    },
    30_000,
  )
})
