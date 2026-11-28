// RFC-627: fail-closed CI change classifier against the latest verified green ancestor.
// Zero third-party dependencies: runs directly under Bun in `detect-changes` without `bun install`.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { isMigrationTierTest, isValidBackendTestPath } from './backend-shards'

export type CiMode = 'docs-only' | 'standard' | 'full'

export interface GitCommandResult {
  status: number
  stdout: string
  stderr: string
}

export type CiGitRunner = (args: readonly string[]) => GitCommandResult

export interface CompletedWorkflowRun {
  readonly id: number
  readonly conclusion: string | null
  readonly head_sha: string
  readonly head_repository?: { readonly full_name?: string }
}

export interface ChangeClassificationResult {
  mode: CiMode
  baseSha: string
  linksBaseSha: string
  runFrontendFull: boolean
  runE2e: boolean
  gitleaksBaseSha: string
  reason: string
  changedCount: number
}

export const MAX_ANCESTOR_DISTANCE = 200
export const MAX_RUN_PAGES = 2
export const RUNS_PER_PAGE = 100

export const DOCS_ONLY_EXACT_PATHS = Object.freeze([
  'STATE.md',
  'CLAUDE.md',
  'AGENTS.md',
  'README.md',
  'README.zh-CN.md',
] as const)

export const DOCS_ONLY_DIR_PREFIXES = Object.freeze(['design/', 'docs/', 'proposal/'] as const)

/**
 * Markdown files under `design/` or `docs/` that are read by code/schema/vitest contract tests
 * outside `docs-fast-gate` and must therefore never take the `docs-only` fast path.
 */
export const DOCS_ONLY_EXCLUDED_PATHS = Object.freeze([
  'design/RFC-395-database-target-schema-rebuild/table-mapping.md',
  'design/RFC-349-postgresql-provider-one-click-migration/schema-contract.md',
  'docs/crewstation-automation.md',
] as const)

/** Exact repository files whose modification always promotes CI to `mode=full`. */
export const FULL_TRIGGER_EXACT_PATHS = Object.freeze([
  'packages/backend/src/platform/contracts/migrationDecision.ts',
  'packages/backend/src/platform/contracts/historyRestriction.ts',
  'packages/backend/src/bootstrap/conversionRules.ts',
  'packages/backend/src/bootstrap/persistenceSchema.ts',
  'packages/backend/src/bootstrap/persistenceHead.ts',
  'packages/backend/src/bootstrap/persistenceBaseline.ts',
  'packages/backend/src/bootstrap/migrate.ts',
  'packages/backend/src/bootstrap/historyRestrictions.ts',
  'packages/backend/src/bootstrap/targetColumnDestinations.json',
  'packages/backend/src/bootstrap/targetSchemaRoster.json',
  'packages/backend/src/bootstrap/daemonProviderBootstrap.ts',
  'packages/backend/src/bootstrap/daemonProviderMigrationAdmission.ts',
  'packages/backend/src/cli/epochMigration.ts',
  'packages/backend/src/cli/epochMigrationLegacy.ts',
  'packages/backend/src/cli/database.ts',
  'packages/backend/src/cli/dbCompact.ts',
  'packages/backend/src/cli/migrationReport.ts',
  'packages/backend/src/cli/backup.ts',
  'packages/backend/src/cli/restore.ts',
  'packages/backend/tests/migration-freeze.ts',
  'packages/backend/tests/helpers/eachProvider.ts',
  'packages/backend/tests/helpers/testDatabase.ts',
  'packages/backend/tests/helpers/epochMigrationReachability.ts',
  'scripts/schema-history.ts',
  '.github/scripts/release-upgrade.ts',
  'design/RFC-395-database-target-schema-rebuild/table-mapping.md',
  'design/RFC-349-postgresql-provider-one-click-migration/schema-contract.json',
  'design/RFC-349-postgresql-provider-one-click-migration/schema-contract.md',
  '.github/workflows/ci.yml',
  '.github/workflows/ci-work.yml',
  '.github/workflows/backend-full-nightly.yml',
  '.github/workflows/ci-timings.yml',
  '.github/scripts/ci-postgresql-service.sh',
  'package.json',
  'bun.lock',
  'bunfig.toml',
] as const)

/** Existing directory prefixes whose modification always promotes CI to `mode=full`. */
export const FULL_TRIGGER_DIR_PREFIXES = Object.freeze([
  'packages/backend/src/platform/persistence/',
  'packages/backend/src/platform/content/migration/',
  'packages/backend/src/platform/content/inventory/',
  'packages/backend/src/modules/system-operations/',
  'packages/backend/src/db/',
  'packages/backend/db/',
  'packages/backend/tests/fixtures/release-upgrade/',
  'packages/backend/tests/fixtures/shipped-migrations/',
  'packages/backend/tests/helpers/releaseUpgrade/',
  'packages/backend/tests/helpers/epoch1Protocol/',
  'scripts/release-upgrade/',
  'scripts/ci/',
] as const)

