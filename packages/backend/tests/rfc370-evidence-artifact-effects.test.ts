// RFC-370 A2: physical publication/digests wait for the selected content receiver.
import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvidenceStore } from '@/modules/development-automation/infrastructure/evidenceStore'
import { adoptActionWorkspace } from '@/modules/development-automation/infrastructure/actionWorkspace'
import { placeUploadSeed } from '@/modules/development-automation/infrastructure/uploadPlacement'
import type { UploadPlacementPersistence } from '@/modules/development-automation/application/ports/uploadPlacementStore'
import { sha256Hex } from '@/util/hash'
import { GatedEvidenceArtifacts } from './helpers/rfc370EvidenceArtifacts'

const bytes = new Uint8Array([0, 255, 10, 65, 42])
const budget = { maxFiles: 2, maxFileBytes: 1024, maxTotalBytes: 1024 }

test('the independent file adapter preserves complete binary capture, read and materialization faces', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-evidence-native-'))
  try {
    const staged = join(root, 'staged')
    mkdirSync(staged)
    writeFileSync(join(staged, 'input.bin'), bytes)
    const native = new EvidenceStore(join(root, 'storage'))
    const captured = await native.putFile(join(staged, 'input.bin'))
    expect(captured).toEqual({ sha256: sha256Hex(bytes), bytes: bytes.length })
    const bundle = await native.importStagedTree(staged, budget)
    expect(native.getBundle(bundle.bundleId)).toEqual(bundle)
    expect(native.hasBlob(captured.sha256)).toBe(true)
    expect(
      await native.contents.readRange({ sha256: captured.sha256, offsetBytes: 1, limitBytes: 2 }),
    ).toMatchObject({
      ok: true,
      bytes: new Uint8Array([255, 10]),
      totalBytes: bytes.length,
      truncated: true,
      nextOffset: 3,
    })
    expect(native.materializeBlob('0'.repeat(64), join(root, 'missing'))).toBe(false)
    const dest = join(root, 'materialized')
    expect(native.materializeBundle(bundle.bundleId, dest)).toEqual(bundle.entries)
    expect([...readFileSync(join(dest, 'input.bin'))]).toEqual([...bytes])
    const ref = await native.contexts.save('{"context":true}')
    expect(await native.contexts.load(ref)).toBe('{"context":true}')
    const download = await native.downloads.open(captured.sha256)
    expect(download).not.toBeNull()
    expect([
      ...new Uint8Array(await new Response(await download!.open(1, 2)).arrayBuffer()),
    ]).toEqual([255, 10])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('adopting an existing workspace waits for selected bundle materialization before returning facts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-evidence-adopt-'))
  const entered = Promise.withResolvers<void>(),
    ready = Promise.withResolvers<void>()
  let pending: ReturnType<typeof adoptActionWorkspace> | undefined
  try {
    const staged = join(root, 'staged'),
      workspace = join(root, 'workspace')
    mkdirSync(staged)
    mkdirSync(workspace)
    writeFileSync(join(staged, 'input.bin'), bytes)
    writeFileSync(join(workspace, 'README.md'), 'original')
    const store = new EvidenceStore(join(root, 'storage'))
    const bundle = await store.importStagedTree(staged, budget)
    const selected = Object.freeze(
      new GatedEvidenceArtifacts(join(root, 'storage'), async (effect, ref) => {
        expect(effect).toBe('materialize-bundle')
        expect(ref).toBe(bundle.bundleId)
        entered.resolve()
        await ready.promise
      }),
    )
    let settled = false
    pending = adoptActionWorkspace(
      { evidence: selected },
      { workspacePath: workspace, bundles: [{ bundleId: bundle.bundleId, mountPath: 'inputs' }] },
    ).finally(() => {
      settled = true
    })
    await entered.promise
    expect(settled).toBe(false)
    expect(existsSync(join(workspace, 'inputs'))).toBe(false)
    ready.resolve()
    const result = await pending
    expect(result.workspacePath).toBe(workspace)
    expect(result.businessTreeDigest).toMatch(/^[0-9a-f]{64}$/)
    expect([...readFileSync(join(workspace, 'inputs', 'input.bin'))]).toEqual([...bytes])
    expect(readFileSync(join(workspace, 'README.md'), 'utf8')).toBe('original')
    expect(selected.calls).toBe(1)
  } finally {
    ready.resolve()
    await pending
    rmSync(root, { recursive: true, force: true })
  }
}, 20_000)

