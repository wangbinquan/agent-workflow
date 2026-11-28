// RFC-626 §3.4 row 2b ("校验的配合") and §7 "封存与保留 / 内容": an automatic upgrade records
// content that is not provable as missing (for example a file that appeared after the inventory)
// and the new database asserts nothing about those bytes. Verification therefore must not compare
// a receipt registered as missing with the disk in automatic mode, or a file at that location
// would fail the upgrade as content drift. Receipts that register bytes are still compared, so an
// edit after conversion is still drift. With the resolution omitted or `operator` nothing changes.
// The adapter case locks that `ContentInventoryPort.open` hands the resolution through.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureContentManifest } from '@/platform/content/inventory/manifest'
import { createFreezeContentInventory } from '@/platform/content/inventory/freezeInventory'
import { contentByteFacts } from '@/platform/content/inventory/treeDigest'
import { createContentInventoryAdapter } from '@/modules/system-operations/infrastructure/epochSwitch/contentInventoryAdapter'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import type {
  ArtifactReceipt,
  ConversionResolution,
} from '@/platform/persistence/migration/conversion/types'
import type {
  ContentRootSpec,
  FreezeContentManifest,
  FrozenSourceHandle,
} from '@/platform/persistence/migration/run/types'
import type { SourcePreflight } from '@/platform/persistence/migration/sourceTypes'

let directory: string
let root: ContentRootSpec
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'rfc626-verify-'))
  root = { kind: 'app-home', root: join(directory, 'home'), runsSupplied: true, objects: 'none' }
  mkdirSync(root.root)
}, 5_000)
afterEach(() => rmSync(directory, { recursive: true, force: true }), 5_000)

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

const encoder = new TextEncoder()
function write(path: string, text: string): string {
  const absolute = join(root.root, path)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, text)
  return absolute
}
function receipt(
  id: string,
  reference: string,
  content:
    | { readonly bytes: string }
    | { readonly missing: 'originally-absent' | 'missing-at-freeze' },
): ArtifactReceipt {
  const key = encodeMigrationKey('doc_versions', [canonicalValue(id)])
  return {
    sourceTable: 'doc_versions',
    sourceKey: key,
    sourceColumn: 'body_path',
    originalReference: reference,
    target: { table: 'doc_versions', key, backend: 'local-file', contentId: null },
    bytes: 'bytes' in content ? contentByteFacts(encoder.encode(content.bytes)) : null,
    publication: 'not-required',
    missing:
      'missing' in content
        ? { state: content.missing, evidence: `registered ${id} missing` }
        : null,
  }
}
async function* stream(values: readonly ArtifactReceipt[]) {
  yield* values
}

/**
 * Captures a listing of `runs/kept.md` and `runs/changed.md`, then — after the inventory — adds
 * `runs/late.md` and rewrites `runs/changed.md` with the same size and modification time.
 */
async function scenario(): Promise<{
  readonly manifest: FreezeContentManifest
  readonly receipts: readonly ArtifactReceipt[]
}> {
  write('runs/kept.md', 'kept')
  const changed = write('runs/changed.md', 'before')
  utimesSync(changed, 1000, 1000)
  const manifest = await captureContentManifest({
    root,
    source: emptySource(),
    destination: join(directory, 'operation/content-listing.json'),
  })
  write('runs/late.md', 'appeared after the inventory')
  writeFileSync(changed, 'after!')
  utimesSync(changed, 1000, 1000)
  return {
    manifest,
    receipts: [
      // Registered with bytes, unchanged.
      receipt('kept', 'runs/kept.md', { bytes: 'kept' }),
      // Registered with bytes, edited after conversion.
      receipt('changed', 'runs/changed.md', { bytes: 'before' }),
      // Registered missing (not in the listing at conversion); a file is there now.
      receipt('late', 'runs/late.md', { missing: 'originally-absent' }),
      // Registered missing although the listed file is present and unchanged.
      receipt('kept-missing', 'runs/kept.md', { missing: 'missing-at-freeze' }),
      // Registered missing and still absent, with the cause the inventory observes.
      receipt('never', 'runs/never.md', { missing: 'originally-absent' }),
      // Registered missing and absent, but under a different cause.
      receipt('never-lost', 'runs/never.md', { missing: 'missing-at-freeze' }),
    ],
  }
}

const OPERATOR_DRIFT = [
  ['runs/changed.md', 'digest-changed'],
  ['runs/late.md', 'unlisted'],
  ['runs/kept.md', 'unlisted'],
  ['runs/never.md', 'missing'],
]
const AUTOMATIC_DRIFT = [['runs/changed.md', 'digest-changed']]
const expectations: readonly [ConversionResolution | undefined, string[][]][] = [
  [undefined, OPERATOR_DRIFT],
  ['operator', OPERATOR_DRIFT],
  ['automatic', AUTOMATIC_DRIFT],
]

for (const [resolution, expected] of expectations)
  test(`verification with resolution ${resolution ?? 'omitted'} compares ${resolution === 'automatic' ? 'only receipts that register bytes' : 'every receipt'} with the disk`, async () => {
    const { manifest, receipts } = await scenario()
    const inventory = createFreezeContentInventory({
      root,
      manifest,
      source: emptySource(),
      ...(resolution ? { resolution } : {}),
    })
    const drift = await inventory.verifyUnchanged(stream(receipts))
    expect(drift.map((entry) => [entry.originalReference, entry.reason])).toEqual(expected)
    const changed = drift.find((entry) => entry.originalReference === 'runs/changed.md')!
    expect(changed.expected).toEqual(contentByteFacts(encoder.encode('before')))
    expect(changed.actual).toEqual(contentByteFacts(encoder.encode('after!')))
  })

test('in automatic mode a registered-missing receipt is left alone even when its file was listed and is gone', async () => {
  const { manifest } = await scenario()
  const inventory = createFreezeContentInventory({ root, manifest, resolution: 'automatic' })
  rmSync(join(root.root, 'runs/kept.md'))
  expect(
    await inventory.verifyUnchanged(
      stream([receipt('kept-missing', 'runs/kept.md', { missing: 'originally-absent' })]),
    ),
  ).toEqual([])
  // The same location registered with bytes is still reported.
  expect(
    (
      await inventory.verifyUnchanged(stream([receipt('kept', 'runs/kept.md', { bytes: 'kept' })]))
    ).map((entry) => entry.reason),
  ).toEqual(['missing'])
})

test('the content inventory adapter hands the resolution to the platform inventory', async () => {
  const { manifest, receipts } = await scenario()
  const adapter = createContentInventoryAdapter()
  const reasons = async (resolution?: ConversionResolution) =>
    (
      await (
        await adapter.open({
          manifest,
          root,
          source: emptySource(),
          ...(resolution ? { resolution } : {}),
        })
      ).verifyUnchanged(stream(receipts))
    ).map((entry) => [entry.originalReference, entry.reason])
  expect(await reasons('automatic')).toEqual(AUTOMATIC_DRIFT)
  expect(await reasons('operator')).toEqual(OPERATOR_DRIFT)
  expect(await reasons()).toEqual(OPERATOR_DRIFT)
})
