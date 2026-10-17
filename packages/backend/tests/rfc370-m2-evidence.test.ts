// RFC-370 M2: preserve durable DA identities, immutable bytes, range semantics,
// staging budgets and the ownership fence across both database providers.
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCrewStationEvidenceArtifacts } from '@/modules/development-automation/infrastructure/crewstation/evidenceArtifacts'
import { createDevelopmentObjectIndex } from '@/modules/development-automation/infrastructure/crewstation/objectIndex'
import { createHostedObjectPublications } from '@/modules/system-operations/infrastructure/crewstation/objectPublications'
import { executeTaskImageEvidence } from '@/modules/development-automation/composition/taskImageEvidence'
import {
  inspectEvidenceFile,
  scanEvidenceTree,
} from '@/modules/development-automation/infrastructure/local/evidenceFileFacts'
import { objectFixture } from './helpers/rfc370Objects'
import { describeEachProvider } from './helpers/eachProvider'

const budget = { maxFiles: 5, maxFileBytes: 6 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 }

describeEachProvider('RFC-370 durable CS development evidence', (harness) => {
  test('restart retains blob SHA, bundle membership, context and exact ranged downloads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-hosted-evidence-'))
    const f = objectFixture()
    let held = true
    const fence = {
      current: () => ({ epoch: 1, leaseId: 'lease', instanceId: 'instance' }),
      async assertHeld() {
        if (!held) throw new Error('lost hosted authority')
      },
    }
    const written = new Map<string, Uint8Array>()
    const create = () =>
      createCrewStationEvidenceArtifacts({
        objects: f.objects,
        index: createDevelopmentObjectIndex({ db: harness.db }),
        // RFC-370 v3 V6: development evidence publishes through the neutral journal.
        publications: createHostedObjectPublications({
          db: harness.db,
          fence,
          objects: f.objects,
        }).publications,
        files: {
          inspect: async (path) => ({
            ...(await inspectEvidenceFile(path)),
            open: () => Bun.file(path).stream(),
          }),
          scan: async (path, limits) => scanEvidenceTree(path, limits),
          join: (path, rel) => `${path}/${rel}`,
          async write(path, stream, facts) {
            const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
            expect(bytes.byteLength).toBe(facts.size)
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(facts.sha256)
            written.set(path, bytes)
          },
        },
      })
    try {
      const bytes = Buffer.alloc(5 * 1024 * 1024 + 7, 37)
      writeFileSync(join(root, 'large.bin'), bytes)
      mkdirSync(join(root, 'nested'))
      writeFileSync(join(root, 'nested', 'readme.txt'), 'Evidence 正文')
      const first = create()
      const bundle = await first.artifacts.importStagedTree(root, budget)
      const large = bundle.entries.find((entry) => entry.relativePath === 'large.bin')!
      const context = await first.artifacts.contexts.save('{"attempt":1}')
      const count = f.pins.length
      await first.artifacts.putBlobFromFile(join(root, 'large.bin'))
      expect(f.pins.length).toBe(count)
      rmSync(root, { recursive: true, force: true })
      const second = create()
      expect(await second.artifacts.getBundle(bundle.bundleId)).toEqual(bundle)
      expect(await second.artifacts.contexts.load(context)).toBe('{"attempt":1}')
      expect(
        await second.artifacts.documents.readText({
          bundleRef: bundle.bundleId,
          relativePath: 'nested/readme.txt',
        }),
      ).toBe('Evidence 正文')
      expect(
        await second.artifacts.documents.readText({
          bundleRef: bundle.bundleId,
          relativePath: '../large.bin',
        }),
      ).toBeNull()
      const range = await second.artifacts.contents.readRange({
        sha256: large.sha256,
        offsetBytes: 2,
        limitBytes: 10 * 1024 * 1024,
      })
      expect(range.ok).toBe(true)
      if (!range.ok) throw new Error('missing range')
      expect(range.bytes.byteLength).toBe(4 * 1024 * 1024)
      expect(range.nextOffset).toBe(2 + 4 * 1024 * 1024)
      expect(range.truncated).toBe(true)
      const download = await second.artifacts.downloads.open(large.sha256)
      expect(Buffer.from(await new Response(await download!.open(3, 9)).arrayBuffer())).toEqual(
        bytes.subarray(3, 10),
      )
      await second.artifacts.materializeBundle(bundle.bundleId, 'cs-workspace:case/evidence')
      expect(written.get('cs-workspace:case/evidence/large.bin')).toEqual(new Uint8Array(bytes))
      expect(await second.artifacts.hasBlob('bad')).toBe(false)
      const doc = await second.documents.writeDocument({
        relativePath: 'manifest.json',
        content: '{"ok":true}',
        budget,
      })
      expect(
        await second.artifacts.documents.readText({
          bundleRef: doc.bundleId,
          relativePath: 'manifest.json',
        }),
      ).toBe('{"ok":true}')
      await expect(
        second.documents.writeDocument({ relativePath: '../escape', content: 'x', budget }),
      ).rejects.toThrow('path-invalid')
      await expect(
        second.documents.writeDocument({
          relativePath: 'a',
          content: 'xx',
          budget: { ...budget, maxFileBytes: 1 },
        }),
      ).rejects.toThrow('file too large')
      held = false
      await expect(second.artifacts.contexts.save('new after authority lost')).rejects.toThrow(
        'lost hosted authority',
      )
      f.tamper('body')
      await expect(second.artifacts.contents.readText(context)).rejects.toThrow('content-mismatch')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test('task-image evidence rejects symlink parents and oversized trees before import', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-evidence-scan-'))
  const outside = mkdtempSync(join(tmpdir(), 'aw-evidence-outside-'))
  try {
    writeFileSync(join(outside, 'secret'), 'outside')
    mkdirSync(join(root, 'staging'))
    writeFileSync(join(root, 'staging', 'file'), 'too large')
    await expect(
      executeTaskImageEvidence(
        { method: 'scan', path: join(root, 'staging'), budget: { ...budget, maxTotalBytes: 2 } },
        root,
      ),
    ).rejects.toThrow('total too large')
    symlinkSync(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(
      executeTaskImageEvidence({ method: 'inspect', path: join(root, 'link', 'secret') }, root),
    ).rejects.toThrow('symlink')
    await expect(
      executeTaskImageEvidence({ method: 'scan', path: root, budget }, root),
    ).rejects.toThrow('not-regular')
    await expect(
      executeTaskImageEvidence({ method: 'inspect', path: join(outside, 'secret') }, root),
    ).rejects.toThrow('outside-work-volume')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
