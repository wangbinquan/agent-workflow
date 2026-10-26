// RFC-395 V3-F: original absence, freeze drift and byte identity across content codecs.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
  existsSync,
  readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContentLocation } from '@/platform/content/contentRef'
import type {
  ContentRootSpec,
  FreezeContentManifest,
  FrozenSourceHandle,
} from '@/platform/persistence/migration/run/types'
import type { SourcePreflight } from '@/platform/persistence/migration/sourceTypes'
import type { ArtifactReceipt } from '@/platform/persistence/migration/conversion/types'
import {
  encodeMigrationKey,
  canonicalValue,
} from '@/platform/persistence/migration/conversion/migrationKey'
import {
  captureContentManifest,
  verifyContentManifest,
  contentManifestDigest,
} from '@/platform/content/inventory/manifest'
import { createFreezeContentInventory } from '@/platform/content/inventory/freezeInventory'
import { resolveContentLocation } from '@/platform/content/inventory/resolvers'
import { skillTreeManifestBytes, contentByteFacts } from '@/platform/content/inventory/treeDigest'
import { hostedObjectReference } from '@/platform/content/locations/hostedObject'
import { CrewStationApiError } from '@/platform/crewstation/platformApi'
import type { InventoryObjectReader } from '@/platform/content/inventory/objects'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import {
  contentFixture,
  seedContentParents,
  objectId,
  contentBytes,
  contentLookups,
} from './helpers/rfc395V2/contentFixtures'
import { readInventorySource } from '@/platform/content/inventory/databaseTrees'
import { conversion as contentConversion } from '@/platform/content/migration'
import { conversion as runContribution } from '@/modules/task-execution/infrastructure/migration/run'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { runValues, taskFacts, taskMounts, writeTask } from './helpers/rfc395V2/runFixtures'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import { openLiveSnapshotSource } from '@/platform/persistence/migration/freeze/sourceAccess'
import { createContentInventoryAdapter } from '@/modules/system-operations/infrastructure/epochSwitch/contentInventoryAdapter'

let directory: string
let root: ContentRootSpec
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'v3-content-'))
  root = { kind: 'app-home', root: join(directory, 'home'), runsSupplied: true, objects: 'none' }
  mkdirSync(root.root)
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))
const file = (path: string, bytes: string | Uint8Array) => {
  const absolute = join(root.root, path)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, bytes)
  return absolute
}
function emptySource(): FrozenSourceHandle {
  const preflight: SourcePreflight = {
    version: 1,
    kind: 'sqlite-file',
    sourceVersion: 'fixture',
    contract: null,
    sourceGenerationId: 'dbg_fixture',
    watermark: 'fixture',
    fingerprint: {
      version: 1,
      provider: 'sqlite',
      evidence: 'physical-catalog-and-journal',
      catalog: [],
      catalogDigest: 'fixture',
      journal: [],
      journalEntryCount: 0,
      tableRows: {},
      digest: 'fixture',
    },
    identityHighWater: [],
    identityEvidence: 'physical',
    requiresOfflineUpgrade: false,
    tables: [],
    expectedAbsent: [],
    content: [],
  }
  return {
    preflight,
    preUpgrade: null,
    watermark: preflight.watermark,
    evidenceRoot: null,
    async close() {},
    reader: {
      kind: preflight.kind,
      async preflight() {
        return preflight
      },
      async assertUnchanged() {},
      async readChunk() {
        throw new Error('no fixture tables')
      },
      async readRawChunk() {
        throw new Error('no fixture tables')
      },
      async close() {},
    },
  }
}
const capture = () =>
  captureContentManifest({
    root,
    source: emptySource(),
    destination: join(directory, 'manifest.json'),
  })
