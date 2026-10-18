// RFC-370 A-T7 / RFC-376: reports must read the committed source,
// independent of uncommitted edits. Reads Git objects; never creates a checkout.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { readCommittedArchitectureSource } from '../../../scripts/lib/committed-architecture-source'
import { buildArchitectureReport, readReportSource } from './architecture/architectureReport'

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
    'packages/backend/tests/rfc370-committed-architecture-source.test.ts',
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
  const selected = readReportSource(root, 'HEAD')
  // Build from the explicit snapshot; no live directory is passed to the builder.
  const report = buildArchitectureReport(selected)
  expect(new Set(report.moduleSymbolOwners.map((entry) => entry.file)).size).toBeGreaterThan(1000)
  const backend = selected.units.filter((unit) => unit.path.startsWith('packages/backend/src/'))
  const modules = backend.filter((unit) => unit.path.startsWith('packages/backend/src/modules/'))
  expect(report.metrics.backendProductionFiles).toBe(backend.length)
  expect(
    report.moduleSymbolOwners.filter((entry) => entry.file.includes('/src/modules/')).length,
  ).toBeGreaterThan(modules.length)
  expect(report.sourceSha).toBe(selected.sourceSha)
})
