// RFC-626 T14 (design §7「端到端（发布版升级矩阵 L1 的新种子）」「升级后可启动」「每一类处置的种子都跑
// 完整的校验」): overlay seeds on the released v0.19.2 build, the automatic upgrade as the CLI runs it,
// and the independent resolution oracle.
//
// Independence (repository rule, CLAUDE.md「发版」; RFC-398 seeds/README.md): the overlay seeds describe
// what an old v0.19.2 database could hold, and `rfc626/oracle.json` is hand-written from
// design §3.2–§3.4 and the old release's semantics. Nothing here imports the converter
// (`platform/persistence/migration/conversion`) or derives an expectation from its output; keys are
// encoded by the matrix's own independent `encodedKey` / `keyCell` (data.ts).
import { test } from 'bun:test'
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { composeAutomaticUpgradeProvisioning } from '@/bootstrap/epochMigrationAuto'
import { composeLocalEpochSwitchDependencies } from '@/bootstrap/epochMigration'
import { persistenceHead, persistencePostgresqlCatalogs } from '@/bootstrap/persistenceHead'
import { loadConfig } from '@/config'
import {
  autoUpgrade,
  createAutoUpgradeRecords,
  createAutoUpgradeSessionLock,
  createEpochSwitchApplication,
  createLegacyMigrationFinalize,
} from '@/modules/system-operations/composition/epochMigration'
import { parseEpochSwitchJournal } from '@/modules/system-operations/domain/epochSwitch/model'
import { startMaintenanceTicker } from '@/platform/background/maintenanceTicker'
import { runGit } from '@/platform/execution/local/gitProcess'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { FIXTURES, readRegistry, sha256 } from '../../../../../scripts/release-upgrade/lib/io'
import type { Json } from '../../../../../scripts/release-upgrade/lib/model'
import {
  columns,
  quoteIdentifier,
  sqliteValue,
} from '../../../../../scripts/release-upgrade/lib/seed-ledger'
import { resolveTestProviders } from '../eachProvider'
import { buildReleaseHome, type BuiltRelease } from './build'
import {
  encodedKey,
  equal,
  invariant,
  keyCell,
  normalized,
  pgSnapshot,
  sqliteSnapshot,
  UPGRADE_TIME,
  type Row,
  type Snapshot,
} from './data'
import {
  checkApiExpectations,
  installMockRuntime,
  startSourceDaemon,
  type MatrixDaemon,
} from './daemon'

export const RFC626_FIXTURES = join(FIXTURES, 'rfc626')
export type Provider = 'sqlite' | 'postgresql'

/** Database integer/bigint/bytes representations compare equal (data.ts `normalized`). */
function canonicalOf(value: unknown): string {
  return canonicalSchemaJson(normalized(value))
}

// ---------------------------------------------------------------------------------------------
// Overlay seeds
// ---------------------------------------------------------------------------------------------

/**
 * One row the old v0.19.2 database holds on top of the released ledger. `clone` copies exactly one
 * existing row (released ledger or an earlier overlay row) and replaces the named columns, so every
 * column the released migrations added keeps the value they gave it; `insert` writes the named
 * columns only (the rest take the old schema's defaults). Values use the seed ledger's canonical
 * logical representation (seeds/README.md「Seed format」), including `<AW_HOME>` substitution.
 */
export interface OverlayRow {
  readonly op: 'clone' | 'insert'
  readonly table: string
  readonly from?: Readonly<Record<string, Json>>
  readonly values: Readonly<Record<string, Json>>
  /** clone only: literal replacements applied, in order, to the copied text of a column. */
  readonly replace?: Readonly<Record<string, readonly (readonly [string, string])[]>>
  /** Providers whose old schema can hold this row; absent means every provider of the seed. */
  readonly providers?: readonly Provider[]
  readonly why: string
}
export interface OverlayContent {
  readonly path: string
  readonly utf8: string
  /** SHA-256 of the UTF-8 bytes when the old database registered them (checked on write). */
  readonly sha256?: string
}
export interface OverlayWorktree {
  /** Home-relative path of the worktree (the task's `worktree_path`). */
  readonly path: string
  /** Home-relative path of the repository (the task's `repo_path`); created when absent. */
  readonly repository: string
  /** The task's branch, created by the worktree. */
  readonly branch: string
  /** The repository's branch the task started from. */
  readonly baseBranch: string
}
export interface OverlaySeed {
  readonly formatVersion: 1
  readonly scenario: string
  readonly base: 'v0.19.2'
  readonly providers: readonly Provider[]
  readonly provenance: {
    readonly kind: 'curated'
    readonly sources: readonly string[]
    readonly note: string
  }
  readonly rows: readonly OverlayRow[]
  readonly content?: readonly OverlayContent[]
  /** Released-ledger files removed (the old database still names them). */
  readonly removeContent?: readonly string[]
  /**
   * Task worktrees the old daemon left behind, as git made them: a worktree of the task's
   * repository on the task's branch. A task that resumes after the upgrade prepares its
   * workspace in it, which needs a real git worktree, not an empty directory.
   */
  readonly worktrees?: readonly OverlayWorktree[]
  /** SQLite only: source tables whose rows already break the old database's own foreign keys. */
  readonly foreignKeyViolations?: readonly string[]
}

