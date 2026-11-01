#!/usr/bin/env bun
// RFC-398: read-only release preflight and matrices. No release/tag/run mutations.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { command, FIXTURES, REPO_ROOT, readRegistry } from '../../scripts/release-upgrade/lib/io'
import { matrixCases } from '../../packages/backend/tests/helpers/releaseUpgrade/cases'
import { executableName, nativePlatform } from '../../scripts/release-upgrade/lib/model'
import type { ReleaseEntry, ReleaseRegistry } from '../../scripts/release-upgrade/lib/model'
import type { BuildCoverage, CoverageLedger } from '../../scripts/release-upgrade/lib/seed-model'
import {
  buildSeedDatabase,
  readApprovedExemptions,
} from '../../scripts/release-upgrade/lib/seed-ledger'

interface PublishedRelease {
  tag_name: string
  draft: boolean
  prerelease: boolean
}

export function previousPublishedRelease(releases: PublishedRelease[], candidate: string): string {
  const versionTag = /^v\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/
  if (!versionTag.test(candidate)) throw new Error(`Invalid candidate release tag: ${candidate}`)
  const order = (a: string, b: string) => Bun.semver.order(a.slice(1), b.slice(1))
  const previous = releases
    .filter((r) => !r.draft && versionTag.test(r.tag_name) && order(r.tag_name, candidate) < 0)
    .sort((a, b) => order(a.tag_name, b.tag_name))
    .at(-1)
  if (!previous) throw new Error(`No published release below ${candidate}`)
  return previous.tag_name
}

/**
 * RFC-398 §7.5/§7.7 (implementation gate r1 P1-2): the committed ledger is not evidence by
 * itself. The predecessor's build is rebuilt from its receipts and the current seeds, which
 * enumerates every table of that release's schema; the committed entry must equal that rebuild
 * (a dropped table entry or deleted seeds behind an unchanged ledger both fail), and every
 * rebuilt table needs rows or an approved exact-build exemption.
 */
export function requireSeedCoverage(
  registry: ReleaseRegistry,
  ledger: CoverageLedger,
  tag: string,
  rebuild: (representative: ReleaseEntry) => BuildCoverage,
): void {
  const release = registry.releases.find((r) => r.tag === tag)
  if (!release)
    throw new Error(
      `${tag}: highest preceding published release is not registered; run registry.ts --write after publishing each release`,
    )
  const mapping = registry.l1Builds.find(
    (b) => b.buildKey === release.buildKey && b.tags.includes(tag),
  )
  const committed = ledger.builds.find(
    (b) => b.buildKey === release.buildKey && b.tags.includes(tag),
  )
  if (!mapping || !committed || !committed.tables.length)
    throw new Error(`${tag}: missing seed coverage for ${release.buildKey}`)
  const representative = registry.releases.find((r) => r.tag === mapping.representative)
  if (!representative) throw new Error(`${tag}: build representative is not registered`)
  const coverage = rebuild(representative)
  const comparable = (build: BuildCoverage) =>
    JSON.stringify({
      tables: [...build.tables].sort((a, b) => a.table.localeCompare(b.table)),
      failures: build.failures,
    })
  if (comparable(coverage) !== comparable(committed))
    throw new Error(
      `${tag}: committed seed coverage differs from the rebuilt build; run scripts/release-upgrade/seed-ledger.ts check --write-coverage and review the seeds`,
    )
  const missing = coverage.tables.filter((table) => {
    if ((table.coverage === 'curated' || table.coverage === 'scenario') && table.rows > 0)
      return false
    if (table.coverage !== 'exempt') return true
    return !ledger.exemptions.some(
      (e) =>
        e.id === table.exemption &&
        e.table === table.table &&
        e.epoch === coverage.epoch &&
        e.status === 'approved' &&
        e.buildKeys.includes(release.buildKey),
    )
  })
  if (coverage.failures.length || missing.length)
    throw new Error(
      `${tag}: incomplete seed coverage: ${JSON.stringify({ failures: coverage.failures, tables: missing.map((t) => t.table) })}`,
    )
}

export function nightlyMatrix(registry: ReleaseRegistry, negativeControl: boolean) {
  const desktop = ['macos-latest', 'windows-latest'].map((os) => ({
    os,
    id: os,
    selection: 'gate',
    shard: '',
    tags: negativeControl ? 'v0.19.2' : '',
    variants: 'sqlite,sqlite-no-sidecar',
  }))
  const linux = negativeControl
    ? [
        {
          os: 'ubuntu-latest',
          id: 'linux-negative-control',
          selection: 'gate',
          shard: '',
          tags: 'v0.19.2',
          variants: 'sqlite,sqlite-no-sidecar,postgresql',
        },
      ]
    : registry.nightlyShards.map((shard) => ({
        os: 'ubuntu-latest',
        id: shard.id,
        selection: 'nightly',
        shard: shard.id,
        tags: '',
        variants: 'sqlite,sqlite-no-sidecar,postgresql,postgresql-restricted-role,chain',
      }))
  const assigned = registry.nightlyShards.flatMap((s) => s.tags)
  const required = registry.releases.filter((r) => r.binaries['linux-x86_64']).map((r) => r.tag)
  if (
    new Set(assigned).size !== assigned.length ||
    required.some((tag) => !assigned.includes(tag)) ||
    assigned.some((tag) => !required.includes(tag))
  )
    throw new Error(
      'nightlyShards must map every Linux binary exactly once, including logged unsupported entries',
    )
  if (linux.length + desktop.length > 256)
    throw new Error('GitHub matrix exceeds 256 jobs; consolidate registry nightlyShards')
  return { include: [...linux, ...desktop] }
}