async function* receipts(...values: ArtifactReceipt[]) {
  yield* values
}
function receipt(reference: string, bytes: Uint8Array): ArtifactReceipt {
  const key = encodeMigrationKey('doc_versions', [canonicalValue('doc')])
  return {
    sourceTable: 'doc_versions',
    sourceKey: key,
    sourceColumn: 'body_path',
    originalReference: reference,
    target: { table: 'doc_versions', key, backend: 'local-file', contentId: null },
    bytes: contentByteFacts(bytes),
    publication: 'not-required',
    missing: null,
  }
}
function objectReader(values: Map<string, Uint8Array>): InventoryObjectReader {
  return {
    async stat(id) {
      const bytes = values.get(id)
      if (!bytes) throw new CrewStationApiError(404, 'object-storage', 'absent', {})
      return { id, ...contentByteFacts(bytes) }
    },
    async open(object) {
      return new Blob([values.get(object.id)!]).stream()
    },
  }
}

test('prompt, review and local port codecs resolve their original roots; all four classifications remain distinct', async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0, 255])
  const path = file('runs/task/prompts/run.md', bytes)
  const locations: ContentLocation[] = [
    { codec: 'prompt', value: { promptText: null, promptPath: 'task/prompts/run.md' } },
    { codec: 'review-body', value: 'runs/task/prompts/run.md' },
    { codec: 'port-archive-file', value: 'runs/task/prompts/run.md' },
  ]
  const manifest = await capture()
  const inventory = createFreezeContentInventory({ root, manifest })
  for (const location of locations) {
    expect(resolveContentLocation(location, root)).toEqual({ kind: 'file', path })
    expect(await inventory.stat(location)).toEqual({ state: 'present', ...contentByteFacts(bytes) })
    expect(await inventory.read(location)).toEqual(bytes)
  }
  const absent = { codec: 'review-body', value: 'runs/absent.md' }
  expect(await inventory.stat(absent)).toMatchObject({
    state: 'absent',
    cause: 'originally-absent',
  })
  file('runs/absent.md', '')
  await expect(inventory.stat(absent)).rejects.toThrow('content-unlisted-present')
  rmSync(path)
  expect(await inventory.stat(locations[0]!)).toMatchObject({
    state: 'absent',
    cause: 'missing-at-freeze',
  })
  await expect(inventory.read(locations[0]!)).rejects.toThrow('content-bytes-absent')
})

test('local skill trees rebase old paths and emit byte-identical canonical manifests, including empty directories', async () => {
  const entries = [
    { path: 'SKILL.md', bytes: new TextEncoder().encode('\ufeff技能\r\n') },
    { path: 'data.bin', bytes: new Uint8Array([255, 0, 128]) },
    { path: 'empty', bytes: new Uint8Array() },
  ]
  for (const entry of entries) file(`skills/id/files/${entry.path}`, entry.bytes)
  mkdirSync(join(root.root, 'skills/empty/files'), { recursive: true })
  const manifest = await capture()
  const inventory = createFreezeContentInventory({ root, manifest })
  const expected = skillTreeManifestBytes(
    entries.map((entry) => ({ path: entry.path, ...contentByteFacts(entry.bytes) })),
  )
  for (const value of [
    'skills/id/files',
    '/previous/home/skills/id/files',
    'C:\\previous\\home\\skills\\id\\files',
  ]) {
    const location = { codec: 'skill-path', value }
    expect(await inventory.read(location)).toEqual(expected)
    expect(await inventory.stat(location)).toEqual({
      state: 'present',
      ...contentByteFacts(expected),
    })
  }
  expect(await inventory.read({ codec: 'skill-path', value: 'skills/empty/files' })).toEqual(
    skillTreeManifestBytes([]),
  )
  expect(new TextDecoder().decode(expected)).toContain('skill-tree-manifest@1')
  expect(
    skillTreeManifestBytes(
      [...entries]
        .reverse()
        .map((entry) => ({ path: entry.path, ...contentByteFacts(entry.bytes) })),
    ),
  ).toEqual(expected)
  file('skills/id/files/added', 'later')
  await expect(inventory.stat({ codec: 'skill-path', value: 'skills/id/files' })).rejects.toThrow(
    'content-unlisted-present',
  )
})