export function readOverlay(scenario: string): OverlaySeed {
  const seed = JSON.parse(
    readFileSync(join(RFC626_FIXTURES, `${scenario}.json`), 'utf8'),
  ) as OverlaySeed
  invariant(seed.formatVersion === 1, `${scenario}: overlay format`)
  invariant(seed.scenario === scenario, `${scenario}: overlay names another scenario`)
  invariant(seed.base === 'v0.19.2', `${scenario}: overlay base release`)
  invariant(seed.provenance.kind === 'curated', `${scenario}: overlay provenance`)
  return seed
}

function rowsFor(seed: OverlaySeed, provider: Provider): OverlayRow[] {
  return seed.rows.filter((row) => !row.providers || row.providers.includes(provider))
}

function contentPath(home: string, path: string): string {
  const absolute = resolve(home, path)
  invariant(absolute.startsWith(`${resolve(home)}${sep}`), `content path escapes home: ${path}`)
  return absolute
}

function materializeOverlayContent(built: BuiltRelease, seed: OverlaySeed): void {
  for (const path of seed.removeContent ?? []) {
    const absolute = contentPath(built.home, path)
    invariant(
      existsSync(absolute),
      `${seed.scenario}: removed content is not in the ledger: ${path}`,
    )
    rmSync(absolute, { recursive: true, force: true })
  }
  for (const file of seed.content ?? []) {
    const absolute = contentPath(built.home, file.path)
    const bytes = Buffer.from(file.utf8, 'utf8')
    if (file.sha256 !== undefined)
      equal(sha256(bytes), file.sha256, `${seed.scenario}: overlay content digest ${file.path}`)
    invariant(
      !existsSync(absolute),
      `${seed.scenario}: overlay content already exists: ${file.path}`,
    )
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, bytes, { flag: 'wx' })
  }
}

async function git(cwd: string, args: string[], label: string): Promise<void> {
  const result = await runGit(cwd, args)
  invariant(result.exitCode === 0, `${label}: git ${args.join(' ')}: ${result.stderr}`)
}

async function materializeOverlayWorktrees(built: BuiltRelease, seed: OverlaySeed): Promise<void> {
  for (const entry of seed.worktrees ?? []) {
    const label = `${seed.scenario}: worktree ${entry.path}`
    const repository = contentPath(built.home, entry.repository)
    const worktree = contentPath(built.home, entry.path)
    invariant(!existsSync(worktree), `${label} already exists`)
    if (!existsSync(repository)) {
      mkdirSync(repository, { recursive: true })
      await git(repository, ['init', '-q', '-b', entry.baseBranch], label)
      await git(
        repository,
        [
          '-c',
          'user.name=RFC-626 fixture',
          '-c',
          'user.email=rfc626@example.invalid',
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          'upgrade example',
        ],
        label,
      )
    }
    mkdirSync(dirname(worktree), { recursive: true })
    await git(
      repository,
      ['worktree', 'add', '-q', '-b', entry.branch, worktree, entry.baseBranch],
      label,
    )
  }
}

function replaced(seed: OverlaySeed, row: OverlayRow, base: Row): Row {
  const copy: Row = { ...base }
  for (const [column, pairs] of Object.entries(row.replace ?? {})) {
    const original = copy[column]
    invariant(typeof original === 'string', `${seed.scenario}: ${row.table}.${column} is not text`)
    let value: string = original
    for (const [from, to] of pairs) {
      invariant(value.includes(from), `${seed.scenario}: ${row.table}.${column} lacks ${from}`)
      value = value.replaceAll(from, to)
    }
    copy[column] = value
  }
  return copy
}

