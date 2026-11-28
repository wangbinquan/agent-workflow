// RFC-626 design §3.4 row 4 (and §3.6): with automatic resolution a cached repository whose
// address cannot be read back is converted instead of blocking the upgrade. A sealed address
// stays byte for byte (restoring the key makes it usable again); a legacy escrow the new
// version cannot decode is cleared together with its display form and archived, because the
// new version's backup preparation decodes every escrow on every backup and refuses the whole
// backup for a damaged one (services/repoCredentials.ts decodeLegacyUrlEscrow), and the product
// refuses to refresh exactly when `url_redacted` is NULL (repositoryMirrorCache.ts). Facts that
// contradict the frozen row (`-fact-missing`, `-source-changed`) end the upgrade with an
// engine error. Operator resolution still blocks every one of these rows.
import { expect, test } from 'bun:test'
import { gitUrlCacheKeyWith, parseGitUrl } from '@agent-workflow/shared'
import { sha1Hex } from '@/platform/contracts/hash'
import { createSecretBoxFromKey } from '@/platform/crypto/secretBox'
import {
  conversion,
  repositoryUrlEnvironment,
  legacyUrlEscrowReadable,
  KEPT_UNREADABLE_URL_REASONS,
  URL_KEPT_UNREADABLE,
} from '@/modules/source-control/infrastructure/migration/repositoryUrlRule'
import { LINKABLE_UNREADABLE_URL_REASONS } from '@/modules/integration/infrastructure/migration/scheduledPayloadRule'
import { createBootUpgradeFacts } from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import type { ConversionInput } from '@/platform/persistence/migration/conversion/plan'
import type { MigrationRecord } from '@/platform/persistence/migration/conversion/types'
import type { BootUpgradeCaptureInput } from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'
import { describeV2Providers, emptyV2Content } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'

const escrowPrefix = 'aw-legacy-url-hex-v1:'
const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex')

test('legacy escrow readability matches what the new backup preparation can decode', () => {
  expect(legacyUrlEscrowReadable(`${escrowPrefix}${hex('https://example.test/repo.git')}`)).toBe(
    true,
  )
  for (const value of [
    `${escrowPrefix}`, // empty payload
    `${escrowPrefix}zz`, // not hexadecimal
    `${escrowPrefix}abc`, // odd length
    `${escrowPrefix}ff`, // not UTF-8
    `${escrowPrefix}${hex('not a git url')}`, // decodes, but to no repository address
    hex('https://example.test/repo.git'), // no escrow prefix at all
  ])
    expect(legacyUrlEscrowReadable(value)).toBe(false)
})

test('the schedule rule links by hash for exactly the reasons the cached repository is kept', () => {
  // The two modules keep their own copy (no cross-module import of migration code).
  expect([...LINKABLE_UNREADABLE_URL_REASONS].sort()).toEqual(
    [...KEPT_UNREADABLE_URL_REASONS].sort(),
  )
  expect(KEPT_UNREADABLE_URL_REASONS).not.toContain('v2-boot-url-fact-missing')
  expect(KEPT_UNREADABLE_URL_REASONS).not.toContain('v2-boot-url-source-changed')
  expect(KEPT_UNREADABLE_URL_REASONS).not.toContain('v2-boot-url-reference-conflict')
})

function captureInput(input: ConversionInput, root: string): BootUpgradeCaptureInput {
  const artifacts = new Map<string, Uint8Array>()
  return {
    stage: 'plan',
    source: {
      reader: input.source,
      preflight: input.preflight,
      preUpgrade: null,
      watermark: input.preflight.watermark,
      evidenceRoot: null,
      close: async () => {},
    },
    root: { kind: 'app-home', root, runsSupplied: false, objects: 'none' },
    content: emptyV2Content,
    manifest: {
      version: 1,
      roots: [],
      files: [],
      objects: [],
      databaseTrees: [],
      digest: valueDigest([]),
    },
    readArtifact: async (name) => artifacts.get(name) ?? null,
    writeArtifact: async (name, bytes) => {
      artifacts.set(name, bytes)
    },
  }
}
const decisions = (sink: V2MemorySink, code: string): MigrationRecord[] =>
  [...sink.units.values()]
    .flatMap((unit) => unit.records)
    .filter((record) => record.kind === 'decision' && record.code === code)

