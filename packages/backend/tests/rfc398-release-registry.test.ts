// RFC-398 T7: offline receipt/provenance guards. These tests deliberately do not
// read Git tags, download releases, start a daemon, or call the registry generator.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { LEGACY_MIGRATION_HASHES } from '../src/platform/persistence/migration/epoch1/journalAliases'
import {
  buildIdentity,
  compareTags,
  l1Builds,
  PLATFORMS,
  selectRegistryTags,
} from '../../../scripts/release-upgrade/lib/model'
import type { ReleaseRegistry, Row } from '../../../scripts/release-upgrade/lib/model'
import {
  canonical,
  FIXTURES,
  normalizeHome,
  REPO_ROOT,
  sha256,
  walk,
} from '../../../scripts/release-upgrade/lib/io'
import { verifyBinary } from '../../../scripts/release-upgrade/lib/binaries'
import { canonicalRows, logicalValue } from '../../../scripts/release-upgrade/record'
import type { FinalizeFixtureManifest } from '../../../scripts/release-upgrade/record'
import { projectRows } from '../../../scripts/release-upgrade/lib/client'

const registry = JSON.parse(
  readFileSync(join(FIXTURES, 'releases.json'), 'utf8'),
) as ReleaseRegistry
const sqliteRoot = join(REPO_ROOT, 'packages/backend/db/migrations')
const pgRoot = join(REPO_ROOT, 'packages/backend/db/postgresql-migrations')
const historyRoot = join(REPO_ROOT, 'packages/backend/db/schema-history/epoch2')
const frozenJournal = JSON.parse(readFileSync(join(sqliteRoot, 'meta/_journal.json'), 'utf8')) as {
  entries: { tag: string; when: number }[]
}
const frozenMigrations = readMigrationFiles({ migrationsFolder: sqliteRoot })
const digest = /^sha256:[a-f0-9]{64}$/
const hex = /^[a-f0-9]{64}$/