test('backup without runs records V1 original-absence evidence even when a later local file appears', async () => {
  root = { ...root, kind: 'backup', runsSupplied: false }
  const manifest = await capture()
  const inventory = createFreezeContentInventory({ root, manifest })
  const location = {
    codec: 'prompt',
    value: { promptText: null, promptPath: 'task/prompts/run.md' },
  }
  const absent = await inventory.stat(location)
  expect(absent).toEqual({
    state: 'absent',
    cause: 'originally-absent',
    evidence: 'epoch-1 backup run content was not supplied to the restore; absence recorded',
  })
  file('runs/task/prompts/run.md', 'not supplied')
  expect(await inventory.stat(location)).toMatchObject({
    state: 'absent',
    cause: 'originally-absent',
  })
  root = { ...root, runsSupplied: true }
  expect(
    await createFreezeContentInventory({ root, manifest: await capture() }).read(location),
  ).toEqual(new TextEncoder().encode('not supplied'))
})

test('verification rehashes same-size/same-mtime files and stat/read cannot hide intervening edits', async () => {
  const reference = 'runs/body.md'
  const path = file(reference, 'before')
  utimesSync(path, 1000, 1000)
  const manifest = await capture()
  const inventory = createFreezeContentInventory({ root, manifest })
  const location = { codec: 'review-body', value: reference }
  await inventory.stat(location)
  const proof = receipt(reference, await inventory.read(location))
  expect(await inventory.verifyUnchanged(receipts(proof))).toEqual([])
  writeFileSync(path, 'after!')
  utimesSync(path, 1000, 1000)
  await expect(inventory.read(location)).rejects.toThrow('content-stat-read-drift')
  expect(await inventory.verifyUnchanged(receipts(proof))).toEqual([
    expect.objectContaining({ reason: 'digest-changed', sourceKey: proof.sourceKey }),
  ])
  rmSync(path)
  expect(await inventory.verifyUnchanged(receipts(proof))).toEqual([
    expect.objectContaining({ reason: 'missing' }),
  ])
  expect(() => verifyContentManifest({ ...manifest, files: [] })).toThrow(
    'content-manifest-digest-mismatch',
  )
})

test('object codecs share actual bytes, listed disappearance differs from original absence and standalone is unsupported', async () => {
  const bytes = new Uint8Array([0, 1, 255])
  const values = new Map([[objectId, bytes]])
  const objects = objectReader(values)
  const base = await capture()
  const { digest: _digest, ...payload } = base
  const content = {
    ...payload,
    objects: [{ id: objectId, present: true, ...contentByteFacts(bytes) }],
  }
  const manifest: FreezeContentManifest = { ...content, digest: contentManifestDigest(content) }
  const reference = hostedObjectReference('task-artifact', {
    id: objectId,
    ...contentByteFacts(bytes),
  })
  const locations = [
    { codec: 'hosted-object-id', value: objectId },
    { codec: 'aw-object:v2', value: reference },
    { codec: 'review-object', value: { reference: 'runs/review.md', objectId } },
    { codec: 'port-archive-file', value: reference },
  ]
  const inventory = createFreezeContentInventory({
    root: { ...root, objects: 'crewstation' },
    manifest,
    objects,
  })
  for (const location of locations) {
    expect(await inventory.stat(location)).toEqual({ state: 'present', ...contentByteFacts(bytes) })
    expect(await inventory.read(location)).toEqual(bytes)
    expect(resolveContentLocation(location, root).kind).toBe('unsupported')
  }
  values.delete(objectId)
  expect(await inventory.stat(locations[0]!)).toMatchObject({
    state: 'absent',
    cause: 'missing-at-freeze',
  })
  const missing = { codec: 'hosted-object-id', value: 'absent' }
  expect(await inventory.stat(missing)).toMatchObject({
    state: 'absent',
    cause: 'originally-absent',
  })
  values.set('absent', new Uint8Array())
  await expect(inventory.stat(missing)).rejects.toThrow('content-unlisted-present')
})

