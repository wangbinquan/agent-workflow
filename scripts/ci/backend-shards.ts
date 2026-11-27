// RFC-627: deterministic backend test tiering and LPT shard planning.
// Zero third-party dependencies: runs directly under Bun in no-install CI jobs.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type BackendTestTier = 'core' | 'migration' | 'all'

export const BACKEND_TEST_PATH_PATTERN =
  /^packages\/backend\/tests\/(?:[^/]+\/)*[^/]+\.(?:test|spec)\.ts$/

export const BACKEND_CORE_SHARDS = 16
export const BACKEND_MIGRATION_SHARDS = 28
export const BACKEND_FULL_SHARDS = 44

export const DEFAULT_CORE_FILE_MS = 10_000
export const DEFAULT_MIGRATION_FILE_MS = 30_000

/** Only backend tests that depend on or opportunistically probe a real `opencode` binary on PATH. */
export const SHARD_1_PINNED_FILES = Object.freeze([
  'packages/backend/tests/cli.test.ts',
  'packages/backend/tests/opencode-version.test.ts',
] as const)

/**
 * Pure-SQLite / static migration smoke tests retained in the standard per-push `core` tier.
 * None of these files may use dual-provider or PostgreSQL test helpers, so `mode=full` never
 * loses any PostgreSQL migration coverage when `migration = all \ core`.
 */
export const CORE_MIGRATION_SMOKE = Object.freeze([
  'packages/backend/tests/release-upgrade-matrix-55-v0_19_2-sqlite.test.ts',
  'packages/backend/tests/release-upgrade-matrix-56-v0_19_3-sqlite.test.ts',
  'packages/backend/tests/rfc398-auto-upgrade-resume-intent.test.ts',
  'packages/backend/tests/rfc398-auto-upgrade-resume-phase-frozen.test.ts',
  'packages/backend/tests/rfc395-r1-target-contract.test.ts',
  'packages/backend/tests/rfc395-schema-equivalence.test.ts',
  'packages/backend/tests/rfc395-v3-plan-document.test.ts',
] as const)

const CORE_MIGRATION_SMOKE_SET: ReadonlySet<string> = new Set(CORE_MIGRATION_SMOKE)

/**
 * Curated real-PostgreSQL + same-process dual-engine parity suite executed on every code push
 * by `ci-work.yml:test-backend-postgresql`.
 */
export const TEST_BACKEND_POSTGRESQL_FILES = Object.freeze([
  'packages/backend/tests/rfc357-postgresql-page.integration.test.ts',
  'packages/backend/tests/rfc357-page-parity.test.ts',
  'packages/backend/tests/rfc357-provider-portability.test.ts',
  'packages/backend/tests/rfc357-task-list-authorization.test.ts',
  'packages/backend/tests/rfc359-engine-capabilities.test.ts',
  'packages/backend/tests/rfc359-each-provider-harness.test.ts',
  'packages/backend/tests/rfc311-perf-guards.test.ts',
  'packages/backend/tests/architecture/rfc359-w5-composition-root-route-surface.test.ts',
  'packages/backend/tests/rfc359-w6-t26-postgresql-plan-audit.test.ts',
  'packages/backend/tests/rfc359-w8-migration-lock-scope.test.ts',
  'packages/backend/tests/rfc615-g1-plan-stability.test.ts',
  'packages/backend/tests/rfc397-owner-fenced-writes-read-committed.test.ts',
  'packages/backend/tests/tasks.test.ts',
  'packages/backend/tests/rfc359-t2c-review-decision.test.ts',
  'packages/backend/tests/rfc099-acl-endpoints-matrix.test.ts',
  'packages/backend/tests/release-upgrade-matrix-56-v0_19_3-postgresql.test.ts',
] as const)

/**
 * Heavy migration, cross-version upgrade, and hosted PostgreSQL recovery suites.
 * Any file matching these patterns (and not in `CORE_MIGRATION_SMOKE`) belongs to `migration`,
 * runs on every `mode=full` push (`test-backend-migration`, 28 shards, dual-engine PG) and
 * daily in `backend-full-nightly.yml` (44 shards, dual-engine PG + coverage).
 */
