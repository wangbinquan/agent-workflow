#!/usr/bin/env bun
/** RFC-398 §7.7. Run only after development: real old and candidate binaries. */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { candidateBinary, resolveBinary } from './lib/binaries'
import type { BinaryEvidence, ResolveBinaryOptions } from './lib/binaries'
import { captureProjections, continueMigratedTasks, ReleaseClient, runNewTask } from './lib/client'
import { DaemonStartError, oldCli, startOldDaemon } from './lib/daemon'
import type { DaemonOptions, OldDaemon } from './lib/daemon'
import { canonical, readRegistry, sha256, writeJson } from './lib/io'
import { compareTags, nativePlatform } from './lib/model'
import type { Json, ReleaseEntry, ReleaseRegistry, Row } from './lib/model'
import {
  executeDatabaseStatements,
  inspectPostgresqlRole,
  printedDatabaseStatements,
  provisionPostgresqlFixture,
} from './lib/postgresql'
import type { PostgresqlFixture } from './lib/postgresql'
import { prepareScenario, VARIANTS } from './scenario'
import { migrateWorkflowDefinitionToLatest } from '../../packages/shared/src/workflowMigration'
import { WORKFLOW_SCHEMA_VERSION } from '../../packages/shared/src/schemas/workflow'
import type { PreparedScenario, ScenarioVariant } from './scenario'

export const NEGATIVE_SIGNATURES = {
  sqlite: 'This is an epoch-1 installation',
  // Bun on macOS links the system SQLite, which refuses a read-only WAL database without sidecars
  // (S4). Bun's bundled SQLite on Linux and Windows opens it (creating -wal/-shm), so v0.19.3
  // reaches the same epoch-1 refusal as the plain SQLite variant there.
  'sqlite-no-sidecar':
    process.platform === 'darwin'
      ? 'unable to open database file'
      : 'This is an epoch-1 installation',
  postgresql: 'Finish or roll back RFC-349 operation',
} as const

export function assertExpectedStartupFailure(
  error: unknown,
  oldHomeSeeded: boolean,
  signature: string | undefined,
): asserts error is DaemonStartError {
  if (
    !oldHomeSeeded ||
    !(error instanceof DaemonStartError) ||
    !error.started ||
    error.timedOut ||
    error.exitCode === null ||
    error.exitCode === 0 ||
    !signature ||
    !error.output.includes(signature)
  )
    throw new Error(
      `Not a valid seeded candidate startup failure: ${error instanceof Error ? error.message : String(error)}`,
    )
}

export interface VerificationResult {
  tag: string
  variant: ScenarioVariant
  status: 'passed' | 'failed' | 'skipped' | 'expected-failure'
  reason?: string
  oldHomeSeeded: boolean
  candidateStarted: boolean
  assertions: string[]
  home?: string
  oldBinaries?: BinaryEvidence[]
  sourceShutdowns?: PreparedScenario['manifest']['shutdowns']
  candidateLog?: string
  exitCode?: number | null
  signature?: string
  unavailable?: { feature: string; reason: string }[]
  durationMs: number
}

/** Additional candidate API fields are allowed. Every source field and array
 * member must still exist with the same value; no data-loss mismatch is skipped. */
export function assertProjectionEqual(expected: Json, actual: Json, path = '$'): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length)
      throw new Error(`${path}: projection array cardinality changed`)
    // Collection ordering is not a persistence contract. Match by stable IDs
    // when available; nested ordered arrays (ports, answers) retain their order.
    const identity = (value: Json): string | undefined => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
      const key = value.id ?? value.nodeRunId
      return typeof key === 'string' ? key : undefined
    }
    for (const [index, item] of expected.entries()) {
      const key = identity(item)
      const matches =
        key === undefined ? [actual[index]!] : actual.filter((row) => identity(row) === key)
      if (matches.length !== 1) throw new Error(`${path}: missing or duplicate identity ${key}`)
      assertProjectionEqual(item, matches[0]!, `${path}[${key ?? index}]`)
    }
  } else if (expected !== null && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual))
      throw new Error(`${path}: projection object is missing`)
    for (const [key, value] of Object.entries(expected)) {
      if (!(key in actual)) throw new Error(`${path}.${key}: source field is missing`)
      assertProjectionEqual(value, actual[key]!, `${path}.${key}`)
    }
  } else if (expected !== actual) {
    throw new Error(`${path}: expected ${canonical(expected)}, received ${canonical(actual)}`)
  }
}