describeV2Providers('RFC-395 V3 inventory from frozen database rows', (h) => {
  test('indexes database skill trees and hosted port references once, and supports a reopened inventory', async () => {
    await h.install()
    await seedContentParents(h)
    const entries = [
      {
        path: 'bom.md',
        encoding: 'utf8',
        content: '\ufeff技能',
        bytes: new TextEncoder().encode('\ufeff技能'),
      },
      { path: 'empty', encoding: 'utf8', content: '', bytes: new Uint8Array() },
      { path: 'binary', encoding: 'base64', content: '/wCA', bytes: new Uint8Array([255, 0, 128]) },
    ]
    await h.write(
      'skill_content_entries',
      entries.map((entry) =>
        contentFixture('skill_content_entries', {
          path: entry.path,
          encoding: entry.encoding,
          content: entry.content,
          size: entry.bytes.length,
        }),
      ),
    )
    if (h.sourceHarness.provider === 'sqlite') {
      // Bun's TEXT binding strips a leading BOM; CAST exact bytes to seed the intended frozen row.
      h.sourceHarness.sqlite
        .query("UPDATE skill_content_entries SET content=CAST(? AS TEXT) WHERE path='bom.md'")
        .run(entries[0]!.bytes)
    }
    await h.write('skill_versions', [contentFixture('skill_versions')])
    await h.sourceHarness.native.execute(
      `UPDATE ${h.sourceHarness.table('skills')} SET managed_path='database:skill_content_entries' WHERE id='skill'`,
    )
    await h.sourceHarness.native.execute(
      `UPDATE ${h.sourceHarness.table('node_runs')} SET consumed_upstream_runs_json='not json' WHERE id='run'`,
    )
    await h.write('hosted_task_artifacts', [contentFixture('hosted_task_artifacts')])
    await h.write('node_run_outputs', [
      contentFixture('node_run_outputs', {
        archive_json: JSON.stringify({
          v: 1,
          items: [
            {
              path: 'file',
              file: 'runs/task/ports/run/file',
              size: contentBytes.length,
              truncated: false,
            },
          ],
        }),
      }),
    ])
    const reader = await h.sourceHarness.source()
    const preflight = await reader.preflight()
    const source: FrozenSourceHandle = {
      reader,
      preflight,
      preUpgrade: null,
      watermark: preflight.watermark,
      evidenceRoot: null,
      close: () => reader.close(),
    }
    const objects = objectReader(new Map([[objectId, contentBytes]]))
    const hostedRoot = { ...root, objects: 'crewstation' as const }
    const adapter = createContentInventoryAdapter({ objects })
    try {
      const manifest = await adapter.capture({
        source,
        root: hostedRoot,
        destination: join(directory, 'manifest.json'),
      })
      expect(manifest.objects).toEqual([
        { id: objectId, present: true, ...contentByteFacts(contentBytes) },
      ])
      for (let reopen = 0; reopen < 2; reopen++) {
        const inventory = await adapter.open({ source, root: hostedRoot, manifest })
        const location = { codec: 'skill-tree', value: { skillId: 'skill', tree: 'live' } }
        const expected = skillTreeManifestBytes(
          entries.map((entry) => ({ path: entry.path, ...contentByteFacts(entry.bytes) })),
        )
        expect(await inventory.read(location)).toEqual(expected)
        await expect(
          inventory.read({ codec: 'skill-path', value: 'database:skill_content_entries' }),
        ).rejects.toThrow('skill-path-source-identity-required')
        expect(await inventory.stat(location)).toEqual({
          state: 'present',
          ...contentByteFacts(expected),
        })
        for (const entry of entries)
          expect(
            await inventory.read({
              codec: 'skill-tree',
              value: { skillId: 'skill', tree: 'live', path: entry.path },
            }),
          ).toEqual(entry.bytes)
        const port = { codec: 'port-archive-file', value: 'runs/task/ports/run/file' }
        expect(await inventory.read(port)).toEqual(contentBytes)
      }
    } finally {
      await source.close()
    }
  }, 300_000)
  test('a shared database sentinel does not choose an arbitrary skill identity', async () => {
    await h.install()
    await h.write('skills', [
      contentFixture('skills', {
        id: 'a',
        name: 'a',
        managed_path: 'database:skill_content_entries',
      }),
      contentFixture('skills', {
        id: 'b',
        name: 'b',
        managed_path: 'database:skill_content_entries',
      }),
    ])
    const reader = await h.sourceHarness.source()
    const preflight = await reader.preflight()
    const source: FrozenSourceHandle = {
      reader,
      preflight,
      preUpgrade: null,
      watermark: preflight.watermark,
      evidenceRoot: null,
      close: () => reader.close(),
    }
    try {
      const manifest = await captureContentManifest({
        root,
        source,
        destination: join(directory, 'manifest.json'),
      })
      await expect(
        createFreezeContentInventory({ root, manifest, source }).stat({
          codec: 'skill-path',
          value: 'database:skill_content_entries',
        }),
      ).rejects.toThrow('skill-path-source-identity-required')
    } finally {
      await source.close()
    }
  }, 300_000)
})

