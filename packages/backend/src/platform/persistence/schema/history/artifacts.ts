// RFC-395 II-b R2: append-only contract, plans and optional generated PostgreSQL catalog artifacts, usable by A without target-table imports.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalSchemaJson, digestSchemaContract } from '../canonical'
import type { SchemaRegistry } from '../registry'
import { compileContract } from '../contract'
import { createHistoryVersion } from './compiler'
import { verifyPostgresqlCatalogArtifact, type PostgresqlCatalogArtifact } from './catalog'
import { HISTORY_META_TABLES, type MetaTableDeclaration } from './meta'
import { deriveSchemaEdge, sameSchemaValue } from './edgeDiff'
import {
  SCHEMA_EDGE_KINDS,
  SchemaHistoryError,
  type HistoryVersion,
  type SchemaEdge,
  type SchemaEdgeKind,
} from './types'

function assertDigest(value: { readonly digest: string }, label: string): void {
  const { digest, ...payload } = value
  if (digestSchemaContract(payload) !== digest)
    throw new SchemaHistoryError('digest-mismatch', label)
}
export function verifyHistoryVersion(version: HistoryVersion): void {
  assertDigest(version.contract, 'contract artifact')
  assertDigest(version.contract.contract, 'compiled contract')
  assertDigest(version.sqlite, 'SQLite plan')
  assertDigest(version.postgresql, 'PostgreSQL plan')
  if (version.postgresqlCatalog)
    verifyPostgresqlCatalogArtifact(version.postgresqlCatalog, version.postgresql)
  if (version.contract.contract.schemaEpoch !== 2)
    throw new SchemaHistoryError('schema-epoch', 'compiled history contract must belong to epoch 2')
  for (const provider of ['sqlite', 'postgresql'] as const) {
    const plan = version[provider]
    if (
      plan.formatVersion !== 1 ||
      plan.schemaEpoch !== 2 ||
      plan.provider !== provider ||
      plan.version !== version.contract.version ||
      plan.contractDigest !== version.contract.contract.digest
    )
      throw new SchemaHistoryError('plan-identity', provider)
  }
  if (
    version.contract.formatVersion !== 1 ||
    version.contract.schemaEpoch !== 2 ||
    !Number.isSafeInteger(version.contract.version) ||
    version.contract.version < 0
  )
    throw new SchemaHistoryError('contract-version', 'unsupported history format/epoch/version')
}
export function verifySchemaHistory(
  versions: readonly HistoryVersion[],
  registry?: SchemaRegistry,
): void {
  if (!versions.length) throw new SchemaHistoryError('empty', 'generate the epoch-2 baseline first')
  for (const [index, version] of versions.entries()) {
    verifyHistoryVersion(version)
    const previous = versions[index - 1]
    if (
      version.contract.version !== index ||
      version.contract.previousDigest !== (previous?.contract.digest ?? null)
    )
      throw new SchemaHistoryError(
        'chain',
        `version ${index} is missing or has a different predecessor`,
      )
    if (previous) {
      const edge = version.contract.edge
      if (
        !edge ||
        !sameSchemaValue(
          edge,
          deriveSchemaEdge(edge.kind, previous.contract.contract, version.contract.contract, edge),
        )
      )
        throw new SchemaHistoryError('edge-diff-mismatch', String(index))
    } else if (version.contract.edge !== null)
      throw new SchemaHistoryError('baseline-edge', 'baseline must not carry an edge')
  }
  if (registry) {
    const last = versions.at(-1)!
    if (last.contract.contract.digest !== compileContract(registry).digest)
      throw new SchemaHistoryError(
        'registry-head-mismatch',
        'last artifact contract digest differs from registry compile digest',
      )
    const expected = createHistoryVersion({ registry, slug: last.contract.slug })
    for (const provider of ['sqlite', 'postgresql'] as const)
      if (!sameSchemaValue(last[provider].head, expected[provider].head))
        throw new SchemaHistoryError('registry-plan-mismatch', provider)
  }
}
export function historyArtifactStem(version: HistoryVersion): string {
  return `${String(version.contract.version).padStart(4, '0')}_${version.contract.slug}`
}
export function schemaHistoryFiles(directory: string): Readonly<Record<string, string>> {
  if (!existsSync(directory)) return {}
  return Object.fromEntries(
    readdirSync(directory)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => [file, join(directory, file)]),
  )
}
export function postgresqlCatalogArtifactName(version: HistoryVersion, major: number): string {
  return `${historyArtifactStem(version)}.postgresql-${major}-catalog.json`
}
export function readHistoryPostgresqlCatalogs(
  files: Readonly<Record<string, string>>,
  version: HistoryVersion,
  metaTables?: readonly MetaTableDeclaration[],
): readonly PostgresqlCatalogArtifact[] {
  const prefix = `${historyArtifactStem(version)}.postgresql-`
  return Object.keys(files)
    .filter((name) => name.startsWith(prefix) && /\.postgresql-\d+-catalog\.json$/.test(name))
    .sort()
    .map((name) => {
      const artifact = JSON.parse(readFileSync(files[name]!, 'utf8')) as PostgresqlCatalogArtifact
      verifyPostgresqlCatalogArtifact(artifact, version.postgresql, metaTables)
      if (name !== postgresqlCatalogArtifactName(version, artifact.postgresqlMajor))
        throw new SchemaHistoryError('artifact-name', name)
      return artifact
    })
}
/** The same reader serves disk and Bun's embedded file map; it never compiles a registry. */
export function readSchemaHistoryFiles(
  files: Readonly<Record<string, string>>,
  postgresqlMajor?: number,
  metaTables?: readonly MetaTableDeclaration[],
): readonly HistoryVersion[] {
  const names = Object.keys(files).sort()
  const contracts = names.filter((file) => /^\d{4,}_[a-z0-9_-]+\.contract\.json$/.test(file))
  const expectedFiles = new Set(
    contracts.flatMap((file) => {
      const stem = file.slice(0, -'.contract.json'.length)
      return ['contract', 'sqlite-plan', 'postgresql-plan'].map(
        (suffix) => `${stem}.${suffix}.json`,
      )
    }),
  )
  for (const name of names) {
    const match = /^(\d{4,}_[a-z0-9_-]+)\.postgresql-\d+-catalog\.json$/.exec(name)
    if (match && expectedFiles.has(`${match[1]}.contract.json`)) expectedFiles.add(name)
  }
  if (names.some((file) => !expectedFiles.has(file)))
    throw new SchemaHistoryError('artifact-set', 'unexpected history artifact')
  const versions = contracts.map((file) => {
    const stem = file.slice(0, -'.contract.json'.length)
    const read = (suffix: string): unknown => {
      const path = files[`${stem}.${suffix}.json`]
      if (!path) throw new SchemaHistoryError('artifact-missing', `${stem}.${suffix}`)
      return JSON.parse(readFileSync(path, 'utf8')) as unknown
    }
    const version = {
      contract: read('contract'),
      sqlite: read('sqlite-plan'),
      postgresql: read('postgresql-plan'),
    } as HistoryVersion
    if (historyArtifactStem(version) !== stem) throw new SchemaHistoryError('artifact-name', file)
    const catalogs = readHistoryPostgresqlCatalogs(files, version, metaTables)
    const catalog =
      postgresqlMajor === undefined
        ? catalogs.length === 1
          ? catalogs[0]
          : undefined
        : catalogs.find((entry) => entry.postgresqlMajor === postgresqlMajor)
    if (postgresqlMajor !== undefined && !catalog)
      throw new SchemaHistoryError('catalog-postgresql-major', String(postgresqlMajor))
    return catalog ? { ...version, postgresqlCatalog: catalog } : version
  })
  if (versions.length) verifySchemaHistory(versions)
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  freeze(versions)
  return versions
}
export function readSchemaHistory(
  directory: string,
  postgresqlMajor?: number,
): readonly HistoryVersion[] {
  return readSchemaHistoryFiles(schemaHistoryFiles(directory), postgresqlMajor)
}
export function writeHistoryArtifacts(
  directory: string,
  version: HistoryVersion,
): readonly string[] {
  const versions = readSchemaHistory(directory)
  verifySchemaHistory([...versions, version])
  mkdirSync(directory, { recursive: true })
  const stem = historyArtifactStem(version)
  const entries = [
    ['contract', version.contract],
    ['sqlite-plan', version.sqlite],
    ['postgresql-plan', version.postgresql],
    ...(version.postgresqlCatalog
      ? [
          [
            `postgresql-${version.postgresqlCatalog.postgresqlMajor}-catalog`,
            version.postgresqlCatalog,
          ] as const,
        ]
      : []),
  ] as const
  const paths = entries.map(([suffix]) => join(directory, `${stem}.${suffix}.json`))
  if (paths.some((path) => existsSync(path)))
    throw new SchemaHistoryError('immutable-artifact', stem)
  for (const [index, [, artifact]] of entries.entries())
    writeFileSync(paths[index]!, canonicalSchemaJson(artifact), { flag: 'wx' })
  return paths
}
export function generateHistoryBaseline(
  directory: string,
  registry: SchemaRegistry,
  slug = 'baseline',
): readonly string[] {
  if (readSchemaHistory(directory).length)
    throw new SchemaHistoryError('baseline-exists', directory)
  return writeHistoryArtifacts(directory, createHistoryVersion({ registry, slug }))
}
export function appendSchemaHistory(input: {
  readonly directory: string
  readonly registry: SchemaRegistry
  readonly kind: SchemaEdgeKind
  readonly slug: string
  readonly explicitEdge?: SchemaEdge
}): readonly string[] {
  const previous = readSchemaHistory(input.directory).at(-1)
  if (!previous) throw new SchemaHistoryError('baseline-missing', 'run --baseline first')
  const edge = deriveSchemaEdge(
    input.kind,
    previous.contract.contract,
    compileContract(input.registry),
    input.explicitEdge,
  )
  return writeHistoryArtifacts(
    input.directory,
    createHistoryVersion({ registry: input.registry, slug: input.slug, previous, edge }),
  )
}
export function runSchemaHistoryCommand(
  argv: readonly string[],
  input: {
    readonly registry: SchemaRegistry
    readonly directory: string
    readonly explicitEdge?: SchemaEdge
  },
): readonly string[] {
  if (argv[0] === '--check' && argv.length === 1) {
    verifySchemaHistory(readSchemaHistory(input.directory), input.registry)
    return []
  }
  if (argv[0] === '--baseline' && argv.length === 2)
    return generateHistoryBaseline(input.directory, input.registry, argv[1]!)
  if (
    argv[0] === '--append' &&
    argv.length === 3 &&
    SCHEMA_EDGE_KINDS.includes(argv[1] as SchemaEdgeKind)
  )
    return appendSchemaHistory({ ...input, kind: argv[1] as SchemaEdgeKind, slug: argv[2]! })
  throw new SchemaHistoryError('usage', '--baseline <slug> | --append <edgeKind> <slug> | --check')
}