export const MIGRATION_TIER_PATTERNS: readonly RegExp[] = Object.freeze([
  /^packages\/backend\/tests\/release-upgrade-matrix-/,
  /^packages\/backend\/tests\/rfc398-/,
  /^packages\/backend\/tests\/rfc395-/,
  /^packages\/backend\/tests\/rfc626-/,
  /^packages\/backend\/tests\/rfc625-source-manifest-native\.test\.ts$/,
  /^packages\/backend\/tests\/rfc349-postgresql-logical-target-finalization\.test\.ts$/,
  /^packages\/backend\/tests\/rfc349-database-migration-coordinator\.integration\.test\.ts$/,
  /^packages\/backend\/tests\/rfc359-t19h-postgresql-migration-sequence\.test\.ts$/,
  /^packages\/backend\/tests\/rfc359-w8-migrator-conformance\.test\.ts$/,
  /^packages\/backend\/tests\/rfc359-w8-logical-source-conformance\.test\.ts$/,
  /^packages\/backend\/tests\/rfc359-t19h-logical-backup-restore\.test\.ts$/,
  /^packages\/backend\/tests\/rfc370-m0-hosted-postgresql\.integration\.test\.ts$/,
  /^packages\/backend\/tests\/rfc370-m3-hosted-database-restore\.integration\.test\.ts$/,
  /^packages\/backend\/tests\/rfc370-v3-hosted-standby-boot\.integration\.test\.ts$/,
  /^packages\/backend\/tests\/rfc370-v3-hosted-write-window\.integration\.test\.ts$/,
  /^packages\/backend\/tests\/rfc374-node-run-seq-migration\.test\.ts$/,
  /^packages\/backend\/tests\/rfc602-code-history-index-upgrade\.test\.ts$/,
  /^packages\/backend\/tests\/epoch1-permission-text-backup\.test\.ts$/,
  /^packages\/backend\/tests\/skill-identity-migration\.test\.ts$/,
  /^packages\/backend\/tests\/skill-legacy-op-upgrade\.test\.ts$/,
  /^packages\/backend\/tests\/upgrade-rolling\.test\.ts$/,
  /^packages\/backend\/tests\/fusion-provenance-repair\.test\.ts$/,
  /^packages\/backend\/tests\/rfc370-skill-identity-content\.test\.ts$/,
])

export interface BackendShardPlan {
  version: 1
  tier: BackendTestTier
  shard: { current: number; total: number }
  assignments: string[][]
  estimatedShardMs: number[]
  unknownFiles: string[]
}

export function isValidBackendTestPath(path: string): boolean {
  return (
    BACKEND_TEST_PATH_PATTERN.test(path) &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..') &&
    !path.includes('\\') &&
    ![...path].some((character) => character.charCodeAt(0) < 32)
  )
}

export function isMigrationTierTest(path: string): boolean {
  if (!isValidBackendTestPath(path)) return false
  if (CORE_MIGRATION_SMOKE_SET.has(path)) return false
  return MIGRATION_TIER_PATTERNS.some((pattern) => pattern.test(path))
}

export function parseBackendTestTier(value: string): BackendTestTier {
  if (value === 'core' || value === 'migration' || value === 'all') return value
  throw new Error(`Invalid backend test tier: ${value}`)
}

export function parseShardSpec(spec: string): { current: number; total: number } {
  const match = /^(\d+)\/(\d+)$/.exec(spec)
  if (!match) throw new Error(`Invalid shard specification: ${spec}`)
  const current = Number(match[1])
  const total = Number(match[2])
  if (
    !Number.isSafeInteger(current) ||
    !Number.isSafeInteger(total) ||
    total < 1 ||
    current < 1 ||
    current > total
  )
    throw new Error(`Invalid shard bounds: ${spec}`)
  return { current, total }
}