test('restore --content-root replaces run content while skills stay bound to the backup', async () => {
  file('skills/id/files/SKILL.md', 'backup skill')
  const external = join(directory, 'external')
  mkdirSync(join(external, 'runs/task'), { recursive: true })
  mkdirSync(join(external, 'skills/id/files'), { recursive: true })
  writeFileSync(join(external, 'runs/task/prompt'), 'supplied run')
  writeFileSync(join(external, 'skills/id/files/SKILL.md'), 'wrong skill')
  root = { ...root, kind: 'backup', runContentRoot: external, runsSupplied: true }
  const manifest = await capture()
  const inventory = createFreezeContentInventory({ root, manifest })
  const expected = skillTreeManifestBytes([
    { path: 'SKILL.md', ...contentByteFacts(new TextEncoder().encode('backup skill')) },
  ])
  expect(await inventory.read({ codec: 'skill-path', value: 'skills/id/files' })).toEqual(expected)
  expect(await inventory.read({ codec: 'prompt', value: { promptPath: 'task/prompt' } })).toEqual(
    new TextEncoder().encode('supplied run'),
  )
  expect(manifest.files.map((entry) => entry.path)).toContain('runs/task/prompt')
  expect(manifest.files.map((entry) => entry.path).some((path) => path.includes('..'))).toBe(false)
})
for (const kind of [
  'sqlite-backup',
  'logical-backup',
  'logical-artifact',
  'hosted-backup',
] as const)
  test(`absent run-content evidence names ${kind}`, async () => {
    root = { ...root, kind: 'backup', runsSupplied: false }
    const source = emptySource()
    const preflight = { ...source.preflight, kind }
    const inventory = createFreezeContentInventory({
      root,
      manifest: await capture(),
      source: { ...source, preflight },
    })
    expect(await inventory.stat({ codec: 'review-body', value: 'runs/missing' })).toMatchObject({
      state: 'absent',
      cause: 'originally-absent',
      evidence: `epoch-1 ${kind} run content was not supplied to the restore; absence recorded`,
    })
  })

test('a content manifest keeps its digest when a fresh Job re-materialises its roots', async () => {
  file('skills/id/files/SKILL.md', 'preserved')
  const manifest = await capture()
  const relocated = {
    ...manifest,
    roots: manifest.roots.map((path) => path.replace(root.root, join(directory, 'fresh-home'))),
  }
  expect(() => verifyContentManifest(relocated)).not.toThrow()
})

test('volatile log rotation does not change the backup content digest; skill changes do', async () => {
  file('logs/daemon.log', 'before')
  file('skills/id/files/SKILL.md', 'stable')
  const before = await capture()
  file('logs/daemon.log', 'after quiesce with additional bytes')
  file('logs/rotated/daemon.1', 'rotated')
  const after = await capture()
  expect(after.files).not.toEqual(before.files)
  expect(after.digest).toBe(before.digest)
  file('skills/id/files/SKILL.md', 'changed skill')
  expect((await capture()).digest).not.toBe(before.digest)
})

test('object stat/read downloads once and validation downloads again to detect drift', async () => {
  const bytes = new TextEncoder().encode('object bytes')
  const values = new Map([[objectId, bytes]])
  const reader = objectReader(values)
  let reads = 0
  const objects: InventoryObjectReader = {
    ...reader,
    async open(object) {
      reads += 1
      return reader.open(object)
    },
  }
  const base = await capture()
  const { digest: _digest, ...payload } = base
  const listing = {
    ...payload,
    objects: [{ id: objectId, present: true, ...contentByteFacts(bytes) }],
  }
  const inventory = createFreezeContentInventory({
    root: { ...root, objects: 'crewstation' },
    manifest: { ...listing, digest: contentManifestDigest(listing) },
    objects,
  })
  const location = { codec: 'hosted-object-id', value: objectId }
  await inventory.stat(location)
  await inventory.read(location)
  expect(reads).toBe(1)
  const proof = {
    ...receipt(objectId, bytes),
    target: { ...receipt(objectId, bytes).target, backend: 'object' as const },
  }
  expect(await inventory.verifyUnchanged(receipts(proof))).toEqual([])
  expect(reads).toBe(2)
  values.set(objectId, new TextEncoder().encode('changed'))
  expect(await inventory.verifyUnchanged(receipts(proof))).toHaveLength(1)
})