export function readPostgresqlCatalogArtifact(
  directory: string,
  version: HistoryVersion,
  metaTables: readonly MetaTableDeclaration[] = HISTORY_META_TABLES,
  postgresqlMajor?: number,
): PostgresqlCatalogArtifact {
  const artifacts = readHistoryPostgresqlCatalogs(
    schemaHistoryFiles(directory),
    version,
    metaTables,
  )
  const artifact =
    postgresqlMajor === undefined
      ? artifacts.length === 1
        ? artifacts[0]
        : undefined
      : artifacts.find((entry) => entry.postgresqlMajor === postgresqlMajor)
  if (!artifact)
    throw new SchemaHistoryError(
      'catalog-artifact-missing',
      `${historyArtifactStem(version)}:${postgresqlMajor ?? 'unspecified-major'}`,
    )
  return artifact
}
/** Generator/check context only: the supplied compiler applies the head on a scratch engine. */
export async function generatePostgresqlCatalogArtifacts(input: {
  readonly directory: string
  readonly check: boolean
  readonly compile: (plan: HistoryVersion['postgresql']) => Promise<PostgresqlCatalogArtifact>
  readonly metaTables?: readonly MetaTableDeclaration[]
}): Promise<readonly string[]> {
  const paths: string[] = []
  for (const version of readSchemaHistory(input.directory)) {
    const artifact = await input.compile(version.postgresql)
    verifyPostgresqlCatalogArtifact(
      artifact,
      version.postgresql,
      input.metaTables ?? HISTORY_META_TABLES,
    )
    const path = join(
      input.directory,
      postgresqlCatalogArtifactName(version, artifact.postgresqlMajor),
    )
    if (input.check || existsSync(path)) {
      const stored = readPostgresqlCatalogArtifact(
        input.directory,
        version,
        input.metaTables,
        artifact.postgresqlMajor,
      )
      if (!sameSchemaValue(stored, artifact))
        throw new SchemaHistoryError('catalog-artifact-mismatch', path)
    } else {
      writeFileSync(path, canonicalSchemaJson(artifact), { flag: 'wx' })
      paths.push(path)
    }
  }
  return paths
}
