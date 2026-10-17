// RFC-370 M2: real task-image verification and evidence; unknown replies retain
// the candidate, and a durable unreaped-writer receipt survives new receivers.
import { expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCrewStationVerificationCommandEffectsFactory } from '@/modules/development-automation/composition/crewstationVerification'
import { executeTaskImageVerification } from '@/modules/development-automation/composition/taskImageVerification'
import { executeTaskImageRepositoryOperation } from '@/modules/source-control/composition/taskImageRepositoryEffects'
import {
  retainWorkVolumeWriter,
  assertWorkVolumeWritersSettled,
} from '@/platform/crewstation/workVolumeWriters'
import { createHostedRepositoryCandidateOperations } from '@/modules/source-control/infrastructure/crewstation/repositoryCandidate'
import { runVerificationProfileWithEffects } from '@/modules/development-automation/application/verificationRunner'
import type { EvidenceArtifactPort } from '@/modules/development-automation/application/ports/evidenceArtifacts'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { VerificationStep } from '@/modules/development-automation/application/ports/verificationCommandEffects'

const step: VerificationStep = {
  stepId: 'check',
  programRef: 'repo:verify.sh',
  argsRef: null,
  timeoutMs: 5000,
  networkProfileRef: 'default',
  successExitCodes: [0],
  evidenceSelectors: [{ kind: 'file-glob', value: 'proof.txt' }],
}