function applySqliteOverlay(built: BuiltRelease, seed: OverlaySeed): void {
  const db = new Database(built.sourcePath)
  try {
    // The ledger itself is inserted without FK enforcement (buildSeedDatabase); the overlay is
    // ordered parent-first and its intended violations are asserted exactly below.
    db.exec('PRAGMA foreign_keys=OFF')
    db.transaction(() => {
      for (const [index, row] of rowsFor(seed, 'sqlite').entries()) {
        const label = `${seed.scenario} row ${index} (${row.op} ${row.table})`
        const allowed = new Set(columns(db, row.table).map(({ name }) => name))
        invariant(allowed.size > 0, `${label}: table absent from v0.19.2`)
        for (const name of [...Object.keys(row.values), ...Object.keys(row.replace ?? {})])
          invariant(allowed.has(name), `${label}: column absent from v0.19.2: ${name}`)
        let values: Record<string, SQLQueryBindings>
        if (row.op === 'clone') {
          invariant(row.from && Object.keys(row.from).length, `${label}: clone needs a selector`)
          const selector = Object.keys(row.from)
          const found = db
            .query<
              Row,
              SQLQueryBindings[]
            >(`SELECT * FROM ${quoteIdentifier(row.table)} WHERE ${selector.map((name) => `${quoteIdentifier(name)} IS ?`).join(' AND ')}`)
            .all(...selector.map((name) => sqliteValue(row.from![name]!, built.home)))
          equal(found.length, 1, `${label}: clone source rows`)
          values = replaced(seed, row, found[0]!) as Record<string, SQLQueryBindings>
        } else {
          invariant(!row.from && !row.replace, `${label}: insert takes values only`)
          values = {}
        }
        for (const [name, value] of Object.entries(row.values))
          values[name] = sqliteValue(value, built.home)
        const names = Object.keys(values)
        db.query(
          `INSERT INTO ${quoteIdentifier(row.table)} (${names.map(quoteIdentifier).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
        ).run(...names.map((name) => values[name]!))
      }
    })()
    const violations = db
      .query<{ table: string }, []>('PRAGMA foreign_key_check')
      .all()
      .map((violation) => violation.table)
    equal(
      [...new Set(violations)].sort(),
      [...(seed.foreignKeyViolations ?? [])].sort(),
      `${seed.scenario}: the old database's own foreign-key violations`,
    )
    equal(db.query('PRAGMA quick_check').all(), [{ quick_check: 'ok' }], 'overlay quick_check')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    built.before = sqliteSnapshot(db)
  } finally {
    db.close()
  }
}

async function applyPostgresqlOverlay(built: BuiltRelease, seed: OverlaySeed): Promise<void> {
  invariant(built.database && built.contract, `${seed.scenario}: PostgreSQL source absent`)
  // PostgreSQL enforces the old foreign keys: rows that break them are SQLite-only overlay rows,
  // and an insert that broke one here fails the transaction.
  const sql = built.database.sql
  const physical = (table: string): string =>
    built.contract!.tables.find((entry) => entry.id === table)?.providerTables.postgresql ?? table
  const types = new Map(
    (
      await sql.unsafe<{ table_name: string; column_name: string; data_type: string }[]>(
        "SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='agent_workflow'",
      )
    ).map((column) => [`${column.table_name}.${column.column_name}`, column.data_type]),
  )
  // The ledger value representation is SQLite-shaped (booleans as 0/1); bind what the old
  // PostgreSQL column type takes, never a re-encoded text form.
  const bind = (table: string, column: string, value: Json): unknown => {
    const bound = sqliteValue(value, built.home)
    return types.get(`${table}.${column}`) === 'boolean' && typeof bound === 'number'
      ? bound !== 0
      : bound
  }
  await sql.begin(async (tx) => {
    await tx.unsafe('SET LOCAL search_path TO agent_workflow, public')
    for (const [index, row] of rowsFor(seed, 'postgresql').entries()) {
      const label = `${seed.scenario} row ${index} (${row.op} ${row.table})`
      const table = physical(row.table)
      for (const name of [...Object.keys(row.values), ...Object.keys(row.replace ?? {})])
        invariant(types.has(`${table}.${name}`), `${label}: column absent from v0.19.2: ${name}`)
      let values: Record<string, unknown>
      if (row.op === 'clone') {
        invariant(row.from && Object.keys(row.from).length, `${label}: clone needs a selector`)
        const selector = Object.keys(row.from)
        const found = await tx.unsafe<Row[]>(
          `SELECT * FROM agent_workflow.${quoteIdentifier(table)} WHERE ${selector.map((name, i) => `${quoteIdentifier(name)} = $${i + 1}`).join(' AND ')}`,
          selector.map((name) => bind(table, name, row.from![name]!)),
        )
        equal(found.length, 1, `${label}: clone source rows`)
        values = replaced(seed, row, { ...found[0]! })
      } else {
        invariant(!row.from && !row.replace, `${label}: insert takes values only`)
        values = {}
      }
      for (const [name, value] of Object.entries(row.values))
        values[name] = bind(table, name, value)
      const names = Object.keys(values)
      await tx.unsafe(
        `INSERT INTO agent_workflow.${quoteIdentifier(table)} (${names.map(quoteIdentifier).join(',')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(',')})`,
        names.map((name) => values[name]),
      )
    }
  })
  built.before = await pgSnapshot(sql)
}

/** Writes the overlay into the stopped v0.19.2 installation, then refreshes `built.before`. */
export async function applyOverlay(built: BuiltRelease, seed: OverlaySeed): Promise<void> {
  invariant(
    seed.providers.includes(built.provider),
    `${seed.scenario}: no ${built.provider} variant`,
  )
  materializeOverlayContent(built, seed)
  await materializeOverlayWorktrees(built, seed)
  if (built.provider === 'sqlite') applySqliteOverlay(built, seed)
  else await applyPostgresqlOverlay(built, seed)
}

// ---------------------------------------------------------------------------------------------
// The automatic upgrade (same composition as the CLI and the matrix's in-process mode)
// ---------------------------------------------------------------------------------------------

/**
 * `upgrade.ts#automaticUpgrade` observes the conversion input through the dry run; the automatic
 * mode of RFC-626 no longer rehearses (design §4.2), so this runs the same composition without that
 * observer. The fixed clock is the matrix's plan time (`fixtureInputs.ts`).
 */
export async function automaticUpgradeDirect(
  built: BuiltRelease,
): Promise<{ operationId: string }> {
  const appHome = built.home,
    env = built.env,
    config = loadConfig(join(appHome, 'config.json'))
  const lock = createAutoUpgradeSessionLock({
    appHome,
    startMonitor: (onTick) =>
      startMaintenanceTicker({
        job: 'auto-upgrade-lock',
        intervalMs: 1000,
        phaseOffsetMs: 1000,
        keepAlive: true,
        onTick,
      }),
  })
  const records = createAutoUpgradeRecords(appHome)
  const provisioning =
    config.database.provider === 'postgresql'
      ? composeAutomaticUpgradeProvisioning({
          appHome,
          env,
          config: config.database,
          sourceProfileRef: 'env:RFC398_URL',
          async recordProvisioned(receipt) {
            await records.append(receipt.sessionOperationId, 'provisioned', { ...receipt })
          },
        })
      : undefined
  const epoch = composeLocalEpochSwitchDependencies({
    appHome,
    env,
    config,
    head: persistenceHead(),
    catalogArtifacts: persistencePostgresqlCatalogs(),
    autoUpgrade: true,
    sessionLock: lock,
    autoUpgradeRecords: records,
    nextTargetLocation: provisioning?.nextTargetLocation,
  })
  epoch.now = () => UPGRADE_TIME
  const result = await autoUpgrade({
    epoch,
    application: createEpochSwitchApplication(epoch),
    records,
    lock,
    legacy: createLegacyMigrationFinalize({ appHome, env }),
    provisioning,
    enabled: config.autoEpochMigration !== false,
    standalone: true,
  })
  // G1: the automatic upgrade does not refuse because of data.
  equal(result.outcome, 'done', `RFC-626 automatic upgrade ${JSON.stringify(result)}`)
  invariant(result.operationId, 'automatic operation ID missing')
  const journal = parseEpochSwitchJournal(
    readFileSync(
      join(appHome, 'database-migrations', result.operationId, 'epoch-switch.json'),
      'utf8',
    ),
  )
  equal(journal.payload.phase, 'verified', 'upgrade verified before any daemon write')
  return { operationId: result.operationId }
}

// ---------------------------------------------------------------------------------------------
// The resolution oracle
// ---------------------------------------------------------------------------------------------

export interface ExpectedSettlement {
  readonly taskId: string
  readonly cause: 'unprovable-records' | 'parent-cascade'
  readonly originalStatus: string
  readonly parentTaskId: string | null
  /** The causing block codes must include these (the converter may report further ones). */
  readonly blockCodesInclude: readonly string[]
}
export interface ExpectedRow {
  readonly table: string
  readonly key: Readonly<Record<string, Json>>
  readonly expect: 'present' | 'absent'
  readonly columns?: Readonly<Record<string, Json>>
  readonly providers?: readonly Provider[]
  readonly why: string
}
export interface ExpectedDisposition {
  readonly sourceTable: string
  readonly sourceKey: Json
  readonly class: 'converted' | 'preserved' | 'archived'
  readonly kind?: string
  readonly decisionCode?: Json
  /** Archived only: the set-aside archive keeps the old row's raw evidence (or has none). */
  readonly raw?: 'present' | 'absent'
  readonly providers?: readonly Provider[]
  readonly why: string
}
export interface ExpectedRecord {
  readonly code?: string
  readonly codePrefix?: string
  readonly payload: Json
  readonly providers?: readonly Provider[]
  readonly why: string
}
export interface ExpectedArtifact {
  readonly sourceTable: string
  readonly sourceKey: Json
  readonly sourceColumn: string
  readonly columns: Readonly<Record<string, Json>>
  readonly providers?: readonly Provider[]
  readonly why: string
}
export interface ExpectedFinalize {
  readonly targetTable: string
  readonly targetKey: Json
  readonly foreignKey: string
  readonly references: string
  readonly action: 'detached' | 'substituted' | 'set-aside'
  readonly providers?: readonly Provider[]
  readonly why: string
}
export interface ScenarioOracle {
  readonly seed: string
  readonly design: readonly string[]
  readonly settlements: readonly ExpectedSettlement[]
  readonly rows: readonly ExpectedRow[]
  readonly dispositions?: readonly ExpectedDisposition[]
  readonly records?: readonly ExpectedRecord[]
  readonly artifacts?: readonly ExpectedArtifact[]
  readonly finalize?: readonly ExpectedFinalize[]
  /**
   * Every listed history table yields exactly one package whose index covers each source row,
   * except the rows listed in `setAside`: a row whose rejected value does not have its column's
   * type cannot be read back from a package and is set aside on its own (design §9.9, row 8).
   */
  readonly historyPackages?: {
    readonly tables: readonly string[]
    readonly indexed: readonly { readonly table: string; readonly originalId: string }[]
    readonly setAside?: readonly { readonly table: string; readonly originalId: string }[]
  }
}
export interface ResolutionOracle {
  readonly formatVersion: 1
  readonly authority: 'independent-rfc626-specification'
  readonly authoring: Readonly<Record<string, Json>>
  readonly validation: { readonly checks: readonly string[]; readonly probes: readonly string[] }
  readonly constants: Readonly<Record<string, Json>>
  readonly scenarios: Readonly<Record<string, ScenarioOracle>>
}

export function readResolutionOracle(): ResolutionOracle {
  const oracle = JSON.parse(
    readFileSync(join(RFC626_FIXTURES, 'oracle.json'), 'utf8'),
  ) as ResolutionOracle
  invariant(oracle.formatVersion === 1, 'RFC-626 oracle format')
  equal(oracle.authority, 'independent-rfc626-specification', 'RFC-626 oracle authority')
  equal(oracle.authoring.converterExecuted, false, 'oracle authored without the converter')
  equal(oracle.authoring.conversionOutputUsed, false, 'oracle authored without conversion output')
  return oracle
}

export interface MatchContext {
  readonly scenario: string
  readonly seed: OverlaySeed
  readonly sourceRow?: Row
}

function isToken(value: Json): value is { readonly [key: string]: Json } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.keys(value)[0]!.startsWith('$')
  )
}

function overlayBytes(ctx: MatchContext, path: Json): Buffer {
  invariant(typeof path === 'string', 'content token takes a path')
  const file = ctx.seed.content?.find((entry) => entry.path === path)
  invariant(file, `${ctx.scenario}: oracle names content the overlay does not write: ${path}`)
  return Buffer.from(file.utf8, 'utf8')
}

/** `{ "$key": [table, [cell, ...]] }`: the mk1 key of the listed cells in that order. */
export function oracleKey(value: Json): string {
  invariant(
    Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      Array.isArray(value[1]),
    `invalid $key ${JSON.stringify(value)}`,
  )
  return encodedKey(
    value[0],
    (value[1] as Json[]).map((cell) => keyCell(cell)),
  )
}

/** Concrete value of a token that names one (keys, the plan time, overlay content facts). */
function concrete(expected: Json, ctx: MatchContext): unknown {
  if (!isToken(expected)) return expected
  const [token, argument] = Object.entries(expected)[0]!
  switch (token) {
    case '$upgradeTime':
      return UPGRADE_TIME
    case '$key':
      return oracleKey(argument)
    case '$sha256Of':
      return sha256(overlayBytes(ctx, argument))
    case '$sizeOf':
      return overlayBytes(ctx, argument).byteLength
    case '$source': {
      invariant(typeof argument === 'string', '$source takes a column')
      invariant(ctx.sourceRow, `${ctx.scenario}: $source without a source row`)
      invariant(argument in ctx.sourceRow, `${ctx.scenario}: source lacks ${argument}`)
      return ctx.sourceRow[argument]
    }
    default:
      return undefined
  }
}

/** Returns a failure description, or null when `actual` satisfies `expected`. */
export function mismatch(
  actual: unknown,
  expected: Json,
  ctx: MatchContext,
  path = '',
): string | null {
  if (isToken(expected)) {
    const [token, argument] = Object.entries(expected)[0]!
    switch (token) {
      case '$notNull':
        return actual === null || actual === undefined ? `${path}: expected a value` : null
      case '$startsWith':
        return typeof actual === 'string' && actual.startsWith(String(argument))
          ? null
          : `${path}: ${JSON.stringify(actual)} does not start with ${JSON.stringify(argument)}`
      case '$includes':
        return typeof actual === 'string' && actual.includes(String(argument))
          ? null
          : `${path}: ${JSON.stringify(actual)} does not include ${JSON.stringify(argument)}`
      case '$oneOf': {
        invariant(Array.isArray(argument), '$oneOf takes a list')
        return argument.some((candidate) => mismatch(actual, candidate, ctx, path) === null)
          ? null
          : `${path}: ${JSON.stringify(actual)} is none of ${JSON.stringify(argument)}`
      }
      case '$json': {
        if (typeof actual !== 'string') return `${path}: expected JSON text`
        let parsed: unknown
        try {
          parsed = JSON.parse(actual)
        } catch {
          return `${path}: not JSON text`
        }
        return mismatch(parsed, argument, ctx, `${path}(json)`)
      }
      case '$includesAll': {
        invariant(Array.isArray(argument), '$includesAll takes a list')
        if (!Array.isArray(actual)) return `${path}: expected a list`
        const missing = argument.filter(
          (wanted) => !actual.some((entry) => mismatch(entry, wanted, ctx) === null),
        )
        return missing.length ? `${path}: missing ${JSON.stringify(missing)}` : null
      }
      default: {
        const value = concrete(expected, ctx)
        invariant(value !== undefined, `unknown oracle token ${token}`)
        return canonicalOf(actual) === canonicalOf(value)
          ? null
          : `${path}: expected ${JSON.stringify(normalized(value))}, actual ${JSON.stringify(normalized(actual))}`
      }
    }
  }
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual))
      return `${path}: expected an object, actual ${JSON.stringify(normalized(actual))}`
    // `isToken`'s false branch narrows the object case away; the value is still a JSON object.
    for (const [key, wanted] of Object.entries(expected as { readonly [key: string]: Json })) {
      const failure = mismatch((actual as Row)[key], wanted, ctx, `${path}.${key}`)
      if (failure) return failure
    }
    return null
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length)
      return `${path}: expected ${expected.length} entries, actual ${JSON.stringify(normalized(actual))}`
    for (const [index, wanted] of expected.entries()) {
      const failure = mismatch(actual[index], wanted, ctx, `${path}[${index}]`)
      if (failure) return failure
    }
    return null
  }
  return canonicalOf(actual) === canonicalOf(expected)
    ? null
    : `${path}: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(normalized(actual))}`
}