const url = 'https://user:token@example.test/repo.git'
const box = createSecretBoxFromKey(Buffer.alloc(32, 7))
const cases = [
  // Sealed with the current key, only this upgrade cannot open it: kept byte for byte.
  { mode: 'sealed-key-missing', reason: 'v2-boot-url-key-missing', cleared: false },
  { mode: 'sealed-key-unreadable', reason: 'v2-boot-url-key-unreadable', cleared: false },
  { mode: 'sealed-wrong-key', reason: 'v2-boot-url-decode-unproven', cleared: false },
  // A readable escrow waits for the key; the new backup preparation seals it then.
  { mode: 'escrow-key-missing', reason: 'v2-boot-url-key-missing', cleared: false },
  // An escrow the new version cannot decode must not reach the new database.
  { mode: 'escrow-malformed', reason: 'v2-boot-url-escrow-invalid', cleared: true },
  { mode: 'escrow-not-utf8', reason: 'v2-boot-url-decode-unproven', cleared: true },
  { mode: 'escrow-not-url', reason: 'v2-boot-url-decode-invalid', cleared: true },
  { mode: 'escrow-malformed-key-missing', reason: 'v2-boot-url-key-missing', cleared: true },
] as const
function storedAddress(mode: (typeof cases)[number]['mode']): string {
  if (mode.startsWith('sealed')) return box.seal(url)
  if (mode === 'escrow-key-missing') return `${escrowPrefix}${hex(url)}`
  if (mode === 'escrow-not-utf8') return `${escrowPrefix}ff`
  if (mode === 'escrow-not-url') return `${escrowPrefix}${hex('not a git url')}`
  return `${escrowPrefix}zz`
}