/**
 * Documented epoch-2 representation changes that keep the value but move it. Each one is proved
 * against the candidate's own API before the source field is replaced by its new form; anything
 * that cannot be proved stays in `expected` and fails as data loss.
 *
 * - Schedules: RFC-395 `integration/scheduled-payload` stores a launch repository as
 *   `cachedRepoId` (StartTask accepts `repoUrl` xor `cachedRepoId`); the URL lives on the
 *   cached-repository row, whose wire form is `urlRedacted`.
 * - Workflows: an older `$schema_version` is compared after the published, pure format
 *   migration (`migrateWorkflowDefinitionToLatest`, packages/shared/src/workflowMigration.ts);
 *   the candidate must return exactly the migrated definition.
 * - Users: released migration 0188 (RFC-312) grants `users:presence` to existing user/manager
 *   accounts. Only for a source that predates 0188, the candidate may add exactly that key.
 * - Task repositories: released migration 0173 (RFC-308) drops `gitignore_commit` (no runtime
 *   reader). Only for a source that predates 0173, `repos[].gitignoreCommit` may be absent.
 */
export function applyDocumentedConversions(
  expected: Record<string, Json>,
  actual: Record<string, Json>,
  cachedRepos: readonly Row[],
  source: { readonly presenceBackfill?: boolean; readonly gitignoreCommitRetired?: boolean } = {},
): { collections: Record<string, Json>; proofs: string[] } {
  const proofs: string[] = []
  const collections = structuredClone(expected)
  if (source.gitignoreCommitRetired && Array.isArray(collections.tasks))
    for (const task of collections.tasks as Row[]) {
      const after = (Array.isArray(actual.tasks) ? (actual.tasks as Row[]) : []).find(
        (row) => row.id === task.id,
      )
      if (!Array.isArray(task.repos) || !after || !Array.isArray(after.repos)) continue
      for (const [index, repo] of (task.repos as Row[]).entries()) {
        const candidate = (after.repos as Row[])[index]
        if (!candidate || !('gitignoreCommit' in repo) || 'gitignoreCommit' in candidate) continue
        delete repo.gitignoreCommit
        proofs.push(`task-repo-gitignore-commit-retired-0173:${String(task.id)}:${index}`)
      }
    }
  if (source.presenceBackfill && Array.isArray(collections.users))
    for (const user of collections.users as Row[]) {
      const before = user.additionalPermissions
      if (!['user', 'manager'].includes(String(user.role)) || !Array.isArray(before)) continue
      if (before.includes('users:presence')) continue
      const after = (Array.isArray(actual.users) ? (actual.users as Row[]) : []).find(
        (row) => row.id === user.id,
      )?.additionalPermissions
      if (!Array.isArray(after) || after.length !== before.length + 1) continue
      const added = after.filter((key) => !before.includes(key))
      if (added.length !== 1 || added[0] !== 'users:presence') continue
      user.additionalPermissions = after
      proofs.push(`users-presence-grant-0188:${String(user.id)}`)
    }
  if (Array.isArray(collections.workflows))
    for (const workflow of collections.workflows as Row[]) {
      const definition = workflow.definition as Row | null | undefined
      const version = definition?.$schema_version
      if (typeof version !== 'number' || version >= WORKFLOW_SCHEMA_VERSION) continue
      workflow.definition = migrateWorkflowDefinitionToLatest(
        definition as unknown as Parameters<typeof migrateWorkflowDefinitionToLatest>[0],
      ) as unknown as Json
      proofs.push(
        `workflow-definition-format:${String(workflow.id)}:v${version}->v${WORKFLOW_SCHEMA_VERSION}`,
      )
    }
  const schedules = collections.schedules
  const candidate = Array.isArray(actual.schedules) ? (actual.schedules as Row[]) : []
  if (Array.isArray(schedules))
    for (const schedule of schedules as Row[]) {
      const payload = schedule.launchPayload as Row | null | undefined
      if (!payload || typeof payload.repoUrl !== 'string') continue
      const converted = candidate.find((row) => row.id === schedule.id)?.launchPayload as
        | Row
        | null
        | undefined
      if (!converted || 'repoUrl' in converted || typeof converted.cachedRepoId !== 'string')
        continue
      const repo = cachedRepos.find((row) => row.id === converted.cachedRepoId)
      if (!repo || repo.urlRedacted !== payload.repoUrl)
        throw new Error(
          `$.schedules[${String(schedule.id)}].launchPayload.cachedRepoId does not resolve to ${payload.repoUrl}`,
        )
      const { repoUrl: _repoUrl, ...rest } = payload
      schedule.launchPayload = { ...rest, cachedRepoId: converted.cachedRepoId }
      proofs.push(`schedule-repo-url-as-cached-repo:${String(schedule.id)}`)
    }
  return { collections, proofs }
}