test('more than 65,536 inline rows stream into operation-local staging without retaining inline payload keys', async () => {
  const base = emptySource()
  const contract = frozenEpoch1Contract.tables.find((table) => table.id === 'node_run_outputs')!
  const total = 65_537
  let reads = 0
  const preflight = { ...base.preflight, contract: { ...frozenEpoch1Contract, tables: [contract] } }
  const scratch = join(directory, 'operation')
  const orphan = join(scratch, 'inventory/conversion-crashed')
  mkdirSync(orphan, { recursive: true })
  writeFileSync(join(orphan, 'staging.sqlite'), 'incomplete')
  const source: FrozenSourceHandle = {
    ...base,
    preflight,
    reader: {
      ...base.reader,
      async readChunk(table, after, limit) {
        reads += 1
        const start = after ? Number((after[0] as { value: string }).value) + 1 : 0
        const values = Array.from({ length: Math.min(limit, total - start) }, (_, offset) =>
          contentFixture('node_run_outputs', {
            node_run_id: String(start + offset),
            content: 'inline'.repeat(64),
            archive_json: null,
          }),
        )
        const rows = values.map((value, offset) => ({
          key: [canonicalValue(String(start + offset)), canonicalValue('out')],
          values: contract.columns.map((column) => canonicalValue(value[column.name]!)),
        }))
        expect(existsSync(join(scratch, 'inventory'))).toBe(true)
        expect(existsSync(orphan)).toBe(false)
        return {
          version: 1,
          table,
          sourceVersion: 'fixture',
          migrationKey: contract.migrationKey,
          afterKey: after,
          firstKey: rows[0]?.key ?? null,
          lastKey: rows.at(-1)?.key ?? null,
          rows,
          decodedRows: values,
          sourceDigest: 'fixture',
        }
      },
    },
  }
  const index = await readInventorySource(source, root, scratch)
  expect(index.receipts.size).toBe(0)
  expect(index.locations.size).toBe(0)
  expect(index.failures.size).toBe(0)
  const before = reads
  expect(await readInventorySource(source, root, scratch)).toBe(index)
  expect(reads).toBe(before)
  expect(readdirSync(join(scratch, 'inventory'))).toEqual([])
}, 300_000)