function applies(entry: { readonly providers?: readonly Provider[] }, provider: Provider): boolean {
  return !entry.providers || entry.providers.includes(provider)
}

function selectRows(snapshot: Snapshot, table: string, key: Readonly<Record<string, Json>>): Row[] {
  return (snapshot.get(table) ?? []).filter((row) =>
    Object.entries(key).every(([column, value]) => canonicalOf(row[column]) === canonicalOf(value)),
  )
}

function parse(value: unknown): unknown {
  return JSON.parse(String(value))
}

/** The twelve checks and eleven probes of the conversion's own validation, each passed. */
export function checkCompleteValidation(oracle: ResolutionOracle, target: Snapshot): void {
  const runs = target.get('aw_meta_migration_runs') ?? []
  equal(runs.length, 1, 'one conversion run')
  const report = parse(runs[0]!.validation_json) as {
    passed: boolean
    checks: { check: string; passed: boolean }[]
    probes: { id: string; passed: boolean }[]
    blocks: unknown[]
    contentDrift: unknown[]
  }
  equal(report.passed, true, 'validation passed')
  equal(
    report.checks.map((check) => check.check).sort(),
    [...oracle.validation.checks].sort(),
    'all twelve validation checks ran',
  )
  equal(
    report.checks.filter((check) => !check.passed),
    [],
    'every validation check passed',
  )
  equal(
    report.probes.map((probe) => probe.id).sort(),
    [...oracle.validation.probes].sort(),
    'all eleven read-only probes ran',
  )
  equal(
    report.probes.filter((probe) => !probe.passed),
    [],
    'every read-only probe passed',
  )
  equal(report.blocks, [], 'validation produced no blocks')
  equal(report.contentDrift, [], 'validation found no content drift')
  equal(target.get('aw_meta_migration_blocks') ?? [], [], 'no conversion, load or plan blocks')
}

