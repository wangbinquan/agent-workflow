// RFC-398: these checks are also run by the workflows before real binary verification.
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import {
  assertExpectedStartupFailure,
  applyDocumentedConversions,
  assertProjectionEqual,
  NEGATIVE_SIGNATURES,
  selectReleases,
} from '../../scripts/release-upgrade/verify'
import { spawnSync } from 'node:child_process'
import { OLD_POSTGRESQL_TASK_DEFECTS } from '../../scripts/release-upgrade/scenario'
import { DaemonStartError } from '../../scripts/release-upgrade/lib/daemon'
import { tagSourceArchive } from '../../scripts/release-upgrade/lib/binaries'
import { printedDatabaseStatements } from '../../scripts/release-upgrade/lib/postgresql'
import { FIXTURES, readRegistry } from '../../scripts/release-upgrade/lib/io'
import {
  l1StartFiles,
  l1StartChildEnv,
  nightlyMatrix,
  previousPublishedRelease,
  requireSeedCoverage,
} from './release-upgrade'
import type { BuildCoverage, CoverageLedger } from '../../scripts/release-upgrade/lib/seed-model'
import {
  buildSeedDatabase,
  readApprovedExemptions,
} from '../../scripts/release-upgrade/lib/seed-ledger'

test('negative controls require a seeded home, a real candidate exit, and the specific signature', () => {
  for (const signature of Object.values(NEGATIVE_SIGNATURES)) {
    const failure = (
      started = true,
      code: number | null = 1,
      output: string = signature,
      timedOut = false,
    ) =>
      new DaemonStartError('fixture failure', started, code, output, '/tmp/candidate.log', timedOut)
    expect(() => assertExpectedStartupFailure(failure(), true, signature)).not.toThrow()
    for (const invalid of [
      new Error('asset download failed'),
      failure(false),
      failure(true, null),
      failure(true, 0),
      failure(true, 1, 'different failure'),
      failure(true, 1, signature, true),
    ])
      expect(() => assertExpectedStartupFailure(invalid, true, signature)).toThrow()
    expect(() => assertExpectedStartupFailure(failure(), false, signature)).toThrow()
  }
})

test('projections preserve source fields, values and populations while accepting additional candidate fields', () => {
  const before = [
    { id: 'a', body: 'original' },
    { id: 'b', body: 'second' },
  ]
  expect(() =>
    assertProjectionEqual(before, [
      { id: 'b', body: 'second', extra: 1 },
      { id: 'a', body: 'original' },
    ]),
  ).not.toThrow()
  for (const after of [
    [{ id: 'a', body: 'original' }],
    [{ id: 'a', body: 'changed' }, before[1]!],
    [{ id: 'a' }, before[1]!],
    [before[0]!, before[0]!],
  ])
    expect(() => assertProjectionEqual(before, after)).toThrow()
})

test('schedule repoUrl is accepted as cachedRepoId only when the candidate resolves the same URL', () => {
  const url = 'http://127.0.0.1:1/git/business'
  const before = {
    schedules: [{ id: 's1', launchPayload: { workflowId: 'w', repoUrl: url, ref: 'main' } }],
  }
  const after = {
    schedules: [{ id: 's1', launchPayload: { workflowId: 'w', cachedRepoId: 'r1', ref: 'main' } }],
  }
  const documented = applyDocumentedConversions(before, after, [{ id: 'r1', urlRedacted: url }])
  expect(documented.proofs).toEqual(['schedule-repo-url-as-cached-repo:s1'])
  expect(() => assertProjectionEqual(documented.collections, after)).not.toThrow()
  // The source projection itself is untouched (it is the recorded evidence).
  expect(before.schedules[0]!.launchPayload.repoUrl).toBe(url)
  expect(() =>
    applyDocumentedConversions(before, after, [{ id: 'r1', urlRedacted: 'http://other/x' }]),
  ).toThrow('does not resolve')
  expect(() => applyDocumentedConversions(before, after, [])).toThrow('does not resolve')
  // A candidate that simply dropped the field is still data loss.
  const dropped = { schedules: [{ id: 's1', launchPayload: { workflowId: 'w', ref: 'main' } }] }
  const unchanged = applyDocumentedConversions(before, dropped, [{ id: 'r1', urlRedacted: url }])
  expect(unchanged.proofs).toEqual([])
  expect(() => assertProjectionEqual(unchanged.collections, dropped)).toThrow(
    'repoUrl: source field is missing',
  )
})