for (const outcome of ['saved', 'failure', 'missing'] as const) {
  test(`upload placement holds seed/receipt publication until selected content ${outcome} ACK`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-evidence-placement-'))
    const entered = Promise.withResolvers<void>(),
      ready = Promise.withResolvers<void>()
    let pending: ReturnType<typeof placeUploadSeed> | undefined
    try {
      const file = join(root, 'input.bin')
      writeFileSync(file, bytes)
      const native = new EvidenceStore(join(root, 'storage'))
      const blob = await native.putFile(file)
      const selected = Object.freeze(
        new GatedEvidenceArtifacts(join(root, 'storage'), async (effect) => {
          expect(effect).toBe('materialize-blob')
          entered.resolve()
          await ready.promise
          if (outcome === 'failure') throw new Error('selected-materialization-unavailable')
        }),
      )
      const receipts: Parameters<UploadPlacementPersistence['record']>[0][] = []
      const persistence: UploadPlacementPersistence = {
        async load(planId) {
          return {
            planId,
            planDigest: 'selected-plan',
            baselineSnapshotRef: 'baseline',
            baselineSha: 'b'.repeat(40),
            entries: [
              {
                fileId: 'file',
                uploadBlobRef: outcome === 'missing' ? '0'.repeat(64) : blob.sha256,
                repositoryTargetPath: 'tools/input.bin',
                targetFileMode: 'executable',
                expectedTargetKind: 'absent',
                ordinal: 0,
              },
            ],
            placementReceipt: null,
          }
        },
        async record(input) {
          receipts.push(input)
        },
      }
      const seedsRoot = join(root, 'seeds')
      let settled = false
      pending = placeUploadSeed(
        { persistence, evidence: selected, seedsRoot, now: () => 17 },
        { planId: 'plan' },
      ).finally(() => {
        settled = true
      })
      const observed = pending.then(
        (result) => ({ result }),
        (error) => ({ error }),
      )
      await entered.promise
      expect(settled).toBe(false)
      expect(receipts).toHaveLength(0)
      expect(existsSync(join(seedsRoot, 'selected-plan'))).toBe(false)
      ready.resolve()
      const result = await observed
      if (outcome === 'saved') {
        expect('result' in result).toBe(true)
        expect(receipts).toHaveLength(1)
        expect(receipts[0]).toMatchObject({
          planId: 'plan',
          seedChangeRef: 'selected-plan',
          createdAt: 17,
        })
        expect([...readFileSync(join(seedsRoot, 'selected-plan', 'tools', 'input.bin'))]).toEqual([
          ...bytes,
        ])
        if (process.platform !== 'win32') {
          expect(
            (statSync(join(seedsRoot, 'selected-plan', 'tools', 'input.bin')).mode & 0o111) !== 0,
          ).toBe(true)
        }
      } else {
        expect('error' in result).toBe(true)
        expect(readdirSync(seedsRoot)).toEqual([])
        expect(receipts).toHaveLength(0)
        expect(existsSync(join(seedsRoot, 'selected-plan'))).toBe(false)
        if ('error' in result)
          expect(String(result.error)).toContain(
            outcome === 'failure' ? 'selected-materialization-unavailable' : 'upload blob missing',
          )
      }
      expect(selected.calls).toBe(1)
    } finally {
      ready.resolve()
      await pending?.catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
}

for (const initialOutcome of ['saved', 'failure'] as const) {
  test(`same-seed concurrent replay waits for the first ${initialOutcome} ACK and remains retryable`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-evidence-replay-'))
    const entered = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<void>()
    const loadedTwice = Promise.withResolvers<void>()
    const pending: Promise<unknown>[] = []
    try {
      const file = join(root, 'input.bin')
      writeFileSync(file, bytes)
      const native = new EvidenceStore(join(root, 'storage'))
      const blob = await native.putFile(file)
      let materializations = 0
      const selected = Object.freeze(
        new GatedEvidenceArtifacts(join(root, 'storage'), async (effect) => {
          expect(effect).toBe('materialize-blob')
          materializations += 1
          if (materializations === 1) {
            entered.resolve()
            await ready.promise
            if (initialOutcome === 'failure') throw new Error('first-selected-ACK-failed')
          }
        }),
      )
      const receipts = new Map<string, Parameters<UploadPlacementPersistence['record']>[0]>()
      let loads = 0
      const persistence: UploadPlacementPersistence = {
        async load(planId) {
          loads += 1
          if (loads === 2) loadedTwice.resolve()
          const receipt = receipts.get(planId)
          return {
            planId,
            planDigest: 'shared-seed',
            baselineSnapshotRef: 'baseline',
            baselineSha: 'b'.repeat(40),
            entries: [
              {
                fileId: 'file',
                uploadBlobRef: blob.sha256,
                repositoryTargetPath: 'tools/input.bin',
                targetFileMode: 'regular',
                expectedTargetKind: 'absent',
                ordinal: 0,
              },
            ],
            placementReceipt:
              receipt === undefined ? null : { seedTreeDigest: receipt.seedTreeDigest },
          }
        },
        async record(input) {
          if (!receipts.has(input.planId)) receipts.set(input.planId, input)
        },
      }
      const seedsRoot = join(root, 'seeds')
      const deps = { persistence, evidence: selected, seedsRoot, now: () => 17 }
      const first = placeUploadSeed(deps, { planId: 'plan' }).then(
        (result) => ({ result }),
        (error) => ({ error }),
      )
      pending.push(first)
      await entered.promise
      let secondSettled = false
      const second = placeUploadSeed(deps, { planId: 'plan' })
        .then(
          (result) => ({ result }),
          (error) => ({ error }),
        )
        .finally(() => {
          secondSettled = true
        })
      pending.push(second)
      await loadedTwice.promise
      await Promise.resolve()
      expect(materializations).toBe(1)
      expect(secondSettled).toBe(false)
      expect(receipts.size).toBe(0)
      expect(existsSync(join(seedsRoot, 'shared-seed'))).toBe(false)
      ready.resolve()
      const [firstResult, replayResult] = await Promise.all([first, second])
      expect('result' in replayResult).toBe(true)
      if (initialOutcome === 'saved') {
        expect('result' in firstResult).toBe(true)
        if ('result' in firstResult && 'result' in replayResult)
          expect(replayResult.result).toEqual(firstResult.result)
      } else {
        expect('error' in firstResult).toBe(true)
        if ('error' in firstResult)
          expect(String(firstResult.error)).toContain('first-selected-ACK-failed')
      }
      expect(materializations).toBe(initialOutcome === 'saved' ? 1 : 2)
      expect(receipts.size).toBe(1)
      expect([...readFileSync(join(seedsRoot, 'shared-seed', 'tools', 'input.bin'))]).toEqual([
        ...bytes,
      ])
      expect(readdirSync(seedsRoot)).toEqual(['shared-seed'])
      const replay = await placeUploadSeed(deps, { planId: 'plan' })
      if ('result' in replayResult) expect(replay).toEqual(replayResult.result)
      expect(receipts.size).toBe(1)
      expect(materializations).toBe(initialOutcome === 'saved' ? 1 : 2)
    } finally {
      ready.resolve()
      await Promise.all(pending)
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
}

test('different plan IDs that publish the same seed reference share one asynchronous publication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-evidence-shared-seed-'))
  const entered = Promise.withResolvers<void>(),
    ready = Promise.withResolvers<void>(),
    loadedTwice = Promise.withResolvers<void>()
  const pending: Promise<unknown>[] = []
  try {
    const file = join(root, 'input.bin')
    writeFileSync(file, bytes)
    const native = new EvidenceStore(join(root, 'storage')),
      blob = await native.putFile(file)
    let loads = 0
    const selected = Object.freeze(
      new GatedEvidenceArtifacts(join(root, 'storage'), async (effect) => {
        expect(effect).toBe('materialize-blob')
        entered.resolve()
        await ready.promise
      }),
    )
    const receipts: Parameters<UploadPlacementPersistence['record']>[0][] = []
    const persistence: UploadPlacementPersistence = {
      async load(planId) {
        loads += 1
        if (loads === 2) loadedTwice.resolve()
        return {
          planId,
          planDigest: 'shared-seed',
          baselineSnapshotRef: 'baseline',
          baselineSha: 'b'.repeat(40),
          entries: [
            {
              fileId: 'file',
              uploadBlobRef: blob.sha256,
              repositoryTargetPath: 'tools/input.bin',
              targetFileMode: 'regular',
              expectedTargetKind: 'absent',
              ordinal: 0,
            },
          ],
          placementReceipt: null,
        }
      },
      async record(input) {
        receipts.push(input)
      },
    }
    const seedsRoot = join(root, 'seeds'),
      deps = { persistence, evidence: selected, seedsRoot, now: () => 17 }
    const first = placeUploadSeed(deps, { planId: 'plan-1' }).then(
      (result) => ({ result }),
      (error) => ({ error }),
    )
    pending.push(first)
    await entered.promise
    const second = placeUploadSeed(deps, { planId: 'plan-2' }).then(
      (result) => ({ result }),
      (error) => ({ error }),
    )
    pending.push(second)
    await loadedTwice.promise
    await Promise.resolve()
    expect(selected.calls).toBe(1)
    expect(receipts).toHaveLength(0)
    ready.resolve()
    const results = await Promise.all([first, second])
    expect(results.every((result) => 'result' in result)).toBe(true)
    expect(results[0]).toEqual(results[1])
    expect(selected.calls).toBe(1)
    expect(receipts.map((row) => row.planId).sort()).toEqual(['plan-1', 'plan-2'])
    expect(readdirSync(seedsRoot)).toEqual(['shared-seed'])
    expect([...readFileSync(join(seedsRoot, 'shared-seed', 'tools', 'input.bin'))]).toEqual([
      ...bytes,
    ])
  } finally {
    ready.resolve()
    await Promise.all(pending)
    rmSync(root, { recursive: true, force: true })
  }
}, 20_000)