/**
 * Compares the upgraded target with the scenario's hand-written expectations. All failures are
 * collected so one run reports every difference.
 */
export function checkResolutionOracle(
  built: BuiltRelease,
  seed: OverlaySeed,
  oracle: ResolutionOracle,
  target: Snapshot,
): void {
  const scenario = oracle.scenarios[seed.scenario]
  invariant(scenario, `oracle has no scenario ${seed.scenario}`)
  const provider = built.provider
  const ctx: MatchContext = { scenario: seed.scenario, seed }
  const failures: unknown[] = []
  const attempt = (label: string, body: () => void) => {
    try {
      body()
    } catch (error) {
      failures.push(new Error(`${seed.scenario} ${label}: ${String(error)}`))
    }
  }
  const fail = (label: string, detail: string | null) => {
    if (detail) failures.push(new Error(`${seed.scenario} ${label}: ${detail}`))
  }
  attempt('validation', () => checkCompleteValidation(oracle, target))
  const run = (target.get('aw_meta_migration_runs') ?? [])[0]
  const plan = run
    ? (parse(run.conversion_plan_json) as {
        resolution?: string
        settlements?: {
          taskId: string
          cause: string
          originalStatus: string
          blockCodes: string[]
          parentTaskId: string | null
        }[]
      })
    : undefined
  attempt('plan', () => {
    invariant(plan, 'no conversion plan')
    equal(plan.resolution, 'automatic', 'the conversion plan records automatic resolution')
    const settled = plan.settlements ?? []
    equal(
      settled.map((entry) => entry.taskId).sort(),
      scenario.settlements.map((entry) => entry.taskId).sort(),
      'exactly the expected tasks are ended (design §3.2.1)',
    )
    for (const wanted of scenario.settlements) {
      const actual = settled.find((entry) => entry.taskId === wanted.taskId)
      if (!actual) continue
      equal(
        [actual.cause, actual.originalStatus, actual.parentTaskId],
        [wanted.cause, wanted.originalStatus, wanted.parentTaskId],
        `settlement ${wanted.taskId}`,
      )
      for (const code of wanted.blockCodesInclude)
        invariant(
          actual.blockCodes.includes(code),
          `settlement ${wanted.taskId} lacks ${code}: ${JSON.stringify(actual.blockCodes)}`,
        )
      if (wanted.cause === 'parent-cascade')
        equal(actual.blockCodes, [], `cascade ${wanted.taskId} carries no block code`)
    }
  })
  // proposal §6 item 1: every task the oracle does not end keeps its status.
  attempt('unchanged tasks', () => {
    const ended = new Set(scenario.settlements.map((entry) => entry.taskId))
    for (const source of built.before.get('tasks') ?? []) {
      if (ended.has(String(source.id))) continue
      const migrated = selectRows(target, 'tasks', { id: String(source.id) })
      equal(migrated.length, 1, `task ${String(source.id)} converted`)
      equal(migrated[0]!.status, source.status, `task ${String(source.id)} keeps its status`)
    }
  })
  for (const expected of scenario.rows.filter((entry) => applies(entry, provider)))
    attempt(`row ${expected.table} ${JSON.stringify(expected.key)}`, () => {
      const found = selectRows(target, expected.table, expected.key)
      if (expected.expect === 'absent') {
        equal(found.length, 0, `absent (${expected.why})`)
        return
      }
      equal(found.length, 1, `present (${expected.why})`)
      const sourceRow = selectRows(built.before, expected.table, expected.key)[0]
      fail(
        `row ${expected.table} ${JSON.stringify(expected.key)}`,
        mismatch(found[0], expected.columns ?? {}, { ...ctx, sourceRow }),
      )
    })
  const dispositions = target.get('aw_meta_migration_row_dispositions') ?? []
  const archives = target.get('aw_meta_migration_archives') ?? []
  for (const expected of (scenario.dispositions ?? []).filter((entry) => applies(entry, provider)))
    attempt(`disposition ${expected.sourceTable}`, () => {
      const key = String(concrete(expected.sourceKey, ctx))
      const found = dispositions.filter(
        (row) => row.source_table === expected.sourceTable && row.source_key === key,
      )
      const matching = found.filter(
        (row) =>
          row.class === expected.class &&
          (expected.kind === undefined || row.kind === expected.kind) &&
          (expected.decisionCode === undefined ||
            mismatch(
              (parse(row.decision_json ?? 'null') as { code?: string } | null)?.code,
              expected.decisionCode,
              ctx,
            ) === null),
      )
      invariant(
        matching.length > 0,
        `${key}: no ${expected.class}/${expected.kind ?? '*'} disposition (${expected.why}); found ${JSON.stringify(found.map((row) => [row.class, row.kind, row.decision_json]))}`,
      )
      if (expected.class !== 'archived') return
      for (const row of matching) {
        const archive = archives.filter((entry) => entry.archive_ref === row.archive_ref)
        equal(archive.length, 1, `${key}: the set-aside row has its archive`)
        const bytes = archive[0]!.bytes as Uint8Array
        equal(`archive:sha256:${sha256(bytes)}`, row.archive_ref, `${key}: archive digest`)
        const payload = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
          canonical?: { key?: unknown }
          raw?: unknown
        }
        // The archive carries the source row as it was read (design §3.3): its key cells are
        // the source key's cells.
        equal(
          payload.canonical?.key,
          (JSON.parse(key.slice(4)) as [string, unknown[]])[1],
          `${key}: archive holds the source row`,
        )
        if (expected.raw === 'present')
          invariant(payload.raw !== null && payload.raw !== undefined, `${key}: raw evidence`)
        if (expected.raw === 'absent') equal(payload.raw ?? null, null, `${key}: no raw evidence`)
      }
    })
  const records = (target.get('aw_meta_migration_records') ?? []).map((row) => ({
    unitId: String(row.unit_id),
    record: parse(row.record_json) as { kind: string; code?: string; payload?: unknown },
  }))
  for (const expected of (scenario.records ?? []).filter((entry) => applies(entry, provider)))
    attempt(`record ${expected.code ?? `${expected.codePrefix}*`}`, () => {
      const candidates = records.filter(
        ({ record }) =>
          record.kind === 'decision' &&
          typeof record.code === 'string' &&
          (expected.code === undefined || record.code === expected.code) &&
          (expected.codePrefix === undefined || record.code.startsWith(expected.codePrefix)),
      )
      const matching = candidates.filter(
        ({ record }) => mismatch(record.payload, expected.payload, ctx) === null,
      )
      invariant(
        matching.length > 0,
        `no matching decision record (${expected.why}); closest: ${JSON.stringify(
          candidates
            .slice(0, 5)
            .map(({ record }) => [record.code, mismatch(record.payload, expected.payload, ctx)]),
        )}`,
      )
    })
  const receipts = target.get('aw_meta_migration_artifact_receipts') ?? []
  for (const expected of (scenario.artifacts ?? []).filter((entry) => applies(entry, provider)))
    attempt(`artifact ${expected.sourceTable}.${expected.sourceColumn}`, () => {
      const key = String(concrete(expected.sourceKey, ctx))
      const found = receipts.filter(
        (row) =>
          row.source_table === expected.sourceTable &&
          row.source_key === key &&
          row.source_column === expected.sourceColumn,
      )
      invariant(found.length > 0, `${key}: no artifact receipt (${expected.why})`)
      for (const row of found)
        fail(
          `artifact ${expected.sourceTable}.${expected.sourceColumn}`,
          mismatch(row, expected.columns, ctx),
        )
    })
  for (const expected of (scenario.finalize ?? []).filter((entry) => applies(entry, provider)))
    attempt(`finalize ${expected.targetTable}`, () => {
      const key = String(concrete(expected.targetKey, ctx))
      const matching = records.filter(
        ({ unitId, record }) =>
          unitId.startsWith('v3:finalize:reference:') &&
          record.code === 'v3-finalize-reference' &&
          mismatch(
            record.payload,
            {
              targetTable: expected.targetTable,
              targetKey: key,
              foreignKey: expected.foreignKey,
              references: expected.references,
              action: expected.action,
            },
            ctx,
          ) === null,
      )
      equal(matching.length, 1, `one finalize disposition for ${key} (${expected.why})`)
      if (expected.action === 'set-aside') {
        const ref = (matching[0]!.record.payload as { archive?: string }).archive
        const archive = archives.filter((entry) => entry.archive_ref === ref)
        equal(archive.length, 1, `${key}: finalize archive`)
        equal(archive[0]!.kind, 'deleted-row', `${key}: finalize archive kind`)
      }
    })
  if (scenario.historyPackages)
    attempt('history packages', () => {
      const packages = target.get('code_history_archives') ?? []
      const index = target.get('code_history_id_index') ?? []
      const setAside = scenario.historyPackages!.setAside ?? []
      for (const table of scenario.historyPackages!.tables) {
        const source = built.before.get(table)
        invariant(source, `history table absent from the source: ${table}`)
        const packaged = source.length - setAside.filter((entry) => entry.table === table).length
        const found = packages.filter((row) => row.source_table === table)
        // T0-7: one package per table, its index complete, or the daemon cannot start.
        equal(found.length, 1, `exactly one package for ${table}`)
        equal(
          Number(found[0]!.row_count),
          packaged,
          `${table} package holds every source row that was not set aside`,
        )
        equal(
          index.filter((row) => row.archive_id === found[0]!.id).length,
          packaged,
          `${table} index covers the package`,
        )
      }
      for (const { table, originalId } of setAside)
        equal(
          index.filter((row) => row.original_id === originalId).length,
          0,
          `${table}/${originalId} was set aside, not packaged`,
        )
      for (const { table, originalId } of scenario.historyPackages!.indexed) {
        const archive = packages.find((row) => row.source_table === table)
        invariant(archive, `no package for ${table}`)
        equal(
          index.filter((row) => row.archive_id === archive.id && row.original_id === originalId)
            .length,
          1,
          `${table}/${originalId} is indexed`,
        )
      }
    })
  if (failures.length) throw new AggregateError(failures, 'RFC-626 resolution oracle failed')
}