test('an older workflow definition is compared after the published format migration', () => {
  const definition = { $schema_version: 6, inputs: [], nodes: [], edges: [] }
  const before = { workflows: [{ id: 'w1', definition }] }
  const migrated = { workflows: [{ id: 'w1', definition: { ...definition, $schema_version: 7 } }] }
  const documented = applyDocumentedConversions(before, migrated, [])
  expect(documented.proofs).toEqual(['workflow-definition-format:w1:v6->v7'])
  expect(() => assertProjectionEqual(documented.collections, migrated)).not.toThrow()
  // Anything beyond the format migration is still a value change.
  const changed = {
    workflows: [{ id: 'w1', definition: { ...definition, $schema_version: 7, nodes: [{}] } }],
  }
  expect(() =>
    assertProjectionEqual(applyDocumentedConversions(before, changed, []).collections, changed),
  ).toThrow()
})

test('the 0188 presence grant is accepted only for pre-0188 sources and only as that key', () => {
  const before = { users: [{ id: 'u1', role: 'user', additionalPermissions: [] }] }
  const after = {
    users: [{ id: 'u1', role: 'user', additionalPermissions: ['users:presence'] }],
  }
  const documented = applyDocumentedConversions(before, after, [], { presenceBackfill: true })
  expect(documented.proofs).toEqual(['users-presence-grant-0188:u1'])
  expect(() => assertProjectionEqual(documented.collections, after)).not.toThrow()
  // A source that already ran 0188 must not gain it, and no other key is ever accepted.
  expect(() =>
    assertProjectionEqual(applyDocumentedConversions(before, after, []).collections, after),
  ).toThrow()
  const other = { users: [{ id: 'u1', role: 'user', additionalPermissions: ['tasks:write'] }] }
  expect(() =>
    assertProjectionEqual(
      applyDocumentedConversions(before, other, [], { presenceBackfill: true }).collections,
      other,
    ),
  ).toThrow()
})

test('the 0173 gitignore commit retirement is accepted only for pre-0173 sources', () => {
  const before = { tasks: [{ id: 't1', repos: [{ repoUrl: 'u', gitignoreCommit: null }] }] }
  const after = { tasks: [{ id: 't1', repos: [{ repoUrl: 'u', workspaceProfileVersion: null }] }] }
  const documented = applyDocumentedConversions(before, after, [], {
    gitignoreCommitRetired: true,
  })
  expect(documented.proofs).toEqual(['task-repo-gitignore-commit-retired-0173:t1:0'])
  expect(() => assertProjectionEqual(documented.collections, after)).not.toThrow()
  expect(() =>
    assertProjectionEqual(applyDocumentedConversions(before, after, []).collections, after),
  ).toThrow('gitignoreCommit: source field is missing')
})

test('restricted-role refusal must contain both original executable DBA statements', () => {
  const target = 'CREATE DATABASE "aw_upgrade_test_epoch2" TEMPLATE template0 OWNER "fixture";'
  const scratch =
    'CREATE DATABASE "aw_upgrade_test_epoch2_scratch" TEMPLATE template0 OWNER "fixture";'
  expect(
    printedDatabaseStatements(JSON.stringify({ error: { statements: [target, scratch] } })),
  ).toEqual([target, scratch])
  expect(
    printedDatabaseStatements(`${target}\n${scratch}\n${JSON.stringify([target, scratch])}`),
  ).toEqual([target, scratch])
  const conclusion = JSON.stringify({
    mode: 'auto',
    outcome: 'refused',
    exitCode: 3,
    guidance: [
      `postgresql-create-database-denied: ${JSON.stringify({ statements: [target, scratch] })}`,
      'Prepare the reported empty databases, then run agent-workflow migrate again.',
    ],
  })
  expect(printedDatabaseStatements(`Startup log\n${conclusion}\nRefused startup`)).toEqual([
    target,
    scratch,
  ])
  expect(() => printedDatabaseStatements(target)).toThrow()
})