describe('RFC-398 published release registry', () => {
  test('tags are unique, monotonic, and retain the full initial publication inventory', () => {
    expect(registry.formatVersion).toBe(1)
    expect(registry.releases.length).toBeGreaterThanOrEqual(80)
    expect(registry.releases[0]!.tag).toBe('v0.1.0')
    expect(registry.releases.some((release) => release.tag === 'v0.19.3')).toBe(true)
    for (let index = 0; index < registry.releases.length; index += 1) {
      const release = registry.releases[index]!
      if (index) expect(compareTags(registry.releases[index - 1]!.tag, release.tag)).toBeLessThan(0)
      expect(release.commit).toMatch(/^[a-f0-9]{40}$/)
      expect(release.bunVersion).toMatch(/^\d+\.\d+\.\d+$/)
      expect(Number(release.epoch1 !== null) + Number(release.epoch2 !== null)).toBe(1)
    }
  })

  test('SQLite records every journal row and uses Drizzle raw UTF-8 SQL hashes', () => {
    for (const release of registry.releases) {
      if (!release.epoch1) continue
      expect(release.epoch1.sqlite.length).toBeGreaterThan(0)
      for (const [index, receipt] of release.epoch1.sqlite.entries()) {
        const journal = frozenJournal.entries[index]!
        expect(receipt.tag).toBe(journal.tag)
        expect(receipt.created_at).toBe(journal.when)
        const replacement = release.releasedSql.find(
          (sql) => sql.provider === 'sqlite' && sql.migration === receipt.tag,
        )
        const bytes = readFileSync(
          replacement ? join(FIXTURES, replacement.file) : join(sqliteRoot, `${receipt.tag}.sql`),
        )
        expect(receipt.hash).toBe(sha256(bytes.toString('utf8')))
        if (!replacement) {
          expect(receipt.hash).toBe(frozenMigrations[index]!.hash)
          expect(receipt.created_at).toBe(frozenMigrations[index]!.folderMillis)
        } else if (replacement.recognizedAlias) {
          expect(LEGACY_MIGRATION_HASHES[receipt.tag]).toContain(receipt.hash)
        }
      }
    }
  })

  test('all released SQL is content addressed and every changed receipt has its actual bytes', () => {
    const referenced = new Set<string>()
    for (const release of registry.releases)
      for (const sql of release.releasedSql) {
        expect(sql.file).toBe(`released-sql/${sql.sha256}.sql`)
        expect(sql.sha256).toMatch(hex)
        expect(sha256(readFileSync(join(FIXTURES, sql.file)))).toBe(sql.sha256)
        const path = join(sql.provider === 'sqlite' ? sqliteRoot : pgRoot, `${sql.migration}.sql`)
        expect(sql.frozenSha256).toBe(existsSync(path) ? sha256(readFileSync(path)) : null)
        expect(sql.sha256).not.toBe(sql.frozenSha256)
        referenced.add(sql.file)
      }
    const shipped = registry.releases.find((release) => release.tag === 'v0.18.10')!
    expect(
      shipped.releasedSql.find((sql) => sql.migration === '0111_rfc223_agent_refs_to_id')?.sha256,
    ).toBe('8f7584ecb9229bf9bfad82040d9fab68a11ed4885748e7f034eee0b0f8510d97')
    expect(referenced.size).toBeGreaterThanOrEqual(4)
  })

  test('PostgreSQL begins at v0.18.18 and preserves both rewritten baselines and every upgrade receipt', () => {
    for (const release of registry.releases) {
      if (release.epoch2) continue
      const pg = release.epoch1!.postgresql
      if (compareTags(release.tag, 'v0.18.18') < 0) {
        expect(pg).toBeNull()
        continue
      }
      expect(pg?.length).toBeGreaterThan(0)
      const original = release.tag === 'v0.18.18' || release.tag === 'v0.18.19'
      expect(release.epoch1!.postgresqlSource).toBe(original ? 'released-baseline' : 'frozen')
      const baseline = JSON.parse(
        readFileSync(
          original
            ? join(FIXTURES, 'released-postgresql', release.tag, 'meta/_journal.json')
            : join(pgRoot, 'meta/_journal.json'),
          'utf8',
        ),
      ) as { baselineId: string; contractDigest: string; planDigest: string }
      for (const [index, receipt] of pg!.entries()) {
        expect(receipt.contractDigest).toMatch(digest)
        expect(receipt.planDigest).toMatch(digest)
        const replaced = release.releasedSql.find(
          (sql) => sql.provider === 'postgresql' && `${sql.migration}.sql` === receipt.sqlFile,
        )
        expect(receipt.sqlSha256).toBe(
          sha256(
            readFileSync(replaced ? join(FIXTURES, replaced.file) : join(pgRoot, receipt.sqlFile)),
          ),
        )
        if (index === 0) {
          expect(receipt.baselineId).toBe(baseline.baselineId)
          expect(receipt.contractDigest).toBe(baseline.contractDigest)
          expect(receipt.planDigest).toBe(baseline.planDigest)
        } else {
          const step = JSON.parse(
            readFileSync(
              join(pgRoot, 'meta', receipt.sqlFile.replace(/\.sql$/, '.upgrade.json')),
              'utf8',
            ),
          ) as { id: string; digest: string; to: { contractDigest: string; planDigest: string } }
          expect(receipt.baselineId).toBe(`upgrade:${step.id}:${step.digest}`)
          expect(receipt.contractDigest).toBe(step.to.contractDigest)
          expect(receipt.planDigest).toBe(step.to.planDigest)
        }
      }
      expect(release.epoch1!.postgresqlFresh).toEqual([
        {
          baselineId: pg![0]!.baselineId,
          contractDigest: pg!.at(-1)!.contractDigest,
          planDigest: pg!.at(-1)!.planDigest,
        },
      ])
      if (original) {
        expect(release.epoch1!.sqlite).toHaveLength(223)
        expect(release.epoch1!.postgresqlBaselinePath).toEndWith(
          `/released-postgresql/${release.tag}`,
        )
      }
    }
    const bridges = registry.releases.filter(
      (release) => release.epoch1?.postgresqlSource === 'released-baseline',
    )
    expect(
      new Set(bridges.map((release) => release.epoch1!.postgresql![0]!.contractDigest)).size,
    ).toBe(2)
  })

  test('epoch-2 points to real versioned history with matching contract and provider plans', () => {
    for (const release of registry.releases) {
      const epoch = release.epoch2
      if (!epoch) continue
      const contract = JSON.parse(
        readFileSync(join(historyRoot, `${epoch.history}.contract.json`), 'utf8'),
      ) as { version: number; digest: string }
      expect(epoch.version).toBe(contract.version)
      expect(epoch.contractDigest).toBe(contract.digest)
      for (const provider of ['sqlite', 'postgresql'] as const) {
        const plan = JSON.parse(
          readFileSync(join(historyRoot, `${epoch.history}.${provider}-plan.json`), 'utf8'),
        ) as { digest: string }
        expect(epoch[`${provider}PlanDigest`]).toBe(plan.digest)
      }
    }
    expect(registry.releases.find((release) => release.tag === 'v0.19.3')!.epoch2?.history).toBe(
      '0000_rfc395_target_baseline',
    )
  })

  test('buildKey deduplicates only identical receipts, and every release has exactly one L1 mapping', () => {
    for (const release of registry.releases)
      expect(release.buildKey).toBe(`sha256:${sha256(canonical(buildIdentity(release)))}`)
    expect(registry.l1Builds).toEqual(l1Builds(registry.releases))
    expect(new Set(registry.l1Builds.map((build) => build.buildKey)).size).toBe(
      registry.l1Builds.length,
    )
    expect(registry.l1Builds.flatMap((build) => build.tags).sort(compareTags)).toEqual(
      registry.releases.map((release) => release.tag),
    )
    expect(registry.l1Builds.some((build) => build.tags.length > 1)).toBe(true)
    const original = registry.releases[0]!
    const changed = structuredClone(original)
    changed.epoch1!.sqlite[0]!.hash = '0'.repeat(64)
    expect(sha256(canonical(buildIdentity(changed)))).not.toBe(
      sha256(canonical(buildIdentity(original))),
    )
  })

  test('binary provenance, Bun fallback and nightly shard mappings are complete, including unapproved exclusions', () => {
    for (const release of registry.releases) {
      expect(release.fallback).toEqual({
        kind: 'tag-build',
        evidenceLevel: 4,
        bunVersion: release.bunVersion,
      })
      for (const [platform, binary] of Object.entries(release.binaries)) {
        expect(PLATFORMS as readonly string[]).toContain(platform)
        expect(binary.sha256).toMatch(hex)
        expect(binary.evidenceLevel).toBe(binary.kind === 'release-asset' ? 1 : 2)
        expect(binary.release).toBe(
          binary.kind === 'retained-asset' ? 'upgrade-fixture-binaries' : release.tag,
        )
      }
      if (release.binaries['linux-x86_64']) {
        expect(release.l2.nightly).toBe(true)
        expect(
          registry.nightlyShards.filter((shard) => shard.tags.includes(release.tag)),
        ).toHaveLength(1)
        expect(
          registry.nightlyShards.find((shard) => shard.id === release.l2.shard)?.tags,
        ).toContain(release.tag)
      }
      if (release.l2.unsupported) expect(release.l2.unsupported).toContain('requires user approval')
      expect(release.runtime.sourceSha256).toMatch(hex)
      expect(release.runtime.probeVersion).toMatch(/^\d+\.\d+\.\d+$/)
    }
    expect(new Set(registry.nightlyShards.map((shard) => shard.id)).size).toBe(
      registry.nightlyShards.length,
    )
    expect(registry.releases.at(-1)!.l2.gate).toBe(true)
    const withdrawn = registry.releases.find((release) => release.tag === 'v0.19.3')!
    expect(withdrawn.binaries['linux-x86_64']!.sha256).toBe(
      '364fafdbfdd4f54d360c4186ececbfed1aef96da9f25c32861544afb5768f4ca',
    )
    expect(withdrawn.binaries['macos-arm64']!.provenance?.reportedVersion).toBe('d7b5d9d')
  })

  test('runtime gates and resource selectors retain old protocol boundaries', () => {
    const runtime = (tag: string) =>
      registry.releases.find((release) => release.tag === tag)!.runtime
    expect(runtime('v0.10.0').minimum).toBe('1.14.0')
    expect(runtime('v0.10.0').maximumExclusive).toBe('1.17.0')
    expect(runtime('v0.17.0').minimum).toBe('1.18.3')
    expect(runtime('v0.1.0').capabilities.auth).toBe('token')
    expect(runtime('v0.10.0').capabilities.auth).toBe('session')
    expect(runtime('v0.18.2').capabilities.auth).toBe('bootstrap')
    expect(runtime('v0.16.3').capabilities.workgroupId).toBe(false)
    expect(runtime('v0.16.3').capabilities.skillId).toBe(false)
    expect(runtime('v0.18.2').capabilities.workgroupId).toBe(true)
    expect(runtime('v0.18.2').capabilities.skillId).toBe(true)
  })
})