// ---------------------------------------------------------------------------------------------
// Daemon helpers
// ---------------------------------------------------------------------------------------------

export function items(value: unknown): Row[] {
  if (Array.isArray(value)) return value as Row[]
  invariant(value && typeof value === 'object', 'API collection absent')
  for (const key of ['items', 'rows', 'runs', 'tasks', 'skills', 'reviews'])
    if (Array.isArray((value as Row)[key])) return (value as Row)[key] as Row[]
  throw new Error(`Unexpected API collection ${JSON.stringify(value).slice(0, 2000)}`)
}

class RefusalMissing extends Error {}

/** The request must fail; returns the failure text (status, body and daemon output). */
export async function requestRefused(
  daemon: MatrixDaemon,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<string> {
  try {
    const value = await daemon.request(path, method, body)
    throw new RefusalMissing(`${method} ${path} succeeded: ${JSON.stringify(value).slice(0, 2000)}`)
  } catch (error) {
    if (error instanceof RefusalMissing) throw error
    return String(error)
  }
}

/** Approves every pending review round of the task until it is done (as `newTaskToDone`). */
export async function approveUntilDone(daemon: MatrixDaemon, taskId: string): Promise<void> {
  const deadline = Date.now() + 90_000,
    approved = new Set<string>()
  while (Date.now() < deadline) {
    const current = (await daemon.request(`/api/tasks/${taskId}`)) as Row
    if (current.status === 'done') return
    invariant(
      !['failed', 'canceled'].includes(String(current.status)),
      `upgraded review task did not continue: ${JSON.stringify(current)}\n${daemon.child.output}`,
    )
    if (current.status === 'awaiting_review')
      for (const review of items(await daemon.request('/api/reviews')).filter(
        (entry) => entry.taskId === taskId && entry.awaitingReview,
      )) {
        const key = `${String(review.nodeRunId)}/${String(review.reviewIteration)}`
        if (approved.has(key)) continue
        await daemon.request(`/api/reviews/${String(review.nodeRunId)}/decision`, 'POST', {
          decision: 'approved',
          reviewIteration: review.reviewIteration,
        })
        approved.add(key)
      }
    await new Promise((settle) => setTimeout(settle, 500))
  }
  throw new Error(
    `upgraded review task did not finish: ${JSON.stringify(await daemon.request(`/api/tasks/${taskId}/node-runs`))}`,
  )
}

// ---------------------------------------------------------------------------------------------
// One case = one seed on one provider
// ---------------------------------------------------------------------------------------------

export interface ResolutionCase {
  readonly built: BuiltRelease
  readonly seed: OverlaySeed
  readonly oracle: ResolutionOracle
  readonly target: Snapshot
  readonly daemon: MatrixDaemon
}

/**
 * Builds the released v0.19.2 installation, writes the overlay, upgrades automatically, checks the
 * complete validation and the oracle, then starts the current source's daemon (it must pass its
 * readiness: the fail-closed boot steps, the skill-operation recovery and the code-history query
 * index included) and runs the scenario's representative operation on it.
 */
export function registerResolutionCase(
  scenario: string,
  provider: Provider,
  operate: (input: ResolutionCase) => Promise<void>,
): void {
  const enabled = resolveTestProviders(process.env).includes(provider)
  ;(enabled ? test : test.skip)(
    `RFC-626 ${scenario} -> v0.19.2 / ${provider} / automatic upgrade, validation, oracle, daemon`,
    async () => {
      const started = performance.now()
      const seed = readOverlay(scenario)
      const oracle = readResolutionOracle()
      const release = readRegistry().releases.find((entry) => entry.tag === seed.base)
      invariant(release, `release ${seed.base} absent from the registry`)
      const built = await buildReleaseHome(release, provider)
      let daemon: MatrixDaemon | undefined
      try {
        await applyOverlay(built, seed)
        await automaticUpgradeDirect(built)
        const target = await built.snapshotTarget()
        checkResolutionOracle(built, seed, oracle, target)
        await installMockRuntime(built)
        daemon = await startSourceDaemon(built)
        await checkApiExpectations(built, daemon)
        await operate({ built, seed, oracle, target, daemon })
        await daemon.stop()
        daemon = undefined
      } catch (error) {
        await daemon?.stop()
        daemon = undefined
        const evidence = mkdtempSync(join(tmpdir(), `rfc626-failed-${scenario}-${provider}-`))
        cpSync(built.home, join(evidence, 'home'), { recursive: true })
        console.error(`RFC-626 failure evidence: ${evidence}`)
        throw error
      } finally {
        await daemon?.stop()
        await built.close()
      }
      invariant(
        performance.now() - started <= 240_000,
        `RFC-626 ${scenario}/${provider} exceeded the four-minute shard budget`,
      )
    },
    240_000,
  )
}