test('published predecessor lookup excludes draft, withdrawn tags and the candidate itself', () => {
  expect(
    previousPublishedRelease(
      [
        { tag_name: 'v0.19.4', draft: true, prerelease: false },
        { tag_name: 'v0.19.2', draft: false, prerelease: false },
        { tag_name: 'v0.18.19', draft: false, prerelease: false },
      ],
      'v0.19.4',
    ),
  ).toBe('v0.19.2')
})

test('published prereleases participate in predecessor coverage in semver order', () => {
  const releases = [
    { tag_name: 'v0.19.2', draft: false, prerelease: false },
    { tag_name: 'v0.19.4-rc.2', draft: false, prerelease: true },
    { tag_name: 'v0.19.4-rc.10', draft: false, prerelease: true },
    { tag_name: 'v0.19.4', draft: false, prerelease: false },
  ]
  expect(previousPublishedRelease(releases, 'v0.19.4')).toBe('v0.19.4-rc.10')
  expect(previousPublishedRelease(releases, 'v0.19.4-rc.10')).toBe('v0.19.4-rc.2')
  expect(previousPublishedRelease(releases, 'v0.19.4-rc.1')).toBe('v0.19.2')
  expect(() => previousPublishedRelease(releases, 'main')).toThrow()
})

test('missing, partial, stale and unapproved seed coverage fail release preflight', () => {
  const registry = readRegistry()
  const release = registry.releases.at(-1)!
  const build = {
    buildKey: release.buildKey,
    tags: [release.tag],
    epoch: release.epoch2 ? (2 as const) : (1 as const),
    tables: [
      { table: 'agents', rows: 1, coverage: 'curated' as const, sources: ['fixture'] },
      { table: 'users', rows: 2, coverage: 'curated' as const, sources: ['fixture'] },
    ],
    failures: [],
  }
  const ledger: CoverageLedger = {
    formatVersion: 1,
    evidence: 'receipt-and-seed-sqlite-reconstruction',
    exemptions: [],
    builds: [build],
  }
  const rebuilt = (value: BuildCoverage) => () => value
  expect(() => requireSeedCoverage(registry, ledger, release.tag, rebuilt(build))).not.toThrow()
  expect(() => requireSeedCoverage(registry, ledger, 'v99.99.99', rebuilt(build))).toThrow()
  expect(() =>
    requireSeedCoverage(registry, { ...ledger, builds: [] }, release.tag, rebuilt(build)),
  ).toThrow()
  // A whole table entry dropped from the committed ledger (the rebuild still enumerates it).
  expect(() =>
    requireSeedCoverage(
      registry,
      { ...ledger, builds: [{ ...build, tables: [build.tables[0]!] }] },
      release.tag,
      rebuilt(build),
    ),
  ).toThrow('differs from the rebuilt build')
  // Seeds deleted while the committed ledger still claims rows.
  expect(() =>
    requireSeedCoverage(
      registry,
      ledger,
      release.tag,
      rebuilt({
        ...build,
        tables: [build.tables[0]!, { table: 'users', rows: 0, coverage: 'missing', sources: [] }],
      }),
    ),
  ).toThrow('differs from the rebuilt build')
  const missing = {
    ...build,
    tables: [{ table: 'agents', rows: 0, coverage: 'missing' as const, sources: [] }],
  }
  expect(() =>
    requireSeedCoverage(registry, { ...ledger, builds: [missing] }, release.tag, rebuilt(missing)),
  ).toThrow('incomplete seed coverage')
  const unapproved = {
    ...build,
    tables: [
      {
        table: 'agents',
        rows: 0,
        coverage: 'exempt' as const,
        sources: [],
        exemption: 'unapproved',
      },
    ],
  }
  expect(() =>
    requireSeedCoverage(
      registry,
      { ...ledger, builds: [unapproved] },
      release.tag,
      rebuilt(unapproved),
    ),
  ).toThrow('incomplete seed coverage')
})