/** Filename prefixes (directory + leading filename stem) promoting CI to `mode=full`. */
export const FULL_TRIGGER_FILE_PREFIXES = Object.freeze([
  'packages/backend/src/bootstrap/epochMigration',
  'packages/backend/src/bootstrap/autoUpgrade',
  'packages/backend/tests/release-upgrade',
  'packages/backend/tests/helpers/epoch2',
] as const)

/** Regex patterns promoting CI to `mode=full`. */
export const FULL_TRIGGER_PATTERNS: readonly RegExp[] = Object.freeze([
  /^packages\/backend\/src\/(?:modules|platform)\/[^/]+\/(?:infrastructure\/)?migration\//,
  /^packages\/backend\/src\/(?:modules|platform)\/[^/]+\/composition\/conversion\.ts$/,
  /^packages\/backend\/src\/(?:modules|platform)\/[^/]+\/(?:composition|infrastructure\/persistence)\/[A-Za-z0-9_-]*[Ss]chema\.ts$/,
  /^packages\/backend\/tests\/(?:helpers\/)?.*(?:rfc395|rfc398|rfc625|rfc626)/,
])

/** Exact repository files whose modification requires the full 3-shard frontend Vitest run. */
export const FRONTEND_FULL_TRIGGER_EXACT_PATHS = Object.freeze([
  'package.json',
  'bun.lock',
  'bunfig.toml',
  'tsconfig.base.json',
  'eslint.config.js',
  '.prettierrc',
  '.prettierignore',
  '.github/workflows/ci.yml',
  '.github/workflows/ci-work.yml',
] as const)

/** Directory prefixes whose modification requires the full 3-shard frontend Vitest run. */
export const FRONTEND_FULL_TRIGGER_DIR_PREFIXES = Object.freeze([
  'packages/frontend/',
  'packages/shared/',
  'scripts/ci/',
] as const)

const DOCS_ONLY_EXACT_SET: ReadonlySet<string> = new Set(DOCS_ONLY_EXACT_PATHS)
const DOCS_ONLY_EXCLUDED_SET: ReadonlySet<string> = new Set(DOCS_ONLY_EXCLUDED_PATHS)
const FULL_TRIGGER_EXACT_SET: ReadonlySet<string> = new Set(FULL_TRIGGER_EXACT_PATHS)
const FRONTEND_FULL_TRIGGER_EXACT_SET: ReadonlySet<string> = new Set(
  FRONTEND_FULL_TRIGGER_EXACT_PATHS,
)

function isValidRepoRelativePath(path: string): boolean {
  if (!path || path.includes('\\') || path.startsWith('/')) return false
  if ([...path].some((ch) => ch.charCodeAt(0) < 32)) return false
  return !path.split('/').some((part) => part === '' || part === '.' || part === '..')
}

function isCommitSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) && !/^0+$/.test(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function isDocsOnlyPath(path: string): boolean {
  if (!isValidRepoRelativePath(path)) return false
  if (DOCS_ONLY_EXCLUDED_SET.has(path)) return false
  if (DOCS_ONLY_EXACT_SET.has(path)) return true
  return path.endsWith('.md') && DOCS_ONLY_DIR_PREFIXES.some((prefix) => path.startsWith(prefix))
}

export function isFullTriggerPath(path: string): boolean {
  if (!isValidRepoRelativePath(path)) return true
  if (isMigrationTierTest(path)) return true
  if (FULL_TRIGGER_EXACT_SET.has(path)) return true
  if (FULL_TRIGGER_DIR_PREFIXES.some((prefix) => path.startsWith(prefix))) return true
  if (FULL_TRIGGER_FILE_PREFIXES.some((prefix) => path.startsWith(prefix))) return true
  return FULL_TRIGGER_PATTERNS.some((pattern) => pattern.test(path))
}

export function isFrontendFullTriggerPath(path: string): boolean {
  if (!isValidRepoRelativePath(path)) return true
  if (FRONTEND_FULL_TRIGGER_EXACT_SET.has(path)) return true
  return FRONTEND_FULL_TRIGGER_DIR_PREFIXES.some((prefix) => path.startsWith(prefix))
}

/**
 * Pure backend test files (`packages/backend/tests/**\/*.{test,spec}.ts`, excluding
 * `helpers/` and `fixtures/` which may be imported by `e2e/`). Changes confined to
 * these paths and docs-only paths do not affect the compiled binary or browser E2E.
 */
export function isBackendTestOnlyPath(path: string): boolean {
  if (!isValidBackendTestPath(path)) return false
  if (
    path.startsWith('packages/backend/tests/helpers/') ||
    path.startsWith('packages/backend/tests/fixtures/')
  )
    return false
  return true
}

export function classifyChangedPaths(paths: readonly string[]): {
  mode: CiMode
  runFrontendFull: boolean
  runE2e: boolean
  reason: string
} {
  if (paths.length === 0)
    return {
      mode: 'full',
      runFrontendFull: true,
      runE2e: true,
      reason: 'empty diff; failing closed to full verification',
    }
  if (paths.some((path) => !isValidRepoRelativePath(path)))
    return {
      mode: 'full',
      runFrontendFull: true,
      runE2e: true,
      reason: 'invalid path in diff; failing closed to full verification',
    }
  if (paths.every(isDocsOnlyPath))
    return {
      mode: 'docs-only',
      runFrontendFull: false,
      runE2e: false,
      reason: `all ${paths.length} changed files match strict Markdown docs allowlist`,
    }
  const runFrontendFull = paths.some(isFrontendFullTriggerPath)
  const runE2e = !paths.every((path) => isDocsOnlyPath(path) || isBackendTestOnlyPath(path))
  const fullHit = paths.find(isFullTriggerPath)
  if (fullHit !== undefined)
    return {
      mode: 'full',
      runFrontendFull,
      runE2e,
      reason: `full verification triggered by ${fullHit}`,
    }
  return {
    mode: 'standard',
    runFrontendFull,
    runE2e,
    reason: `${paths.length} non-migration code/test files changed`,
  }
}

export function parseNullSeparatedPaths(stdout: string): string[] {
  return [...new Set(stdout.split('\0').filter((entry) => entry.length > 0))].sort((a, b) =>
    a.localeCompare(b),
  )
}

function ensureCommit(git: CiGitRunner, sha: string): boolean {
  if (git(['cat-file', '-e', `${sha}^{commit}`]).status === 0) return true
  if (git(['fetch', '--no-tags', '--filter=blob:none', '--depth=1', 'origin', sha]).status !== 0)
    return false
  return git(['cat-file', '-e', `${sha}^{commit}`]).status === 0
}

function failClosedFull(reason: string): ChangeClassificationResult {
  return {
    mode: 'full',
    baseSha: '',
    linksBaseSha: 'ALL',
    runFrontendFull: true,
    runE2e: true,
    gitleaksBaseSha: '',
    reason,
    changedCount: 0,
  }
}

export function resolveCiClassification(options: {
  eventName: string
  payload: unknown
  dispatchMode?: string
  headSha: string
  repository: string
  currentRunId: number
  git: CiGitRunner
  listCompletedMainPushRuns: () => readonly CompletedWorkflowRun[] | null
}): ChangeClassificationResult {
  const { eventName, payload, dispatchMode, headSha, repository, currentRunId, git } = options

  if (eventName === 'workflow_dispatch' && dispatchMode !== 'auto') {
    return failClosedFull(`manual workflow_dispatch requested mode=${dispatchMode || 'full'}`)
  }

  let baseSha: string | null = null
  let compareHead: string | null = null

  if (eventName === 'pull_request') {
    const pr = asRecord(asRecord(payload).pull_request)
    const prBase = asRecord(pr.base).sha
    const prHead = asRecord(pr.head).sha
    if (!isCommitSha(prBase) || !isCommitSha(prHead))
      return failClosedFull('pull_request payload missing immutable base/head SHAs')
    if (!ensureCommit(git, prBase) || !ensureCommit(git, prHead))
      return failClosedFull('pull_request base/head commit unavailable locally')
    baseSha = prBase
    compareHead = prHead
  } else if (
    eventName === 'push' ||
    (eventName === 'workflow_dispatch' && dispatchMode === 'auto')
  ) {
    if (!isCommitSha(headSha)) return failClosedFull('GITHUB_SHA is missing or invalid')
    compareHead = headSha
    const runs = options.listCompletedMainPushRuns()
    if (!runs) return failClosedFull('GitHub Actions API unavailable; failing closed to full')
    for (const run of runs) {
      if (
        run.conclusion !== 'success' ||
        run.id === currentRunId ||
        run.head_repository?.full_name !== repository ||
        !isCommitSha(run.head_sha)
      )
        continue
      if (git(['cat-file', '-e', `${run.head_sha}^{commit}`]).status !== 0) continue
      if (git(['merge-base', '--is-ancestor', run.head_sha, compareHead]).status !== 0) continue
      const distance = git(['rev-list', '--count', `${run.head_sha}..${compareHead}`])
      const count = Number(distance.stdout.trim())
      if (distance.status !== 0 || !Number.isSafeInteger(count) || count > MAX_ANCESTOR_DISTANCE)
        continue
      baseSha = run.head_sha
      break
    }
    if (!baseSha)
      return failClosedFull(
        `no verified green main push ancestor within ${MAX_ANCESTOR_DISTANCE} commits`,
      )
  } else {
    return failClosedFull(`unsupported event '${eventName}'; failing closed to full`)
  }

  const diff = git(['diff', '--name-only', '-z', '--no-renames', baseSha, compareHead])
  if (diff.status !== 0)
    return failClosedFull(`git diff failed between ${baseSha} and ${compareHead}`)

  const changed = parseNullSeparatedPaths(diff.stdout)
  if (changed.length === 0)
    return failClosedFull(
      `empty diff between ${baseSha} and ${compareHead}; failing closed to full`,
    )

  const classified = classifyChangedPaths(changed)
  return {
    mode: classified.mode,
    baseSha,
    linksBaseSha: baseSha,
    runFrontendFull: classified.runFrontendFull,
    runE2e: classified.runE2e,
    gitleaksBaseSha: baseSha,
    reason: `${classified.reason} (${baseSha.slice(0, 8)}..${compareHead.slice(0, 8)})`,
    changedCount: changed.length,
  }
}

function runGit(args: readonly string[]): GitCommandResult {
  const result = spawnSync('git', [...args], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.error?.message ?? result.stderr ?? '',
  }
}

function fetchCompletedMainPushRuns(repository: string): CompletedWorkflowRun[] | null {
  const runs: CompletedWorkflowRun[] = []
  for (let page = 1; page <= MAX_RUN_PAGES; page++) {
    const result = spawnSync(
      'gh',
      [
        'api',
        `repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=${RUNS_PER_PAGE}&page=${page}`,
      ],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    )
    if (result.status !== 0) return null
    let parsed: { workflow_runs?: unknown }
    try {
      parsed = JSON.parse(result.stdout) as { workflow_runs?: unknown }
    } catch {
      return null
    }
    if (!Array.isArray(parsed.workflow_runs)) return null
    for (const raw of parsed.workflow_runs) {
      const entry = asRecord(raw)
      const headRepo = asRecord(entry.head_repository)
      if (typeof entry.id === 'number' && typeof entry.head_sha === 'string') {
        runs.push({
          id: entry.id,
          conclusion: typeof entry.conclusion === 'string' ? entry.conclusion : null,
          head_sha: entry.head_sha,
          head_repository: {
            full_name: typeof headRepo.full_name === 'string' ? headRepo.full_name : undefined,
          },
        })
      }
    }
    if (parsed.workflow_runs.length < RUNS_PER_PAGE) break
  }
  return runs
}

if (import.meta.main) {
  const eventName = process.env.GITHUB_EVENT_NAME ?? ''
  const eventPath = process.env.GITHUB_EVENT_PATH
  const payload: unknown = eventPath ? JSON.parse(readFileSync(eventPath, 'utf8')) : {}
  const repository = process.env.GITHUB_REPOSITORY ?? ''
  const headSha = process.env.GITHUB_SHA ?? ''
  const currentRunId = Number(process.env.GITHUB_RUN_ID ?? '0')
  const dispatchMode = process.env.AW_DISPATCH_MODE

  const result = resolveCiClassification({
    eventName,
    payload,
    dispatchMode,
    headSha,
    repository,
    currentRunId: Number.isSafeInteger(currentRunId) ? currentRunId : 0,
    git: runGit,
    listCompletedMainPushRuns: () => (repository ? fetchCompletedMainPushRuns(repository) : null),
  })

  const outputPath = process.env.GITHUB_OUTPUT
  if (outputPath) {
    const clean = (value: string) => value.replace(/[\r\n]+/g, ' ')
    appendFileSync(
      outputPath,
      [
        `mode=${clean(result.mode)}`,
        `base_sha=${clean(result.baseSha)}`,
        `links_base_sha=${clean(result.linksBaseSha)}`,
        `run_frontend_full=${result.runFrontendFull}`,
        `run_e2e=${result.runE2e}`,
        `gitleaks_base_sha=${clean(result.gitleaksBaseSha)}`,
        `reason=${clean(result.reason)}`,
      ].join('\n') + '\n',
    )
  }
  console.log(JSON.stringify(result, null, 2))
}
