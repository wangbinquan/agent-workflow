/** RFC-398: committed, tag-independent contracts shared by L1 and L2 tooling. */
export const PLATFORMS = [
  'linux-x86_64',
  'linux-arm64',
  'macos-arm64',
  'macos-x86_64',
  'windows-x86_64',
] as const
export type Platform = (typeof PLATFORMS)[number]
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Row = Record<string, Json>

export interface SqliteReceipt {
  tag: string
  created_at: number
  hash: string
}
export interface PostgresqlReceipt {
  baselineId: string
  contractDigest: string
  planDigest: string
  sqlFile: string
  sqlSha256: string
}
export interface ReleasedSql {
  provider: 'sqlite' | 'postgresql'
  migration: string
  sha256: string
  file: string
  frozenSha256: string | null
  recognizedAlias: boolean
}
export interface BinarySource {
  kind: 'release-asset' | 'retained-asset'
  release: string
  asset: string
  sha256: string
  digestSource: 'github-metadata' | 'download'
  evidenceLevel: 1 | 2
  provenance?: { runId: number; commit: string; reportedVersion: string }
}
export interface ReleaseCapabilities {
  auth: 'token' | 'session' | 'bootstrap'
  profile: boolean
  /** The profile PATCH accepts `gitName` (v0.18.16+); earlier strict schemas reject unknown keys. */
  profileGitName: boolean
  mcps: boolean
  schedules: boolean
  scheduleEnvelope: boolean
  workgroups: boolean
  memories: boolean
  clarify: boolean
  /** Runs carry an RFC-200 envelope nonce (minted from v0.15.0); RFC-395 refuses pending gates without it. */
  nonce: boolean
  /**
   * Prompts render that nonce (the runner passes it from v0.16.0). v0.15.x mint a nonce but send
   * bare prompts, so the runtime shim must use the legacy transport for them.
   */
  promptNonce: boolean
  agentId: boolean
  skillId: boolean
  workgroupId: boolean
  repoUrl: boolean
  workflowSchema: number
  permission: boolean
  readonly: boolean
  /** The complete sample requires fanout, named port kinds and RFC-200 envelopes. */
  businessWorkflow: boolean
}
export interface ReleaseEntry {
  tag: string
  commit: string
  bunVersion: string
  epoch1: {
    sqlite: SqliteReceipt[]
    postgresql: PostgresqlReceipt[] | null
    /** Fresh databases install the tag's head plan directly under baselineId. */
    postgresqlFresh:
      | Pick<PostgresqlReceipt, 'baselineId' | 'contractDigest' | 'planDigest'>[]
      | null
    postgresqlSource: 'frozen' | 'released-baseline' | null
    /** T3b owns the production baseline bundle at this path. */
    postgresqlBaselinePath: string | null
  } | null
  epoch2: {
    history: string
    version: number
    contractDigest: string
    sqlitePlanDigest: string
    postgresqlPlanDigest: string
  } | null
  releasedSql: ReleasedSql[]
  buildKey: string
  binaries: Partial<Record<Platform, BinarySource>>
  binaryAbsence: string | null
  fallback: { kind: 'tag-build'; evidenceLevel: 4; bunVersion: string }
  runtime: {
    probeVersion: string
    minimum: string | null
    maximumExclusive: string | null
    source: string
    sourceSha256: string
    capabilities: ReleaseCapabilities
  }
  l2: {
    gate: boolean
    nightly: boolean
    shard: string | null
    unsupported?: string
    approval?: { approvedBy: 'user'; approvedAt: string }
  }
}
export interface L2Approval {
  tag: string
  reason: string
  approvedBy: 'user'
  approvedAt: string
}
export interface BuildMapping {
  buildKey: string
  representative: string
  tags: string[]
  providers: ('sqlite' | 'postgresql')[]
}
export interface ReleaseRegistry {
  formatVersion: 1
  repository: string
  releases: ReleaseEntry[]
  l1Builds: BuildMapping[]
  nightlyShards: { id: string; tags: string[] }[]
}