export function selectReleases(
  registry: ReleaseRegistry,
  selection: string,
  tags?: string,
  shard?: string,
): ReleaseEntry[] {
  let selected: string[]
  if (tags) selected = tags.split(',')
  else if (selection === 'gate')
    selected = registry.releases.filter((r) => r.l2.gate).map((r) => r.tag)
  else if (selection === 'nightly') {
    const shards = shard
      ? registry.nightlyShards.filter((s) => s.id === shard)
      : registry.nightlyShards
    if (!shards.length) throw new Error(`Unknown or empty nightly shard: ${shard}`)
    selected = shards.flatMap((s) => s.tags)
  } else throw new Error(`Unknown selection: ${selection}`)
  if (!selected.length) throw new Error('Empty release selection')
  return [...new Set(selected)].map((tag) => {
    const release = registry.releases.find((r) => r.tag === tag)
    if (!release) throw new Error(`Unregistered old release: ${tag}`)
    return release
  })
}

/** The candidate speaks today's API; source capability flags never drive it. */
function candidateProtocol(registry: ReleaseRegistry, binary: BinaryEvidence): ReleaseEntry {
  const latest = [...registry.releases].sort((a, b) => compareTags(a.tag, b.tag)).at(-1)
  if (!latest?.epoch2) throw new Error('Candidate protocol requires an epoch-2 registry entry')
  return {
    ...latest,
    tag: binary.tag,
    commit: binary.commit,
    l2: { gate: false, nightly: false, shard: null },
  }
}

function derivedDatabases(home: string): string[] {
  const root = join(home, 'database-migrations/auto-upgrade/allocations')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const value = JSON.parse(readFileSync(join(root, name), 'utf8')) as { database: string }
      if (typeof value.database !== 'string')
        throw new Error('Invalid auto-upgrade database allocation')
      return value.database
    })
}

async function assertHealth(client: ReleaseClient, scenario: PreparedScenario): Promise<void> {
  const health = (await client.request('/health')) as Row
  if (health.ok !== true) throw new Error('Candidate health is not ok')
  if (!scenario.manifest.postgresql) return
  const pointer = JSON.parse(
    readFileSync(join(client.daemon.home, 'database-generation.json'), 'utf8'),
  ) as {
    payload: { database: { kind: string; profileRef: string } }
  }
  const location = pointer.payload.database
  if (location.kind !== 'postgresql-target')
    throw new Error('PostgreSQL scenario switched providers')
  const match = /^env:([^/]+)(?:\/(.+))?$/.exec(location.profileRef)
  if (!match || !scenario.env[match[1]!])
    throw new Error('Candidate PostgreSQL pointer is not resolvable')
  const url = new URL(scenario.env[match[1]!]!)
  if (match[2]) url.pathname = `/${match[2]}`
  const actual = await inspectPostgresqlRole(url.toString())
  assertProjectionEqual(
    { provider: 'postgresql', databaseName: actual.database },
    health.database ?? null,
    '$.health.database',
  )
}

interface CaseOptions {
  release: ReleaseEntry
  variant: ScenarioVariant
  candidate: BinaryEvidence
  protocol: ReleaseEntry
  chain: ReleaseEntry[]
  binaryOptions: ResolveBinaryOptions
  adminUrl?: string
  stubPath?: string
  expectFailure: boolean
  signature?: string
}