test('the committed ledger equals a real rebuild of the latest registered release', () => {
  const registry = readRegistry()
  const release = registry.releases.at(-1)!
  const ledger = JSON.parse(readFileSync(join(FIXTURES, 'coverage.json'), 'utf8')) as CoverageLedger
  const root = mkdtempSync(join(tmpdir(), 'aw-release-seed-test-'))
  try {
    expect(() =>
      requireSeedCoverage(registry, ledger, release.tag, (representative) =>
        buildSeedDatabase(representative, join(root, representative.tag), {
          exemptions: readApprovedExemptions(),
        }),
      ),
    ).not.toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

test('nightly matrix covers exactly the L2 registry shards, both desktop gates and every L1 build/provider through start', () => {
  const registry = readRegistry()
  const matrix = nightlyMatrix(registry, false).include
  expect(matrix.filter((job) => job.os === 'ubuntu-latest').map((job) => job.shard)).toEqual(
    registry.nightlyShards.map((shard) => shard.id),
  )
  for (const shard of registry.nightlyShards)
    expect(selectReleases(registry, 'nightly', undefined, shard.id).map((r) => r.tag)).toEqual(
      shard.tags,
    )
  expect(matrix.filter((job) => job.os !== 'ubuntu-latest').map((job) => job.selection)).toEqual([
    'gate',
    'gate',
  ])
  expect(nightlyMatrix(registry, true).include).toHaveLength(3)
  expect(() => selectReleases(registry, 'nightly', undefined, 'absent')).toThrow()
  const files = l1StartFiles(registry)
  expect(new Set(files).size).toBe(files.length)
  expect(files.filter((f) => f.endsWith('-sqlite.test.ts'))).toHaveLength(registry.l1Builds.length)
  expect(files.filter((f) => f.endsWith('-postgresql.test.ts'))).toHaveLength(
    registry.l1Builds.filter((b) => {
      const r = registry.releases.find((r) => r.tag === b.representative)!
      return r.epoch2 || r.epoch1?.postgresql
    }).length,
  )
  expect(() => l1StartFiles({ ...registry, l1Builds: registry.l1Builds.slice(1) })).toThrow(
    'every registered build/provider',
  )
  const workflow = parse(
    readFileSync(new URL('../workflows/release-upgrade-nightly.yml', import.meta.url), 'utf8'),
  )
  const job = workflow.jobs['l1-start']
  expect(job.needs).toBe('plan')
  expect(job['runs-on']).toBe('ubuntu-latest')
  expect(job.if).toBeUndefined()
  const steps = job.steps as {
    uses?: string
    run?: string
    id?: string
    if?: string
    with?: Record<string, unknown>
    env?: Record<string, string>
  }[]
  expect(steps.find((s) => s.uses === 'actions/checkout@v5')?.with).toEqual({
    ref: '${{ needs.plan.outputs.tools-ref }}',
    'fetch-depth': 0,
  })
  expect(steps.find((s) => s.uses === 'oven-sh/setup-bun@v2')?.with?.['bun-version']).toBe('1.4.3')
  expect(steps.find((s) => s.uses === 'actions/cache@v6')?.with?.path).toBe('~/.bun/install/cache')
  const start = steps.findIndex(
    (s) => s.run === 'bash .github/scripts/ci-postgresql-service.sh start awtest',
  )
  const run = steps.findIndex((s) => s.run === 'bun .github/scripts/release-upgrade.ts l1-start')
  const stop = steps.findIndex(
    (s) => s.run === 'bash .github/scripts/ci-postgresql-service.sh stop',
  )
  expect(start).toBeGreaterThan(0)
  expect(run).toBeGreaterThan(start)
  expect(stop).toBeGreaterThan(run)
  expect(steps[run]!.if).toBeUndefined()
  // RFC-359 W8: AW_TEST_PROVIDERS stays out of workflows (default = both providers); the
  // runner pins both for every child, asserted with the runner below.
  expect(steps[run]!.env).toEqual({
    AW_TEST_POSTGRESQL_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/awtest',
    AW_RELEASE_UPGRADE_MODE: 'start',
  })
  expect(steps[stop]!.if).toBe(
    "always() && steps.postgres.outcome != '' && steps.postgres.outcome != 'skipped'",
  )
})

test('L1 start children run both providers in start mode even when the caller narrowed', () => {
  expect(
    l1StartChildEnv({
      AW_TEST_PROVIDERS: 'sqlite',
      AW_RELEASE_UPGRADE_MODE: 'in-process',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      AW_TEST_POSTGRESQL_URL: 'postgresql://ci/awtest',
    }),
  ).toEqual({
    AW_TEST_PROVIDERS: 'sqlite,postgresql',
    AW_RELEASE_UPGRADE_MODE: 'start',
    AW_TEST_POSTGRESQL_URL: 'postgresql://ci/awtest',
  })
})

test('release re-runs have no public asset mutation before all upgrade gates pass', () => {
  const workflow = parse(readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8'))
  expect(workflow.jobs.publish.needs).toEqual(['build', 'upgrade-gate'])
  for (const name of ['build', 'upgrade-gate']) {
    expect(JSON.stringify(workflow.jobs[name])).not.toContain('gh release upload')
    expect(JSON.stringify(workflow.jobs[name])).not.toContain('--draft=false')
  }
  const create = workflow.jobs['create-release'].steps[0].run as string
  expect(create.indexOf('gh release view')).toBeLessThan(create.indexOf('gh release create'))
  expect(create).toContain('exit 0')
  const publish = JSON.stringify(workflow.jobs.publish.steps)
  expect(publish.indexOf('gh release upload')).toBeLessThan(publish.indexOf('--draft=false'))
})

// Release-upgrade nightly 41287876705: v0.15.0 / v0.15.1 stub runs exited 3 ("prompt is missing the
// RFC-200 envelope nonce"). Those releases mint a run nonce but render bare prompts; the runner
// passes the nonce into the prompt only from v0.16.0. Pending gates follow the stored nonce
// (RFC-395 v2-run-null-nonce), the runtime shim's transport follows the prompt.
test('run nonce and prompt nonce are registered separately; the shim follows the prompt', () => {
  const caps = new Map(readRegistry().releases.map((r) => [r.tag, r.runtime.capabilities]))
  const pick = (tag: string) => {
    const c = caps.get(tag)!
    return { nonce: c.nonce, promptNonce: c.promptNonce }
  }
  expect(pick('v0.14.1')).toEqual({ nonce: false, promptNonce: false })
  expect(pick('v0.15.0')).toEqual({ nonce: true, promptNonce: false })
  expect(pick('v0.15.1')).toEqual({ nonce: true, promptNonce: false })
  expect(pick('v0.16.0')).toEqual({ nonce: true, promptNonce: true })
  for (const [tag, c] of caps)
    if (c.promptNonce) expect({ tag, nonce: c.nonce }).toEqual({ tag, nonce: true })
  const daemon = readFileSync(
    new URL('../../scripts/release-upgrade/lib/daemon.ts', import.meta.url),
    'utf8',
  )
  expect(daemon).toContain(
    "AW_RELEASE_LEGACY_ENVELOPE: options.release.runtime.capabilities.promptNonce ? '0' : '1'",
  )
})

// Release-upgrade nightly 41287876705 (Windows): under Git Bash `tar` is MSYS GNU tar, which cannot
// use a native `C:\…` path as `-C`; extraction runs in the archive directory instead.
test('tag-build extraction passes no native path to tar', () => {
  const binaries = readFileSync(
    new URL('../../scripts/release-upgrade/lib/binaries.ts', import.meta.url),
    'utf8',
  )
  expect(binaries).toContain("command(['tar', '-xf', '-'], { input: archive, cwd: scratch })")
  expect(binaries).not.toMatch(/\['tar',[^\]]*'-C'/)
})

/** The bytes of one regular file in a tar stream (git archive writes ustar plus a pax header). */
function tarMember(archive: Buffer, name: string): Buffer | null {
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) return null
    const member = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').trim() || '0', 8)
    if (member === name) return archive.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return null
}

// Release-upgrade nightly 41303628365 (Windows): tags before RFC-254's .gitattributes carry no eol
// rule and `git archive` applies the runner's `core.autocrlf=true`, so bun.lock arrived with CRLF and
// `bun install --frozen-lockfile` refused it for v0.1.0, v0.10.0 and v0.16.3. The tag build must
// archive the committed bytes whatever the host's line-ending configuration.
test('tag-build archives committed bytes under core.autocrlf=true', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'aw-tag-archive-'))
  try {
    const git = (...args: string[]) => {
      const identity = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid']
      const signing = ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false']
      const result = spawnSync('git', [...identity, ...signing, ...args], { cwd: repo })
      if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr.toString()}`)
      return result.stdout
    }
    const committed = '{\n  "lockfileVersion": 1,\n  "workspaces": {}\n}\n'
    git('init', '-q')
    writeFileSync(join(repo, 'bun.lock'), committed)
    git('add', 'bun.lock')
    git('commit', '-q', '-m', 'lock')
    git('tag', 'v9.9.9')
    // The windows-latest runner's global configuration, scoped to this repository.
    git('config', 'core.autocrlf', 'true')
    // Control: the plain archive reproduces the nightly's CRLF lockfile on this host too.
    expect(tarMember(git('archive', '--format=tar', 'v9.9.9'), 'bun.lock')?.toString()).toBe(
      committed.replaceAll('\n', '\r\n'),
    )
    expect(tarMember(await tagSourceArchive('v9.9.9', repo), 'bun.lock')?.toString()).toBe(
      committed,
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

// User decision 2026-11-01: only the nightly verify job may read the draft release holding the
// retained v0.19.3 assets (GitHub lists drafts only to write-capable tokens); it never publishes.
test('nightly verify can read the retained draft assets and publishes nothing', () => {
  const nightly = parse(
    readFileSync(new URL('../workflows/release-upgrade-nightly.yml', import.meta.url), 'utf8'),
  )
  expect(nightly.permissions).toEqual({ contents: 'read', actions: 'read' })
  expect(nightly.jobs.verify.permissions).toEqual({ contents: 'write', actions: 'read' })
  for (const [name, job] of Object.entries(
    nightly.jobs as Record<string, { permissions?: unknown }>,
  ))
    if (name !== 'verify')
      expect({ name, permissions: job.permissions }).toEqual({ name, permissions: undefined })
  const steps = JSON.stringify(nightly.jobs.verify.steps)
  for (const mutation of [
    'gh release upload',
    'gh release create',
    'gh release edit',
    '--draft=false',
  ])
    expect(steps).not.toContain(mutation)
})

// Release-upgrade nightly 41287876705: v0.18.13–v0.18.15 have the profile route but a strict schema
// without gitName (HTTP 422 unrecognized_keys); the field arrived in v0.18.16.
test('the profile PATCH sends gitName only to releases whose schema accepts it', () => {
  const caps = new Map(readRegistry().releases.map((r) => [r.tag, r.runtime.capabilities]))
  expect([caps.get('v0.18.15')!.profileGitName, caps.get('v0.18.16')!.profileGitName]).toEqual([
    false,
    true,
  ])
  for (const [tag, c] of caps)
    if (c.profileGitName) expect({ tag, profile: c.profile }).toEqual({ tag, profile: true })
  const client = readFileSync(
    new URL('../../scripts/release-upgrade/lib/client.ts', import.meta.url),
    'utf8',
  )
  expect(client).toContain(
    "...(capabilities.profileGitName ? { gitName: 'Release Upgrade Fixture' } : {})",
  )
  expect(client).not.toMatch(/^\s+gitName: 'Release Upgrade Fixture',$/m)
})

// Old PostgreSQL releases may fail their own task writes after their one-click migration; the
// scenario tolerates only the recorded exact message, and each one must exist in that release.
test('recorded old PostgreSQL task defects are exact messages from each release source', () => {
  const tags = Object.keys(OLD_POSTGRESQL_TASK_DEFECTS)
  expect(tags).toEqual(['v0.18.18', 'v0.18.19', 'v0.19.0', 'v0.19.1', 'v0.19.2', 'v0.19.3'])
  for (const [tag, defect] of Object.entries(OLD_POSTGRESQL_TASK_DEFECTS)) {
    const grep = spawnSync(
      'git',
      ['grep', '-l', '-F', defect.signature, tag, '--', 'packages/backend/src'],
      {
        cwd: new URL('../..', import.meta.url).pathname,
      },
    )
    expect({ tag, found: grep.status === 0 && grep.stdout.toString().trim().length > 0 }).toEqual({
      tag,
      found: true,
    })
  }
})
