// RFC-370 A-T7: shared-main publication must project the committed source,
// independent of uncommitted edits. Reads Git objects; never creates a checkout.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { readCommittedArchitectureSource } from '../../../scripts/lib/committed-architecture-source'

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
