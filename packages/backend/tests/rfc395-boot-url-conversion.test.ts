// RFC-395 U-4: escrow conversion is offline, byte-linked, and replayable. Authored for T18.
import { expect, test } from 'bun:test'
import { gitUrlCacheKeyWith, parseGitUrl, redactGitUrl } from '@agent-workflow/shared'
import { redactSensitiveString } from '@/util/redact'
import { sha1Hex } from '@/util/hash'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import {
  conversion,
  repositoryUrlEnvironment,
  repositoryUrlConversion,
} from '@/modules/source-control/infrastructure/migration/repositoryUrlRule'
import {
  createBootUpgradeFacts,
  repositoryUrlFacts,
  resolveRepositoryUrlFact,
  bootUpgradeEffectsFromRecords,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { createStagingStore } from '@/platform/persistence/migration/conversion/staging'
import {
  buildLookups,
  idSetLookup,
  columnLookup,
} from '@/platform/persistence/migration/conversion/lookups'
import { conversion as tasks } from '@/modules/task-execution/infrastructure/migration/task'
import { conversion as schedules } from '@/modules/integration/infrastructure/migration/scheduledPayloadRule'
import { taskRow, repoRow, writeTaskFixture } from './helpers/rfc395V2/taskFixtures'
import { decodeRequestedSourceJson } from '@/modules/task-execution/domain/requestedSourceCodec'
import type { ConversionInput } from '@/platform/persistence/migration/conversion/plan'
import { installFrozenSqlite } from './helpers/rfc395V1Harness'
import { loadFrozenEpoch1History } from '@/platform/persistence/migration/epoch1/bundle'
import { openEpoch1SqliteSource } from '@/platform/persistence/migration/sqliteSourceReader'
import { upgradeEpoch1Copy } from '@/platform/persistence/migration/offlineSourceUpgrade'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { describeV2Providers, emptyV2Content } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'
import type { BootUpgradeCaptureInput } from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'
import type { TargetRow } from '@/platform/persistence/migration/conversion/types'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describeV2Providers('RFC-395 boot repository URLs', (h) => {
  test.each([
    'escrow',
    'sealed-missing-display',
    'missing-key',
    'wrong-key',
    'malformed-escrow',
    'converged',
    'error-only',
  ] as const)(
    '%s is decided from source facts on both providers',
    async (mode) => {
      await h.install()
      const url = 'https://user:token@example.test/repo.git?access_token=original'
      const box = createSecretBoxFromKey(Buffer.alloc(32, 7))
      const original = ['sealed-missing-display', 'wrong-key', 'converged', 'error-only'].includes(
        mode,
      )
        ? box.seal(url)
        : mode === 'malformed-escrow'
          ? 'aw-legacy-url-hex-v1:zz'
          : `aw-legacy-url-hex-v1:${Buffer.from(url).toString('hex')}`
      await h.write('cached_repos', [
        frozenValues('cached_repos', {
          id: 'cache',
          url_hash: gitUrlCacheKeyWith(parseGitUrl(url)!, sha1Hex).hash,
          url_enc: original,
          url_redacted: mode === 'converged' || mode === 'error-only' ? redactGitUrl(url) : null,
          last_submodule_sync_error: mode === 'error-only' ? `failed ${url}` : null,
        }),
      ])
      const input = await h.input([conversion])
      const artifacts = new Map<string, Uint8Array>()
      let seals = 0
      const selectedBox = mode === 'wrong-key' ? createSecretBoxFromKey(Buffer.alloc(32, 8)) : box
      const environment = repositoryUrlEnvironment({
        async open() {
          return mode === 'missing-key'
            ? null
            : {
                identity: 'fixture',
                fingerprint: 'key-7',
                box: {
                  unseal: selectedBox.unseal,
                  seal(text) {
                    seals++
                    return selectedBox.seal(text)
                  },
                },
              }
        },
      })
      const capture: BootUpgradeCaptureInput = {
        stage: 'plan',
        source: {
          reader: input.source,
          preflight: input.preflight,
          preUpgrade: null,
          watermark: input.preflight.watermark,
          evidenceRoot: null,
          close: async () => {},
        },
        root: {
          kind: 'app-home',
          root: h.sourceHarness.operationRoot,
          runsSupplied: false,
          objects: 'none',
        },
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
      try {
        const first = createBootUpgradeFacts(await environment.capture(capture))
        const frozen = createBootUpgradeFacts(
          await environment.capture({ ...capture, stage: 'freeze' }),
        )
        expect(frozen).toEqual(first)
        const sink = new V2MemorySink(),
          summary = await runConversion({ ...input, bootUpgradeFacts: first }, sink)
        const succeeds = ['escrow', 'sealed-missing-display', 'converged', 'error-only'].includes(
          mode,
        )
        expect(summary.status).toBe(succeeds ? 'converted' : 'blocked')
        if (succeeds) {
          const row = sink.rows('cached_repos')[0]!
          expect(box.unseal(String(row.url_enc))).toBe(url)
          expect(String(row.url_redacted)).not.toContain('original')
          expect(seals).toBe(mode === 'escrow' ? 1 : 0)
          expect(bootUpgradeEffectsFromRecords(summary.records)[0]).toMatchObject({
            disposition: mode === 'converged' ? 'copied' : 'transformed',
            sourceTable: 'cached_repos',
          })
          expect(row.last_submodule_sync_error).toBe(
            mode === 'error-only' ? redactSensitiveString(`failed ${url}`) : null,
          )
          if (mode === 'error-only')
            expect(bootUpgradeEffectsFromRecords(summary.records)[0]!.after).toMatchObject({
              error: redactSensitiveString(`failed ${url}`),
              fields: ['last_submodule_sync_error'],
            })
          const replay = new V2MemorySink()
          expect(await runConversion({ ...input, bootUpgradeFacts: frozen }, replay)).toEqual(
            summary,
          )
          expect(replay.rows('cached_repos')).toEqual(sink.rows('cached_repos'))
        } else expect(sink.rows('cached_repos')).toEqual([])
        expect(
          (await input.source.readChunk('cached_repos', null, 100)).decodedRows[0]!.url_enc,
        ).toBe(original)
      } finally {
        await input.source.close()
      }
    },
    180_000,
  )
})

test.each(['tasks', 'task_repos', 'scheduled_tasks'] as const)(
  'raw query bytes in %s select the original cache before display projection; colliding displays keep distinct IDs',
  async (table) => {
    const root = mkdtempSync(join(tmpdir(), 'boot-url-lookup-')),
      staged = createStagingStore(root)
    const urls = [
      'https://example.test/a.git?access_token=one',
      'https://example.test/a.git?access_token=two',
    ]
    const caches = urls.map((url, i) =>
      frozenValues('cached_repos', {
        id: `cache-${i}`,
        url_hash: gitUrlCacheKeyWith(parseGitUrl(url)!, sha1Hex).hash,
        url_enc: null,
        url_redacted: 'https://example.test/a.git?access_token=[REDACTED]',
      }),
    )
    const put = (table: string, values: TargetRow) => {
      const key =
        table === 'task_repos'
          ? [canonicalValue(String(values.task_id)), canonicalValue(Number(values.ordinal))]
          : [canonicalValue(String(values.id))]
      staged.put({
        table,
        key,
        encodedKey: encodeMigrationKey(table, key),
        phase: 'current',
        values,
        canonical: { key, values: Object.values(values).map(canonicalValue) },
      })
    }
    try {
      for (const row of caches) put('cached_repos', row)
      urls.forEach((url, i) =>
        put(
          table,
          table === 'scheduled_tasks'
            ? { id: `schedule-${i}`, launch_payload: JSON.stringify({ repos: [{ repoUrl: url }] }) }
            : table === 'task_repos'
              ? { task_id: `task-${i}`, ordinal: 0, repo_url: url, cached_repo_id: null }
              : { id: `task-${i}`, repo_url: url, cached_repo_id: null },
        ),
      )
      const facts = createBootUpgradeFacts(
        caches.map((row) => ({
          id: `repository-url:${row.id}`,
          kind: 'repository-url-key',
          material: null,
          evidence: {
            id: String(row.id),
            sourceDigest: valueDigest(row),
            urlEnc: null,
            urlRedacted: String(row.url_redacted),
            reason: null,
          },
        })),
      )
      const lookup = await buildLookups(repositoryUrlConversion(facts).lookups, staged)
      expect(
        urls.map(
          (url) => resolveRepositoryUrlFact(lookup(repositoryUrlFacts), url, null).cachedRepoId,
        ),
      ).toEqual(['cache-0', 'cache-1'])
      expect(
        resolveRepositoryUrlFact(lookup(repositoryUrlFacts), urls[0]!, 'cache-1'),
      ).toMatchObject({ state: 'proven', cachedRepoId: 'cache-1', reason: null })
      expect(
        resolveRepositoryUrlFact(lookup(repositoryUrlFacts), urls[0]!, 'deleted'),
      ).toMatchObject({ state: 'proven', cachedRepoId: 'deleted', reason: null })
      expect(
        resolveRepositoryUrlFact(lookup(repositoryUrlFacts), 'unparseable', null),
      ).toMatchObject({ state: 'proven', cachedRepoId: null, repoUrl: 'unparseable' })
    } finally {
      staged.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
)

function urlCapture(input: ConversionInput, root: string): BootUpgradeCaptureInput {
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

describeV2Providers('RFC-395 shared URL decisions and pre-0147 source', (h) => {
  test('one conversion shares URL facts across cached repositories, tasks, mounts and schedules', async () => {
    await h.install()
    const url = 'https://example.test/source.git',
      box = createSecretBoxFromKey(Buffer.alloc(32, 7))
    await h.write('cached_repos', [
      frozenValues('cached_repos', {
        id: 'cache',
        url_hash: gitUrlCacheKeyWith(parseGitUrl(url)!, sha1Hex).hash,
        url_enc: box.seal(url),
        url_redacted: url,
      }),
    ])
    const cases = [
      { id: 'linked', raw: url, cached: null, expected: 'cache' },
      { id: 'dangling', raw: url, cached: 'deleted', expected: 'deleted' },
      { id: 'invalid', raw: 'historical-unparseable-url', cached: null, expected: null },
      { id: 'unmatched', raw: 'https://example.test/unmatched.git', cached: null, expected: null },
    ]
    for (const entry of cases) {
      const task = taskRow(entry.id, { repo_url: entry.raw, cached_repo_id: entry.cached })
      await writeTaskFixture(h, task, { repos: [repoRow(task)] })
      await h.write('scheduled_tasks', [
        frozenValues('scheduled_tasks', {
          id: entry.id,
          launch_payload: JSON.stringify({
            repoUrl: entry.raw,
            ...(entry.cached ? { cachedRepoId: entry.cached } : {}),
          }),
        }),
      ])
    }
    const input = await h.input([
      conversion,
      tasks,
      schedules,
      {
        rules: [],
        validators: [],
        lookups: [
          idSetLookup('users', 'id'),
          columnLookup('workflows', ['id'], ['builtin']),
          columnLookup('node_runs', ['id'], ['continuation_slot_key']),
        ],
      },
    ])
    try {
      const capture = urlCapture(input, h.sourceHarness.operationRoot)
      const env = repositoryUrlEnvironment({
        open: async () => ({ identity: 'fixture', fingerprint: 'key', box }),
      })
      const facts = createBootUpgradeFacts(await env.capture(capture))
      const sink = new V2MemorySink(),
        summary = await runConversion({ ...input, bootUpgradeFacts: facts }, sink)
      expect(summary.blocks).toEqual([])
      for (const entry of cases) {
        const workspace = sink.rows('task_workspaces').find((row) => row.task_id === entry.id)!
        expect(decodeRequestedSourceJson(String(workspace.requested_source)).cachedRepoId).toBe(
          entry.expected,
        )
        expect(
          sink.rows('task_repository_mounts').find((row) => row.task_id === entry.id)!
            .cached_repo_id,
        ).toBe(entry.expected)
        const payload = JSON.parse(
          String(sink.rows('scheduled_tasks').find((row) => row.id === entry.id)!.launch_payload),
        )
        expect(payload.cachedRepoId ?? null).toBe(entry.expected)
        if (entry.expected === null) expect(payload.repoUrl).toBe(entry.raw)
      }
      const mutableCapture: BootUpgradeCaptureInput = {
        ...capture,
        source: {
          ...capture.source,
          reader: {
            ...input.source,
            async readChunk(...args) {
              const chunk = await input.source.readChunk(...args)
              return {
                ...chunk,
                decodedRows: chunk.decodedRows.map((row) => ({
                  ...row,
                  last_fetched_at: 999,
                  last_auto_refresh_at: 1000,
                })),
              }
            },
          },
        },
      }
      const observed = createBootUpgradeFacts(await env.capture(mutableCapture))
      expect(observed.environmentDigest).toBe(facts.environmentDigest)
      expect(valueDigest(observed)).not.toBe(valueDigest(facts))
    } finally {
      await input.source.close()
    }
  }, 180_000)

  if (h.sourceHarness.provider === 'sqlite')
    test('a real pre-0147 source is upgraded offline and then converted without touching plaintext source', async () => {
      const history = await loadFrozenEpoch1History()
      const boundary = history.sqliteTags.indexOf('0147_rfc279_database_redundancy_cleanup')
      expect(boundary).toBeGreaterThan(0)
      await installFrozenSqlite(h.sourceHarness.sqlite, boundary)
      const url = 'https://user:original@example.test/pre-0147.git'
      h.sourceHarness.sqlite
        .query(
          'INSERT INTO cached_repos (id, url, url_hash, local_path, default_branch, last_fetched_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          'legacy-cache',
          url,
          gitUrlCacheKeyWith(parseGitUrl(url)!, sha1Hex).hash,
          '/cache',
          'main',
          1,
          1,
        )
      const manifest = await h.sourceHarness.manifest()
      const source = openEpoch1SqliteSource({
        path: h.sourceHarness.sqlitePath,
        manifest,
        operationRoot: h.sourceHarness.operationRoot,
      })
      const expected = await source.preflight()
      const copy = await upgradeEpoch1Copy({
        source,
        expected,
        manifest,
        operationRoot: h.sourceHarness.operationRoot,
      })
      try {
        const input = await h.input([conversion], { source: copy.reader })
        const before = (await copy.reader.readChunk('cached_repos', null, 10)).decodedRows[0]!
        expect(String(before.url_enc)).toStartWith('aw-legacy-url-hex-v1:')
        const box = createSecretBoxFromKey(Buffer.alloc(32, 7))
        const facts = createBootUpgradeFacts(
          await repositoryUrlEnvironment({
            open: async () => ({ identity: 'fixture', fingerprint: 'key', box }),
          }).capture(urlCapture(input, h.sourceHarness.operationRoot)),
        )
        const sink = new V2MemorySink(),
          summary = await runConversion({ ...input, bootUpgradeFacts: facts }, sink)
        expect(summary.blocks).toEqual([])
        expect(box.unseal(String(sink.rows('cached_repos')[0]!.url_enc))).toBe(url)
        expect(bootUpgradeEffectsFromRecords(summary.records)[0]).toMatchObject({
          disposition: 'transformed',
        })
        await source.assertUnchanged(expected)
        expect(
          h.sourceHarness.sqlite
            .query('SELECT url FROM cached_repos WHERE id = ?')
            .get('legacy-cache'),
        ).toEqual({ url })
      } finally {
        await copy.close()
        await source.close()
      }
    }, 300_000)
})
