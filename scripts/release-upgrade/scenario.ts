#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Database } from 'bun:sqlite'
import { resolveBinary } from './lib/binaries'
import type { BinaryEvidence, ResolveBinaryOptions } from './lib/binaries'
import { captureProjections, ReleaseClient, seedRound } from './lib/client'
import type { ApiProjection, SeedRound } from './lib/client'
import { oldCli, startOldDaemon } from './lib/daemon'
import type { DaemonOptions, OldDaemon } from './lib/daemon'
import { startGitServer } from './lib/git-server'
import type { GitFixtureServer } from './lib/git-server'
import { readRegistry, writeJson } from './lib/io'
import type { ReleaseEntry } from './lib/model'
import { inspectPostgresqlRole } from './lib/postgresql'
import { assertStoppedHome, recordingSqlitePath } from './record'

export const VARIANTS = [
  'sqlite',
  'sqlite-no-sidecar',
  'postgresql',
  'postgresql-restricted-role',
  'chain',
] as const
export type ScenarioVariant = (typeof VARIANTS)[number]
export interface ScenarioOptions {
  release: ReleaseEntry
  variant: ScenarioVariant
  /** Empty directory only. Omit for a fresh OS-temp home. */
  home?: string
  binaryOptions?: ResolveBinaryOptions
  stubPath?: string
  env?: NodeJS.ProcessEnv
  /** Caller provisions an empty, dedicated database; only the variable name is recorded. */
  postgresqlUrlEnv?: string
  /** Explicit intermediate releases; the final candidate is started by verify.ts. */
  chain?: ReleaseEntry[]
  /**
   * PostgreSQL variants only. `false` stops right after the old one-click migration, before any
   * live PostgreSQL write (the RFC-349 "unwritten" state recorded for T4 finalize equivalence).
   */
  postgresqlLiveRound?: boolean
}
export interface ScenarioManifest {
  formatVersion: 1
  variant: ScenarioVariant
  home: string
  releases: string[]
  binaries: BinaryEvidence[]
  shutdowns: {
    tag: string
    method: OldDaemon['shutdownMethod']
    sqliteCheckpointValidated: boolean
  }[]
  seeds: SeedRound[]
  projectionFile: string
  git: { root: string; repository: string; remoteUrl: string }
  postgresql?: {
    urlEnv: string
    database: string
    user: string
    canCreateDatabase: boolean
    operationId: string
  }
  candidateWork: string[]
}
export interface PreparedScenario {
  manifest: ScenarioManifest
  projections: ApiProjection
  /** Remains alive for the candidate to resume pending tasks and clone new repos. */
  git: GitFixtureServer
  env: NodeJS.ProcessEnv
  dispose(): Promise<void>
}

function migrationManifest(home: string): {
  operationId: string
  phase: string
  firstLiveWriteAt: number | null
} {
  const root = join(home, 'database-migrations')
  const candidates = readdirSync(root).filter(
    (name) => name.startsWith('dbm_') && !name.startsWith('dbm_e2_'),
  )
  if (candidates.length !== 1)
    throw new Error(`Expected one RFC-349 migration; found ${candidates.length}`)
  const doc = JSON.parse(readFileSync(join(root, candidates[0]!, 'manifest.json'), 'utf8')) as {
    payload: { operationId: string; phase: string; firstLiveWriteAt: number | null }
  }
  return doc.payload
}

/** A stopped process and a successful integrity/checkpoint check precede removal;
 * historical Windows termination retains the intact WAL until this recovery. */
export function removeCleanSqliteSidecars(home: string): void {
  assertStoppedHome(home)
  const path = recordingSqlitePath(home)
  if (!existsSync(path)) throw new Error(`No SQLite database found: ${path}`)
  const db = new Database(path, { readwrite: true, create: false })
  try {
    const integrity = db.query('PRAGMA quick_check').all() as { quick_check: string }[]
    if (integrity.length !== 1 || integrity[0]!.quick_check !== 'ok')
      throw new Error(`Stopped SQLite home failed quick_check: ${path}`)
    const checkpoint = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
      busy: number
      log: number
      checkpointed: number
    }
    if (checkpoint.busy !== 0 || checkpoint.log > checkpoint.checkpointed)
      throw new Error(`SQLite WAL was not fully checkpointed: ${path}`)
  } finally {
    db.close()
  }
  for (const suffix of ['-wal', '-shm'])
    if (existsSync(`${path}${suffix}`)) unlinkSync(`${path}${suffix}`)
}

/** A distinct regular-WAL control: closing SQLite normally removes these files.
 * Snapshot only a checkpointed, idle connection's sidecars and restore its exact
 * bytes after close. No connection remains open when the candidate is started. */
function retainCleanSqliteSidecars(home: string): void {
  removeCleanSqliteSidecars(home)
  const path = recordingSqlitePath(home)
  const db = new Database(path, { readwrite: true, create: false })
  let sidecars: { path: string; bytes: Buffer }[]
  try {
    db.query('SELECT count(*) FROM sqlite_schema').get()
    sidecars = ['-wal', '-shm'].map((suffix) => ({
      path: path + suffix,
      bytes: readFileSync(path + suffix),
    }))
  } finally {
    db.close()
  }
  for (const sidecar of sidecars!) writeFileSync(sidecar.path, sidecar.bytes)
}