/** L1 is independent of L2 asset/approval selection: every registered build/provider. */
export function l1StartFiles(registry: ReleaseRegistry): string[] {
  const expected = registry.l1Builds
    .flatMap((build) => {
      const release = registry.releases.find((r) => r.tag === build.representative)!
      return (
        release.epoch2 || release.epoch1?.postgresql ? ['sqlite', 'postgresql'] : ['sqlite']
      ).map((provider) => `${build.buildKey}/${provider}`)
    })
    .sort()
  if (
    JSON.stringify(matrixCases.map((c) => `${c.buildKey}/${c.provider}`).sort()) !==
    JSON.stringify(expected)
  )
    throw new Error('L1 cases must cover every registered build/provider exactly once')
  return matrixCases.map((c) => {
    const file = `packages/backend/tests/release-upgrade-matrix-${c.id}.test.ts`
    if (!existsSync(join(REPO_ROOT, file))) throw new Error(`Missing L1 matrix file: ${file}`)
    return file
  })
}

/** Every L1 child runs both providers through `start`, whatever narrowing the caller inherited. */
export function l1StartChildEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const child: Record<string, string | undefined> = {
    ...env,
    AW_TEST_PROVIDERS: 'sqlite,postgresql',
    AW_RELEASE_UPGRADE_MODE: 'start',
  }
  delete child.CLAUDECODE
  delete child.CLAUDE_CODE_ENTRYPOINT
  return child
}

async function runL1Start(registry: ReleaseRegistry): Promise<void> {
  if (!process.env.AW_TEST_POSTGRESQL_URL)
    throw new Error('L1 nightly requires the PostgreSQL service; no provider skips')
  const files = l1StartFiles(registry)
  const logs = join(REPO_ROOT, 'release-upgrade-l1-logs')
  mkdirSync(logs, { recursive: true })
  const results: { file: string; code: number; seconds: number }[] = []
  let next = 0
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (;;) {
        const file = files[next++]
        if (!file) return
        const started = performance.now()
        const env = l1StartChildEnv(process.env)
        const child = Bun.spawn(
          [process.execPath, 'test', '--isolate', '--timeout', '600000', file],
          {
            cwd: REPO_ROOT,
            env,
            stdout: 'pipe',
            stderr: 'pipe',
          },
        )
        const deadline = setTimeout(() => child.kill('SIGKILL'), 1_500_000)
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]).finally(() => clearTimeout(deadline))
        writeFileSync(join(logs, file.split('/').at(-1)! + '.log'), stdout + stderr)
        const result = { file, code, seconds: (performance.now() - started) / 1000 }
        results.push(result)
        console.log(JSON.stringify(result))
      }
    }),
  )
  writeFileSync(join(logs, 'results.json'), JSON.stringify(results, null, 2) + '\n')
  if (results.length !== files.length || results.some((r) => r.code !== 0))
    throw new Error(
      `L1 start matrix failed: ${results
        .filter((r) => r.code !== 0)
        .map((r) => r.file)
        .join(', ')}`,
    )
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      tag: { type: 'string' },
      'negative-control': { type: 'boolean', default: false },
    },
  })
  const registry = readRegistry()
  if (positionals[0] === 'preflight') {
    const releases = JSON.parse(
      (
        await command([
          'gh',
          'api',
          `repos/${registry.repository}/releases`,
          '--paginate',
          '--slurp',
        ])
      ).toString(),
    ) as PublishedRelease[][]
    const previous = previousPublishedRelease(releases.flat(), values.tag ?? '')
    const path = join(FIXTURES, 'coverage.json')
    if (!existsSync(path)) throw new Error(`${previous}: seed coverage ledger is missing`)
    const exemptions = readApprovedExemptions()
    const root = mkdtempSync(join(tmpdir(), 'aw-release-seed-'))
    try {
      requireSeedCoverage(
        registry,
        JSON.parse(readFileSync(path, 'utf8')) as CoverageLedger,
        previous,
        (representative) =>
          buildSeedDatabase(representative, join(root, representative.tag), { exemptions }),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    console.log(
      `Highest published release below ${values.tag}: ${previous}; registered with seed coverage`,
    )
  } else if (positionals[0] === 'l1-start') {
    await runL1Start(registry)
  } else if (positionals[0] === 'matrix') {
    const matrix = JSON.stringify(nightlyMatrix(registry, values['negative-control']!))
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`)
    console.log(matrix)
  } else if (positionals[0] === 'candidate-path') {
    console.log(join('dist', executableName(nativePlatform())))
  } else if (positionals[0] === 'stub-path') {
    console.log(
      join(
        'dist',
        `stub-opencode-${nativePlatform()}${process.platform === 'win32' ? '.exe' : ''}`,
      ),
    )
  } else
    throw new Error(
      'Expected preflight --tag, matrix [--negative-control], l1-start, candidate-path, or stub-path',
    )
}