describeV2Providers('RFC-395 V3-F fix round content integration', (h) => {
  test('real V2-N inline/file prompts and V2-X inline output/database bytes verify without false drift', async () => {
    await h.install()
    const task = taskFacts()
    await writeTask(h, task)
    await h.write('node_runs', [
      runValues('run', { seq: 1, prompt_text: 'inline prompt', prompt_path: null }),
      runValues('file', { seq: 2, prompt_text: null, prompt_path: 'task/prompts/file.md' }),
    ])
    await h.write('node_run_outputs', [contentFixture('node_run_outputs')])
    await h.write('skills', [
      contentFixture('skills', {
        id: 'skill',
        name: 'skill',
        managed_path: 'database:skill_content_entries',
      }),
    ])
    await h.write('skill_content_entries', [contentFixture('skill_content_entries')])
    const path = file('runs/task/prompts/file.md', 'file prompt')
    const input = await h.input([runContribution, contentConversion, contentLookups([task])], {
      fixtures: { taskMounts: [taskMounts()] },
    })
    const source: FrozenSourceHandle = {
      reader: input.source,
      preflight: input.preflight,
      preUpgrade: null,
      watermark: input.preflight.watermark,
      evidenceRoot: null,
      close: () => input.source.close(),
    }
    try {
      const manifest = await captureContentManifest({
        root,
        source,
        destination: join(directory, 'operation/manifest.json'),
      })
      const inventory = createFreezeContentInventory({ root, source, manifest })
      const sink = new V2MemorySink()
      const summary = await runConversion(
        { ...input, content: inventory, contentManifestDigest: manifest.digest },
        sink,
      )
      expect(summary.blocks).toEqual([])
      const artifacts = [...sink.units.values()].flatMap((unit) => unit.artifacts)
      expect(
        artifacts.some(
          (item) => item.sourceColumn === 'prompt_text' && item.target.backend === 'inline',
        ),
      ).toBe(true)
      expect(
        artifacts.some(
          (item) => item.sourceColumn === 'prompt_path' && item.target.backend === 'local-file',
        ),
      ).toBe(true)
      expect(
        artifacts.some(
          (item) => item.sourceTable === 'node_run_outputs' && item.target.backend === 'inline',
        ),
      ).toBe(true)
      expect(artifacts.some((item) => item.target.backend === 'database-bytes')).toBe(true)
      const reopened = createFreezeContentInventory({ root, source, manifest })
      expect(await reopened.verifyUnchanged(receipts(...artifacts))).toEqual([])
      rmSync(path)
      expect(await reopened.verifyUnchanged(receipts(...artifacts))).toEqual([
        expect.objectContaining({ sourceColumn: 'prompt_path', reason: 'missing' }),
      ])
    } finally {
      await source.close()
    }
  }, 300_000)
  test('malformed content rows produce per-row facts and V2 blocks while a neighboring valid output converts', async () => {
    await h.install()
    await seedContentParents(h)
    await h.write('node_run_outputs', [
      contentFixture('node_run_outputs', {
        port_name: 'bad',
        archive_json: '{"v":1,"items":"invalid"}',
      }),
      contentFixture('node_run_outputs', { port_name: 'good' }),
    ])
    await h.write('skill_content_entries', [
      contentFixture('skill_content_entries', { encoding: 'base64', content: '?', size: 1 }),
    ])
    await h.write('collaboration_gate_artifacts', [
      contentFixture('collaboration_gate_artifacts', {
        receipt_json: '{"kind":"cs-review-object-v2","invalid":true}',
      }),
    ])
    const input = await h.input([contentConversion, contentLookups()])
    const source: FrozenSourceHandle = {
      reader: input.source,
      preflight: input.preflight,
      preUpgrade: null,
      watermark: input.preflight.watermark,
      evidenceRoot: null,
      close: () => input.source.close(),
    }
    try {
      const manifest = await captureContentManifest({
        root,
        source,
        destination: join(directory, 'operation/manifest.json'),
      })
      const index = await readInventorySource(source, root)
      expect(index.failures.size).toBeGreaterThanOrEqual(3)
      const inventory = createFreezeContentInventory({ root, source, manifest })
      const sink = new V2MemorySink()
      const summary = await runConversion({ ...input, content: inventory }, sink)
      expect(
        summary.blocks.filter((block) => block.code === 'v2-content-source-invalid').length,
      ).toBeGreaterThanOrEqual(3)
      expect(sink.rows('node_run_outputs').map((row) => row.port_name)).toEqual(['good'])
    } finally {
      await source.close()
    }
  }, 300_000)
  test('two skills with live and version trees share the sentinel but keep six exact inventory identities', async () => {
    await h.install()
    for (const id of ['a', 'b']) {
      await h.write('skills', [
        contentFixture('skills', { id, name: id, managed_path: 'database:skill_content_entries' }),
      ])
      for (const version of [1, 2])
        await h.write('skill_versions', [
          contentFixture('skill_versions', {
            id: `${id}-${version}`,
            skill_id: id,
            version_index: version,
            files_path: 'database:skill_content_entries',
          }),
        ])
      for (const tree of ['live', 'version:1', 'version:2']) {
        const content = `${id}/${tree}`
        await h.write('skill_content_entries', [
          contentFixture('skill_content_entries', {
            skill_id: id,
            tree,
            content,
            size: content.length,
          }),
        ])
      }
    }
    const input = await h.input([contentConversion, contentLookups()])
    const source: FrozenSourceHandle = {
      reader: input.source,
      preflight: input.preflight,
      preUpgrade: null,
      watermark: input.preflight.watermark,
      evidenceRoot: null,
      close: () => input.source.close(),
    }
    try {
      const manifest = await captureContentManifest({
        root,
        source,
        destination: join(directory, 'operation/manifest.json'),
      })
      const inventory = createFreezeContentInventory({ root, manifest, source })
      const sink = new V2MemorySink()
      expect((await runConversion({ ...input, content: inventory }, sink)).blocks).toEqual([])
      expect(manifest.databaseTrees).toHaveLength(6)
      for (const id of ['a', 'b'])
        for (const tree of ['live', 'version:1', 'version:2']) {
          const expected = skillTreeManifestBytes([
            { path: 'SKILL.md', ...contentByteFacts(new TextEncoder().encode(`${id}/${tree}`)) },
          ])
          expect(
            await inventory.read({ codec: 'skill-tree', value: { skillId: id, tree } }),
          ).toEqual(expected)
        }
      expect(
        await inventory.verifyUnchanged(
          receipts(...[...sink.units.values()].flatMap((unit) => unit.artifacts)),
        ),
      ).toEqual([])
    } finally {
      await source.close()
    }
  }, 300_000)
  test('live plan content races use present observations while frozen manifests retain strict drift classification', async () => {
    await h.install()
    const source = await openLiveSnapshotSource({
      location:
        h.sourceHarness.provider === 'sqlite'
          ? {
              kind: 'sqlite-file',
              path: h.sourceHarness.sqlitePath,
              pointerPath: join(directory, 'missing-pointer'),
            }
          : { kind: 'postgresql-database', profileRef: 'env:SOURCE' },
      postgresql: () => h.sourceHarness.runtime,
      manifest: await h.sourceHarness.manifest(),
      emptyTables: [],
      operationRoot: join(directory, 'operation'),
    })
    try {
      const path = file('runs/live.txt', 'before')
      file('skills/live/files/SKILL.md', 'skill')
      const manifest = await captureContentManifest({
        source,
        root,
        destination: join(directory, 'operation/content.json'),
      })
      writeFileSync(path, 'after listing')
      const live = createFreezeContentInventory({ source, root, manifest })
      expect(await live.stat({ codec: 'review-body', value: 'runs/live.txt' })).toMatchObject({
        state: 'present',
      })
      expect(
        await createFreezeContentInventory({ root, manifest }).stat({
          codec: 'review-body',
          value: 'runs/live.txt',
        }),
      ).toMatchObject({ state: 'absent', cause: 'missing-at-freeze' })
      rmSync(path)
      expect(await live.stat({ codec: 'review-body', value: 'runs/live.txt' })).toMatchObject({
        state: 'absent',
        cause: 'originally-absent',
      })
      rmSync(join(root.root, 'skills/live/files'), { recursive: true })
      const tree = { codec: 'skill-path', value: 'skills/live/files' }
      expect(await live.stat(tree)).toMatchObject({ state: 'absent', cause: 'originally-absent' })
      expect(await createFreezeContentInventory({ root, manifest }).stat(tree)).toMatchObject({
        state: 'absent',
        cause: 'missing-at-freeze',
      })
      const values = new Map<string, Uint8Array>()
      const { digest: _digest, ...payload } = manifest
      const objectListing = {
        ...payload,
        objects: [{ id: objectId, present: true, ...contentByteFacts(contentBytes) }],
      }
      const objectInventory = createFreezeContentInventory({
        source,
        root: { ...root, objects: 'crewstation' },
        manifest: { ...objectListing, digest: contentManifestDigest(objectListing) },
        objects: objectReader(values),
      })
      expect(
        await objectInventory.stat({ codec: 'hosted-object-id', value: objectId }),
      ).toMatchObject({ state: 'absent', cause: 'originally-absent' })
      values.set(objectId, contentBytes)
      expect(
        await objectInventory.stat({ codec: 'hosted-object-id', value: objectId }),
      ).toMatchObject({ state: 'present' })
    } finally {
      await source.close()
    }
  }, 300_000)
})
