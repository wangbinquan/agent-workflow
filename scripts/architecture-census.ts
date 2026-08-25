// RFC-294 N1 — reproducible architecture report / canonical manifest writer.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  CANONICAL_MANIFEST_PATHS,
  PROVENANCE_ARTIFACTS,
  buildCanonicalArtifacts,
  projectGovernanceArtifacts,
  stableJson,
  validateCanonicalArtifacts,
  withArtifactProvenance,
} from '../packages/backend/tests/architecture/rfc294Canonical'
import {
  assertsAbsence,
  corpusFloor,
  isCorpusScanner,
  negativeFixtureAssertions,
  sourceUnit,
} from '../packages/backend/tests/architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..')
const args = new Set(process.argv.slice(2))
const write = args.has('--write')
const snapshotIndex = process.argv.indexOf('--snapshot-sha')
const requestedSnapshot = snapshotIndex >= 0 ? process.argv[snapshotIndex + 1] : undefined
const seedIndex = process.argv.indexOf('--seed-ref')
const seedRef = seedIndex >= 0 ? process.argv[seedIndex + 1] : undefined

function fullSha(value: string): string {
  const result = spawnSync('git', ['rev-parse', `${value}^{commit}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`cannot resolve commit '${value}': ${(result.stderr ?? '').trim()}`)
  }
  const sha = (result.stdout ?? '').trim()
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`git returned a non-full SHA for '${value}'`)
  return sha
}

function provenanceOrigin(value: Record<string, unknown>, path: string): string {
  const provenance = value.provenance
  if (provenance !== null && typeof provenance === 'object' && !Array.isArray(provenance)) {
    const origin = (provenance as Record<string, unknown>).originSha
    if (typeof origin === 'string' && origin.length > 0) return fullSha(origin)
  }
  if (typeof value.recordedAtSha === 'string') return fullSha(value.recordedAtSha)
  const baseline = value.baseline
  if (baseline !== null && typeof baseline === 'object' && !Array.isArray(baseline)) {
    const origin = (baseline as Record<string, unknown>).recordedAtSha
    if (typeof origin === 'string') return fullSha(origin)
  }
  throw new Error(`${path} has neither provenance.originSha nor legacy recordedAtSha`)
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, path), 'utf8')) as Record<string, unknown>
}

function readSeedJson(path: string): Record<string, unknown> {
  if (seedRef === undefined) return readJson(path)
  const result = spawnSync('git', ['show', `${seedRef}:${path}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(
      `cannot read ${path} from seed ref '${seedRef}': ${(result.stderr ?? '').trim()}`,
    )
  }
  return JSON.parse(result.stdout ?? '') as Record<string, unknown>
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function asciiJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )}\n`
}

function upsertCanonicalGuard(value: Record<string, unknown>): Record<string, unknown> {
  const path = 'packages/backend/tests/architecture/rfc294-canonical-manifests.test.ts'
  const text = readFileSync(resolve(REPO_ROOT, path), 'utf8')
  const unit = sourceUnit(path, text)
  const raw = Array.isArray(value.guards) ? value.guards : []
  const guards = raw.filter(
    (entry): entry is Record<string, unknown> =>
      entry !== null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      entry.id !== 'rfc294-canonical-manifests' &&
      entry.file !== path,
  )
  guards.push({
    id: 'rfc294-canonical-manifests',
    file: path,
    runner: 'bun',
    mechanism: 'ast',
    corpusScanner: isCorpusScanner(unit),
    minCorpusFiles: corpusFloor(unit),
    assertsAbsence: assertsAbsence(unit),
    negativeFixture: negativeFixtureAssertions(unit).length > 0,
    classified: true,
    lines: text.split('\n').length - 1,
  })
  return {
    ...value,
    guards: guards.sort((left, right) => String(left.id).localeCompare(String(right.id))),
  }
}

const artifacts = buildCanonicalArtifacts(REPO_ROOT)
const errors = validateCanonicalArtifacts(artifacts)
if (errors.length > 0)
  throw new Error(`canonical artifact validation failed:\n${errors.join('\n')}`)

if (!write) {
  process.stdout.write(stableJson(artifacts.report))
  process.exit(0)
}

for (const [name, path] of Object.entries(CANONICAL_MANIFEST_PATHS)) {
  const artifact = artifacts[name as keyof typeof artifacts]
  writeFileSync(resolve(REPO_ROOT, path), stableJson(artifact))
}

const governance = projectGovernanceArtifacts(artifacts, {
  commonsManifest: readSeedJson('architecture/commons-manifest.json'),
  commonsDebt: readSeedJson('architecture/commons-debt.json'),
  guardManifest: upsertCanonicalGuard(readSeedJson('architecture/guard-manifest.json')),
  ledgerBaselines: readSeedJson('architecture/ledger-baselines.json'),
})
const governanceByPath: Record<(typeof PROVENANCE_ARTIFACTS)[number], Record<string, unknown>> = {
  'architecture/commons-manifest.json': governance.commonsManifest,
  'architecture/commons-debt.json': governance.commonsDebt,
  'architecture/guard-manifest.json': governance.guardManifest,
  'architecture/ledger-baselines.json': governance.ledgerBaselines,
}
for (const path of PROVENANCE_ARTIFACTS) {
  writeFileSync(
    resolve(REPO_ROOT, path),
    path === 'architecture/commons-manifest.json'
      ? asciiJson(governanceByPath[path])
      : prettyJson(governanceByPath[path]),
  )
}

if (requestedSnapshot !== undefined) {
  const currentSnapshotSha = fullSha(requestedSnapshot)
  for (const path of PROVENANCE_ARTIFACTS) {
    const absolute = resolve(REPO_ROOT, path)
    const current = readJson(path)
    const next = withArtifactProvenance(current, {
      originSha: provenanceOrigin(current, path),
      currentSnapshotSha,
    })
    writeFileSync(
      absolute,
      path === 'architecture/commons-manifest.json' ? asciiJson(next) : prettyJson(next),
    )
  }
}

process.stdout.write(
  `${Object.keys(CANONICAL_MANIFEST_PATHS).length} architecture artifacts written` +
    (requestedSnapshot === undefined
      ? '\n'
      : `; provenance pinned to ${fullSha(requestedSnapshot)}\n`),
)