describeV2Providers('RFC-626 cached repositories whose address is unreadable', (h) => {
  for (const { mode, reason, cleared } of cases)
    test(`${mode}: automatic keeps the repository (${reason}), operator blocks it`, async () => {
      await h.install()
      const original = storedAddress(mode)
      await h.write('cached_repos', [
        frozenValues('cached_repos', {
          id: 'cache',
          url_hash: gitUrlCacheKeyWith(parseGitUrl(url)!, sha1Hex).hash,
          url_enc: original,
          url_redacted: null,
          last_submodule_sync_error: null,
        }),
      ])
      const input = await h.input([conversion])
      try {
        const environment = repositoryUrlEnvironment({
          async open() {
            if (mode === 'sealed-key-unreadable') throw new Error('secret.key is unreadable')
            if (mode.endsWith('key-missing')) return null
            const selected =
              mode === 'sealed-wrong-key' ? createSecretBoxFromKey(Buffer.alloc(32, 8)) : box
            return { identity: 'fixture', fingerprint: 'key', box: selected }
          },
        })
        const facts = createBootUpgradeFacts(
          await environment.capture(captureInput(input, h.sourceHarness.operationRoot)),
        )
        const source = (await input.source.readChunk('cached_repos', null, 10)).decodedRows[0]!

        const sink = new V2MemorySink()
        const summary = await runConversion(
          { ...input, bootUpgradeFacts: facts, resolution: 'automatic' },
          sink,
        )
        expect(summary.blocks).toEqual([])
        expect(summary.status).toBe('converted')
        const row = sink.rows('cached_repos').find((entry) => entry.id === 'cache')!
        expect(row).toBeDefined()
        expect(row.url_hash).toBe(source.url_hash!)
        expect(row.local_path).toBe(source.local_path!)
        if (cleared) {
          expect(row.url_enc).toBeNull()
          expect(row.url_redacted).toBeNull()
        } else {
          expect(row.url_enc).toBe(original)
          expect(row.url_redacted).toBe(source.url_redacted!)
        }
        const kept = decisions(sink, URL_KEPT_UNREADABLE)
        expect(kept).toHaveLength(1)
        const payload = (kept[0] as Extract<MigrationRecord, { kind: 'decision' }>).payload as {
          readonly [key: string]: unknown
        }
        expect(payload).toMatchObject({
          automatic: 'kept',
          sourceTable: 'cached_repos',
          cacheId: 'cache',
          reason,
          encoding: mode.startsWith('sealed') ? 'sealed' : 'escrow',
          address: cleared ? 'cleared' : 'unchanged',
        })
        const units = [...sink.units.values()]
        if (cleared) {
          // The original row, address included, is kept in an archive the decision names.
          expect(typeof payload.archive).toBe('string')
          const archive = units
            .flatMap((unit) => unit.archives)
            .find((entry) => entry.ref === payload.archive)!
          expect(archive).toMatchObject({
            kind: 'source-journal',
            sourceTable: 'cached_repos',
            format: 'logical-row@1',
            rows: 1,
          })
          expect(Buffer.from(archive.bytes).toString('utf8')).toContain(original)
          expect(units.flatMap((unit) => unit.dispositions)).toContainEqual(
            expect.objectContaining({
              sourceTable: 'cached_repos',
              class: 'converted',
              kind: 'conflict-resolved',
              archive: payload.archive,
              decision: expect.objectContaining({ code: URL_KEPT_UNREADABLE }),
            }),
          )
        } else expect(payload.archive).toBeNull()
        // The row is accounted as converted, not set aside.
        expect(
          summary.tableReceipts.find((receipt) => receipt.sourceTable === 'cached_repos')!.counts,
        ).toMatchObject({ converted: 1, archived: 0, blocked: 0 })

        // Operator resolution: the same facts still block the row, as before RFC-626.
        const manualSink = new V2MemorySink()
        const manual = await runConversion({ ...input, bootUpgradeFacts: facts }, manualSink)
        expect(manual.status).toBe('blocked')
        expect(manual.blocks.map((block) => block.code)).toEqual([reason])
        expect(manualSink.rows('cached_repos')).toEqual([])
        expect(decisions(manualSink, URL_KEPT_UNREADABLE)).toEqual([])
        // The source is never written.
        expect(
          (await input.source.readChunk('cached_repos', null, 10)).decodedRows[0]!.url_enc,
        ).toBe(original)
      } finally {
        await input.source.close()
      }
    }, 180_000)

  test('facts that contradict the frozen row end the automatic upgrade with an engine error', async () => {
    await h.install()
    await h.write('cached_repos', [
      frozenValues('cached_repos', {
        id: 'cache',
        url_hash: gitUrlCacheKeyWith(parseGitUrl(url)!, sha1Hex).hash,
        url_enc: box.seal(url),
        url_redacted: null,
      }),
    ])
    const input = await h.input([conversion])
    try {
      // No fact was captured for the row.
      await expect(
        runConversion({ ...input, resolution: 'automatic' }, new V2MemorySink()),
      ).rejects.toThrow('v2-boot-url-fact-missing')
      // A fact captured from a different row.
      const changed = createBootUpgradeFacts([
        {
          id: 'repository-url:cache',
          kind: 'repository-url-key',
          material: null,
          evidence: {
            id: 'cache',
            sourceDigest: valueDigest({ different: true }),
            urlEnc: null,
            urlRedacted: null,
            reason: null,
          },
        },
      ])
      await expect(
        runConversion(
          { ...input, bootUpgradeFacts: changed, resolution: 'automatic' },
          new V2MemorySink(),
        ),
      ).rejects.toThrow('v2-boot-url-source-changed')
      // Operator resolution keeps reporting both as blocks.
      const manual = await runConversion({ ...input }, new V2MemorySink())
      expect(manual.blocks.map((block) => block.code)).toEqual(['v2-boot-url-fact-missing'])
      const manualChanged = await runConversion(
        { ...input, bootUpgradeFacts: changed },
        new V2MemorySink(),
      )
      expect(manualChanged.blocks.map((block) => block.code)).toEqual([
        'v2-boot-url-source-changed',
      ])
    } finally {
      await input.source.close()
    }
  }, 180_000)
})