/** Release tags: `v` + semver, published prereleases included (release.yml marks `*-*` tags). */
export const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/

export function compareTags(a: string, b: string): number {
  for (const value of [a, b])
    if (!RELEASE_TAG.test(value)) throw new Error(`Not a release tag: ${value}`)
  return Bun.semver.order(a.slice(1), b.slice(1))
}

/**
 * RFC-398 §7.7: the release gate checks the registry while the candidate tag already exists
 * and its release is still a draft. Only tags strictly below the candidate are evidence;
 * the candidate itself is registered after it is published.
 */
export function selectRegistryTags(tags: readonly string[], candidate?: string): string[] {
  if (candidate !== undefined && !RELEASE_TAG.test(candidate))
    throw new Error(`Not a release tag: ${candidate}`)
  return tags
    .filter((tag) => RELEASE_TAG.test(tag))
    .filter((tag) => candidate === undefined || compareTags(tag, candidate) < 0)
    .sort(compareTags)
}

/** Provenance (tag/asset/path) must not prevent equivalent schemas sharing a build. */
export function buildIdentity(release: Pick<ReleaseEntry, 'epoch1' | 'epoch2' | 'releasedSql'>) {
  return {
    epoch1: release.epoch1 && {
      sqlite: release.epoch1.sqlite,
      postgresql: release.epoch1.postgresql,
      postgresqlFresh: release.epoch1.postgresqlFresh,
    },
    epoch2: release.epoch2,
    releasedSql: release.releasedSql.map(({ provider, migration, sha256 }) => ({
      provider,
      migration,
      sha256,
    })),
  }
}

export function l1Builds(releases: readonly ReleaseEntry[]): BuildMapping[] {
  const builds = new Map<string, BuildMapping>()
  for (const release of releases) {
    let build = builds.get(release.buildKey)
    if (!build) {
      build = {
        buildKey: release.buildKey,
        representative: release.tag,
        tags: [],
        providers:
          release.epoch2 || release.epoch1?.postgresql ? ['sqlite', 'postgresql'] : ['sqlite'],
      }
      builds.set(release.buildKey, build)
    }
    build.tags.push(release.tag)
  }
  return [...builds.values()]
}

export function nativePlatform(): Platform {
  const os =
    process.platform === 'darwin'
      ? 'macos'
      : process.platform === 'win32'
        ? 'windows'
        : process.platform
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch
  const platform = `${os}-${arch}`
  if (!(PLATFORMS as readonly string[]).includes(platform))
    throw new Error(`Unsupported host: ${platform}`)
  return platform as Platform
}

export function executableName(platform: Platform): string {
  return `agent-workflow-${platform}${platform.startsWith('windows') ? '.exe' : ''}`
}

/**
 * Where a published tag keeps its OpenCode CLI probe (the version bounds the registry records),
 * tried in this order. A tag matching none of them stops registration until its layout is
 * inspected and added here. RFC-492 appended the runtime-management layout: the runtime driver
 * family moved from `services/runtime/` into runtime-management's infrastructure.
 */
export const OPENCODE_PROBE_SUFFIXES = [
  '/util/opencode.ts',
  '/runtime/opencode/util.ts',
  '/opencodeProbe.ts',
  '/runtime-management/infrastructure/drivers/opencode/util.ts',
] as const

export function opencodeProbePath(files: readonly string[]): string | undefined {
  for (const suffix of OPENCODE_PROBE_SUFFIXES) {
    const path = files.find((file) => file.endsWith(suffix))
    if (path !== undefined) return path
  }
  return undefined
}

/** The production OpenCode driver of each published layout (read for the L2 support judgment). */
export const OPENCODE_DRIVER_PATHS = [
  'packages/backend/src/services/runtime/opencode/driver.ts',
  'packages/backend/src/modules/runtime-management/infrastructure/drivers/opencode/driver.ts',
] as const

export function opencodeDriverPath(has: (path: string) => boolean): string | undefined {
  return OPENCODE_DRIVER_PATHS.find((path) => has(path))
}