test.skipIf(process.platform === 'win32')(
  'real verification runs in its volume and imports tails and file artifacts',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-hosted-verification-'))
    const workspace = join(root, 'ws')
    mkdirSync(workspace)
    writeFileSync(
      join(workspace, 'verify.sh'),
      '#!/bin/sh\nprintf success\nprintf proof > proof.txt\n',
    )
    chmodSync(join(workspace, 'verify.sh'), 0o700)
    const retained = new Set<string>()
    const captured = new Map<string, string>()
    const helper: WorkspaceHelper = {
      async call<T>(_task: string, operation: string, value: unknown) {
        expect(operation).toBe('verification-command')
        return (await executeTaskImageVerification(value, undefined, root)) as T
      },
    }
    const evidence = {
      async putBlobFromFile(path: string) {
        const bytes = readFileSync(path)
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        captured.set(sha256, bytes.toString())
        return { sha256, bytes: bytes.length }
      },
    } as EvidenceArtifactPort
    try {
      const factory = createCrewStationVerificationCommandEffectsFactory({
        helper,
        locate: (path) => ({ taskId: 'case', path }),
        reference: (_task, path) => path,
        retainWorkspace: (ref, keep) => {
          if (keep) retained.add(ref)
          else retained.delete(ref)
        },
      })
      const receipt = await runVerificationProfileWithEffects(factory.create({ evidence }), {
        workspacePath: workspace,
        profile: { schemaVersion: 1, steps: [step], stopPolicy: 'first-failure', maxParallel: 1 },
      })
      expect(receipt.ok).toBe(true)
      expect(captured.get(receipt.steps[0]!.outputTailRef!)).toBe('success\n')
      expect(captured.get(receipt.steps[0]!.evidenceFiles[0]!.sha256)).toBe('proof')
      expect(retained.size).toBe(0)
      expect(() => assertWorkVolumeWritersSettled(root, workspace)).not.toThrow()
      writeFileSync(join(workspace, 'verify.sh'), '#!/bin/sh\nsleep 20\n')
      const timeout = (await executeTaskImageVerification(
        { method: 'run', path: workspace, id: randomUUID(), step: { ...step, timeoutMs: 50 } },
        undefined,
        root,
      )) as { timedOut: boolean }
      expect(timeout.timedOut).toBe(true)
      expect(() => assertWorkVolumeWritersSettled(root, workspace)).not.toThrow()
      await expect(
        executeTaskImageVerification(
          { method: 'collect', path: workspace, pattern: '../*' },
          undefined,
          root,
        ),
      ).rejects.toThrow('path-invalid')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  20_000,
)

test('lost verification response blocks candidate cleanup and retries one request identity', async () => {
  const retained = new Set<string>()
  const ids: string[] = []
  let calls = 0
  let closes = 0
  const helper: WorkspaceHelper = {
    async call<T>(
      _task: string,
      operation: string,
      value: unknown,
      options?: Parameters<WorkspaceHelper['call']>[3],
    ) {
      const request = value as { method?: string }
      // RFC-370 §9.2 V3: staging is one coarse command; its tree stays in the
      // volume until the matching discard command.
      if (operation === 'candidate-stage')
        return { ok: true, ws: '/work/tmp/candidates/candidate-test/ws', treeOid: 'tree' } as T
      if (operation === 'candidate-discard') {
        closes++
        return null as T
      }
      if (request.method === 'resolve') return true as T
      if (request.method === 'run') {
        ids.push(options!.operationId!)
        calls++
        if (calls === 1) throw new Error('platform response unknown')
        return { exitCode: 0, timedOut: false, outputFile: null } as T
      }
      return undefined as T
    },
  }
  const staged = await createHostedRepositoryCandidateOperations({
    helper,
    writerHeld: (ref) => retained.has(ref),
  }).operations.stage({
    baselineRepoPath: 'cs-workspace:case/repos/base',
    baselineSha: 'base',
    overlayRoot: 'cs-workspace:case/overlay',
  })
  if (!staged.ok) throw new Error('stage failed')
  expect(staged.ws).toBe('cs-workspace:case/tmp/candidates/candidate-test/ws')
  const owner = createCrewStationVerificationCommandEffectsFactory({
    helper,
    locate: (ref) => ({ taskId: 'case', path: '/work/' + ref.split('/').slice(1).join('/') }),
    reference: (_task, path) => path,
    retainWorkspace: (ref, keep) => {
      if (keep) retained.add(ref)
      else retained.delete(ref)
    },
  }).create({ evidence: {} as EvidenceArtifactPort })
  const program = (await owner.resolveProgram({
    programRef: step.programRef,
    argsRef: null,
    workspaceRef: staged.ws,
  }))!
  await expect(owner.execute({ program, workspaceRef: staged.ws, step })).rejects.toThrow('unknown')
  await expect(staged.cleanup()).rejects.toThrow('writer-not-settled')
  expect(closes).toBe(0)
  await owner.execute({ program, workspaceRef: staged.ws, step })
  expect(ids[0]).toBe(ids[1])
  await staged.cleanup()
  await staged.cleanup()
  expect(closes).toBe(1)
})

test('durable task-image writer blocks a new candidate cleanup receiver', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-writer-barrier-'))
  const path = join(root, 'tmp', 'candidates', 'candidate-test', 'ws')
  mkdirSync(path, { recursive: true })
  try {
    const writer = retainWorkVolumeWriter(root, 'lost-command', path)
    const input = { ws: path }
    await expect(
      executeTaskImageRepositoryOperation('candidate-discard', input, root),
    ).rejects.toThrow('writer-not-settled')
    expect(existsSync(path)).toBe(true)
    writer.release()
    await executeTaskImageRepositoryOperation('candidate-discard', input, root)
    expect(existsSync(path)).toBe(false)
    expect(existsSync(join(root, 'tmp', 'candidates', 'candidate-test'))).toBe(false)
    // Discard is bound to exactly one allocated staged tree, never its root.
    await expect(
      executeTaskImageRepositoryOperation(
        'candidate-discard',
        { ws: join(root, 'tmp', 'candidates') },
        root,
      ),
    ).rejects.toThrow('owner-mismatch')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('writer receipts protect ancestors and descendants and reserve one identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-writer-guard-'))
  try {
    const first = retainWorkVolumeWriter(root, 'one', root)
    expect(() => retainWorkVolumeWriter(root, 'one', root)).toThrow('writer-not-settled')
    expect(() => assertWorkVolumeWritersSettled(root, join(root, 'nested'))).toThrow(
      'writer-not-settled',
    )
    first.release()
    const second = retainWorkVolumeWriter(root, 'two', join(root, 'nested'))
    expect(() => assertWorkVolumeWritersSettled(root, root)).toThrow('writer-not-settled')
    second.release()
    expect(() => assertWorkVolumeWritersSettled(root, root)).not.toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === 'win32')(
  'writer receipt directory cannot redirect outside the volume',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-writer-link-'))
    const outside = mkdtempSync(join(tmpdir(), 'aw-writer-outside-'))
    try {
      symlinkSync(outside, join(root, '.aw-writers'))
      expect(() => retainWorkVolumeWriter(root, 'one', root)).toThrow('symlink-path')
      expect(() => assertWorkVolumeWritersSettled(root, root)).toThrow('symlink-path')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform === 'win32')(
  'durable verification receipt recovers cleanup even when the script disappeared',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-verification-cold-'))
    const path = join(root, 'ws')
    mkdirSync(path)
    writeFileSync(join(path, 'verify.sh'), '#!/bin/sh\nprintf complete\n')
    chmodSync(join(path, 'verify.sh'), 0o700)
    const request = { method: 'run', path, id: randomUUID(), step }
    try {
      const first = await executeTaskImageVerification(request, undefined, root)
      // Crash after result fsync but before writer receipt removal.
      retainWorkVolumeWriter(root, `verification:${request.id}`, path)
      rmSync(join(path, 'verify.sh'))
      expect(await executeTaskImageVerification(request, undefined, root)).toEqual(first)
      expect(() => assertWorkVolumeWritersSettled(root, path)).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)