/**
 * Old binaries that fail their own task writes on PostgreSQL after their own one-click migration
 * (live round only). Each entry is an exact error signature from the release's source; a
 * different error still fails the scenario. The pre-migration SQLite round keeps every task state,
 * so pending review/question rows still cross the migration.
 */
export const OLD_POSTGRESQL_TASK_DEFECTS: Readonly<
  Record<string, { readonly signature: string; readonly reason: string }>
> = {
  'v0.18.18': {
    signature: 'foreign-legacy-actor-projection',
    reason: 'v0.18.18 on PostgreSQL cannot launch tasks after its one-click migration',
  },
  'v0.18.19': {
    signature: 'foreign-legacy-actor-projection',
    reason: 'v0.18.19 on PostgreSQL cannot launch tasks after its one-click migration',
  },
  // v0.19.0 / v0.19.1: the same refusal as v0.19.2, observed in release-upgrade nightly 41287876705.
  'v0.19.0': {
    signature: 'ownerless task mutation refused durable owner',
    reason:
      'v0.19.0 on PostgreSQL refuses its own human-gate task writes after one-click migration',
  },
  'v0.19.1': {
    signature: 'ownerless task mutation refused durable owner',
    reason:
      'v0.19.1 on PostgreSQL refuses its own human-gate task writes after one-click migration',
  },
  'v0.19.2': {
    signature: 'ownerless task mutation refused durable owner',
    reason:
      'v0.19.2 on PostgreSQL refuses its own human-gate task writes after one-click migration',
  },
  // v0.19.3 keeps v0.19.2's code path (the signature is in its source); its PG round was hidden by
  // the retained-asset download failure in that nightly.
  'v0.19.3': {
    signature: 'ownerless task mutation refused durable owner',
    reason:
      'v0.19.3 on PostgreSQL refuses its own human-gate task writes after one-click migration',
  },
}