export async function verifyCase(options: CaseOptions): Promise<VerificationResult> {
  const startedAt = Date.now()
  const result: VerificationResult = {
    tag: options.release.tag,
    variant: options.variant,
    status: 'failed',
    oldHomeSeeded: false,
    candidateStarted: false,
    assertions: [],
    durationMs: 0,
  }
  let scenario: PreparedScenario | undefined
  let fixture: PostgresqlFixture | undefined
  let daemon: OldDaemon | undefined
  try {
    const skip =
      options.release.l2.unsupported ??
      (options.variant.startsWith('postgresql') &&
      !options.release.epoch1?.postgresql &&
      !options.release.epoch2
        ? 'This release predates PostgreSQL support'
        : options.variant === 'chain' && !options.chain.length
          ? 'No later published intermediate below the candidate; direct variants cover this release'
          : undefined)
    if (skip) {
      result.status = 'skipped'
      result.reason = skip
      return result
    }
    if (options.variant.startsWith('postgresql')) {
      if (!options.adminUrl)
        throw new Error('PostgreSQL variants require --postgresql-admin-url-env')
      fixture = await provisionPostgresqlFixture(
        options.adminUrl,
        options.variant === 'postgresql-restricted-role',
      )
    }
    scenario = await prepareScenario({
      release: options.release,
      variant: options.variant,
      chain: options.chain,
      binaryOptions: options.binaryOptions,
      stubPath: options.stubPath,
      ...(fixture
        ? { postgresqlUrlEnv: 'AW_UPGRADE_SOURCE_URL', env: { AW_UPGRADE_SOURCE_URL: fixture.url } }
        : {}),
    })
    result.home = scenario.manifest.home
    result.oldBinaries = scenario.manifest.binaries
    result.sourceShutdowns = scenario.manifest.shutdowns
    result.unavailable = scenario.projections.unavailable
    // Reaching this point requires every old seed task to reach its specified
    // state, API snapshots to succeed, and a validated stop (including PG live writes).
    result.oldHomeSeeded = true
    result.assertions.push('old-binary-seeded-and-stopped', 'source-api-projections-captured')
    const driver: DaemonOptions = {
      home: result.home,
      release: options.protocol,
      binary: options.candidate,
      env: scenario.env,
      stubPath: options.stubPath,
      startupTimeoutMs: 600_000,
      logName: 'release-upgrade-candidate.log',
    }
    const start = async (name: string) => {
      try {
        const process = await startOldDaemon({ ...driver, logName: name })
        result.candidateStarted = true
        result.candidateLog = process.logPath
        return process
      } catch (error) {
        if (error instanceof DaemonStartError) {
          result.candidateStarted ||= error.started
          result.candidateLog = error.logPath
          result.exitCode = error.exitCode
        }
        throw error
      }
    }
    if (options.expectFailure) {
      try {
        daemon = await start('release-upgrade-negative-control.log')
      } catch (error) {
        assertExpectedStartupFailure(error, result.oldHomeSeeded, options.signature)
        result.status = 'expected-failure'
        result.signature = options.signature
        result.assertions.push(
          'candidate-process-started',
          'candidate-exited-nonzero',
          'variant-failure-signature-matched',
        )
        return result
      }
      throw new Error('Negative control unexpectedly reached healthy startup')
    }
    if (options.variant === 'postgresql-restricted-role' && options.release.epoch1) {
      try {
        daemon = await start('release-upgrade-permission-refusal.log')
      } catch (error) {
        if (
          !(error instanceof DaemonStartError) ||
          !error.started ||
          error.timedOut ||
          error.exitCode === null ||
          error.exitCode === 0
        )
          throw error
        const statements = printedDatabaseStatements(error.output)
        writeJson(join(result.home, 'release-upgrade-dba-statements.json'), { statements })
        await executeDatabaseStatements(options.adminUrl!, statements, fixture!)
        result.assertions.push(
          'restricted-role-exited-nonzero',
          'both-printed-dba-statements-executed',
        )
      }
      if (daemon) throw new Error('Restricted role unexpectedly completed epoch provisioning')
      daemon = await start('release-upgrade-candidate-after-dba.log')
    } else daemon = await start('release-upgrade-candidate.log')
    result.assertions.push('plain-start-healthy')
    const client = new ReleaseClient(daemon)
    // Authenticate without rewriting the profile whose migration is under test.
    await client.bootstrap({ updateProfile: false })
    await assertHealth(client, scenario)
    const source = options.chain.at(-1) ?? options.release
    const after = await captureProjections(client, scenario.manifest.seeds, source)
    writeJson(join(result.home, 'release-upgrade-api-after.json'), after)
    const documented = applyDocumentedConversions(
      scenario.projections.collections,
      after.collections,
      await client.list('/api/cached-repos'),
      {
        presenceBackfill:
          source.epoch1 !== null &&
          !source.epoch1.sqlite.some((receipt) => receipt.tag.startsWith('0188_')),
        gitignoreCommitRetired:
          source.epoch1 !== null &&
          !source.epoch1.sqlite.some((receipt) => receipt.tag.startsWith('0173_')),
      },
    )
    assertProjectionEqual(documented.collections, after.collections)
    result.assertions.push(...documented.proofs, 'source-api-projections-equal')
    const continued = await continueMigratedTasks(client, scenario.manifest.seeds)
    result.assertions.push(`migrated-reviews-done:${continued.reviews.length}`)
    if (continued.questions.length)
      result.assertions.push(`migrated-questions-done:${continued.questions.length}`)
    const newTaskId = await runNewTask(client, scenario.manifest.seeds, scenario.git)
    result.assertions.push(`new-task-done:${newTaskId}`)
    await daemon.stop()
    daemon = undefined
    daemon = await start('release-upgrade-candidate-restart.log')
    const restarted = new ReleaseClient(daemon)
    await restarted.bootstrap({ updateProfile: false })
    await assertHealth(restarted, scenario)
    await restarted.waitForTask(newTaskId, 'done')
    result.assertions.push('restart-healthy', 'new-task-retained-after-restart')
    const doctor = await oldCli({ ...driver, env: daemon.env }, ['doctor'])
    if (!doctor.includes('database provider'))
      throw new Error('Doctor output lacks database provider check')
    writeJson(join(result.home, 'release-upgrade-doctor.json'), { exitCode: 0, stdout: doctor })
    result.assertions.push('doctor-passed')
    if (fixture && options.variant === 'postgresql-restricted-role') {
      if ((await inspectPostgresqlRole(fixture.url)).canCreateDatabase)
        throw new Error('Fixture role privileges changed')
      result.assertions.push('role-remains-restricted')
      if (options.release.epoch2)
        result.assertions.push('epoch2-native-history-no-epoch-provisioning-needed')
    }
    result.status = 'passed'
  } catch (error) {
    result.reason = error instanceof Error ? error.message : String(error)
  } finally {
    try {
      try {
        await daemon?.stop()
      } finally {
        await scenario?.dispose()
      }
      // Failed cases keep databases and home evidence for diagnosis. Successful
      // cases drop only this randomly named fixture and its recorded allocations.
      if (fixture && result.status === 'passed')
        await fixture.dispose(derivedDatabases(result.home!))
    } catch (error) {
      result.status = 'failed'
      result.reason = `${result.reason ?? ''}\nCleanup: ${String(error)}`
    }
    result.durationMs = Date.now() - startedAt
  }
  return result
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      candidate: { type: 'string' },
      'candidate-release': { type: 'string' },
      'candidate-ref': { type: 'string', default: process.env.GITHUB_SHA ?? 'local' },
      'candidate-sha256': { type: 'string' },
      selection: { type: 'string', default: 'gate' },
      tags: { type: 'string' },
      shard: { type: 'string' },
      variants: { type: 'string' },
      'chain-tag': { type: 'string' },
      'postgresql-admin-url-env': { type: 'string' },
      stub: { type: 'string' },
      'no-tag-build': { type: 'boolean', default: false },
      'expect-failure': { type: 'boolean', default: false },
      'failure-signature': { type: 'string' },
      summary: { type: 'string', default: 'release-upgrade-summary.json' },
    },
  })
  const summary: {
    formatVersion: 1
    platform: string
    mode: string
    candidate?: BinaryEvidence
    results: VerificationResult[]
    fatal?: string
  } = {
    formatVersion: 1,
    platform: nativePlatform(),
    mode: values['expect-failure'] ? 'negative-control' : 'upgrade',
    results: [],
  }
  try {
    const registry = readRegistry()
    if (Boolean(values.candidate) === Boolean(values['candidate-release']))
      throw new Error('Supply exactly one of --candidate or --candidate-release')
    const binaryOptions = {
      allowTagBuild: !values['no-tag-build'],
      repository: registry.repository,
    }
    let protocol: ReleaseEntry
    if (values['candidate-release']) {
      const release = registry.releases.find((r) => r.tag === values['candidate-release'])
      if (!release) throw new Error('Candidate release is not registered')
      // An unavailable retained asset cannot become a successful negative control.
      summary.candidate = await resolveBinary(release, {
        ...binaryOptions,
        allowTagBuild: values['expect-failure'] ? false : binaryOptions.allowTagBuild,
      })
      protocol = release
    } else {
      summary.candidate = candidateBinary(
        values.candidate!,
        values['candidate-ref']!,
        values['candidate-sha256'],
      )
      protocol = candidateProtocol(registry, summary.candidate)
    }
    const variants = (values.variants?.split(',') ??
      (values['expect-failure']
        ? Object.keys(NEGATIVE_SIGNATURES)
        : nativePlatform().startsWith('linux')
          ? [...VARIANTS]
          : ['sqlite', 'sqlite-no-sidecar'])) as ScenarioVariant[]
    for (const variant of variants)
      if (!(VARIANTS as readonly string[]).includes(variant))
        throw new Error(`Unknown variant: ${variant}`)
    if (!variants.length || (values['failure-signature'] && variants.length !== 1))
      throw new Error('A custom signature requires one variant')
    if (values['expect-failure'] && variants.some((v) => !(v in NEGATIVE_SIGNATURES)))
      throw new Error('Negative controls support only sqlite, sqlite-no-sidecar, postgresql')
    const intermediate = values['chain-tag']
      ? registry.releases.find((r) => r.tag === values['chain-tag'])
      : [...registry.releases]
          .filter(
            (r) =>
              Object.values(r.binaries).some((b) => b.kind === 'release-asset') &&
              !r.l2.unsupported,
          )
          .sort((a, b) => compareTags(a.tag, b.tag))
          .at(-1)
    if (values['chain-tag'] && !intermediate) throw new Error('Unknown --chain-tag')
    for (const release of selectReleases(registry, values.selection!, values.tags, values.shard)) {
      for (const variant of variants) {
        const result = await verifyCase({
          release,
          variant,
          candidate: summary.candidate,
          protocol,
          binaryOptions,
          chain:
            variant === 'chain' && intermediate && compareTags(intermediate.tag, release.tag) > 0
              ? [intermediate]
              : [],
          adminUrl: values['postgresql-admin-url-env']
            ? process.env[values['postgresql-admin-url-env']]
            : undefined,
          stubPath: values.stub ? resolve(values.stub) : undefined,
          expectFailure: values['expect-failure']!,
          signature:
            values['failure-signature'] ??
            NEGATIVE_SIGNATURES[variant as keyof typeof NEGATIVE_SIGNATURES],
        })
        summary.results.push(result)
        writeJson(resolve(values.summary!), summary)
        console.log(
          `${result.tag} ${variant}: ${result.status}${result.reason ? ` — ${result.reason}` : ''}`,
        )
      }
    }
    if (values['expect-failure'] && !summary.results.some((r) => r.status === 'expected-failure'))
      throw new Error('No negative control actually executed')
  } catch (error) {
    summary.fatal = error instanceof Error ? error.message : String(error)
  }
  writeJson(resolve(values.summary!), summary)
  console.log(
    JSON.stringify({
      summary: resolve(values.summary!),
      sha256: sha256(canonical(summary)),
      results: summary.results.map(({ tag, variant, status }) => ({ tag, variant, status })),
      fatal: summary.fatal ?? null,
    }),
  )
  if (summary.fatal || summary.results.some((r) => r.status === 'failed')) process.exitCode = 1
}