// RFC-398 §7.7 release gate: when `vN` is being released its tag exists and its GitHub
// release is still a draft, so `registry.ts --check --candidate vN` must only consider tags
// strictly below the candidate (published prereleases included, ordered by semver).
describe('RFC-398 registry tag selection for the release gate', () => {
  test('the candidate and anything newer are not evidence yet', () => {
    const tags = ['v0.19.3', 'v0.19.2', 'v0.20.0', 'v0.19.4', 'not-a-release', 'v0.19.10']
    expect(selectRegistryTags(tags, 'v0.19.4')).toEqual(['v0.19.2', 'v0.19.3'])
    expect(selectRegistryTags(tags)).toEqual([
      'v0.19.2',
      'v0.19.3',
      'v0.19.4',
      'v0.19.10',
      'v0.20.0',
    ])
  })
  test('prereleases sort before their release and are kept below the candidate', () => {
    expect(compareTags('v1.0.0-rc.1', 'v1.0.0')).toBeLessThan(0)
    expect(compareTags('v0.19.10', 'v0.19.9')).toBeGreaterThan(0)
    expect(selectRegistryTags(['v1.0.0', 'v1.0.0-rc.1', 'v0.19.3'], 'v1.0.0')).toEqual([
      'v0.19.3',
      'v1.0.0-rc.1',
    ])
  })
  test('malformed candidates are rejected', () => {
    expect(() => selectRegistryTags(['v0.19.3'], 'main')).toThrow('Not a release tag')
  })
})