/** Seeds and stops old daemons only. Candidate assertions belong to RFC-398 verify.ts. */
export async function prepareScenario(options: ScenarioOptions): Promise<PreparedScenario> {
  const home = options.home
    ? resolve(options.home)
    : mkdtempSync(join(tmpdir(), 'aw-release-upgrade-home-'))
  mkdirSync(home, { recursive: true })
  if (readdirSync(home).length) throw new Error(`Scenario home must be empty: ${home}`)
  if (options.variant === 'chain' && !options.chain?.length)
    throw new Error('chain requires at least one explicit intermediate release')
  const releases = [options.release, ...(options.variant === 'chain' ? options.chain! : [])]
  for (const release of releases)
    if (release.l2.unsupported) throw new Error(`${release.tag}: ${release.l2.unsupported}`)
  const git = await startGitServer(join(home, 'release-upgrade-git'))
  const binaries: BinaryEvidence[] = []
  const shutdowns: ScenarioManifest['shutdowns'] = []
  const seeds: SeedRound[] = []
  let daemon: OldDaemon | undefined
  let projections: ApiProjection | undefined
  let postgresql: ScenarioManifest['postgresql']
  let candidateEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    AGENT_WORKFLOW_HOME: home,
  }
  try {
    for (let index = 0; index < releases.length; index += 1) {
      const release = releases[index]!
      const binary = await resolveBinary(release, options.binaryOptions)
      binaries.push(binary)
      const driverOptions: DaemonOptions = {
        home,
        release,
        binary,
        stubPath: options.stubPath,
        cacheDir: options.binaryOptions?.cacheDir,
        env: options.env,
      }
      daemon = await startOldDaemon(driverOptions)
      let client = new ReleaseClient(daemon)
      seeds.push(
        await seedRound(
          client,
          git,
          `round-${index}`,
          // v0.18.18–v0.19.2 grant `users:presence` to every new regular user, and their own
          // one-click migration then rejects that row ("logical database codec rejected invalid
          // JSON at user_permission_grants.permission"). The regular user is created by the
          // same old daemon on PostgreSQL in the live round instead.
          options.variant.startsWith('postgresql') && index === releases.length - 1
            ? {
                deferUsers: `${release.tag} one-click migration rejects the users:presence grant it writes; the regular user is created in the postgresql-live round`,
              }
            : {},
        ),
      )
      projections = await captureProjections(client, seeds)
      candidateEnv = daemon.env
      await daemon.stop()
      removeCleanSqliteSidecars(home)
      shutdowns.push({
        tag: release.tag,
        method: daemon.shutdownMethod,
        sqliteCheckpointValidated: true,
      })
      daemon = undefined
      if (options.variant.startsWith('postgresql')) {
        if (!release.epoch1?.postgresql && !release.epoch2)
          throw new Error(
            'RFC-349 one-click variant requires a release with PostgreSQL support (v0.18.18+)',
          )
        const urlEnv = options.postgresqlUrlEnv
        if (!urlEnv || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(urlEnv))
          throw new Error('postgresqlUrlEnv must name a configured environment variable')
        const url = candidateEnv[urlEnv]
        if (!url) throw new Error(`Missing PostgreSQL fixture URL in ${urlEnv}`)
        const role = await inspectPostgresqlRole(url)
        if (options.variant === 'postgresql-restricted-role' && role.canCreateDatabase)
          throw new Error('Restricted-role variant requires NOSUPERUSER NOCREATEDB')
        // The old one-click migrate opens the SQLite source read-only, which cannot open a WAL
        // database without sidecars (RFC-398 S4, fixed only in the candidate). Give the old
        // binary the clean sidecars an idle connection leaves; the data bytes are unchanged.
        retainCleanSqliteSidecars(home)
        const output = await oldCli(driverOptions, [
          'db',
          'migrate',
          '--to',
          'postgresql',
          '--url-env',
          urlEnv,
          '--auto',
        ])
        writeJson(join(home, 'release-upgrade-migrate-output.json'), { stdout: output })
        if (migrationManifest(home).phase !== 'accepting-writes')
          throw new Error('Old one-click migration did not reach accepting-writes')
        if (options.postgresqlLiveRound === false) {
          const migration = migrationManifest(home)
          if (migration.firstLiveWriteAt !== null)
            throw new Error('Unwritten capture already recorded a PostgreSQL first write')
          postgresql = { urlEnv, ...role, operationId: migration.operationId }
          continue
        }
        daemon = await startOldDaemon(driverOptions)
        client = new ReleaseClient(daemon)
        seeds.push(
          await seedRound(client, git, 'postgresql-live', {
            ...(OLD_POSTGRESQL_TASK_DEFECTS[release.tag]
              ? { knownTaskDefect: OLD_POSTGRESQL_TASK_DEFECTS[release.tag] }
              : {}),
          }),
        )
        projections = await captureProjections(client, seeds)
        candidateEnv = daemon.env
        await daemon.stop()
        shutdowns.push({
          tag: release.tag,
          method: daemon.shutdownMethod,
          sqliteCheckpointValidated: false,
        })
        daemon = undefined
        // Reading raw manifest is deliberate: CLI status refreshes firstLiveWriteAt.
        const migration = migrationManifest(home)
        if (migration.phase !== 'accepting-writes')
          throw new Error('Scenario must leave RFC-349 un-finalized')
        postgresql = { urlEnv, ...role, operationId: migration.operationId }
      }
    }
    if (!projections) throw new Error('Scenario produced no projections')
    if (options.variant === 'sqlite-no-sidecar') removeCleanSqliteSidecars(home)
    else if (!postgresql) retainCleanSqliteSidecars(home)
    const projectionFile = join(home, 'release-upgrade-api-before.json')
    writeJson(projectionFile, projections)
    const manifest: ScenarioManifest = {
      formatVersion: 1,
      variant: options.variant,
      home,
      releases: releases.map((release) => release.tag),
      binaries,
      shutdowns,
      seeds,
      projectionFile,
      git: { root: git.root, repository: git.repository, remoteUrl: git.remoteUrl },
      ...(postgresql ? { postgresql } : {}),
      candidateWork: [
        'start candidate against this home',
        'compare API projections',
        'resume pending reviews and questions',
        'run a new task to done',
        'restart and doctor',
        ...(options.variant === 'postgresql-restricted-role'
          ? [
              'capture candidate refusal and DBA SQL',
              'execute emitted SQL using admin connection',
              'restart candidate without changing role privileges',
            ]
          : []),
      ],
    }
    writeJson(join(home, 'release-upgrade-scenario.json'), manifest)
    return { manifest, projections, git, env: candidateEnv, dispose: () => git.stop() }
  } catch (error) {
    try {
      await daemon?.stop()
    } finally {
      await git.stop()
    }
    throw error
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      tag: { type: 'string' },
      variant: { type: 'string', default: 'sqlite' },
      home: { type: 'string' },
      'postgresql-url-env': { type: 'string' },
      chain: { type: 'string' },
      'no-tag-build': { type: 'boolean', default: false },
    },
  })
  const registry = readRegistry()
  const lookup = (tag: string | undefined) => {
    const release = registry.releases.find((entry) => entry.tag === tag)
    if (!release) throw new Error(`Unknown --tag ${tag}`)
    return release
  }
  if (!(VARIANTS as readonly string[]).includes(values.variant!))
    throw new Error(`Unknown variant: ${values.variant}`)
  const scenario = await prepareScenario({
    release: lookup(values.tag),
    variant: values.variant as ScenarioVariant,
    home: values.home,
    postgresqlUrlEnv: values['postgresql-url-env'],
    chain: values.chain?.split(',').map(lookup),
    binaryOptions: { allowTagBuild: !values['no-tag-build'] },
  })
  console.log(JSON.stringify(scenario.manifest, null, 2))
  await scenario.dispose()
}