export function discoverBackendTests(repoRoot: string): string[] {
  const root = resolve(repoRoot, 'packages/backend/tests')
  const discovered: string[] = []
  const visit = (dir: string, relPrefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${relPrefix}/${entry.name}`
      if (entry.isDirectory()) {
        visit(join(dir, entry.name), rel)
      } else if (entry.isFile() && isValidBackendTestPath(rel)) {
        discovered.push(rel)
      }
    }
  }
  visit(root, 'packages/backend/tests')
  return discovered.sort((a, b) => a.localeCompare(b))
}

export function filterBackendTestsByTier(
  allFiles: readonly string[],
  tier: BackendTestTier,
): string[] {
  const unique = new Set<string>()
  for (const path of allFiles) {
    if (!isValidBackendTestPath(path)) throw new Error(`Invalid backend test path: ${path}`)
    if (unique.has(path)) throw new Error(`Duplicate backend test path: ${path}`)
    unique.add(path)
  }
  const sorted = [...unique].sort((a, b) => a.localeCompare(b))
  if (tier === 'all') return sorted
  if (tier === 'migration') return sorted.filter((path) => isMigrationTierTest(path))
  return sorted.filter((path) => !isMigrationTierTest(path))
}

function readTimingMap(path: string): Record<string, number> {
  if (!existsSync(path)) return {}
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    version?: unknown
    files?: unknown
  } | null
  if (
    !parsed ||
    parsed.version !== 1 ||
    parsed.files === null ||
    typeof parsed.files !== 'object' ||
    Array.isArray(parsed.files)
  )
    throw new Error(`Invalid backend timings file: ${path}`)
  const out: Record<string, number> = {}
  for (const [file, ms] of Object.entries(parsed.files as Record<string, unknown>)) {
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) out[file] = ms
  }
  return out
}

export function loadBackendTimingWeights(
  repoRoot: string,
  tier: BackendTestTier,
): Readonly<Record<string, number>> {
  const fullPath = resolve(repoRoot, '.github/backend-test-timings.json')
  const fallback = readTimingMap(fullPath)
  if (tier !== 'core') return fallback
  const corePath = resolve(repoRoot, '.github/backend-core-test-timings.json')
  const core = readTimingMap(corePath)
  return { ...fallback, ...core }
}

export function planBackendShards(
  files: readonly string[],
  weights: Readonly<Record<string, number>>,
  tier: BackendTestTier,
  current: number,
  total: number,
): BackendShardPlan {
  if (
    !Number.isSafeInteger(total) ||
    total < 1 ||
    !Number.isSafeInteger(current) ||
    current < 1 ||
    current > total
  )
    throw new Error(`Invalid backend shard N/M: ${current}/${total}`)
  const unique = new Set<string>()
  for (const file of files) {
    if (!isValidBackendTestPath(file)) throw new Error(`Invalid backend test path: ${file}`)
    if (unique.has(file)) throw new Error(`Duplicate backend test path: ${file}`)
    unique.add(file)
  }
  if (unique.size < total)
    throw new Error(`More backend shards (${total}) than files (${unique.size})`)

  const defaultMs = tier === 'core' ? DEFAULT_CORE_FILE_MS : DEFAULT_MIGRATION_FILE_MS
  const assignments: string[][] = Array.from({ length: total }, () => [])
  const estimatedShardMs = Array.from({ length: total }, () => 0)
  const unknownFiles: string[] = []
  const pinnedSet = new Set<string>()

  const weightOf = (file: string): number => {
    const known = weights[file]
    if (typeof known === 'number' && Number.isFinite(known) && known >= 0) return known
    unknownFiles.push(file)
    return defaultMs
  }

  if (tier === 'core' || tier === 'all') {
    for (const pinned of SHARD_1_PINNED_FILES) {
      if (!unique.has(pinned)) continue
      pinnedSet.add(pinned)
      assignments[0]!.push(pinned)
      estimatedShardMs[0]! += weightOf(pinned)
    }
  }

  const remaining = [...unique]
    .filter((file) => !pinnedSet.has(file))
    .map((file) => ({ file, ms: weightOf(file) }))
    .sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file))

  if (pinnedSet.size > 0 && remaining.length < total - 1) {
    throw new Error(
      `Cannot fill ${total} non-empty backend shards after pinning ${pinnedSet.size} file(s) to shard 1`,
    )
  }

  for (const { file, ms } of remaining) {
    let best = 0
    for (let candidate = 1; candidate < total; candidate++) {
      if (estimatedShardMs[candidate]! < estimatedShardMs[best]!) best = candidate
    }
    assignments[best]!.push(file)
    estimatedShardMs[best]! += ms
  }

  if (assignments.some((bucket) => bucket.length === 0)) {
    throw new Error(`Backend shard plan produced an empty shard for ${tier} (${total} shards)`)
  }

  for (const bucket of assignments) bucket.sort((a, b) => a.localeCompare(b))
  unknownFiles.sort((a, b) => a.localeCompare(b))

  return {
    version: 1,
    tier,
    shard: { current, total },
    assignments,
    estimatedShardMs,
    unknownFiles,
  }
}

export function assertTimingsMatchPlannedFiles(
  timingsData: unknown,
  plannedFiles: readonly string[],
): void {
  if (timingsData === null || typeof timingsData !== 'object' || Array.isArray(timingsData))
    throw new Error('Backend timings output must be a JSON object')
  const doc = timingsData as { version?: unknown; files?: unknown }
  if (
    doc.version !== 1 ||
    doc.files === null ||
    typeof doc.files !== 'object' ||
    Array.isArray(doc.files)
  )
    throw new Error('Backend timings output has unsupported format')
  const recorded = doc.files as Record<string, unknown>
  const expected = [...plannedFiles].sort((a, b) => a.localeCompare(b))
  const actual = Object.keys(recorded).sort((a, b) => a.localeCompare(b))
  const missing = expected.filter((file) => !Object.hasOwn(recorded, file))
  const unexpected = actual.filter((file) => !expected.includes(file))
  if (missing.length || unexpected.length) {
    throw new Error(
      `Backend shard timings mismatch (missing=${missing.length}, unexpected=${unexpected.length}): ` +
        `missing=[${missing.slice(0, 5).join(', ')}] unexpected=[${unexpected.slice(0, 5).join(', ')}]`,
    )
  }
  for (const [file, ms] of Object.entries(recorded)) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0)
      throw new Error(`Invalid recorded duration for ${file}`)
  }
}
