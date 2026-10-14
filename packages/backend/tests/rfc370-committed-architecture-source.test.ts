// RFC-370 A-T7: shared-main publication must project the committed source,
// independent of uncommitted edits. Reads Git objects; never creates a checkout.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { readCommittedArchitectureSource } from '../../../scripts/lib/committed-architecture-source'
import { buildCanonicalArtifacts } from './architecture/rfc294Canonical'

setDefaultTimeout(60_000)
test('the explicit committed corpus and extra inputs come from the exact Git revision', () => {
  const root = resolve(import.meta.dir, '../../..')
  const selected = readCommittedArchitectureSource(root, 'HEAD')
  expect(selected.sourceSha).toMatch(/^[a-f0-9]{40}$/)
  expect(selected.units.length).toBeGreaterThan(1000)
  for (const path of [
    'packages/backend/src/cli/start.ts',
    'packages/shared/src/index.ts',
    'packages/frontend/src/routes/intent.detail.tsx',
    '.dependency-cruiser.cjs',
    'scripts/depcheck.ts',
    'packages/backend/tests/architecture/rfc294-canonical-manifests.test.ts',
  ]) {
    const original = spawnSync('git', ['show', `${selected.sourceSha}:${path}`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    expect(original.status).toBe(0)
    expect(selected.readText(path)).toBe(original.stdout)
  }
  expect(selected.readText('uncommitted/unknown.ts')).toBeUndefined()
  expect(selected.units.some((unit) => unit.path === 'scripts/depcheck.ts')).toBe(false)
  expect(() => readCommittedArchitectureSource(root, 'missing-rfc370-original-revision')).toThrow(
    'architecture source revision is unavailable',
  )
})

test('the committed report counts the selected module corpus without consulting a live directory', () => {
  const root = resolve(import.meta.dir, '../../..')
  const selected = readCommittedArchitectureSource(root, 'HEAD')
  // This path is never created. With an explicit complete source the report
  // must not need a filesystem copy, even while the primary checkout has WIP.
  const artifacts = buildCanonicalArtifacts(
    resolve(root, 'missing-rfc370-snapshot-report-directory'),
    selected,
  )
  expect(
    new Set(
      (artifacts.moduleSymbolOwners.entries as Array<{ file: string }>).map((entry) => entry.file),
    ).size,
  ).toBeGreaterThan(1000)
  const backend = selected.units.filter((unit) => unit.path.startsWith('packages/backend/src/'))
  const modules = backend.filter((unit) => unit.path.startsWith('packages/backend/src/modules/'))
  const contexts = [...new Set(modules.map((unit) => unit.path.split('/')[4]!))].sort()
  const metrics = artifacts.report.metrics as {
    backendProductionFiles: number
    moduleFiles: number
    moduleContexts: Array<{ context: string; files: number }>
  }
  expect(metrics.backendProductionFiles).toBe(backend.length)
  expect(metrics.moduleFiles).toBe(modules.length)
  expect(metrics.moduleContexts).toEqual(
    contexts.map((context) => ({
      context,
      files: modules.filter((unit) =>
        unit.path.startsWith(`packages/backend/src/modules/${context}/`),
      ).length,
    })),
  )
  expect(metrics.moduleContexts.reduce((total, entry) => total + entry.files, 0)).toBe(
    metrics.moduleFiles,
  )
})