describe('RFC-398 recorder and acquisition guards', () => {
  test('corrupted cached bytes fail digest verification', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc398-hash-'))
    try {
      const file = join(root, 'binary')
      writeFileSync(file, 'approved bytes')
      verifyBinary(file, sha256('approved bytes'))
      writeFileSync(file, 'corrupted bytes')
      expect(() => verifyBinary(file, sha256('approved bytes'))).toThrow('SHA-256 mismatch')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test('row recording is order independent, path-normalized and lossless for bigint/blob', () => {
    const values = [
      {
        id: 2,
        path: '/tmp/record-home/skills/x',
        blob: Buffer.from([0, 255]),
        n: 9007199254740993n,
      },
      { id: 1, value: null },
    ]
    const encoded = canonicalRows(values, '/tmp/record-home')
    expect(encoded).toBe(canonicalRows([...values].reverse(), '/tmp/record-home'))
    expect(encoded).toContain('<AW_HOME>/skills/x')
    expect(encoded).not.toContain('/tmp/record-home')
    expect(encoded).toContain('9007199254740993')
    expect(logicalValue(Buffer.from([0, 255]))).toEqual({ $bytes: 'AP8=' })
    expect(normalizeHome({ nested: ['/tmp/record-home/a'] }, '/tmp/record-home')).toEqual({
      nested: ['<AW_HOME>/a'],
    })
  })
  test('API projections retain business state while excluding restart-sensitive timestamps', () => {
    const before = projectRows(
      'tasks',
      [{ id: 't', status: 'awaiting_review', inputs: { text: 'keep' }, startedAt: 1 }],
      '/home',
    )
    expect(before).toEqual(
      projectRows(
        'tasks',
        [{ id: 't', status: 'awaiting_review', inputs: { text: 'keep' }, startedAt: 999 }],
        '/home',
      ),
    )
    expect(before).not.toEqual(
      projectRows('tasks', [{ id: 't', status: 'done', inputs: { text: 'keep' } }], '/home'),
    )
  })
  for (const tag of ['v0.19.2', 'v0.18.19'])
    test(`${tag} finalize captures retain authenticated bytes and fit within 1 MB`, () => {
      const root = join(FIXTURES, 'rfc349-finalize', tag)
      const fixture = JSON.parse(
        readFileSync(join(root, 'capture.json'), 'utf8'),
      ) as FinalizeFixtureManifest
      expect(fixture.binarySha256).toBe(
        registry.releases.find((release) => release.tag === tag)!.binaries['macos-arm64']!.sha256,
      )
      for (const state of ['before', 'after'] as const) {
        const recorded = fixture.states[state]
        for (const file of recorded.files)
          expect(sha256(readFileSync(join(root, state, file.path)))).toBe(file.sha256)
        const compressed = readFileSync(join(root, recorded.postgres.file))
        expect(sha256(compressed)).toBe(recorded.postgres.compressedSha256)
        expect(sha256(gunzipSync(compressed))).toBe(recorded.postgres.sourceSha256)
        expect(recorded.omitted.length).toBeGreaterThan(0)
        for (const file of recorded.omitted) {
          expect(file.path.includes('/chunks/') || file.path.includes('/source-backup/')).toBe(true)
          expect(existsSync(join(root, state, file.path))).toBe(false)
        }
        const migration = join(root, state, 'home/database-migrations', fixture.operationId)
        const manifest = JSON.parse(readFileSync(join(migration, 'manifest.json'), 'utf8')) as {
          payload: Row
        }
        expect(manifest.payload.phase).toBe(state === 'before' ? 'accepting-writes' : 'finalized')
        expect(manifest.payload.firstLiveWriteAt === null).toBe(state === 'before')
        expect(existsSync(join(migration, 'receipt.json'))).toBe(state === 'after')
      }
      expect(
        walk(root).reduce((total, path) => total + statSync(path).size, 0),
      ).toBeLessThanOrEqual(1_000_000)
    })
})
